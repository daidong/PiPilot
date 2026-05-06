/**
 * Coordinator Agent (Research Pilot - pi-mono migration)
 *
 * Key behavior:
 * - Canonical durable memory surface: Artifact
 * - Cross-turn continuity is provided by Session Summary snapshots
 * - Context is assembled with mention selections + latest session summary
 *
 * Rewritten from AgentFoundry to use pi-mono:
 * - @mariozechner/pi-agent-core for Agent
 * - @mariozechner/pi-ai for model resolution and LLM calls
 * - @mariozechner/pi-coding-agent for built-in coding tools
 */

import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { Agent } from '@mariozechner/pi-agent-core'
import { getModel as getPiModel } from '@mariozechner/pi-ai'
import { createCodingTools, createGrepTool, createFindTool, createLsTool, estimateTokens, shouldCompact, generateSummary, DEFAULT_COMPACTION_SETTINGS } from '@mariozechner/pi-coding-agent'
import type { AgentTool, AgentEvent } from '@mariozechner/pi-agent-core'
import type { Model, TextContent, ImageContent } from '@mariozechner/pi-ai'

import { createResearchTools, type ResearchToolContext } from '../tools/index.js'
import { probeStaticProfile, generateAgentGuidance } from '../local-compute/environment-model.js'
import { maybeExtractMemories } from '../memory/extractor.js'
import { createLoadSkillTool } from '../tools/skill-tools.js'
import { loadAllSkills, readEnabledSkills, resolveSkillDependencies, buildSkillsCatalogPrompt, type SkillEntry } from '../skills/loader.js'
import {
  detectIntentsByRules,
  classifyPersistenceDecision,
  buildMentionContext,
  buildSessionSummaryContext,
  buildSkillSummariesPrompt,
  type PersistenceDecision
} from './context-builder.js'
import { createSessionBootstrap } from './session-bootstrap.js'
import { createCoordinatorTelemetryAdapter } from './telemetry-adapter.js'
import { loadPrompt } from './prompts/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { PATHS, AGENT_MD_ID, type SessionSummary, type NoteArtifact } from '../types.js'
import { ROUTER_MODELS, inferProviderFromModelId } from '../models.js'
import { runSubLlmText } from '../telemetry/sub-llm.js'
import type { PipilotTracer } from '../telemetry/tracer.js'
import type { PipilotAuthMode } from '../telemetry/semantic-registry.js'
import { SpanKind, type Span } from '@opentelemetry/api'
import { createHash } from 'crypto'
import {
  migrateLegacyArtifacts,
  findArtifactById,
  readLatestSessionSummary,
  writeSessionSummary,
  readCompactionState,
  writeCompactionState,
  deleteCompactionState,
  COMPACTION_STATE_SCHEMA_VERSION
} from '../memory-v2/store.js'

const SYSTEM_PROMPT = loadPrompt('coordinator-system')

interface TurnExplainSnapshot {
  timestamp: string
  sessionId: string
  intents: string[]
  matchedSkills: string[]
  selectedContext: {
    mentionSelections: number
    approxTokens: number
  }
  persistence: {
    decision: PersistenceDecision
    reason: string
  }
  sessionSummary: {
    included: boolean
    turnRange?: [number, number]
    approxTokens: number
  }
  budget: {
    model: string
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

const MAX_SKILL_PRELOAD = 5

async function matchSkillsWithLLM(
  model: Model<any> | null,
  apiKey: string,
  message: string,
  skills: SkillEntry[],
  priorTurns: Array<{ userMessage: string; response: string }> = [],
  tracer: PipilotTracer | null = null,
  authMode?: PipilotAuthMode
): Promise<string[]> {
  if (!model || skills.length === 0) return []

  const skillList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
  const systemPrompt = [
    'You are a skill router for a research assistant. Given a user message (and recent conversation context, if any), select which skills should be activated.',
    'Return ONLY a JSON array of skill names. Return [] if none are relevant.',
    '',
    'Rules:',
    '- Only select skills directly relevant to the user\'s request',
    '- Do not select skills speculatively',
    `- Maximum ${MAX_SKILL_PRELOAD} skills`,
    '- Consider both English and Chinese messages',
    '- If the current message is a short follow-up or confirmation (e.g. "yes", "do that", "go ahead", "好的", "继续"), infer intent from the recent context',
    '',
    'Available skills:',
    skillList
  ].join('\n')

  // Build a compact context block from prior turns (already truncated to ~300 chars each upstream).
  const contextBlock = priorTurns.length > 0
    ? priorTurns
        .map(t => `User: ${t.userMessage}\nAssistant: ${t.response}`)
        .join('\n\n')
    : ''

  const userContent = contextBlock
    ? `Recent conversation:\n${contextBlock}\n\nCurrent user message:\n${message}`
    : message

  try {
    const text = (await runSubLlmText({
      model,
      systemPrompt,
      userContent,
      apiKey,
      maxTokens: 100,
      tracer,
      authMode,
      purpose: 'router'
    })).trim()
    if (!text) return []

    // Extract JSON array from response (may be wrapped in code fences)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*?\])/)
    const jsonStr = jsonMatch?.[1]?.trim() ?? text
    const parsed = JSON.parse(jsonStr)

    if (!Array.isArray(parsed)) return []
    const validNames = new Set(skills.map(s => s.name))
    return parsed
      .filter((n): n is string => typeof n === 'string' && validNames.has(n))
      .slice(0, MAX_SKILL_PRELOAD)
  } catch {
    return []
  }
}

function writeExplainSnapshot(projectPath: string, snapshot: TurnExplainSnapshot): void {
  const explainDir = join(projectPath, PATHS.explainDir)
  mkdirSync(explainDir, { recursive: true })
  const ts = Date.now().toString(36)
  const path = join(explainDir, `${ts}.${snapshot.sessionId}.turn.json`)
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf-8')
}

export interface CoordinatorConfig {
  apiKey: string
  /** Optional async token getter — called before each LLM request. Overrides static apiKey when set. */
  getApiKeyOverride?: () => Promise<string>
  model?: string
  projectPath?: string
  debug?: boolean
  sessionId?: string
  reasoningEffort?: 'max' | 'high' | 'medium' | 'low'
  /** Resolved numeric settings from user preferences (literature intensity, web search depth, etc.) */
  resolvedSettings?: import('../../shared-ui/settings-types').ResolvedSettings
  /**
   * Live accessor for resolved settings. Called by tools that must react
   * to user-driven changes without requiring a coordinator rebuild
   * (e.g., diagram review-provider selection).
   */
  getResolvedSettings?: () => import('../../shared-ui/settings-types').ResolvedSettings
  /** Live accessor for diagram-tool auth (see lib/tools/types.ts DiagramAuth). */
  getDiagramAuth?: () => import('../tools/types.js').DiagramAuth
  /**
   * Optional SVG rasterizer the coordinator forwards to tools. Populated
   * only when running inside Electron (the main process owns the
   * BrowserWindow needed to render SVG at fidelity). Tools degrade to
   * source-level review when absent.
   */
  rasterizeSvg?: (svg: Buffer, options?: import('../tools/types.js').SvgRasterizeOptions) => Promise<Buffer>
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown, toolCallId?: string) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown, toolCallId?: string) => void
  onToolProgress?: (tool: string, toolCallId: string, phase: 'start' | 'update' | 'end', data: unknown) => void
  onUsage?: (usage: unknown, cost: unknown) => void
  onSkillLoaded?: (skillName: string) => void
  /**
   * Optional telemetry tracer (telemetry-trace v0.10 spec). When provided, every
   * sub-LLM call (router, summarizer, extractor) and turn boundary becomes a
   * trace span. When absent, the agent path runs unchanged.
   */
  tracer?: import('../telemetry/tracer.js').PipilotTracer | null
  /** PiPilot auth mode for `pipilot.auth.mode` span attribute. */
  authMode?: import('../telemetry/semantic-registry.js').PipilotAuthMode
  /** Stable turnId minted at the IPC boundary; propagated as `pipilot.turn.id`. */
  getTurnId?: () => string | undefined
}

export async function createCoordinator(config: CoordinatorConfig): Promise<{
  agent: Agent
  chat: (
    message: string,
    mentions?: ResolvedMention[],
    images?: Array<{ base64: string; mimeType: string }>
  ) => Promise<{ success: boolean; response?: string; error?: string }>
  clearSessionMemory: () => Promise<void>
  abort: () => void
  destroy: () => Promise<void>
}> {
  const {
    apiKey,
    getApiKeyOverride,
    model: modelId,
    projectPath = process.cwd(),
    debug = false,
    sessionId = 'default',
    reasoningEffort = 'high',
    onStream,
    onToolCall,
    onToolResult,
    onToolProgress,
    onUsage,
    onSkillLoaded,
    tracer = null,
    authMode,
    getTurnId
  } = config

  /** Resolve API key — uses dynamic getter if provided (for OAuth token refresh), else static key. */
  const resolveApiKey = getApiKeyOverride ?? (async () => apiKey)

  let turnCount = 0
  let activeTurnToolCallCount: number | null = null
  const turnHistory: Array<{ userMessage: string; response: string; toolCallCount: number; timestamp: string }> = []
  const telemetryAdapter = createCoordinatorTelemetryAdapter({ tracer, getTurnId, debug })

  const migration = migrateLegacyArtifacts(projectPath)
  if (debug && migration.updatedFiles > 0) {
    console.log(`[Coordinator] migrated legacy artifacts: files=${migration.updatedFiles}, literature->paper=${migration.convertedLiteratureType}, data.name removed=${migration.removedDataNameField}`)
  }

  // Resolve pi-mono model
  let piModel: Model<any> | null = null
  if (modelId) {
    const parts = modelId.split(':')
    if (parts.length === 2) {
      // Explicit provider:model format
      // Map subscription providers to their pi-ai provider name
      const piProvider = parts[0] === 'anthropic-sub' ? 'anthropic' : parts[0]
      try {
        const result = getPiModel(piProvider as any, parts[1] as any)
        if (result) piModel = result
      } catch (err) {
        if (debug) console.warn(`[Coordinator] getPiModel("${piProvider}", "${parts[1]}") failed:`, err)
      }
    } else {
      // Infer provider from bare model id, then fall through to the rest in
      // case the table is stale.
      const providerHint = inferProviderFromModelId(modelId)

      const fallbackProviders = ['anthropic', 'openai', 'google', 'deepseek']
      const providers = providerHint
        ? [providerHint, ...fallbackProviders.filter(p => p !== providerHint)]
        : fallbackProviders

      for (const provider of providers) {
        try {
          const result = getPiModel(provider as any, modelId as any)
          if (result) {
            piModel = result
            if (debug) console.log(`[Coordinator] Resolved model "${modelId}" via provider "${provider}"`)
            break
          }
        } catch {
          continue
        }
      }
    }

    if (!piModel) {
      console.warn(`[Coordinator] Could not resolve model "${modelId}" from any provider. Chat will fail.`)
    }
  } else {
    console.warn('[Coordinator] No modelId provided. Chat will fail.')
  }

  // Select a cheap model for intent routing — same provider as the main model
  // so the existing apiKey is guaranteed to work.
  let intentRouterModel: Model<any> | null = null
  {
    const routerByProvider: Record<string, string> = ROUTER_MODELS

    // Determine which provider the main model resolved to
    let mainProvider: string | null = null
    if (modelId) {
      const parts = modelId.split(':')
      if (parts.length === 2) {
        // For intent routing, map subscription providers to their base provider
        mainProvider = parts[0] === 'openai-codex' ? 'openai-codex'
          : parts[0] === 'anthropic-sub' ? 'anthropic'
          : parts[0]
      } else {
        mainProvider = inferProviderFromModelId(modelId)
      }
    }

    // Try same-provider router first, then fall back to others
    const providerOrder = mainProvider
      ? [mainProvider, ...Object.keys(routerByProvider).filter(p => p !== mainProvider)]
      : Object.keys(routerByProvider)

    for (const provider of providerOrder) {
      const routerModelId = routerByProvider[provider]
      if (!routerModelId) continue
      try {
        intentRouterModel = getPiModel(provider as any, routerModelId as any)
        if (debug) console.log(`[Coordinator] Intent router: ${provider}/${routerModelId}`)
        break
      } catch {
        continue
      }
    }
  }

  const wrappedOnToolResult = (tool: string, result: unknown, args?: unknown, toolCallId?: string) => {
    if (activeTurnToolCallCount !== null) {
      activeTurnToolCallCount++
    }
    onToolResult?.(tool, result, args, toolCallId)
  }

  // Create research-specific tools via unified factory
  const toolCtx: ResearchToolContext = {
    workspacePath: projectPath,
    sessionId,
    projectPath,
    callLlm: async (systemPrompt: string, userContent: string) => {
      if (!piModel) throw new Error('No model available for sub-call')
      const currentKey = await resolveApiKey()
      return runSubLlmText({
        model: piModel,
        systemPrompt,
        userContent,
        apiKey: currentKey,
        maxTokens: 4096,
        tracer,
        authMode,
        purpose: 'callLlm'
      })
    },
    // Vision-capable sibling of callLlm. Mirrors the stateless completeSimple
    // shape above plus the ImageContent transformation used by chat() at the
    // user-attached-images path. Reused by the diagram tool's PNG-anchored
    // SVG transcription path, where a final PNG is fed back to the model to
    // be re-emitted as editable SVG markup.
    callLlmVision: async (systemPrompt, userContent, images) => {
      if (!piModel) throw new Error('No model available for sub-call')
      if (!piModel.input.includes('image')) {
        throw new Error(
          `Selected model "${piModel.id}" does not accept image input. ` +
          `Switch to a vision-capable model (e.g. GPT-5.5, Claude Opus 4.7, Gemini 2.5).`
        )
      }
      const currentKey = await resolveApiKey()
      const content: (TextContent | ImageContent)[] = [
        { type: 'text', text: userContent },
        ...images.map((img): ImageContent => ({
          type: 'image',
          data: img.base64,
          mimeType: img.mimeType,
        })),
      ]
      // 8K output budget — SVG transcription of a moderately complex
      // diagram (20-30 nodes) typically lands around 4-6K characters.
      return runSubLlmText({
        model: piModel,
        systemPrompt,
        userContent: content,
        apiKey: currentKey,
        maxTokens: 8192,
        tracer,
        authMode,
        purpose: 'callLlmVision'
      })
    },
    visionCapable: !!piModel?.input.includes('image'),
    onToolCall,
    onToolResult: wrappedOnToolResult,
    settings: config.resolvedSettings,
    getSettings: config.getResolvedSettings,
    getDiagramAuth: config.getDiagramAuth,
    getTurnId,
    rasterizeSvg: config.rasterizeSvg,
  }
  const { tools: researchAgentTools, destroy: destroyResearchTools } = createResearchTools(toolCtx)

  // Create built-in coding tools from pi-coding-agent
  const codingTools = createCodingTools(projectPath)
  // Add code-navigation tools (grep, find, ls) not included in codingTools
  const grepTool = createGrepTool(projectPath)
  const findTool = createFindTool(projectPath)
  const lsTool = createLsTool(projectPath)

  // Load skills and filter by enabled config (with dependency resolution)
  const allSkills = loadAllSkills(projectPath)
  const enabledList = readEnabledSkills(projectPath)
  const directSelection = enabledList ?? allSkills.map(s => s.name)
  const resolved = resolveSkillDependencies(allSkills, directSelection)
  const skills = allSkills.filter(s => resolved.has(s.name))
  if (debug && skills.length > 0) {
    console.log(`[Coordinator] Loaded ${skills.length}/${allSkills.length} skills: ${skills.map(s => s.name).join(', ')}`)
  }
  const loadSkillTool = createLoadSkillTool(skills)

  // Combine all tools. pi-agent-core's AgentTool generic is invariant over its
  // schema, so a heterogeneous tool array needs the wildcard form at the
  // container boundary.
  const allTools: AgentTool<any, any>[] = [
    ...codingTools,
    grepTool,
    findTool,
    lsTool,
    ...researchAgentTools,
    loadSkillTool
  ]

  // Build the full system prompt with skills catalog
  // Environment guidance is injected asynchronously AFTER agent creation (non-blocking)
  const skillsCatalog = buildSkillsCatalogPrompt(skills)

  const baseSystemPrompt = SYSTEM_PROMPT
    + (skillsCatalog ? '\n\n' + skillsCatalog : '')

  // ── Context compaction state ──
  // Tracks the summary of compacted (discarded) messages so iterative
  // compactions can update rather than regenerate from scratch. Persisted
  // to disk per session so a process restart doesn't force a full
  // re-summarization on the next compaction event. See memory-v2/store.ts
  // for the boundary trade-off w.r.t. bootstrap orphan injection.
  const persistedCompaction = readCompactionState(projectPath, sessionId)
  let compactionSummary: string | undefined = persistedCompaction?.summary
  let compactionCount: number = persistedCompaction?.compactionCount ?? 0
  if (debug && persistedCompaction) {
    console.log(`[Compaction] Restored prior summary (count=${compactionCount}, ${compactionSummary!.length} chars) for session ${sessionId}`)
  }

  // ── Restart bootstrap ──
  // On the first chat() call after coordinator creation, recover orphan
  // user/assistant messages from the persisted JSONL (turns from a
  // previous process that were never folded into a SessionSummary) and
  // inject them as a "Recent Conversation" block. Once-only: subsequent
  // chats rely on agent.state.messages accumulating as usual.
  const sessionBootstrap = createSessionBootstrap({ projectPath, sessionId, debug })

  // Create the pi-mono Agent immediately (no blocking on env probe)
  const agent = new Agent({
    initialState: {
      systemPrompt: baseSystemPrompt,
      model: piModel ?? undefined as any,
      tools: allTools,
      thinkingLevel:
        reasoningEffort === 'max' ? 'xhigh'
        : reasoningEffort === 'high' ? 'high'
        : reasoningEffort === 'medium' ? 'medium'
        : 'low'
    },
    sessionId,
    getApiKey: resolveApiKey,

    // Wire-level capture: onPayload/onResponse are inherited from
    // pi-ai's StreamOptions on AgentLoopConfig and fire for the main
    // per-step provider call. Telemetry adapter attaches them to the
    // current `invoke_agent step` span.
    onPayload: telemetryAdapter.onPayload,
    onResponse: telemetryAdapter.onResponse,

    // ── Context compaction via transformContext ──
    // Before each LLM call, check if accumulated messages exceed the model's
    // context window.  If so, summarize old messages and keep only recent ones.
    transformContext: async (messages, signal) => {
      const contextWindow = piModel?.contextWindow ?? 128_000
      const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 30_000 }

      // Estimate total tokens from all messages
      let totalTokens = 0
      for (const msg of messages) {
        totalTokens += estimateTokens(msg)
      }

      if (!shouldCompact(totalTokens, contextWindow, settings)) {
        return messages
      }

      if (!piModel) return messages

      if (debug) {
        console.log(`[Compaction] Context ${totalTokens} tokens exceeds threshold (window=${contextWindow}, reserve=${settings.reserveTokens}). Compacting...`)
      }

      // Walk backwards to find the cut point: keep ~keepRecentTokens of recent messages
      let keptTokens = 0
      let cutIndex = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(messages[i])
        if (keptTokens + msgTokens > settings.keepRecentTokens) {
          cutIndex = i + 1
          break
        }
        keptTokens += msgTokens
        if (i === 0) cutIndex = 0
      }

      // Don't cut if there's nothing meaningful to summarize
      if (cutIndex <= 1) return messages

      // Ensure we don't cut in the middle of a tool-call / tool-result pair
      // Move cutIndex forward until we hit a user message (safe boundary)
      while (cutIndex < messages.length) {
        const msg = messages[cutIndex]
        if (msg.role === 'user') break
        cutIndex++
      }
      if (cutIndex >= messages.length) return messages

      const messagesToSummarize = messages.slice(0, cutIndex)
      const messagesToKeep = messages.slice(cutIndex)

      try {
        const currentKey = await resolveApiKey()
        // Telemetry §6.2 + §6.8: open `summarize context` span around the
        // generateSummary call, attach the discarded turnIds event payload.
        const compactionSpan = tracer
          ? tracer.startSpan('summarize context', SpanKind.INTERNAL)
          : null
        if (compactionSpan) {
          compactionSpan.setAttributes({
            'gen_ai.operation.name': 'pipilot.summarize',
            'pipilot.compaction.discarded_messages': messagesToSummarize.length,
            'pipilot.compaction.kept_tokens': keptTokens
          })
          // §6.8: turnIds are objective. AgentMessage doesn't carry our turnId,
          // so we attach the indexes; Layer 3 can join by message index → turnId
          // via the user-response-signals ledger.
          compactionSpan.addEvent('pipilot.compaction.discarded', {
            turnIds: JSON.stringify(messagesToSummarize.map((_, i) => `msg-idx-${i}`))
          })
        }
        let summary: string
        try {
          summary = await generateSummary(
            messagesToSummarize,
            piModel,
            settings.reserveTokens,
            currentKey,
            undefined,
            signal,
            undefined,
            compactionSummary
          )
        } finally {
          compactionSpan?.end()
        }
        compactionSummary = summary
        compactionCount += 1

        // Persist the running summary so a process restart doesn't force a
        // full re-summarization on the next compaction event. Best-effort —
        // failures must not affect the agent path.
        writeCompactionState(projectPath, {
          schemaVersion: COMPACTION_STATE_SCHEMA_VERSION,
          sessionId,
          summary,
          compactionCount,
          updatedAt: new Date().toISOString()
        })

        if (debug) {
          console.log(`[Compaction] Summarized ${messagesToSummarize.length} messages (${totalTokens - keptTokens} tokens) → kept ${messagesToKeep.length} messages (count=${compactionCount})`)
        }

        // Inject the compaction summary as a synthetic user message at the top
        const summaryMessage: import('@mariozechner/pi-agent-core').AgentMessage = {
          role: 'user' as const,
          content: `[Previous conversation summary]\n\n${summary}\n\n---\n\nThe conversation continues below.`,
          timestamp: Date.now()
        }

        return [summaryMessage, ...messagesToKeep]
      } catch (err) {
        if (debug) {
          console.warn('[Compaction] Failed, using full context:', err)
        }
        return messages
      }
    },

    beforeToolCall: async (ctx) => {
      onToolCall?.(ctx.toolCall.name, ctx.args, ctx.toolCall.id)
      if (debug) {
        console.log(`  [Tool] ${ctx.toolCall.name}(${JSON.stringify(ctx.args).slice(0, 120)}...)`)
      }
      telemetryAdapter.beforeToolCall(ctx)
      return undefined
    },
    afterToolCall: async (ctx) => {
      wrappedOnToolResult(ctx.toolCall.name, ctx.result, ctx.args, ctx.toolCall.id)
      // Notify when a skill is loaded successfully + emit telemetry event (§6.7).
      if (ctx.toolCall.name === 'load_skill' && onSkillLoaded) {
        const args = ctx.args as { name?: string }
        const result = ctx.result as any
        if (args?.name && result?.success !== false) {
          onSkillLoaded(args.name)
          telemetryAdapter.recordSkillLoadOnActiveStep(args.name, 'explicit-load')
        }
      }
      telemetryAdapter.afterToolCall(ctx)
      return undefined
    }
  })

  // Subscribe to agent events for streaming, usage, tool progress, and tracing.
  // Step-span lifecycle (turn_start / turn_end) is owned by telemetryAdapter.
  if (onStream || onUsage || onToolProgress || tracer) {
    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'message_update' && onStream) {
        if (event.assistantMessageEvent.type === 'text_delta') {
          onStream(event.assistantMessageEvent.delta)
        }
      }
      if (event.type === 'turn_end' && onUsage) {
        const msg = event.message
        if (msg && 'usage' in msg && (msg as any).usage) {
          const usage = (msg as any).usage
          onUsage(usage, usage.cost)
        }
      }
      // Tool execution progress events (real-time updates during tool execution).
      if (onToolProgress) {
        if (event.type === 'tool_execution_start') {
          onToolProgress(event.toolName, event.toolCallId, 'start', { args: event.args })
        } else if (event.type === 'tool_execution_update') {
          onToolProgress(event.toolName, event.toolCallId, 'update', { partialResult: event.partialResult })
        } else if (event.type === 'tool_execution_end') {
          onToolProgress(event.toolName, event.toolCallId, 'end', { result: event.result, isError: event.isError })
        }
      }

      telemetryAdapter.processAgentEvent(event)
    })
  }

  async function clearSessionMemory() {
    agent.reset()
    compactionSummary = undefined
    compactionCount = 0
    deleteCompactionState(projectPath, sessionId)
  }

  async function maybeGenerateSummary(): Promise<void> {
    if (turnHistory.length === 0) return

    // Trigger conditions
    const isBaselineTrigger = turnCount % 5 === 0
    const last3 = turnHistory.slice(-3)
    const toolCallSum = last3.reduce((sum, t) => sum + t.toolCallCount, 0)
    const isHeavyToolUsage = last3.length >= 3 && toolCallSum > 15
    const responseCharSum = last3.reduce((sum, t) => sum + t.response.length, 0)
    const isLotsOfContent = last3.length >= 3 && responseCharSum > 8000

    if (!isBaselineTrigger && !isHeavyToolUsage && !isLotsOfContent) return

    if (!intentRouterModel) return

    const historyText = turnHistory
      .map((t, i) => `Turn ${turnCount - turnHistory.length + i + 1}: User: ${t.userMessage}\nAssistant: ${t.response}`)
      .join('\n\n')

    try {
      const currentKey = await resolveApiKey()
      const text = (await runSubLlmText({
        model: intentRouterModel,
        systemPrompt: 'You summarize research conversations concisely. Output JSON with keys: summary (string), topicsDiscussed (string[]), openQuestions (string[]). Output ONLY valid JSON.',
        userContent: `Summarize this research assistant conversation excerpt.\n\n${historyText}`,
        apiKey: currentKey,
        maxTokens: 512,
        tracer,
        authMode,
        purpose: 'session-summary'
      })).trim()
      if (!text) return
      // Extract JSON from possible markdown code fences
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/)
      const jsonStr = jsonMatch?.[1]?.trim() ?? text
      const parsed = JSON.parse(jsonStr)

      const summary: SessionSummary = {
        sessionId,
        turnRange: [Math.max(1, turnCount - turnHistory.length + 1), turnCount],
        summary: parsed.summary || '',
        topicsDiscussed: parsed.topicsDiscussed ?? [],
        openQuestions: parsed.openQuestions ?? [],
        createdAt: new Date().toISOString()
      }

      writeSessionSummary(projectPath, summary)

      if (debug) {
        console.log(`[Summary] Generated session summary at turn ${turnCount}: ${(parsed.summary || '').slice(0, 80)}...`)
      }
    } catch (err) {
      if (debug) {
        console.warn('[Summary] Failed to generate session summary:', err)
      }
    }
  }

  // Fire-and-forget: probe environment and update system prompt asynchronously.
  // Gated behind ENABLE_LOCAL_COMPUTE — no env guidance when compute is disabled.
  if (process.env.ENABLE_LOCAL_COMPUTE === '1') {
    probeStaticProfile()
      .then(profile => {
        const envGuidance = generateAgentGuidance(profile)
        agent.state.systemPrompt = baseSystemPrompt + '\n\n' + envGuidance
      })
      .catch(() => { /* non-fatal */ })
  }

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[], images?: Array<{ base64: string; mimeType: string }>) {
      // Telemetry §6.2: wrap the entire chat() body in an `invoke_agent {model}`
      // root span. Sub-LLM, tool, compaction, and step spans nest under it via
      // AsyncLocalStorage. Span ends when chat() returns; digest writer keys on
      // root-span end (§5.5).
      let rootSpan: Span | null = null

      const runChatBody = async () => {
        try {
        // --- Intent detection (rule-based only, for explain snapshots) ---
        const intents = detectIntentsByRules(message)

        // --- LLM-based skill matching (replaces intent-driven prompt modules) ---
        // Pass the last 2 turns so short follow-ups ("yes, do that") can be routed
        // using recent context. turnHistory entries are already truncated to ~300
        // chars per side, so token cost stays small.
        const priorTurns = turnHistory.slice(-2).map(t => ({
          userMessage: t.userMessage,
          response: t.response
        }))
        const currentKey = await resolveApiKey()
        const matchedSkillNames = await matchSkillsWithLLM(intentRouterModel, currentKey, message, skills, priorTurns, tracer, authMode)
        if (rootSpan && matchedSkillNames.length > 0) {
          rootSpan.setAttribute('pipilot.matched_skills', matchedSkillNames)
        }
        const matchedSkills = matchedSkillNames
          .map(name => skills.find(s => s.name === name))
          .filter((s): s is SkillEntry => s !== undefined)

        // Notify UI about pre-matched skills + emit telemetry events (§6.7).
        // Router-match fires before any step span exists, so the events live
        // on the root invoke_agent span. Layer 3 can join with `matched_skills`
        // on the root attr if it needs the bulk list.
        for (const s of matchedSkills) {
          onSkillLoaded?.(s.name)
          if (rootSpan) {
            rootSpan.addEvent('pipilot.skill.load', {
              skillName: s.name,
              trigger: 'router-match'
            })
          }
        }

        const skillSummariesPrompt = buildSkillSummariesPrompt(matchedSkills)

        // Read agent.md and prepend to additionalInstructions
        const agentMdRecord = findArtifactById(projectPath, AGENT_MD_ID)
        const agentMdContent = agentMdRecord?.artifact?.type === 'note'
          ? (agentMdRecord.artifact as NoteArtifact).content
          : ''

        // Build context pieces
        const mentionContext = buildMentionContext(mentions)
        const latestSummary = readLatestSessionSummary(projectPath, sessionId)
        const summaryContext = latestSummary ? buildSessionSummaryContext(latestSummary) : ''

        // Restart bootstrap (once-only on first chat after restart).
        const { context: bootstrapContext, orphanCount: bootstrapOrphans } =
          sessionBootstrap.consume(latestSummary)
        // Telemetry §6.4: stamp resumption booleans on the root span. Cheap
        // booleans set once at first step. Layer 3 can compute fancier
        // resumption indicators from the raw trace if needed.
        if (rootSpan) {
          rootSpan.setAttribute('pipilot.resumption.bootstrap_orphans', bootstrapOrphans > 0)
          rootSpan.setAttribute('pipilot.resumption.summary_loaded', !!latestSummary)
        }

        const persistence = classifyPersistenceDecision(message)

        const explain: TurnExplainSnapshot = {
          timestamp: new Date().toISOString(),
          sessionId,
          intents: Array.from(intents),
          matchedSkills: matchedSkillNames,
          selectedContext: {
            mentionSelections: mentions?.filter(m => !m.error).length ?? 0,
            approxTokens: 0
          },
          persistence: {
            decision: persistence.decision,
            reason: persistence.reason
          },
          sessionSummary: {
            included: !!latestSummary,
            turnRange: latestSummary?.turnRange,
            approxTokens: 0
          },
          budget: {
            model: modelId ?? 'default'
          }
        }

        if (debug) {
          const intentList = Array.from(intents).join(', ') || 'none'
          const skillList = matchedSkillNames.join(', ') || 'none'
          console.log(`[Chat] Intents: ${intentList}`)
          console.log(`[Chat] Matched skills: ${skillList}`)
          console.log(`[Chat] Sending message to agent (${mentions?.filter(m => !m.error).length ?? 0} mentions, summary=${!!latestSummary})...`)
        }

        // Build the enriched system prompt with context.
        // Only agent.md is injected here (changes rarely — only on user edit).
        // Skill summaries are injected into the user message instead, to keep
        // the system prompt stable across turns for better prompt cache hits
        // on all providers (Anthropic explicit cache, OpenAI APC, Google).
        let enrichedSystem = baseSystemPrompt
        if (agentMdContent) {
          enrichedSystem = `${enrichedSystem}\n\n## User Instructions (agent.md)\n\n${agentMdContent}`
        }
        agent.state.systemPrompt = enrichedSystem

        // Build the user message with injected context.
        // Order: session summary → recent conversation (bootstrap) → skill summaries → mentions → user message
        const contextParts: string[] = []
        if (summaryContext) contextParts.push(summaryContext)
        if (bootstrapContext) contextParts.push(bootstrapContext)
        if (skillSummariesPrompt) contextParts.push(skillSummariesPrompt)
        if (mentionContext) contextParts.push(mentionContext)
        let userMessage = contextParts.length > 0
          ? `${contextParts.join('\n\n')}\n\n---\n\n${message}`
          : message

        // Count tool calls for this turn
        let perTurnToolCallCount = 0
        activeTurnToolCallCount = 0

        try {
          const imageContents = images?.map(img => ({
            type: 'image' as const,
            data: img.base64,
            mimeType: img.mimeType
          }))
          await agent.prompt(userMessage, imageContents?.length ? imageContents : undefined)
          perTurnToolCallCount = activeTurnToolCallCount ?? 0
        } finally {
          activeTurnToolCallCount = null
        }

        // Extract the response text and images from agent messages
        const messages = agent.state.messages
        const lastMsg = messages[messages.length - 1]
        let responseText = ''
        const responseImages: Array<{ base64: string; mimeType: string }> = []
        if (lastMsg && 'content' in lastMsg && Array.isArray(lastMsg.content)) {
          for (const block of lastMsg.content) {
            if ('type' in block && block.type === 'text' && 'text' in block) {
              responseText += (block as TextContent).text
            } else if ('type' in block && block.type === 'image' && 'data' in block) {
              const imgBlock = block as { type: 'image'; data: string; mimeType: string }
              responseImages.push({ base64: imgBlock.data, mimeType: imgBlock.mimeType })
            }
          }
        }

        // Extract usage if available
        if (lastMsg && 'usage' in lastMsg) {
          const usage = (lastMsg as any).usage
          if (usage) {
            explain.budget.promptTokens = usage.input
            explain.budget.completionTokens = usage.output
            explain.budget.totalTokens = usage.totalTokens
          }
        }

        writeExplainSnapshot(projectPath, explain)

        // Surface server-side / auth errors that pi-agent-core packs into the
        // assistant message rather than throwing. Without this, an errored
        // turn returns success=true with an empty response, and the renderer
        // shows "No response" with no actionable info.
        const stopReason = (lastMsg && 'stopReason' in lastMsg)
          ? ((lastMsg as any).stopReason as string | undefined)
          : undefined
        const errorMessage = (lastMsg && 'errorMessage' in lastMsg)
          ? ((lastMsg as any).errorMessage as string | undefined)
          : undefined

        if (stopReason === 'aborted') {
          return { success: false, error: 'Generation stopped by user.' }
        }

        if (stopReason === 'error') {
          return {
            success: false,
            error: errorMessage
              || 'The LLM request failed. This usually indicates an issue on the model server or with authentication. If you are using a Claude or ChatGPT subscription, try signing out and back in via Settings. Otherwise verify your API key, model selection, and network connection.'
          }
        }

        // Defensive: empty content with a normal stop reason — should not
        // normally happen, but if it does, surface a generic hint instead of
        // letting the renderer fall through to "No response".
        if (!responseText && responseImages.length === 0) {
          return {
            success: false,
            error: `The model returned an empty response (stopReason=${stopReason ?? 'unknown'}). This usually indicates a transient issue with the LLM server. Please try again. If the problem persists and you are using a Claude or ChatGPT subscription, try signing out and back in via Settings.`
          }
        }

        // Update turn history and count
        turnCount++
        turnHistory.push({
          userMessage: message.slice(0, 300),
          response: responseText.slice(0, 300),
          toolCallCount: perTurnToolCallCount,
          timestamp: new Date().toISOString()
        })
        if (turnHistory.length > 8) turnHistory.shift()

        // Smart summary trigger
        void maybeGenerateSummary()

        // Background memory extraction (gated by RESEARCH_COPILOT_AUTO_EXTRACT=1)
        const memoryKey = await resolveApiKey()
        void maybeExtractMemories(
          { projectPath, model: piModel!, apiKey: memoryKey, systemPrompt: enrichedSystem, debug, tracer, authMode },
          agent.state.messages,
          turnCount
        )

        if (debug) {
          console.log(`[Chat] Result: success=true, hasOutput=${!!responseText}, turn=${turnCount}`)
        }

        return {
          success: true,
          response: responseText,
          ...(responseImages.length > 0 && { images: responseImages })
        }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          if (debug) {
            console.log(`[Chat] Exception: ${errorMsg}`)
          }
          return { success: false, error: errorMsg }
        }
      }

      if (!tracer) return runChatBody()

      // Stamp root-span identity attrs (§5.4 + §6.2). Resource attributes carry
      // process/build identity only — per-task identity goes here.
      const fullPromptHash = piModel ? createHash('sha256').update(piModel.id).digest('hex').slice(0, 16) : 'unknown'
      const rootName = `invoke_agent ${piModel?.id ?? 'agent'}`
      return tracer.runInSpan(rootName, SpanKind.INTERNAL, async (span) => {
        rootSpan = span
        span.setAttribute('gen_ai.operation.name', 'invoke_agent')
        if (piModel) span.setAttribute('gen_ai.request.model', piModel.id)
        span.setAttribute('pipilot.runtime.full_prompt_hash', `sha256:${fullPromptHash}`)
        const tid = getTurnId?.()
        if (tid) span.setAttribute('pipilot.turn.id', tid)
        return runChatBody()
      })
    },

    clearSessionMemory,

    /** Stop the current LLM turn without tearing down tools. */
    abort() {
      agent.abort()
    },

    async destroy() {
      agent.abort()
      await destroyResearchTools()
    }
  }
}

export { createCoordinator as createCoordinatorRunner }
