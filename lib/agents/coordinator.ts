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
import { createCodingTools } from '@mariozechner/pi-coding-agent'
import type { AgentTool, AgentEvent } from '@mariozechner/pi-agent-core'
import type { Model, TextContent } from '@mariozechner/pi-ai'

import { createResearchTools, type ResearchToolContext } from '../tools/index.js'
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

const INTENT_PRIORITY: IntentLabel[] = [
  'data',
  'literature',
  'critique',
  'writing',
  'citation',
  'grants',
  'docx',
  'web',
  'general'
]

const INTENT_MODULES: Partial<Record<IntentLabel, string>> = {
  literature: 'coordinator-module-literature',
  data: 'coordinator-module-data',
  writing: 'coordinator-module-writing',
  critique: 'coordinator-module-critique'
}

interface TurnExplainSnapshot {
  timestamp: string
  sessionId: string
  intents: string[]
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

async function classifyIntentWithLLM(
  model: Model<any> | null,
  apiKey: string,
  message: string
): Promise<IntentLabel> {
  if (!model) return 'general'

  const systemPrompt = [
    'You are an intent router for a research assistant.',
    'Choose ONE label from: literature, data, writing, critique, web, citation, grants, docx, general.',
    'Output only the label.'
  ].join(' ')

  try {
    const result = await completeSimple(model, {
      systemPrompt,
      messages: [{ role: 'user', content: message, timestamp: Date.now() }]
    }, {
      maxTokens: 6,
      apiKey
    })

    const textContent = result.content.find((c): c is TextContent => c.type === 'text')
    const label = (textContent?.text ?? '').trim().toLowerCase().split(/\s+/)[0] as IntentLabel
    if (INTENT_PRIORITY.includes(label)) return label
  } catch {
    // fallback
  }

  return 'general'
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

function buildAdditionalInstructions(intents: Set<IntentLabel>): string | undefined {
  const ordered = INTENT_PRIORITY.filter(i => intents.has(i)).slice(0, 2)
  const modules: string[] = []

  for (const intent of ordered) {
    const name = INTENT_MODULES[intent]
    if (name) {
      modules.push(loadPrompt(name))
    }
  }

  return modules.length > 0 ? modules.join('\n\n') : undefined
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
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
  onUsage?: (usage: unknown, cost: unknown) => void
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
    onUsage
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
  try {
    if (modelId) {
      // Try to find the model by provider + modelId convention
      // modelId format is typically "provider:model-name" or just "model-name"
      const parts = modelId.split(':')
      if (parts.length === 2) {
        piModel = getPiModel(parts[0] as any, parts[1] as any)
      } else {
        // Try common providers
        for (const provider of ['anthropic', 'openai', 'google'] as const) {
          try {
            piModel = getPiModel(provider, modelId as any)
            break
          } catch {
            continue
          }
        }
      }
    }
  } catch (err) {
    if (debug) {
      console.warn(`[Coordinator] Failed to resolve model "${modelId}":`, err)
    }
  }

  // Select a cheap model for intent routing
  let intentRouterModel: Model<any> | null = null
  try {
    // Try to get a fast/cheap model for intent routing
    const routerModels = [
      ['anthropic', 'claude-haiku-4-5-20251001'],
      ['openai', 'gpt-4.1-nano'],
      ['google', 'gemini-2.0-flash-lite']
    ] as const
    for (const [provider, model] of routerModels) {
      try {
        intentRouterModel = getPiModel(provider as any, model as any)
        break
      } catch {
        continue
      }
    }
  } catch {
    // No intent router available, will fall back to rule-based
  }

  const wrappedOnToolResult = (tool: string, result: unknown, args?: unknown) => {
    if (activeTurnToolCallCount !== null) {
      activeTurnToolCallCount++
    }
    onToolResult?.(tool, result, args)
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
  const researchAgentTools: AgentTool[] = createResearchTools(toolCtx)

  // Create built-in coding tools from pi-coding-agent
  const codingTools = createCodingTools(projectPath)

  // Combine all tools
  const allTools: AgentTool[] = [
    ...codingTools,
    ...researchAgentTools
  ]

  // Build the full system prompt
  const fullSystemPrompt = SYSTEM_PROMPT

  // Create the pi-mono Agent
  const agent = new Agent({
    initialState: {
      systemPrompt: fullSystemPrompt,
      model: piModel ?? undefined as any,
      tools: allTools,
      thinkingLevel: reasoningEffort === 'high' ? 'high' : reasoningEffort === 'medium' ? 'medium' : 'low'
    },
    sessionId,
    getApiKey: async () => apiKey,
    beforeToolCall: async (ctx) => {
      onToolCall?.(ctx.toolCall.name, ctx.args)
      if (debug) {
        console.log(`  [Tool] ${ctx.toolCall.name}(${JSON.stringify(ctx.args).slice(0, 120)}...)`)
      }
      return undefined
    },
    afterToolCall: async (ctx) => {
      wrappedOnToolResult(ctx.toolCall.name, ctx.result, ctx.args)
      return undefined
    }
  })

  // Subscribe to agent events for streaming
  if (onStream || onUsage) {
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
    })
  }

  async function clearSessionMemory() {
    agent.clearMessages()
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
        maxTokens: 200,
        apiKey
      })

      const textContent = result.content.find((c): c is TextContent => c.type === 'text')
      const text = textContent?.text ?? ''
      const parsed = JSON.parse(text)

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

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[]) {
      try {
        const intents = detectIntentsByRules(message)
        const hasModuleIntent = ['literature', 'data', 'writing', 'citation', 'grants', 'docx', 'critique']
          .some(i => intents.has(i as IntentLabel))
        if (!hasModuleIntent) {
          const label = await classifyIntentWithLLM(intentRouterModel, apiKey, message)
          if (label !== 'general') intents.add(label)
        }

        const additionalInstructions = buildAdditionalInstructions(intents)

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
          console.log(`[Chat] Intents: ${intentList}`)
          console.log(`[Chat] Sending message to agent (${mentions?.filter(m => !m.error).length ?? 0} mentions, summary=${!!latestSummary})...`)
        }

        // Build the enriched system prompt with context
        let enrichedSystem = fullSystemPrompt
        if (agentMdContent) {
          enrichedSystem = `${enrichedSystem}\n\n## User Instructions (agent.md)\n\n${agentMdContent}`
        }
        if (additionalInstructions) {
          enrichedSystem = `${enrichedSystem}\n\n${additionalInstructions}`
        }
        agent.setSystemPrompt(enrichedSystem)

        // Build the user message with injected context
        let userMessage = message
        if (mentionContext || summaryContext) {
          const contextParts: string[] = []
          if (summaryContext) contextParts.push(summaryContext)
          if (mentionContext) contextParts.push(mentionContext)
          userMessage = `${contextParts.join('\n\n')}\n\n---\n\n${message}`
        }

        // Count tool calls for this turn
        let perTurnToolCallCount = 0
        activeTurnToolCallCount = 0

        try {
          await agent.prompt(userMessage)
          perTurnToolCallCount = activeTurnToolCallCount ?? 0
        } finally {
          activeTurnToolCallCount = null
        }

        // Extract the response text from agent messages
        const messages = agent.state.messages
        const lastMsg = messages[messages.length - 1]
        let responseText = ''
        if (lastMsg && 'content' in lastMsg && Array.isArray(lastMsg.content)) {
          for (const block of lastMsg.content) {
            if ('type' in block && block.type === 'text' && 'text' in block) {
              responseText += (block as TextContent).text
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

        if (debug) {
          console.log(`[Chat] Result: success=true, hasOutput=${!!responseText}, turn=${turnCount}`)
        }

        return { success: true, response: responseText }
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
    }
  }
}

export { createCoordinator as createCoordinatorRunner }
