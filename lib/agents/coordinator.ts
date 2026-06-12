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
import type { AgentTool, AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
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
import { runAgentTurnWithRetry, isTransientLlmError } from './transient-retry.js'
import { isUsageLimitError, humanizeLlmError } from './llm-error-humanizer.js'
import { createCoordinatorTelemetryAdapter } from './telemetry-adapter.js'
import { loadPrompt } from './prompts/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { PATHS, AGENT_MD_ID, type SessionSummary, type NoteArtifact } from '../types.js'
import { ROUTER_MODELS, inferProviderFromModelId, getSyntheticPiModel } from '../models.js'
import { resolveSubTaskModel } from './sub-task-tier.js'
import { AwsCredentialProvider } from '../aws/credentials.js'
import { buildSharingPromptClause } from '../sharing/index.js'
import { runSubLlmText } from '../telemetry/sub-llm.js'
import { TURN_ID_KEY } from '../telemetry/context-keys.js'
import type { PipilotTracer } from '../telemetry/tracer.js'
import type { PipilotAuthMode } from '../telemetry/semantic-registry.js'
import { context, SpanKind, type Span, type Attributes } from '@opentelemetry/api'
import { redact } from '../telemetry/redaction.js'
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
const REASONING_COMPACTION_RESERVE_TOKENS = 48_000
const REASONING_KEEP_RECENT_TOKENS = 20_000
const NON_REASONING_KEEP_RECENT_TOKENS = 30_000

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

function estimateCharsAsTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function estimateFixedRequestTokens(systemPrompt: string | undefined, tools: AgentTool<any, any>[] | undefined): number {
  let chars = systemPrompt?.length ?? 0

  if (tools?.length) {
    try {
      const responseTools = tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: null
      }))
      chars += JSON.stringify(responseTools).length
    } catch {
      // Fall back to names/descriptions if a tool schema is unexpectedly not serializable.
      chars += tools.reduce((sum, tool) => sum + tool.name.length + tool.description.length, 0)
    }
  }

  return estimateCharsAsTokens(chars)
}

function estimateCompactionMessageTokens(message: AgentMessage): number {
  let tokens = estimateTokens(message)
  if ((message as { role?: string }).role !== 'assistant') return tokens

  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return tokens

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typedBlock = block as {
      type?: string
      thinkingSignature?: string
      thoughtSignature?: string
      textSignature?: string
    }
    if (typedBlock.type === 'thinking' && typeof typedBlock.thinkingSignature === 'string') {
      tokens += estimateCharsAsTokens(typedBlock.thinkingSignature.length)
    } else if (typedBlock.type === 'toolCall' && typeof typedBlock.thoughtSignature === 'string') {
      tokens += estimateCharsAsTokens(typedBlock.thoughtSignature.length)
    } else if (typedBlock.type === 'text' && typeof typedBlock.textSignature === 'string') {
      tokens += estimateCharsAsTokens(typedBlock.textSignature.length)
    }
  }

  return tokens
}

function createCompactionSettings(model: Model<any> | null, thinkingLevel: string | undefined) {
  const isReasoningRun = !!model?.reasoning && thinkingLevel !== 'off'
  return {
    ...DEFAULT_COMPACTION_SETTINGS,
    reserveTokens: isReasoningRun
      ? Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, REASONING_COMPACTION_RESERVE_TOKENS)
      : DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: isReasoningRun
      ? REASONING_KEEP_RECENT_TOKENS
      : NON_REASONING_KEEP_RECENT_TOKENS
  }
}

async function matchSkillsWithLLM(
  model: Model<any> | null,
  apiKey: string,
  message: string,
  skills: SkillEntry[],
  priorTurns: Array<{ userMessage: string; response: string }> = [],
  tracer: PipilotTracer | null = null,
  authMode?: PipilotAuthMode,
  onUsage?: (usage: unknown, cost: unknown) => void
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
      purpose: 'router',
      ...(onUsage && { onUsage: onUsage as (usage: any, cost: any) => void })
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

function normalizeCompactionCutIndex(messages: AgentMessage[], cutIndex: number): number {
  if (cutIndex <= 0 || cutIndex >= messages.length) return cutIndex

  // A tool result is only valid when its corresponding assistant tool-call
  // message is still in context. If the budget lands inside a tool-result
  // batch, keep the assistant tool-call message too.
  while (cutIndex > 0 && messages[cutIndex]?.role === 'toolResult') {
    cutIndex--
  }

  return cutIndex
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
   * Compute backend configuration. When provided, the coordinator builds
   * a ComputeRegistry, registers LocalBackend + ModalBackend with the
   * relevant credentials/threshold accessors, and exposes the registry
   * on its return value so the main process can subscribe to events +
   * handle hydrate/approve/reject IPC.
   *
   * Replaces PR #62's modalCredentials / onModalCostKilled / onModalRunUpdate
   * / createSubAgent leakage onto CoordinatorConfig (RFC-008 §7.4).
   */
  compute?: {
    /** Live accessor for Modal credentials sourced from Settings → API Keys. */
    getModalCredentials?: () => { tokenId?: string; tokenSecret?: string }
    /**
     * Live accessor for compute settings: cost threshold per backend
     * (today only modal honors it) and the global force-approval
     * override.
     */
    getComputeSettings?: () => { modalCostThresholdUsd: number; forceApprovalForAll: boolean }
    /**
     * Live accessor for AWS credential settings (RFC-009 §3.1). Returns
     * what the user typed into Settings → Compute → AWS. Sensitive fields
     * (accessKeyId / secretAccessKey) typically flow through process.env
     * via the existing saveApiKey IPC path; settings here only need to
     * include the non-sensitive bits (region, profile) — the credential
     * provider's env-fallback picks up the rest.
     *
     * When this accessor is absent, AWS support is OFF: no AWS backends
     * are registered and S3 tools are not exposed.
     */
    getAwsSettings?: () => import('../aws/credentials.js').SettingsCredentialInput
    /** Per-backend EC2 cost-kill threshold in USD. Reads compute.backends.aws-ec2.costThresholdUsd. */
    getAwsEc2CostThresholdUsd?: () => number
    /**
     * Subscribe to ComputeEvents. When provided, the coordinator wires
     * this callback immediately after constructing the registry — BEFORE
     * any backends are registered. Backends register synchronously but
     * fire their initial `availability-changed` probe through a promise
     * chain; backends whose probe has no internal await (e.g. Modal,
     * which uses execSync) resolve on the very next microtask. If the
     * subscriber isn't in place by then, the event is dropped and the
     * renderer never learns the backend exists until a manual refresh.
     */
    onEvent?: (event: import('../compute/events.js').ComputeEvent) => void
  }
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
   * Fired when a transient LLM failure (e.g. 529 overloaded) triggers a
   * backoff retry, so the UI can show a "retrying…" notice instead of a
   * silent pause. See lib/agents/transient-retry.ts.
   */
  onRetryNotice?: (info: { attempt: number; nextDelayMs: number; error: string }) => void
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
  /**
   * Generate a "welcome back" recap of the current conversation. Runs on the
   * SAME model as the main turn and replays the SAME system prompt +
   * conversation (just appending a recap instruction), so the prompt cache the
   * last turn wrote is hit at 0.1x — only the appended instruction is uncached.
   * Returns null when there's nothing to recap or the call fails. Best-effort:
   * never throws. See lib/types.ts `RecapRecord`.
   */
  generateRecap: (signal?: AbortSignal) => Promise<{ did: string; next: string } | null>
  abort: () => void
  destroy: () => Promise<void>
  /**
   * Compute backend registry — present when CoordinatorConfig.compute
   * was provided. The main process uses this to: (a) subscribe to
   * ComputeEvents and fan them to the renderer via the single
   * `compute:event` IPC channel, (b) serve `compute:hydrate`,
   * `compute:approve-plan`, `compute:reject-plan`.
   */
  computeRegistry?: import('../compute/registry.js').ComputeRegistry
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
    onRetryNotice,
    tracer = null,
    authMode,
    getTurnId
  } = config

  /** Resolve API key — uses dynamic getter if provided (for OAuth token refresh), else static key. */
  const resolveApiKey = getApiKeyOverride ?? (async () => apiKey)

  let turnCount = 0
  let activeTurnToolCallCount: number | null = null
  // Set by abort() so the transient-retry backoff can be interrupted —
  // agent.abort() only cancels an in-flight run, not a wait between
  // retries. Reset at the start of each turn.
  let turnAborted = false
  const turnHistory: Array<{ userMessage: string; response: string; toolCallCount: number; timestamp: string }> = []
  // The thinking-level accessor reads agent.state.thinkingLevel at span-open
  // time, so mid-session UI changes land on the next span.
  const telemetryAdapter = createCoordinatorTelemetryAdapter({
    tracer,
    getTurnId,
    getThinkingLevel: () => agent.state.thinkingLevel as string | undefined,
    debug
  })

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
        // `?? getSyntheticPiModel` covers Anthropic ids pi-ai doesn't ship yet
        // (claude-opus-4-8, claude-fable-5). See lib/models.ts.
        const result = getPiModel(piProvider as any, parts[1] as any) ?? getSyntheticPiModel(parts[1])
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
            ?? (provider === 'anthropic' ? getSyntheticPiModel(modelId) : null)
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
    callLlm: async (systemPrompt: string, userContent: string, opts) => {
      if (!piModel) throw new Error('No model available for sub-call')
      const currentKey = await resolveApiKey()
      // B-class sub-task sinking: a `tier: 'light'` opt-in runs on the cheap
      // router model when Settings permits (default), else stays on piModel.
      // Read the setting live so the toggle takes effect without a coordinator
      // rebuild. intentRouterModel is selected same-provider as piModel, so the
      // resolveApiKey() key is valid for whichever model we pick.
      const subSetting = (config.getResolvedSettings?.() ?? config.resolvedSettings)?.subTaskModelTier ?? 'light'
      const model = resolveSubTaskModel(opts?.tier, {
        mainModel: piModel,
        lightModel: intentRouterModel,
        setting: subSetting,
      })
      return runSubLlmText({
        model,
        systemPrompt,
        userContent,
        apiKey: currentKey,
        maxTokens: 4096,
        tracer,
        authMode,
        purpose: opts?.purpose ?? 'callLlm',
        ...(onUsage && { onUsage: onUsage as (usage: any, cost: any) => void })
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
        purpose: 'callLlmVision',
        ...(onUsage && { onUsage: onUsage as (usage: any, cost: any) => void })
      })
    },
    visionCapable: !!piModel?.input.includes('image'),
    onToolCall,
    onToolResult: wrappedOnToolResult,
    settings: config.resolvedSettings,
    getSettings: config.getResolvedSettings,
    getDiagramAuth: config.getDiagramAuth,
    getTurnId,
    // Compute registry — see `computeRegistry` construction below;
    // assigned in-place after we've built it so backends + tools share
    // the same instance.
    computeRegistry: undefined as undefined | import('../compute/registry.js').ComputeRegistry,
    awsCredentialProvider: undefined as undefined | import('../aws/credentials.js').AwsCredentialProvider,
    rasterizeSvg: config.rasterizeSvg,
  }

  // ── Compute backend wiring (RFC-008 §7.4–§7.5) ──────────────────────
  // Built here so the registry can close over piModel (for sub-agents)
  // and the coordinator's apiKey resolution. Backends register into it
  // immediately so createResearchTools sees them when emitting tools.
  let computeRegistry: import('../compute/registry.js').ComputeRegistry | undefined = undefined
  if (config.compute) {
    const { ComputeRegistry } = await import('../compute/registry.js')
    const { LocalBackend } = await import('../compute/backends/local/local-backend.js')
    const { ModalBackend } = await import('../compute/backends/modal/modal-backend.js')
    const getCompute = config.compute.getComputeSettings ?? (() => ({ modalCostThresholdUsd: 5, forceApprovalForAll: false }))
    const getModalCreds = config.compute.getModalCredentials ?? (() => ({}))

    computeRegistry = new ComputeRegistry({
      projectPath,
      // Live getter so settings changes take effect on the next plan()
      // without requiring a coordinator rebuild.
      forceApproval: () => getCompute().forceApprovalForAll,
    })

    // CRITICAL: subscribe BEFORE registering any backends. Backend
    // register() fires an initial probe via `probeWithTimeout(...).then(emit)`;
    // backends whose probeAvailability has no internal await (Modal's
    // execSync path) resolve on the very next microtask. The `await
    // import(...)` calls below (for AwsCredentialProvider / AwsEc2Backend)
    // are the microtask boundaries where those probes fire — if the
    // subscriber isn't wired here, those backends' availability-changed
    // events vanish into an empty subscribers set and never reach the
    // renderer. (Symptom: Modal silently absent from the Compute tab.)
    if (config.compute.onEvent) {
      computeRegistry.subscribe(config.compute.onEvent)
    }

    // ComputeContext factory — closes over piModel/resolveApiKey so
    // backend.createSubAgent doesn't reach back into the coordinator.
    function makeContext(opts: { getCredentials: () => Record<string, string | undefined>; getCostThresholdUsd: () => number }) {
      return {
        projectPath,
        workspacePath: projectPath,
        getCredentials: opts.getCredentials,
        getCostThresholdUsd: opts.getCostThresholdUsd,
        emit: (event: import('../compute/events.js').ComputeEvent) => {
          computeRegistry?.emit(event)
        },
        createSubAgent: piModel
          ? (subOpts: { systemPrompt: string; tools: AgentTool[]; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }) => new Agent({
              initialState: {
                systemPrompt: subOpts.systemPrompt,
                model: piModel ?? undefined as any,
                tools: subOpts.tools,
                thinkingLevel: subOpts.thinkingLevel ?? 'low',
              },
              getApiKey: resolveApiKey,
            })
          : undefined,
      }
    }

    const localCtx = makeContext({ getCredentials: () => ({}), getCostThresholdUsd: () => 0 })
    computeRegistry.register(new LocalBackend(localCtx))

    const modalCtx = makeContext({
      getCredentials: () => getModalCreds(),
      getCostThresholdUsd: () => getCompute().modalCostThresholdUsd,
    })
    computeRegistry.register(new ModalBackend(modalCtx))

    // RFC-009 §3.1: shared AWS credentials provider. Built once, shared by
    // the EC2 backend (Layer A) and the S3 tool factory (Layer C). When
    // getAwsSettings is undefined, AWS support is off and no provider is
    // exposed — createResearchTools skips registering S3 tools, and the
    // EC2 backend block below is also skipped.
    if (config.compute.getAwsSettings) {
      const awsProvider = new AwsCredentialProvider({
        getSettings: config.compute.getAwsSettings,
      })
      toolCtx.awsCredentialProvider = awsProvider

      const { AwsEc2Backend } = await import('../compute/backends/aws-ec2/aws-ec2-backend.js')
      const awsCtx = makeContext({
        getCredentials: () => ({}),
        getCostThresholdUsd: () => config.compute?.getAwsEc2CostThresholdUsd?.() ?? 5,
      })
      computeRegistry.register(new AwsEc2Backend(awsCtx, awsProvider))
    }

    // Optional diagnostic backend — off by default. See
    // lib/compute/backends/stub/stub-backend.ts for what it does
    // (in-memory simulator; reference impl for RFC §19).
    if (process.env.ENABLE_COMPUTE_STUB === '1') {
      const { StubBackend } = await import('../compute/backends/stub/stub-backend.js')
      const stubCtx = makeContext({ getCredentials: () => ({}), getCostThresholdUsd: () => 0 })
      computeRegistry.register(new StubBackend(stubCtx))
    }
  }
  toolCtx.computeRegistry = computeRegistry
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

  // RFC-013 §9: soft per-actor file-placement steer — only present when the
  // project is shared (empty string otherwise, so solo behavior is unchanged).
  const sharingClause = buildSharingPromptClause(projectPath)

  const baseSystemPrompt = SYSTEM_PROMPT
    + (skillsCatalog ? '\n\n' + skillsCatalog : '')
    + (sharingClause ? '\n\n' + sharingClause : '')

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
      const settings = createCompactionSettings(piModel, agent.state.thinkingLevel)

      // Estimate the request body that goes to the provider: messages plus
      // fixed overhead that is resent on every step.
      let messageTokens = 0
      for (const msg of messages) {
        messageTokens += estimateCompactionMessageTokens(msg)
      }
      const fixedOverheadTokens = estimateFixedRequestTokens(agent.state.systemPrompt, agent.state.tools)
      const totalTokens = fixedOverheadTokens + messageTokens

      if (!shouldCompact(totalTokens, contextWindow, settings)) {
        return messages
      }

      if (!piModel) return messages

      if (debug) {
        console.log(`[Compaction] Context ${totalTokens} tokens exceeds threshold (messages=${messageTokens}, overhead=${fixedOverheadTokens}, window=${contextWindow}, reserve=${settings.reserveTokens}). Compacting...`)
      }

      // Walk backwards to find the cut point: keep ~keepRecentTokens of recent messages
      let keptTokens = 0
      let cutIndex = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = estimateCompactionMessageTokens(messages[i])
        if (keptTokens + msgTokens > settings.keepRecentTokens) {
          cutIndex = i + 1
          break
        }
        keptTokens += msgTokens
        if (i === 0) cutIndex = 0
      }

      // Don't cut if there's nothing meaningful to summarize
      if (cutIndex <= 1) return messages

      // Ensure we don't cut in the middle of a tool-call / tool-result pair.
      // Allow splitting an in-progress turn: the synthetic summary preserves
      // the dropped prefix, while the kept suffix starts at a protocol-safe
      // user/assistant boundary.
      if (cutIndex >= messages.length && messages.length > 1) {
        cutIndex = messages.length - 1
      }
      cutIndex = normalizeCompactionCutIndex(messages, cutIndex)
      if (cutIndex <= 1 || cutIndex >= messages.length) return messages

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
            'pipilot.compaction.kept_tokens': keptTokens,
            'pipilot.compaction.fixed_overhead_tokens': fixedOverheadTokens
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
          // §6.9 extension: attach the running summary text on the
          // compaction span so per-event provenance is self-contained.
          // Without this the summary text was only recoverable via the
          // next turn's request_payload (where it lands as a synthetic
          // user message) or the latest-state file (lossy across history).
          if (compactionSpan && tracer) {
            try {
              const { value: redactedSummary } = redact(summary, {
                sizeCapBytes: 4096,
                blobStore: tracer.blobs
              })
              compactionSpan.addEvent('pipilot.compaction.summary_text', {
                body: JSON.stringify(redactedSummary)
              } as Attributes)
            } catch {
              // Telemetry must never affect the agent path.
            }
          }
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
          console.log(`[Compaction] Summarized ${messagesToSummarize.length} messages (${messageTokens - keptTokens} message tokens) → kept ${messagesToKeep.length} messages (count=${compactionCount})`)
        }

        // Inject the compaction summary as a synthetic user message at the top
        const summaryMessage: AgentMessage = {
          role: 'user' as const,
          content: `[Previous conversation summary]\n\n${summary}\n\n---\n\nThe conversation continues below.`,
          timestamp: Date.now()
        }

        const compactedMessages = [summaryMessage, ...messagesToKeep]

        // transformContext is called at the request boundary. Mutating the
        // active loop context keeps later tool steps in the same run from
        // resending the full pre-compaction transcript.
        messages.splice(0, messages.length, ...compactedMessages)

        return compactedMessages
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
        purpose: 'session-summary',
        ...(onUsage && { onUsage: onUsage as (usage: any, cost: any) => void })
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
  // Compute is a default feature now; env guidance is always emitted.
  probeStaticProfile()
    .then(profile => {
      const envGuidance = generateAgentGuidance(profile)
      agent.state.systemPrompt = baseSystemPrompt + '\n\n' + envGuidance
    })
    .catch(() => { /* non-fatal */ })

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
        const matchedSkillNames = await matchSkillsWithLLM(intentRouterModel, currentKey, message, skills, priorTurns, tracer, authMode, onUsage)
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
        turnAborted = false

        try {
          const imageContents = images?.map(img => ({
            type: 'image' as const,
            data: img.base64,
            mimeType: img.mimeType
          }))
          // Retry transient LLM failures (e.g. 529 overloaded) with
          // backoff instead of letting a single API hiccup kill a
          // long-running turn. See lib/agents/transient-retry.ts.
          await runAgentTurnWithRetry(agent, userMessage, imageContents, {
            isAborted: () => turnAborted,
            // A Claude *subscription* usage cap is not worth retrying — it
            // resets on a rolling window, not in seconds. Without this, the
            // raw "429 … rate_limit_error" string matches isTransientLlmError
            // and the turn silently retries 5× (looking stuck at "thinking")
            // before surfacing anything. Surface it immediately instead.
            isTransient: (msg) =>
              isTransientLlmError(msg) &&
              !(authMode === 'anthropic-subscription' && isUsageLimitError(msg)),
            onRetry: ({ attempt, nextDelayMs, error }) => {
              if (debug) {
                console.log(`[Chat] Transient LLM error (attempt ${attempt}); retrying in ${Math.round(nextDelayMs / 1000)}s — ${error.slice(0, 200)}`)
              }
              onRetryNotice?.({ attempt, nextDelayMs, error: error.slice(0, 200) })
            }
          })
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
          // Rewrite a Claude-subscription usage cap into an actionable message
          // (mirrors how the Codex provider humanizes ChatGPT limits). Returns
          // null for every other error, so the raw message is preserved.
          const humanized = humanizeLlmError(errorMessage, { authMode })
          return {
            success: false,
            error: humanized
              || errorMessage
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
          { projectPath, model: piModel!, apiKey: memoryKey, systemPrompt: enrichedSystem, debug, tracer, authMode, onUsage },
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
        // Capture thinking level on the root span so the per-turn config is
        // visible alongside model + token usage. Step spans pick it up via
        // the adapter's getThinkingLevel accessor.
        const tl = agent.state.thinkingLevel
        if (tl) span.setAttribute('pipilot.thinking_level', tl)
        // Reset the per-user-turn step counter so request_payload is
        // recorded only on step 1 of this turn (v0.12 wire-payload
        // reduction policy — see telemetry-adapter.ts).
        telemetryAdapter.markUserTurnStart()
        try {
          // Phase T: publish the turn id on the active OTel context for the
          // whole turn body. Child spans (skill router, tool calls, sub-LLM,
          // compaction) inherit pipilot.turn.id via startSpan, and the memory/
          // artifact ledgers read it as a fallback — no per-span/per-caller
          // hand-off. The root span itself already carries it (set above).
          if (!tid) return await runChatBody()
          return await context.with(context.active().setValue(TURN_ID_KEY, tid), runChatBody)
        } finally {
          telemetryAdapter.markUserTurnEnd()
        }
      })
    },

    clearSessionMemory,

    async generateRecap(signal?: AbortSignal) {
      if (!piModel) return null
      const history = agent.state.messages
      if (!history || history.length === 0) return null
      if (signal?.aborted) return null
      try {
        const currentKey = await resolveApiKey()
        // Append the recap instruction as a fresh user message onto a COPY of
        // the live context. We must not mutate agent.state.messages — the next
        // real turn continues from it. Reusing agent.state.systemPrompt and the
        // existing messages verbatim is what lets the warm cache (written by the
        // turn that just finished, on this same piModel) be hit at 0.1x.
        const recapMessages = [
          ...history,
          { role: 'user' as const, content: loadPrompt('recap-instruction'), timestamp: Date.now() }
        ]
        const invokeRecap = (): Promise<string> => runSubLlmText({
          model: piModel,
          systemPrompt: agent.state.systemPrompt,
          // AgentMessage[] → pi-ai Message[]; runSubLlmText documents this cast.
          messages: recapMessages as Parameters<typeof runSubLlmText>[0]['messages'],
          apiKey: currentKey,
          maxTokens: 220,
          tracer,
          authMode,
          purpose: 'recap',
          ...(signal && { signal }),
          ...(onUsage && { onUsage: onUsage as (usage: any, cost: any) => void })
        })
        // Phase T: recap runs after the turn's root span has closed (renderer-
        // triggered, separate trace). Tag its span with the turn it recaps so
        // it isn't a turn-less orphan. getTurnId() still points at the last
        // turn here. Background detach (extractor/wiki-bg) doesn't apply — recap
        // belongs to its turn.
        const recapTurnId = getTurnId?.()
        const text = (recapTurnId
          ? await context.with(context.active().setValue(TURN_ID_KEY, recapTurnId), invokeRecap)
          : await invokeRecap()
        ).trim()
        if (!text || signal?.aborted) return null

        // Extract JSON from possible markdown code fences (router/summary pattern).
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/)
        const jsonStr = jsonMatch?.[1]?.trim() ?? text
        const parsed = JSON.parse(jsonStr)
        const did = typeof parsed.did === 'string' ? parsed.did.trim() : ''
        const next = typeof parsed.next === 'string' ? parsed.next.trim() : ''
        if (!did && !next) return null
        return { did, next }
      } catch (err) {
        if (debug) console.warn('[Recap] generation failed:', err)
        return null
      }
    },

    /** Stop the current LLM turn without tearing down tools. */
    abort() {
      turnAborted = true
      agent.abort()
    },

    async destroy() {
      agent.abort()
      await destroyResearchTools()
      if (computeRegistry) await computeRegistry.destroy()
    },

    computeRegistry,
  }
}

export { createCoordinator as createCoordinatorRunner }
