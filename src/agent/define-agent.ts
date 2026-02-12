/**
 * defineAgent - Agent definition factory
 */

import type { AgentDefinition, Agent, AgentConfig, AgentRunResult, SessionState } from '../types/agent.js'
import type { Runtime } from '../types/runtime.js'

import { EventBus } from '../core/event-bus.js'
import { TraceCollector } from '../core/trace-collector.js'
import { TokenBudget } from '../core/token-budget.js'
import { RuntimeIO } from '../core/runtime-io.js'
import { ToolRegistry } from '../core/tool-registry.js'
import { PolicyEngine } from '../core/policy-engine.js'
import { ContextManager } from '../core/context-manager.js'
import { PromptCompiler } from '../core/prompt-compiler.js'
import { SkillManager } from '../skills/skill-manager.js'
import { ExternalSkillLoader, type LoadedExternalSkill } from '../skills/external-skill-loader.js'
import { globalSkillRegistry } from '../skills/skill-registry.js'
import { AgentLoop } from './agent-loop.js'
import { createLLMClient, getModel, detectProviderFromApiKey } from '../llm/index.js'
import type { Message } from '../llm/index.js'
import type { ProviderID } from '../llm/index.js'
import { createKernelV2, type KernelV2 } from '../kernel-v2/index.js'
import { countTokens } from '../utils/tokenizer.js'
import { isAbsolute, join, relative } from 'path'
import { FRAMEWORK_DIR } from '../constants.js'
import { resolveCommunitySkillDir, resolveProjectSkillDir } from '../skills/skill-source-paths.js'

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Create session state
 */
function createSessionState(): SessionState {
  const store = new Map<string, unknown>()

  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => { store.set(key, value) },
    delete: (key: string): void => { store.delete(key) },
    has: (key: string): boolean => store.has(key)
  }
}

/**
 * Define an Agent
 */
export function defineAgent(definition: AgentDefinition): (config: AgentConfig) => Agent {
  return (config: AgentConfig): Agent => {
    const agentId = definition.id
    const sessionId = config.sessionId ?? generateId()
    const projectPath = config.projectPath ?? process.cwd()

    // Create core components
    const eventBus = new EventBus()
    const traceExportEnabled = config.trace?.export?.enabled ?? true
    const traceExportDir = config.trace?.export?.dir
      ?? join(projectPath, FRAMEWORK_DIR, 'traces')
    const trace = new TraceCollector({
      sessionId,
      agentId,
      export: {
        enabled: traceExportEnabled,
        dir: traceExportDir,
        writeJsonl: config.trace?.export?.writeJsonl ?? true,
        writeSummary: config.trace?.export?.writeSummary ?? true
      }
    })
    const tokenBudget = new TokenBudget({
      total: definition.model?.maxTokens ?? config.maxTokens ?? 100000,
      warningThreshold: 0.8
    })

    // Create policy engine
    const policyEngine = new PolicyEngine({
      trace,
      eventBus,
      onApprovalRequired: config.onApprovalRequired
        ? async (decision) => config.onApprovalRequired!(decision.message, decision.timeout)
        : undefined,
      onAlert: (alert) => {
        console.log(`[${alert.level}] ${alert.message}`)
      }
    })

    // Create tool registry
    const toolRegistry = new ToolRegistry()

    // Create context manager
    const contextManager = new ContextManager()

    // Create runtime
    let currentStep = 0
    const runtime: Runtime = {
      projectPath,
      sessionId,
      agentId,
      get step() { return currentStep },
      set step(value: number) { currentStep = value },
      io: null as unknown as RuntimeIO,
      eventBus,
      trace,
      tokenBudget,
      toolRegistry,
      policyEngine,
      contextManager,
      sessionState: createSessionState()
    } as Runtime

    // Create RuntimeIO
    const runtimeIO = new RuntimeIO({
      projectPath,
      policyEngine,
      trace,
      eventBus,
      agentId,
      sessionId,
      getCurrentStep: () => currentStep
    })

    ;(runtime as any).io = runtimeIO

    // Configure components
    toolRegistry.configure({ policyEngine, trace, runtime })
    contextManager.configure({ trace, tokenBudget, runtime })

    // Merge Packs
    const allPacks = [...definition.packs, ...(config.packs ?? [])]

    // Phase 1.4: Create SkillManager for lazy-loaded procedural knowledge
    const skillManager = new SkillManager({
      trace,
      skillTelemetry: config.skillTelemetry
    })

    for (const pack of allPacks) {
      if (pack.tools) toolRegistry.registerAll(pack.tools)
      if (pack.policies) policyEngine.registerAll(pack.policies)
      if (pack.contextSources) contextManager.registerAll(pack.contextSources)

      // Register Skills with skillLoadingConfig support
      if (pack.skills && pack.skills.length > 0) {
        const packSkills = config.disableResourcefulSkill
          ? pack.skills.filter(skill => skill.id !== 'resourceful-philosophy')
          : pack.skills
        const skillsWithConfig = packSkills.map(skill => {
          if (pack.skillLoadingConfig) {
            if (pack.skillLoadingConfig.eager?.includes(skill.id)) {
              return { ...skill, loadingStrategy: 'eager' as const }
            }
            if (pack.skillLoadingConfig.onDemand?.includes(skill.id)) {
              return { ...skill, loadingStrategy: 'on-demand' as const }
            }
            if (pack.skillLoadingConfig.lazy?.includes(skill.id)) {
              return { ...skill, loadingStrategy: 'lazy' as const }
            }
          }
          return skill
        })

        skillManager.registerAll(skillsWithConfig)
        globalSkillRegistry.registerAll(skillsWithConfig)

        // Load eager skills immediately
        if (pack.skillLoadingConfig?.eager) {
          for (const skillId of pack.skillLoadingConfig.eager) {
            if (config.disableResourcefulSkill && skillId === 'resourceful-philosophy') continue
            skillManager.loadFully(skillId, { trigger: 'eager' })
          }
        }
      }
    }

    // Add SkillManager to runtime
    ;(runtime as any).skillManager = skillManager
    ;(runtime as any).skillRegistry = globalSkillRegistry

    // Skill source directory config
    const resolvedExternalSkillsDir = resolveProjectSkillDir(projectPath, config.externalSkillsDir)
    const resolvedCommunitySkillsDir = resolveCommunitySkillDir(projectPath, config.communitySkillsDir)
    const relativeExternalSkillsDir = relative(projectPath, resolvedExternalSkillsDir)
    const externalSkillsDirForTools = (
      relativeExternalSkillsDir &&
      !relativeExternalSkillsDir.startsWith('..') &&
      !isAbsolute(relativeExternalSkillsDir)
    )
      ? relativeExternalSkillsDir
      : `${FRAMEWORK_DIR}/skills`
    runtime.sessionState.set('externalSkillsDir', externalSkillsDirForTools.replace(/\\/g, '/'))
    runtime.sessionState.set('communitySkillsDir', resolvedCommunitySkillsDir)
    runtime.sessionState.set('skillDirectoryById', new Map<string, string>())
    runtime.sessionState.set('skillScriptsById', new Map<string, unknown[]>())

    let externalSkillLoader: ExternalSkillLoader | null = null

    const registerExternalSkill = (loaded: LoadedExternalSkill, source: 'init' | 'watch'): void => {
      const skillDirectoryById = runtime.sessionState.get<Map<string, string>>('skillDirectoryById')
        ?? new Map<string, string>()
      const skillScriptsById = runtime.sessionState.get<Map<string, unknown[]>>('skillScriptsById')
        ?? new Map<string, unknown[]>()

      skillManager.register(loaded.skill, {
        approvedByUser: true,
        source: loaded.sourceType,
        filePath: loaded.filePath
      })
      globalSkillRegistry.register(loaded.skill)
      skillDirectoryById.set(loaded.skill.id, loaded.skillDir)
      skillScriptsById.set(loaded.skill.id, loaded.scripts)
      runtime.sessionState.set('skillDirectoryById', skillDirectoryById)
      runtime.sessionState.set('skillScriptsById', skillScriptsById)

      if (source === 'watch') {
        skillManager.recordTelemetry(
          'skill.hot_reloaded',
          {
            skillId: loaded.skill.id,
            action: 'modify',
            filePath: loaded.filePath,
            sourceType: loaded.sourceType
          },
          `hot-reload id=${loaded.skill.id} action=modify source=${loaded.sourceType}`
        )
      }
    }

    // Register definition-level policies
    if (definition.policies) {
      policyEngine.registerAll(definition.policies)
    }

    // Register config-level policies
    if (config.policies) {
      policyEngine.registerAll(config.policies)
    }

    // Determine Provider and model — resolve API key first so we can pick a
    // provider-appropriate default model when none is specified.
    const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? ''
    const explicitModel = config.model ?? definition.model?.default
    const modelId = explicitModel ?? (() => {
      // Pick a default model that matches the resolved API key's provider
      const detected = apiKey ? detectProviderFromApiKey(apiKey) : null
      if (detected === 'anthropic') return 'claude-sonnet-4-5-20250929'
      if (detected === 'deepseek') return 'deepseek-chat'
      if (detected === 'google') return 'gemini-2.0-flash'
      return 'gpt-4o'
    })()
    const modelConfig = getModel(modelId)
    const contextWindow = modelConfig?.limit.maxContext ?? 200000
    const provider: ProviderID = config.provider ?? modelConfig?.providerID ?? 'openai'
    const useKernelV2 = config.kernelV2?.enabled ?? true

    // Create LLM client
    const llmClient = createLLMClient({
      provider,
      model: modelId,
      config: { apiKey }
    })

    // Add LLM client to runtime (used for in-tool LLM calls)
    ;(runtime as any).llmClient = llmClient

    const kernelV2: KernelV2 | null = useKernelV2
      ? createKernelV2({
          projectPath,
          config: config.kernelV2,
          contextWindow,
          modelId
        })
      : null
    if (kernelV2) {
      runtime.kernelV2 = kernelV2
    }

    // Provider style normalization (opt-out, enabled by default)
    const normalizeStyle = config.normalizeProviderStyle !== false

    // Compile system prompt (Phase 1.4: Include skillManager)
    const promptCompiler = new PromptCompiler()

    // Helper to compile system prompt with current skill state
    function compileSystemPrompt(): string {
      const compiledPrompt = promptCompiler.compile(
        definition,
        toolRegistry,
        contextManager,
        tokenBudget,
        skillManager,
        normalizeStyle ? provider : undefined
      )
      return compiledPrompt.render()
    }

    let systemPrompt = compileSystemPrompt()

    // Create AgentLoop
    let agentLoop: AgentLoop | null = null
    let packsInitialized = false

    async function initPacks(): Promise<void> {
      if (packsInitialized) return

      for (const pack of allPacks) {
        if (pack.onInit) {
          await pack.onInit(runtime)
        }
      }

      externalSkillLoader = new ExternalSkillLoader({
        skillSources: [
          {
            dir: resolvedCommunitySkillsDir,
            sourceType: 'community-builtin',
            watchForChanges: config.watchCommunitySkills ?? false,
            approvedByDefault: true
          },
          {
            dir: resolvedExternalSkillsDir,
            sourceType: 'project-local',
            watchForChanges: config.watchExternalSkills ?? true,
            approvedByDefault: true
          }
        ],
        watchForChanges: true,
        builtInSkillIds: skillManager.getAll().map(skill => skill.id),
        onSkillLoaded: (loaded) => {
          registerExternalSkill(loaded, 'watch')
        },
        onSkillRemoved: (skillId) => {
          const skillDirectoryById = runtime.sessionState.get<Map<string, string>>('skillDirectoryById')
            ?? new Map<string, string>()
          const skillScriptsById = runtime.sessionState.get<Map<string, unknown[]>>('skillScriptsById')
            ?? new Map<string, unknown[]>()

          const removed = skillManager.unregister(skillId)
          globalSkillRegistry.unregister(skillId)
          skillDirectoryById.delete(skillId)
          skillScriptsById.delete(skillId)
          runtime.sessionState.set('skillDirectoryById', skillDirectoryById)
          runtime.sessionState.set('skillScriptsById', skillScriptsById)
          if (removed) {
            skillManager.recordTelemetry(
              'skill.hot_reloaded',
              { skillId, action: 'remove' },
              `hot-reload id=${skillId} action=remove`
            )
          }
        },
        onError: (error, filePath) => {
          skillManager.recordTelemetry(
            'skill.load_blocked',
            { skillId: null, reason: 'invalid', filePath, error: error.message },
            `load-blocked file=${filePath} reason=invalid`
          )
        }
      })

      const initialExternalSkills = await externalSkillLoader.loadAll()
      for (const loaded of initialExternalSkills) {
        registerExternalSkill(loaded, 'init')
      }

      if ((config.watchExternalSkills ?? true) || (config.watchCommunitySkills ?? false)) {
        externalSkillLoader.startWatching()
      }

      if (kernelV2) {
        await kernelV2.init()
        runtime.memoryStorage = kernelV2.getMemoryStorage(sessionId)
      }

      packsInitialized = true
    }

    const agent: Agent = {
      id: agentId,
      runtime,

      async ensureInit() {
        await initPacks()
      },

      async run(prompt: string): Promise<AgentRunResult> {
        await initPacks()

        // Phase 1.4: Recompile system prompt to pick up lazy-loaded skills
        systemPrompt = compileSystemPrompt()
        let workingContextBlock = ''
        if (kernelV2) {
          const identityTokens = countTokens(systemPrompt)
          const toolSchemas = toolRegistry.generateToolSchemas()
          const toolTokens = countTokens(JSON.stringify(toolSchemas))
          const kernelTurn = await kernelV2.beginTurn({
            sessionId,
            userPrompt: prompt,
            systemPromptTokens: identityTokens,
            toolSchemasTokens: toolTokens
          })
          workingContextBlock = kernelTurn.context.workingContextBlock
        }

        const buildSystemPromptForRun = () => compileSystemPrompt() + workingContextBlock

        agentLoop = new AgentLoop({
          client: llmClient,
          modelId,
          toolRegistry,
          runtime,
          trace,
          systemPrompt: buildSystemPromptForRun(),
          systemPromptBuilder: buildSystemPromptForRun,
          maxSteps: definition.maxSteps ?? config.maxSteps ?? 30,
          maxTokens: definition.model?.maxTokens ?? config.maxTokens,
          onText: config.onStream,
          onToolCall: config.onToolCall,
          onToolResult: config.onToolResult
        })

        const result = await agentLoop.run(prompt)
        if (kernelV2 && agentLoop) {
          await kernelV2.completeTurn({
            sessionId,
            messages: agentLoop.getMessages() as Message[],
            promptTokens: result.usage?.tokens.promptTokens ?? 0
          })
        }

        // Phase 3.3: Clean up expired skills (TTL-based downgrading)
        skillManager.cleanup()
        skillManager.reportTokenSavings(`${sessionId}:${Date.now().toString(36)}`, sessionId)

        return result
      },

      stop(): void {
        agentLoop?.stop()
      },

      async destroy(): Promise<void> {
        externalSkillLoader?.stopWatching()
        externalSkillLoader = null
        if (kernelV2) {
          await kernelV2.destroy()
        }

        for (const pack of allPacks) {
          if (pack.onDestroy) {
            await pack.onDestroy(runtime)
          }
        }

        eventBus.clear()
        trace.clear()
        toolRegistry.clear()
        contextManager.clear()
        policyEngine.clear()
        globalSkillRegistry.clear()
      }
    }

    return agent
  }
}

/**
 * Validate an Agent definition
 */
export function validateAgentDefinition(definition: Partial<AgentDefinition>): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!definition.id) {
    errors.push('id is required')
  }

  if (!definition.name) {
    errors.push('name is required')
  }

  if (!definition.identity) {
    errors.push('identity is required')
  }

  if (!definition.packs || definition.packs.length === 0) {
    errors.push('at least one pack is required')
  }

  if (!definition.constraints) {
    errors.push('constraints is required')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}
