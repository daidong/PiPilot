/**
 * Coordinator Agent (Research Pilot Memory V2 - RFC-012)
 *
 * Key behavior:
 * - Canonical memory surface: Artifact / Fact / Focus / Task Anchor
 * - Focus is session-scoped with TTL + turn-boundary expiry
 * - Durable fact writes route through runtime.memoryStorage (Kernel V2 write gate)
 * - Context is assembled by Kernel V2; focus digest is injected as selected context
 */

import { basename, join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { createAgent, packs, definePack, defineTool } from '../../../src/index.js'
import { createLLMClientFromModelId } from '../../../src/llm/index.js'
import { createSubagentTools } from './subagent-tools.js'
import { createResearchMemoryTools, type MemoryExplainProvider } from '../tools/entity-tools.js'
import type { Agent } from '../../../src/types/agent.js'
import type { ContextSelection } from '../../../src/types/context-pipeline.js'
import type { MemoryStorage } from '../../../src/types/memory.js'
import { countTokens } from '../../../src/utils/tokenizer.js'
import { loadPrompt } from './prompts/index.js'
import { researchPilotSkills } from '../skills/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { PATHS, type Artifact, type FocusEntry } from '../types.js'
import {
  addFocusEntry,
  findArtifactById,
  listFocusEntries,
  pruneExpiredFocusAtTurnBoundary,
  readTaskAnchor
} from '../memory-v2/store.js'

const SYSTEM_PROMPT = loadPrompt('coordinator-system')

type IntentLabel = 'literature' | 'data' | 'writing' | 'critique' | 'resume' | 'web' | 'general'

const INTENT_PRIORITY: IntentLabel[] = [
  'data',
  'literature',
  'critique',
  'writing',
  'resume',
  'web',
  'general'
]

const INTENT_MODULES: Partial<Record<IntentLabel, string>> = {
  literature: 'coordinator-module-literature',
  data: 'coordinator-module-data',
  writing: 'coordinator-module-writing',
  critique: 'coordinator-module-critique',
  resume: 'coordinator-module-resume'
}

interface TurnExplainSnapshot {
  timestamp: string
  sessionId: string
  intents: string[]
  focus: {
    active: number
    used: Array<{ refType: string; refId: string; score: number; reason: string }>
    prunedAtTurnBoundary: number
  }
  selectedContext: {
    mentionSelections: number
    focusDigestIncluded: boolean
    approxTokens: number
  }
  taskAnchor: {
    currentGoal: string
    nowDoing: string
    blockedBy: string[]
    nextAction: string
  }
  budget: {
    model: string
    contextWindow?: number
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

function detectIntentsByRules(message: string): Set<IntentLabel> {
  const text = message.toLowerCase()
  const intents = new Set<IntentLabel>()

  if (/(paper|papers|literature|related work|citation|survey|systematic review|find papers|arxiv|doi|bibtex|scholar)/.test(text)) intents.add('literature')
  if (/(data|dataset|csv|tsv|xlsx|xls|json|parquet|statistics|statistical|analysis|analyze|visualize|plot|chart|graph|regression|modeling|correlation|distribution|outlier)/.test(text)) intents.add('data')
  if (/(rewrite|draft|write|outline|abstract|introduction|section|manuscript|proposal|review article|写作|改写|润色|摘要|大纲)/.test(text)) intents.add('writing')
  if (/(critique|review|evaluate|assessment|assess|weakness|limitation|pros|cons|flaw|评审|评价|批评|缺陷|可行性)/.test(text)) intents.add('critique')
  if (/(continue|resume|progress|status|where are we|what's next|next step|继续|进展|下一步)/.test(text)) intents.add('resume')
  if (/(latest|today|news|deadline|release|price|官网|新闻|截止|版本)/.test(text)) intents.add('web')

  return intents
}

async function classifyIntentWithLLM(
  routerClient: ReturnType<typeof createLLMClientFromModelId> | null,
  message: string
): Promise<IntentLabel> {
  if (!routerClient) return 'general'

  const system = [
    'You are an intent router for a research assistant.',
    'Choose ONE label from: literature, data, writing, critique, resume, web, general.',
    'Output only the label.'
  ].join(' ')

  try {
    const result = await routerClient.generate({
      system,
      messages: [{ role: 'user', content: message }],
      maxTokens: 6
    })
    const label = result.text.trim().toLowerCase().split(/\s+/)[0] as IntentLabel
    if (INTENT_PRIORITY.includes(label)) return label
  } catch {
    // fallback
  }

  return 'general'
}

function describeToolReturn(name: string): string {
  if (name === 'read') return 'file text'
  if (name === 'write') return 'path/bytes'
  if (name === 'edit') return 'replacements'
  if (name === 'glob') return 'paths'
  if (name === 'grep') return 'matches'
  if (name === 'convert_to_markdown') return 'output file path'
  if (name === 'fetch') return 'status + body'
  if (name === 'literature-search') return 'summary + review paths'
  if (name === 'data-analyze') return 'outputs/manifest'
  if (name.startsWith('brave_')) return 'ranked results'
  if (name.startsWith('sqlite_')) return 'JSON text'
  if (name.startsWith('todo-')) return 'todo item'
  if (name.startsWith('memory-')) return 'memory item'
  if (name.startsWith('artifact-')) return 'artifact result'
  if (name.startsWith('fact-')) return 'fact result'
  if (name.startsWith('focus-')) return 'focus result'
  if (name.startsWith('task-anchor-')) return 'task anchor result'
  if (name === 'memory-explain') return 'explain snapshot'
  if (name === 'ctx-get') return 'rendered context'
  if (name === 'bash') return 'stdout/stderr'
  return 'result'
}

function buildToolContracts(toolRegistry: { getAll: () => Array<{ name: string; parameters?: Record<string, { required?: boolean }> }> }): string {
  const tools = toolRegistry.getAll().slice().sort((a, b) => a.name.localeCompare(b.name))
  const lines: string[] = ['## Tool contracts (minimal)']

  for (const tool of tools) {
    const params = tool.parameters ?? {}
    const names = Object.entries(params).map(([name, def]) => def?.required === false ? `${name}?` : name)
    lines.push(`- ${tool.name}({ ${names.join(', ')} }) -> ${describeToolReturn(tool.name)}`)
  }

  return lines.join('\n')
}

function buildAdditionalInstructions(intents: Set<IntentLabel>, toolContracts: string): string | undefined {
  const ordered = INTENT_PRIORITY.filter(i => intents.has(i)).slice(0, 2)
  const modules = [
    toolContracts,
    ...ordered
      .map(i => INTENT_MODULES[i])
      .filter((name): name is string => !!name)
      .map(name => loadPrompt(name))
  ]

  return modules.length > 0 ? modules.join('\n\n') : undefined
}

function getMentionArtifactIds(mentions?: ResolvedMention[]): string[] {
  if (!mentions) return []
  return mentions
    .filter(m => !m.error && (m.ref.type === 'note' || m.ref.type === 'paper' || m.ref.type === 'data') && !!m.entityId)
    .map(m => m.entityId!)
}

function buildMentionSelections(mentions?: ResolvedMention[]): ContextSelection[] {
  if (!mentions) return []

  return mentions
    .filter(m => !m.error && (m.ref.type === 'file' || m.ref.type === 'url'))
    .map(m => ({
      type: 'custom' as const,
      ref: m.ref.raw,
      resolve: async () => {
        const content = `### ${m.label}\n\n${m.content}`
        return {
          source: `mention:${m.ref.raw}`,
          content,
          tokens: countTokens(content)
        }
      }
    }))
}

function shortArtifactBlock(artifact: Artifact): string {
  if (artifact.type === 'note') {
    return `- [note] ${artifact.title}: ${(artifact.summary ?? artifact.content).slice(0, 220)}`
  }
  if (artifact.type === 'paper') {
    const authorText = artifact.authors.slice(0, 3).join(', ')
    return `- [paper] ${artifact.title} (${artifact.year ?? 'n.d.'}) | ${authorText} | doi=${artifact.doi} | ${(artifact.summary ?? artifact.abstract).slice(0, 220)}`
  }
  if (artifact.type === 'data') {
    return `- [data] ${artifact.title} | path=${artifact.filePath} | ${(artifact.summary ?? '').slice(0, 180)}`
  }
  if (artifact.type === 'web-content') {
    return `- [web] ${artifact.title} | ${artifact.url} | ${(artifact.summary ?? artifact.content).slice(0, 220)}`
  }
  return `- [tool-output] ${artifact.title} | ${artifact.toolName} | ${(artifact.summary ?? artifact.outputText ?? '').slice(0, 220)}`
}

async function buildFocusDigestSelection(
  sessionId: string,
  projectPath: string,
  memoryStorage: MemoryStorage | undefined
): Promise<{ selection?: ContextSelection; entriesUsed: FocusEntry[]; approxTokens: number }> {
  const focusEntries = listFocusEntries(projectPath, sessionId)
  if (focusEntries.length === 0) {
    return { entriesUsed: [], approxTokens: 0 }
  }

  const used = focusEntries.slice(0, 12)
  const lines: string[] = ['## Focus Digest']

  for (const entry of used) {
    const prefix = `[score=${entry.score.toFixed(2)} source=${entry.source} ttl=${entry.ttl}]`

    if (entry.refType === 'artifact') {
      const found = findArtifactById(projectPath, entry.refId)
      if (found) {
        lines.push(`${prefix} reason=${entry.reason}`)
        lines.push(shortArtifactBlock(found.artifact))
      }
      continue
    }

    if (entry.refType === 'fact') {
      if (memoryStorage && entry.refId.includes(':')) {
        const [namespace, key] = entry.refId.split(':', 2)
        if (namespace && key) {
          const fact = await memoryStorage.get(namespace, key)
          if (fact) {
            lines.push(`${prefix} reason=${entry.reason}`)
            lines.push(`- [fact] ${namespace}:${key} -> ${fact.valueText ?? JSON.stringify(fact.value).slice(0, 220)}`)
          }
        }
      }
      continue
    }

    if (entry.refType === 'task') {
      const anchor = readTaskAnchor(projectPath)
      lines.push(`${prefix} reason=${entry.reason}`)
      lines.push(`- [task] Goal=${anchor.currentGoal}; Doing=${anchor.nowDoing}; Next=${anchor.nextAction}`)
    }
  }

  const content = lines.join('\n')
  const tokens = countTokens(content)

  const selection: ContextSelection = {
    type: 'custom',
    ref: 'focus:digest',
    resolve: async () => ({
      source: 'focus:digest',
      content,
      tokens
    })
  }

  return {
    selection,
    entriesUsed: used,
    approxTokens: tokens
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
    model,
    projectPath = process.cwd(),
    debug = false,
    sessionId = 'default',
    reasoningEffort = 'high',
    onStream,
    onToolCall,
    onToolResult,
    onUsage
  } = config

  let lastTurnExplain: TurnExplainSnapshot | null = null
  let lastBudgetExplain: TurnExplainSnapshot['budget'] | null = null

  const explainProvider: MemoryExplainProvider = {
    getTurnExplain: () => lastTurnExplain,
    getBudgetExplain: () => lastBudgetExplain
  }

  let intentRouterClient: ReturnType<typeof createLLMClientFromModelId> | null = null
  try {
    intentRouterClient = createLLMClientFromModelId('gpt-5-nano', { apiKey })
  } catch (err) {
    if (debug) {
      console.warn('[IntentRouter] Failed to init gpt-5-nano:', err)
    }
  }

  const { literatureSearchTool, dataAnalyzeTool } = createSubagentTools(
    apiKey,
    model,
    onToolResult,
    projectPath,
    sessionId,
    onToolCall
  )

  const memoryTools = createResearchMemoryTools({
    sessionId,
    projectPath,
    explainProvider
  })

  const documentsPack = await packs.documents({ timeout: 90000 })
  const rawConvertTool = documentsPack.tools?.find(t => t.name === 'convert_to_markdown')

  const convertToMarkdownTool = defineTool({
    name: 'convert_to_markdown',
    description: 'Convert document to markdown, save local .md file, and return preview + headings for targeted reads.',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative path to document file (e.g., "report.pdf")',
        required: true
      }
    },
    execute: async (input, context) => {
      if (!rawConvertTool) {
        return { success: false, error: 'convert_to_markdown MCP tool not available' }
      }

      const fileName = (input as { path: string }).path
      const absPath = join(process.cwd(), fileName)
      if (!existsSync(absPath)) {
        return { success: false, error: `File not found: ${fileName}` }
      }

      const uri = `file://${absPath}`
      const result = await rawConvertTool.execute({ uri }, context)
      if (!result.success) return result

      const data = result.data as { text?: string } | undefined
      const text = data?.text || ''
      if (!text) {
        return { success: false, error: 'No text extracted from document' }
      }

      const outputName = basename(fileName, '.pdf') + '.extracted.md'
      const outputPath = join(process.cwd(), outputName)
      writeFileSync(outputPath, text, 'utf-8')

      const allLines = text.split('\n')
      const lines = allLines.length
      const headings = allLines
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter(item => /^#{1,4}\s/.test(item.text))

      const head = allLines.slice(0, 30).join('\n')
      const tail = lines > 60 ? allLines.slice(-30).join('\n') : ''

      return {
        success: true,
        data: {
          outputFile: outputName,
          lines,
          bytes: text.length,
          head,
          tail: tail || undefined,
          headings: headings.length > 0
            ? headings.map(h => `L${h.line}: ${h.text}`).join('\n')
            : undefined,
          message: `Extracted ${lines} lines. Use read({ path: "${outputName}", offset, limit }) for targeted sections.`
        }
      }
    }
  })

  const webPack = await packs.web({ timeout: 30000 })

  const subagentPack = definePack({
    id: 'subagents',
    name: 'Subagent Tools',
    description: 'Literature search and data analysis tools',
    tools: [literatureSearchTool, dataAnalyzeTool, ...memoryTools]
  })

  const agent = createAgent({
    apiKey,
    model,
    projectPath,
    reasoningEffort,
    identity: SYSTEM_PROMPT,
    constraints: [
      'For multi-step work, briefly state intent before acting',
      'Ask for clarification when instructions are ambiguous'
    ],
    packs: [
      packs.safe(),
      packs.exec({ approvalMode: 'none', denyPatterns: [] }),
      packs.kvMemory(),
      packs.todo(),
      definePack({
        id: 'documents-wrapper',
        description: 'Document conversion wrapper',
        tools: [convertToMarkdownTool as unknown as Tool]
      }),
      webPack,
      subagentPack,
      definePack({
        id: 'research-skills',
        description: 'Research pilot skills for literature, writing, and data analysis',
        skills: researchPilotSkills,
        skillLoadingConfig: {
          lazy: ['academic-writing-skill', 'literature-skill', 'data-analysis-skill']
        }
      })
    ],
    onStream,
    onToolCall: (name: string, args: unknown) => {
      onToolCall?.(name, args)
      if (debug) {
        console.log(`  [Tool] ${name}(${JSON.stringify(args).slice(0, 120)}...)`)
      }
    },
    onToolResult,
    sessionId,
    debug,
    taskProfile: 'research',
    outputReserveStrategy: {
      intermediate: 16384,
      final: 8192,
      extended: 16384
    },
    budgetConfig: {
      enabled: true,
      modelId: model,
      toolResultCap: 4096,
      priorityTools: ['read', 'write', 'edit', 'grep', 'glob', 'literature-search', 'artifact-search']
    },
    toolLoopThreshold: 15,
    maxSteps: 100,
    onUsage,
    kernelV2: {
      enabled: true
    }
  })

  await agent.ensureInit()

  const toolContracts = buildToolContracts(agent.runtime.toolRegistry as unknown as {
    getAll: () => Array<{ name: string; parameters?: Record<string, { required?: boolean }> }>
  })

  async function clearSessionMemory() {
    const storage = agent.runtime.memoryStorage
    if (!storage) return
    const { items } = await storage.list({ namespace: 'session', status: 'active' })
    for (const item of items) {
      await storage.delete('session', item.key, 'session-clear')
    }
  }

  await clearSessionMemory()

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[]) {
      try {
        const memoryStorage = agent.runtime.memoryStorage

        const pruned = pruneExpiredFocusAtTurnBoundary(projectPath, sessionId)
        if (debug && pruned.expired > 0) {
          console.log(`[Focus] Pruned ${pruned.expired} expired entries at turn boundary`) 
        }

        const mentionArtifactIds = getMentionArtifactIds(mentions)
        for (const artifactId of mentionArtifactIds) {
          addFocusEntry(projectPath, {
            sessionId,
            refType: 'artifact',
            refId: artifactId,
            reason: 'entity mentioned in current request',
            score: 0.85,
            source: 'auto',
            ttl: '30m'
          })
        }

        const intents = detectIntentsByRules(message)
        const hasModuleIntent = ['literature', 'data', 'writing', 'critique', 'resume'].some(i => intents.has(i as IntentLabel))
        if (!hasModuleIntent) {
          const label = await classifyIntentWithLLM(intentRouterClient, message)
          if (label !== 'general') intents.add(label)
        }
        const additionalInstructions = buildAdditionalInstructions(intents, toolContracts)

        const mentionSelections = buildMentionSelections(mentions)
        const focusDigest = await buildFocusDigestSelection(sessionId, projectPath, memoryStorage)

        const selectedContext: ContextSelection[] = [...mentionSelections]
        if (focusDigest.selection) {
          selectedContext.push(focusDigest.selection)
        }

        const anchor = readTaskAnchor(projectPath)

        const explain: TurnExplainSnapshot = {
          timestamp: new Date().toISOString(),
          sessionId,
          intents: Array.from(intents),
          focus: {
            active: listFocusEntries(projectPath, sessionId).length,
            used: focusDigest.entriesUsed.map(entry => ({
              refType: entry.refType,
              refId: entry.refId,
              score: entry.score,
              reason: entry.reason
            })),
            prunedAtTurnBoundary: pruned.expired
          },
          selectedContext: {
            mentionSelections: mentionSelections.length,
            focusDigestIncluded: !!focusDigest.selection,
            approxTokens: focusDigest.approxTokens
          },
          taskAnchor: {
            currentGoal: anchor.currentGoal,
            nowDoing: anchor.nowDoing,
            blockedBy: anchor.blockedBy,
            nextAction: anchor.nextAction
          },
          budget: {
            model: model ?? 'default'
          }
        }

        lastTurnExplain = explain
        lastBudgetExplain = explain.budget

        if (debug) {
          const intentList = Array.from(intents).join(', ') || 'none'
          console.log(`[Chat] Intents: ${intentList}`)
          console.log(`[Chat] Sending message to agent (${mentionSelections.length} mention selections, focus entries used: ${focusDigest.entriesUsed.length})...`)
        }

        const result = await agent.run(message, {
          ...(selectedContext.length > 0 ? { selectedContext } : {}),
          ...(additionalInstructions ? { additionalInstructions } : {})
        })

        if (result.usage?.tokens) {
          explain.budget.promptTokens = result.usage.tokens.promptTokens
          explain.budget.completionTokens = result.usage.tokens.completionTokens
          explain.budget.totalTokens = result.usage.tokens.totalTokens
          lastBudgetExplain = explain.budget
          lastTurnExplain = explain
        }

        writeExplainSnapshot(projectPath, explain)

        if (debug) {
          console.log(`[Chat] Result: success=${result.success}, hasOutput=${!!result.output}`)
        }

        if (result.success) {
          return { success: true, response: result.output }
        }

        return {
          success: false,
          error: result.error || 'Agent failed (no error message)'
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
      await agent.destroy()
    }
  }
}

export { createCoordinator as createCoordinatorRunner }
