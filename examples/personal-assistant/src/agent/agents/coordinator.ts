/**
 * Coordinator Agent (Personal Assistant Memory V2 - RFC-013)
 *
 * Key behavior:
 * - Canonical memory surface: Artifact / Fact / Focus / Task Anchor
 * - Focus is session-scoped with TTL + turn-boundary expiry
 * - Durable fact writes route through runtime.memoryStorage (Kernel V2 write gate)
 * - Context is assembled by Kernel V2; focus digest is injected as selected context
 */

import os from 'os'
import { basename, join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { createAgent, packs, definePack, defineTool } from '@framework/index.js'
import { createLLMClientFromModelId, getModel } from '@framework/llm/index.js'
import { createPersonalMemoryTools, type MemoryExplainProvider } from '../tools/entity-tools.js'
import { createCalendarTool } from '../tools/calendar-tool.js'
import { createGmailTool } from '../tools/gmail-tool.js'
import { noGmailDelete } from '../policies/no-gmail-delete.js'
import type { Agent } from '@framework/types/agent.js'
import type { Policy } from '@framework/types/policy.js'
import type { ContextSelection } from '@framework/types/context-pipeline.js'
import type { MemoryStorage } from '@framework/types/memory.js'
import type { Tool } from '@framework/types/tool.js'
import { countTokens } from '@framework/utils/tokenizer.js'
import { loadPrompt } from './prompts/index.js'
import { personalAssistantSkills } from '../../skills/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { PATHS, type Artifact, type FocusEntry } from '../types.js'
import {
  addFocusEntry,
  createArtifact,
  findArtifactById,
  listFocusEntries,
  pruneExpiredFocusAtTurnBoundary,
  readTaskAnchor
} from '../memory-v2/store.js'

const SYSTEM_PROMPT = loadPrompt('coordinator-system')

type IntentLabel = 'email' | 'calendar' | 'docs' | 'memory' | 'scheduler' | 'web' | 'general'

const INTENT_PRIORITY: IntentLabel[] = [
  'email',
  'calendar',
  'scheduler',
  'docs',
  'memory',
  'web',
  'general'
]

const INTENT_PROMPT_MODULES: Partial<Record<IntentLabel, string>> = {
  docs: 'coordinator-module-docs',
  memory: 'coordinator-module-memory',
  scheduler: 'coordinator-module-scheduler'
}

const INTENT_SKILL_IDS: Partial<Record<IntentLabel, string>> = {
  email: 'gmail-skill',
  calendar: 'calendar-skill'
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

  if (/(email|inbox|gmail|mail|thread|reply|send|subject|unread|star|mark as read|message|sender|from:|to:|cc:|bcc:|attachment|附件|邮件|邮箱|收件箱|发件人|主题)/.test(text)) {
    intents.add('email')
  }
  if (/(calendar|meeting|event|invite|availability|free time|schedule (a )?meeting|日历|会议|约会|安排时间|空闲时间)/.test(text)) {
    intents.add('calendar')
  }
  if (/(cron|scheduled task|scheduler|daily briefing|weekly briefing|morning briefing|recurring task|定时任务|定期任务|计划任务|日报|周报|晨报)/.test(text)) {
    intents.add('scheduler')
  }
  if (/(pdf|docx|document|convert|markdown|ppt|slides|xlsx|excel|word|文档|转换|提取|幻灯片|表格)/.test(text)) {
    intents.add('docs')
  }
  if (/(remember|note this|save this|my preference|my name is|timezone|language|remember this|记住|记下来|偏好|时区|语言)/.test(text)) {
    intents.add('memory')
  }
  if (/(latest|today|news|deadline|release|price|website|官网|新闻|截止|版本)/.test(text)) {
    intents.add('web')
  }

  return intents
}

async function classifyIntentWithLLM(
  routerClient: ReturnType<typeof createLLMClientFromModelId> | null,
  message: string
): Promise<IntentLabel> {
  if (!routerClient) return 'general'
  const system = [
    'You are an intent router for a personal assistant.',
    'Choose ONE label from: email, calendar, docs, memory, scheduler, web, general.',
    'Output the label ONLY.'
  ].join(' ')

  try {
    const result = await routerClient.generate({
      system,
      messages: [{ role: 'user', content: message }],
      maxTokens: 6
    })
    const raw = result.text.trim().toLowerCase()
    const label = raw.split(/\s+/)[0] as IntentLabel
    if (INTENT_PRIORITY.includes(label)) {
      return label
    }
  } catch {
    // fall through
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
  if (name.startsWith('brave_')) return 'ranked results'
  if (name.startsWith('sqlite_')) return 'JSON text'
  if (name.startsWith('todo-')) return 'todo item'
  if (name.startsWith('memory-')) return 'memory item'
  if (name.startsWith('artifact-')) return 'artifact result'
  if (name.startsWith('focus-')) return 'focus result'
  if (name.startsWith('task-anchor-')) return 'task anchor result'
  if (name === 'memory-explain') return 'explain snapshot'
  if (name === 'calendar') return 'events text'
  if (name === 'gmail') return 'gmail action result'
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

function preloadSkillsForIntents(intents: Set<IntentLabel>, skillManager: any): void {
  for (const intent of intents) {
    const skillId = INTENT_SKILL_IDS[intent]
    if (skillId && skillManager) {
      skillManager.loadFully(skillId)
    }
  }
}

function buildAdditionalInstructions(intents: Set<IntentLabel>, toolContracts: string): string | undefined {
  const ordered = INTENT_PRIORITY.filter(i => intents.has(i)).slice(0, 2)
  const modules: string[] = [toolContracts]

  for (const intent of ordered) {
    const skillId = INTENT_SKILL_IDS[intent]
    if (skillId) continue

    const promptName = INTENT_PROMPT_MODULES[intent]
    if (promptName) {
      modules.push(loadPrompt(promptName))
    }
  }

  return modules.length > 1 ? modules.join('\n\n') : undefined
}

function getMentionArtifactIds(mentions?: ResolvedMention[]): string[] {
  if (!mentions) return []
  return mentions
    .filter(m => !m.error && (m.ref.type === 'note' || m.ref.type === 'doc') && !!m.entityId)
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
  if (artifact.type === 'todo') {
    return `- [todo:${artifact.status}] ${artifact.title}: ${(artifact.summary ?? artifact.content).slice(0, 220)}`
  }
  if (artifact.type === 'doc') {
    return `- [doc] ${artifact.title} | path=${artifact.filePath} | ${(artifact.summary ?? artifact.description ?? '').slice(0, 180)}`
  }
  if (artifact.type === 'email-message') {
    return `- [mail] ${artifact.subject ?? artifact.title} | from=${artifact.from ?? 'unknown'} | ${(artifact.summary ?? artifact.snippet ?? '').slice(0, 220)}`
  }
  if (artifact.type === 'email-thread') {
    return `- [thread] ${artifact.latestSubject ?? artifact.title} | unread=${artifact.unreadCount ?? 0} | ${(artifact.summary ?? artifact.latestSnippet ?? '').slice(0, 220)}`
  }
  if (artifact.type === 'calendar-event') {
    return `- [calendar] ${artifact.title} | ${artifact.startAt ?? '-'} | ${(artifact.location ?? '').slice(0, 160)}`
  }
  if (artifact.type === 'scheduler-run') {
    return `- [scheduler:${artifact.status}] ${artifact.title} | ${(artifact.summary ?? artifact.output ?? artifact.error ?? '').slice(0, 220)}`
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

function persistToolArtifacts(
  params: {
    projectPath: string
    sessionId: string
    tool: string
    args?: unknown
    result?: unknown
  }
): void {
  try {
    const { projectPath, sessionId, tool, args, result } = params
    const payload = result as { success?: boolean; data?: unknown; error?: string } | undefined
    const success = payload?.success !== false
    const outputText = tool === 'gmail'
      ? JSON.stringify({
          success,
          error: payload?.error,
          note: 'gmail tool output redacted by default'
        })
      : JSON.stringify(result).slice(0, 4000)

    createArtifact({
      type: 'tool-output',
      title: `${tool} ${success ? 'result' : 'error'}`,
      toolName: tool,
      outputText,
      tags: ['tool-output', tool],
      summary: success ? `${tool} executed` : `${tool} failed: ${payload?.error ?? 'unknown error'}`,
      provenance: {
        source: 'agent',
        sessionId,
        extractedFrom: 'tool-output'
      }
    }, { sessionId, projectPath })

    if (tool === 'calendar' && success) {
      const text = typeof payload?.data === 'string' ? payload.data : ''
      if (text && text !== 'No events found for range: today' && text.length > 10) {
        createArtifact({
          type: 'calendar-event',
          title: 'Calendar query result',
          notes: text.slice(0, 5000),
          tags: ['calendar', 'query-result'],
          summary: text.slice(0, 280),
          provenance: { source: 'agent', sessionId, extractedFrom: 'tool-output' }
        }, { sessionId, projectPath })
      }
    }

    if (tool === 'gmail' && success) {
      const input = (args as Record<string, unknown> | undefined) ?? {}
      const action = String(input.action || 'gmail-action')
      if (action === 'send' || action === 'reply') {
        const to = typeof input.to === 'string' ? input.to.split(',').map(v => v.trim()).filter(Boolean) : []
        const cc = typeof input.cc === 'string' ? input.cc.split(',').map(v => v.trim()).filter(Boolean) : []
        const subject = typeof input.subject === 'string' ? input.subject : undefined

        createArtifact({
          type: 'email-message',
          title: subject || `${action} email`,
          accountEmail: typeof input.account_email === 'string' ? input.account_email : undefined,
          threadId: typeof input.thread_id === 'string' ? input.thread_id : undefined,
          to,
          cc,
          subject,
          bodyText: undefined,
          sentAt: new Date().toISOString(),
          tags: ['email', action],
          summary: `${action} email to ${to.join(', ') || 'unknown recipient'}`,
          provenance: { source: 'agent', sessionId, extractedFrom: 'tool-output' }
        }, { sessionId, projectPath })
      }
    }
  } catch {
    // Telemetry persistence should never break the main tool flow.
  }
}

export interface CoordinatorConfig {
  apiKey: string
  model?: string
  projectPath?: string
  debug?: boolean
  sessionId?: string
  emailDbPath?: string
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

  const emailDbPath = config.emailDbPath?.replace(/^~(?=\/|$)/, os.homedir())

  let lastTurnExplain: TurnExplainSnapshot | null = null
  let lastBudgetExplain: TurnExplainSnapshot['budget'] | null = null

  const explainProvider: MemoryExplainProvider = {
    getTurnExplain: () => lastTurnExplain,
    getBudgetExplain: () => lastBudgetExplain
  }

  const userTodoPolicy: Policy = {
    id: 'deny-internal-todo-for-user',
    description: 'Block todo-* tools when user asks for user-facing todos',
    phase: 'guard',
    match: () => false,
    decide: () => ({ action: 'allow' })
  }

  // Select intent router model based on coordinator's provider
  const coordinatorProvider = getModel(model ?? '')?.providerID
  const intentRouterModelId = coordinatorProvider === 'anthropic'
    ? 'claude-haiku-4-5-20251001'
    : 'gpt-5-nano'

  let intentRouterClient: ReturnType<typeof createLLMClientFromModelId> | null = null
  try {
    intentRouterClient = createLLMClientFromModelId(intentRouterModelId, { apiKey })
  } catch (err) {
    if (debug) {
      console.warn(`[IntentRouter] Failed to init ${intentRouterModelId}:`, err)
    }
  }

  const memoryTools = createPersonalMemoryTools({
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

  let sqlitePack: any = null
  if (emailDbPath) {
    try {
      sqlitePack = await packs.sqlite({ dbPath: emailDbPath, toolPrefix: 'sqlite' })
    } catch (err) {
      if (debug) {
        console.warn(`[Coordinator] Failed to initialize SQLite pack for "${emailDbPath}":`, err)
      }
    }
  }

  const gmailTool = emailDbPath ? createGmailTool(emailDbPath) : null

  const memoryPack = definePack({
    id: 'personal-memory-v2',
    name: 'Personal Memory V2 Tools',
    description: 'Artifact/Focus/TaskAnchor/Explain tool surface',
    tools: memoryTools
  })

  const agentPacks = [
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
    memoryPack,
    definePack({
      id: 'assistant-skills',
      description: 'Personal assistant skills for Gmail and Calendar operations',
      skills: personalAssistantSkills,
      skillLoadingConfig: {
        lazy: ['gmail-skill', 'calendar-skill']
      }
    }),
    definePack({
      id: 'calendar-tools',
      name: 'Calendar Tools',
      description: 'Calendar query integration',
      tools: [createCalendarTool()]
    })
  ]

  if (sqlitePack) {
    agentPacks.push(sqlitePack)
  }

  if (gmailTool) {
    agentPacks.push(definePack({
      id: 'gmail-tools',
      name: 'Gmail Tools',
      description: 'Gmail write operations (mark read, star, send, reply)',
      tools: [gmailTool],
      policies: [noGmailDelete]
    }))
  }

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
    policies: [userTodoPolicy],
    packs: agentPacks,
    onStream,
    onToolCall: (name: string, args: unknown) => {
      onToolCall?.(name, args)
      if (debug) {
        console.log(`  [Tool] ${name}(${JSON.stringify(args).slice(0, 120)}...)`)
      }
    },
    onToolResult: (tool: string, result: unknown, args?: unknown) => {
      persistToolArtifacts({ projectPath, sessionId, tool, args, result })
      onToolResult?.(tool, result, args)
    },
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
      priorityTools: ['read', 'write', 'edit', 'grep', 'glob', 'sqlite_read_query', 'artifact-search']
    },
    toolLoopThreshold: 15,
    maxConsecutiveToolRounds: 20,
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
        const hasModuleIntent = ['email', 'calendar', 'docs', 'memory', 'scheduler'].some(i => intents.has(i as IntentLabel))
        if (!hasModuleIntent) {
          const label = await classifyIntentWithLLM(intentRouterClient, message)
          if (label !== 'general') intents.add(label)
        }

        preloadSkillsForIntents(intents, agent.runtime.skillManager)

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
