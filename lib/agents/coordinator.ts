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
import { getModel as getPiModel, completeSimple } from '@mariozechner/pi-ai'
import { createCodingTools, createGrepTool, createFindTool, createLsTool, estimateTokens, shouldCompact, generateSummary, DEFAULT_COMPACTION_SETTINGS } from '@mariozechner/pi-coding-agent'
import type { AgentTool, AgentEvent } from '@mariozechner/pi-agent-core'
import type { Model, TextContent } from '@mariozechner/pi-ai'

import { createResearchTools, type ResearchToolContext } from '../tools/index.js'
import { probeStaticProfile, generateAgentGuidance } from '../local-compute/environment-model.js'
import { maybeExtractMemories } from '../memory/extractor.js'
import { createLoadSkillTool } from '../tools/skill-tools.js'
import { loadAllSkills, readEnabledSkills, resolveSkillDependencies, buildSkillsCatalogPrompt, buildSkillSummary, type SkillEntry } from '../skills/loader.js'
import { loadPrompt } from './prompts/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { PATHS, AGENT_MD_ID, type SessionSummary, type NoteArtifact } from '../types.js'
import {
  migrateLegacyArtifacts,
  findArtifactById,
  readLatestSessionSummary,
  writeSessionSummary
} from '../memory-v2/store.js'

const SYSTEM_PROMPT = loadPrompt('coordinator-system')

type IntentLabel =
  | 'literature'
  | 'data'
  | 'writing'
  | 'critique'
  | 'web'
  | 'citation'
  | 'grants'
  | 'docx'
  | 'general'
type PersistenceDecision = 'ephemeral' | 'conditional' | 'persist-requested'

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

function detectIntentsByRules(message: string): Set<IntentLabel> {
  const text = message.toLowerCase()
  const intents = new Set<IntentLabel>()

  if (/(paper|papers|literature|related work|citation|survey|systematic review|find papers|arxiv|doi|bibtex|scholar)/.test(text)) intents.add('literature')
  if (/(data|dataset|csv|tsv|xlsx|xls|json|parquet|statistics|statistical|analysis|analyze|visualize|plot|chart|graph|matplotlib|seaborn|regression|modeling|correlation|distribution|outlier)/.test(text)) intents.add('data')
  if (/(rewrite|draft|write|outline|abstract|introduction|section|manuscript|proposal|review article|写作|改写|润色|摘要|大纲)/.test(text)) intents.add('writing')
  if (/(citation|cite|bibtex|endnote|zotero|doi|reference list|references|参考文献|引文|引证)/.test(text)) intents.add('citation')
  if (/(grant|grants|proposal|specific aims|broader impacts|nih|nsf|doe|darpa|funding|资助|基金|申报书)/.test(text)) intents.add('grants')
  if (/(docx|word document|tracked changes|track changes|ooxml|comment thread|批注|修订)/.test(text)) intents.add('docx')
  if (/(critique|review|evaluate|assessment|assess|weakness|limitation|pros|cons|flaw|评审|评价|批评|缺陷|可行性)/.test(text)) intents.add('critique')
  if (/(latest|today|news|deadline|release|price|官网|新闻|截止|版本)/.test(text)) intents.add('web')

  return intents
}


const MAX_SKILL_PRELOAD = 5

async function matchSkillsWithLLM(
  model: Model<any> | null,
  apiKey: string,
  message: string,
  skills: SkillEntry[]
): Promise<string[]> {
  if (!model || skills.length === 0) return []

  const skillList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
  const systemPrompt = [
    'You are a skill router for a research assistant. Given a user message, select which skills should be activated.',
    'Return ONLY a JSON array of skill names. Return [] if none are relevant.',
    '',
    'Rules:',
    '- Only select skills directly relevant to the user\'s request',
    '- Do not select skills speculatively',
    `- Maximum ${MAX_SKILL_PRELOAD} skills`,
    '- Consider both English and Chinese messages',
    '',
    'Available skills:',
    skillList
  ].join('\n')

  try {
    const result = await completeSimple(model, {
      systemPrompt,
      messages: [{ role: 'user', content: message, timestamp: Date.now() }]
    }, {
      maxTokens: 100,
      apiKey
    })

    const textContent = result.content.find((c): c is TextContent => c.type === 'text')
    const text = textContent?.text?.trim() ?? ''
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

function buildSkillSummariesPrompt(matchedSkills: SkillEntry[]): string {
  if (matchedSkills.length === 0) return ''
  const sections = matchedSkills.map(s => {
    const summary = buildSkillSummary(s)
    return `### Pre-loaded: ${s.name}\n\n${summary}`
  })
  return [
    '## Matched Skill Summaries',
    'The following skills have been pre-matched to this request. The summaries below are overviews only — they do NOT contain the full procedures, scripts, or parameters.',
    '**Rule: Always call `load_skill(name)` before executing any skill procedure.** The summary is for deciding whether a skill is relevant; the full content is required before acting on it.',
    '',
    ...sections
  ].join('\n\n')
}

function classifyPersistenceDecision(message: string): { decision: PersistenceDecision; reason: string } {
  const text = message.toLowerCase()

  if (/(do not save|don't save|no artifact|just answer|不要保存|别保存|不用保存)/.test(text)) {
    return { decision: 'ephemeral', reason: 'User explicitly requested no persistence.' }
  }

  if (/(save|persist|remember|track|record|store|archive|保存|记住|记录|跟踪|持久化)/.test(text)) {
    return { decision: 'persist-requested', reason: 'User requested durable tracking or saving.' }
  }

  if (/(^|\s)(why|what|how|status|clarify|explain|check)(\s|$)|为什么|怎么|是否|有无|确认/.test(text)) {
    return { decision: 'ephemeral', reason: 'Message appears to be clarification/status Q&A.' }
  }

  return { decision: 'conditional', reason: 'Persist only if reuse/traceability triggers are met during execution.' }
}


function buildMentionContext(mentions?: ResolvedMention[]): string {
  if (!mentions || mentions.length === 0) return ''

  return mentions
    .filter(m => !m.error)
    .map(m => `### ${m.label}\n\n${m.content}`)
    .join('\n\n')
}

function buildSessionSummaryContext(summary: SessionSummary): string {
  const lines = [
    '## Session Summary',
    `Turns ${summary.turnRange[0]}-${summary.turnRange[1]}:`,
    summary.summary,
    '',
    `Topics: ${summary.topicsDiscussed.join(', ')}`,
    ...(summary.openQuestions.length > 0
      ? ['Open questions:', ...summary.openQuestions.map(q => `- ${q}`)]
      : [])
  ]
  return lines.join('\n')
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
  model?: string
  projectPath?: string
  debug?: boolean
  sessionId?: string
  reasoningEffort?: 'high' | 'medium' | 'low'
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown, toolCallId?: string) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown, toolCallId?: string) => void
  onToolProgress?: (tool: string, toolCallId: string, phase: 'start' | 'update' | 'end', data: unknown) => void
  onUsage?: (usage: unknown, cost: unknown) => void
  onSkillLoaded?: (skillName: string) => void
}

export async function createCoordinator(config: CoordinatorConfig): Promise<{
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  clearSessionMemory: () => Promise<void>
  destroy: () => Promise<void>
}> {
  const {
    apiKey,
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
    onSkillLoaded
  } = config

  let turnCount = 0
  let activeTurnToolCallCount: number | null = null
  const turnHistory: Array<{ userMessage: string; response: string; toolCallCount: number; timestamp: string }> = []

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
      try {
        const result = getPiModel(parts[0] as any, parts[1] as any)
        if (result) piModel = result
      } catch (err) {
        if (debug) console.warn(`[Coordinator] getPiModel("${parts[0]}", "${parts[1]}") failed:`, err)
      }
    } else {
      // Infer provider from model name
      const providerHint = modelId.startsWith('claude-') ? 'anthropic'
        : modelId.startsWith('gpt-') || modelId.startsWith('o3') || modelId.startsWith('o4') ? 'openai'
        : modelId.startsWith('gemini-') ? 'google'
        : null

      const providers = providerHint
        ? [providerHint, 'anthropic', 'openai', 'google']
        : ['anthropic', 'openai', 'google']

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
    const routerByProvider: Record<string, string> = {
      anthropic: 'claude-haiku-4-5-20251001',
      openai: 'gpt-5.4-nano',
      google: 'gemini-2.0-flash-lite'
    }

    // Determine which provider the main model resolved to
    let mainProvider: string | null = null
    if (modelId) {
      const parts = modelId.split(':')
      if (parts.length === 2) {
        mainProvider = parts[0]
      } else {
        mainProvider = modelId.startsWith('claude-') ? 'anthropic'
          : modelId.startsWith('gpt-') || modelId.startsWith('o3') || modelId.startsWith('o4') ? 'openai'
          : modelId.startsWith('gemini-') ? 'google'
          : null
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
      const result = await completeSimple(piModel, {
        systemPrompt,
        messages: [{ role: 'user', content: userContent, timestamp: Date.now() }]
      }, { maxTokens: 4096, apiKey })
      const textContent = result.content.find((c): c is TextContent => c.type === 'text')
      return textContent?.text ?? ''
    },
    onToolCall,
    onToolResult: wrappedOnToolResult
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

  // Combine all tools
  const allTools: AgentTool[] = [
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
  // compactions can update rather than regenerate from scratch.
  let compactionSummary: string | undefined

  // Create the pi-mono Agent immediately (no blocking on env probe)
  const agent = new Agent({
    initialState: {
      systemPrompt: baseSystemPrompt,
      model: piModel ?? undefined as any,
      tools: allTools,
      thinkingLevel: reasoningEffort === 'high' ? 'high' : reasoningEffort === 'medium' ? 'medium' : 'low'
    },
    sessionId,
    getApiKey: async () => apiKey,

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
        const summary = await generateSummary(
          messagesToSummarize,
          piModel,
          settings.reserveTokens,
          apiKey,
          signal,
          undefined,
          compactionSummary
        )
        compactionSummary = summary

        if (debug) {
          console.log(`[Compaction] Summarized ${messagesToSummarize.length} messages (${totalTokens - keptTokens} tokens) → kept ${messagesToKeep.length} messages`)
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
      return undefined
    },
    afterToolCall: async (ctx) => {
      wrappedOnToolResult(ctx.toolCall.name, ctx.result, ctx.args, ctx.toolCall.id)
      // Notify when a skill is loaded successfully
      if (ctx.toolCall.name === 'load_skill' && onSkillLoaded) {
        const args = ctx.args as { name?: string }
        const result = ctx.result as any
        if (args?.name && result?.success !== false) {
          onSkillLoaded(args.name)
        }
      }
      return undefined
    }
  })

  // Subscribe to agent events for streaming, usage, and tool progress
  if (onStream || onUsage || onToolProgress) {
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
      // Tool execution progress events (real-time updates during tool execution)
      if (onToolProgress) {
        if (event.type === 'tool_execution_start') {
          onToolProgress(event.toolName, event.toolCallId, 'start', { args: event.args })
        } else if (event.type === 'tool_execution_update') {
          onToolProgress(event.toolName, event.toolCallId, 'update', { partialResult: event.partialResult })
        } else if (event.type === 'tool_execution_end') {
          onToolProgress(event.toolName, event.toolCallId, 'end', { result: event.result, isError: event.isError })
        }
      }
    })
  }

  async function clearSessionMemory() {
    agent.clearMessages()
    compactionSummary = undefined
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
      const result = await completeSimple(intentRouterModel, {
        systemPrompt: 'You summarize research conversations concisely. Output JSON with keys: summary (string), topicsDiscussed (string[]), openQuestions (string[]). Output ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `Summarize this research assistant conversation excerpt.\n\n${historyText}`,
          timestamp: Date.now()
        }]
      }, {
        maxTokens: 512,
        apiKey
      })

      const textContent = result.content.find((c): c is TextContent => c.type === 'text')
      const text = textContent?.text?.trim() ?? ''
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
        agent.setSystemPrompt(baseSystemPrompt + '\n\n' + envGuidance)
      })
      .catch(() => { /* non-fatal */ })
  }

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[], images?: Array<{ base64: string; mimeType: string }>) {
      try {
        // --- Intent detection (rule-based only, for explain snapshots) ---
        const intents = detectIntentsByRules(message)

        // --- LLM-based skill matching (replaces intent-driven prompt modules) ---
        const matchedSkillNames = await matchSkillsWithLLM(intentRouterModel, apiKey, message, skills)
        const matchedSkills = matchedSkillNames
          .map(name => skills.find(s => s.name === name))
          .filter((s): s is SkillEntry => s !== undefined)

        // Notify UI about pre-matched skills
        for (const s of matchedSkills) {
          onSkillLoaded?.(s.name)
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
        agent.setSystemPrompt(enrichedSystem)

        // Build the user message with injected context.
        // Order: session summary → skill summaries → mentions → user message
        const contextParts: string[] = []
        if (summaryContext) contextParts.push(summaryContext)
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
        void maybeExtractMemories(
          { projectPath, model: piModel!, apiKey, systemPrompt: enrichedSystem, debug },
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
    },

    clearSessionMemory,

    async destroy() {
      agent.abort()
      await destroyResearchTools()
    }
  }
}

export { createCoordinator as createCoordinatorRunner }
