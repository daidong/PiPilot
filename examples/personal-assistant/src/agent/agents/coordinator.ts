/**
 * Coordinator Agent (Personal Assistant Memory Minimal Core)
 *
 * Key behavior:
 * - Canonical durable memory surface: Artifact
 * - Cross-turn continuity via Session Summary snapshots
 * - Context assembly uses mention selections + latest session summary
 */

import os from 'os'
import { basename, join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { createAgent, packs, definePack, defineTool } from '@framework/index.js'
import { createLLMClientFromModelId, getModel } from '@framework/llm/index.js'
import { createPersonalMemoryTools } from '../tools/entity-tools.js'
import { createCalendarTool } from '../tools/calendar-tool.js'
import { createGmailTool } from '../tools/gmail-tool.js'
import { noGmailDelete } from '../policies/no-gmail-delete.js'
import { PERSONAL_ASSISTANT_KERNEL_V2_CONFIG } from '../config/kernel-v2.js'
import type { Agent } from '@framework/types/agent.js'
import type { Policy } from '@framework/types/policy.js'
import type { ContextSelection } from '@framework/types/context-pipeline.js'
import type { Tool } from '@framework/types/tool.js'
import { countTokens } from '@framework/utils/tokenizer.js'
import { loadPrompt } from './prompts/index.js'
import { personalAssistantSkills } from '../../skills/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { AGENT_MD_ID, PATHS, type NoteArtifact, type SessionSummary } from '../types.js'
import {
  createArtifact,
  findArtifactById,
  readLatestSessionSummary,
  writeSessionSummary
} from '../memory-v2/store.js'

const SYSTEM_PROMPT = loadPrompt('coordinator-system')

type IntentLabel = 'email' | 'calendar' | 'docs' | 'memory' | 'scheduler' | 'web' | 'general'
type PersistenceDecision = 'ephemeral' | 'conditional' | 'persist-requested'

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
  scheduler: 'coordinator-module-scheduler'
}

const INTENT_SKILL_IDS: Partial<Record<IntentLabel, string>> = {
  email: 'gmail-skill',
  calendar: 'calendar-skill'
}

interface CoordinatorCapabilities {
  gmailWriteAvailable: boolean
  emailDbAvailable: boolean
  calendarAvailable: boolean
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
  if (name.startsWith('artifact-')) return 'artifact result'
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
  if (!skillManager || typeof skillManager.loadFully !== 'function') return
  for (const intent of intents) {
    const skillId = INTENT_SKILL_IDS[intent]
    if (skillId) {
      skillManager.loadFully(skillId)
    }
  }
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

function buildCapabilityGuidance(intents: Set<IntentLabel>, capabilities: CoordinatorCapabilities): string | undefined {
  const lines: string[] = []

  if (intents.has('email')) {
    lines.push('## Email capability')
    if (capabilities.emailDbAvailable) {
      lines.push('- Email database querying is available via sqlite_* tools. Use LIMIT and explicit columns.')
    } else {
      lines.push('- Email database querying is unavailable in this run. Avoid sqlite email workflows.')
    }
    if (capabilities.gmailWriteAvailable) {
      lines.push('- Gmail action tool is available for send/reply/mark/star operations.')
    } else {
      lines.push('- Gmail action tool is unavailable in this run. Explain the limitation and offer manual steps.')
    }
  }

  if (intents.has('calendar')) {
    lines.push('## Calendar capability')
    if (capabilities.calendarAvailable) {
      lines.push('- Calendar tool is available for schedule/event queries.')
    } else {
      lines.push('- Calendar tool is unavailable in this run. Explain limitation and suggest alternatives.')
    }
  }

  return lines.length > 0 ? lines.join('\n') : undefined
}

function buildAdditionalInstructions(
  intents: Set<IntentLabel>,
  toolContracts: string,
  capabilities: CoordinatorCapabilities
): string | undefined {
  const ordered = INTENT_PRIORITY.filter(i => intents.has(i)).slice(0, 2)
  const modules: string[] = [toolContracts]
  const capabilityGuidance = buildCapabilityGuidance(intents, capabilities)
  if (capabilityGuidance) {
    modules.push(capabilityGuidance)
  }

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

function buildMentionSelections(mentions?: ResolvedMention[]): ContextSelection[] {
  if (!mentions) return []

  return mentions
    .filter(m => !m.error)
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

function buildSessionSummarySelection(summary: SessionSummary): ContextSelection {
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
  const content = lines.join('\n')
  const tokens = countTokens(content)

  return {
    type: 'custom',
    ref: 'session:summary',
    resolve: async () => ({
      source: 'session:summary',
      content,
      tokens
    })
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

    if (tool !== 'calendar' && tool !== 'gmail') {
      return
    }

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

  let turnCount = 0
  let activeTurnToolCallCount: number | null = null
  const turnHistory: Array<{ userMessage: string; response: string; toolCallCount: number; timestamp: string }> = []

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
    : 'gpt-5.4-nano'

  let intentRouterClient: ReturnType<typeof createLLMClientFromModelId> | null = null
  try {
    intentRouterClient = createLLMClientFromModelId(intentRouterModelId, { apiKey })
  } catch (err) {
    if (debug) {
      console.warn(`[IntentRouter] Failed to init ${intentRouterModelId}:`, err)
    }
  }

  const wrappedOnToolResult = (tool: string, result: unknown, args?: unknown) => {
    if (activeTurnToolCallCount !== null) {
      activeTurnToolCallCount++
    }
    onToolResult?.(tool, result, args)
  }

  const memoryTools = createPersonalMemoryTools({
    sessionId,
    projectPath
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
      const absPath = join(projectPath, fileName)
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
      const outputPath = join(projectPath, outputName)
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
  const capabilities: CoordinatorCapabilities = {
    gmailWriteAvailable: !!gmailTool,
    emailDbAvailable: !!sqlitePack,
    calendarAvailable: true
  }

  const memoryPack = definePack({
    id: 'personal-memory-v2',
    description: 'Artifact memory surface for Personal Assistant',
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
      wrappedOnToolResult(tool, result, args)
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
    contextWindow,
    kernelV2: PERSONAL_ASSISTANT_KERNEL_V2_CONFIG
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

  async function maybeGenerateSummary(): Promise<void> {
    if (turnHistory.length === 0) return

    const isBaselineTrigger = turnCount % 5 === 0
    const last3 = turnHistory.slice(-3)
    const toolCallSum = last3.reduce((sum, t) => sum + t.toolCallCount, 0)
    const isHeavyToolUsage = last3.length >= 3 && toolCallSum > 15
    const responseCharSum = last3.reduce((sum, t) => sum + t.response.length, 0)
    const isLotsOfContent = last3.length >= 3 && responseCharSum > 8000

    if (!isBaselineTrigger && !isHeavyToolUsage && !isLotsOfContent) return
    if (!intentRouterClient) return

    const historyText = turnHistory
      .map((t, i) => `Turn ${turnCount - turnHistory.length + i + 1}: User: ${t.userMessage}\nAssistant: ${t.response}`)
      .join('\n\n')

    const prompt = [
      'Summarize this personal assistant conversation excerpt.',
      'Output JSON: {"summary":"<2-3 sentences>","topicsDiscussed":["topic1","topic2"],"openQuestions":["q1"]}',
      '',
      historyText
    ].join('\n')

    try {
      const result = await intentRouterClient.generate({
        system: 'You summarize assistant conversations. Output valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200
      })

      const text = result.text.trim()
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return

      const parsed = JSON.parse(jsonMatch[0]) as {
        summary: string
        topicsDiscussed: string[]
        openQuestions: string[]
      }

      const summary: SessionSummary = {
        sessionId,
        turnRange: [Math.max(1, turnCount - turnHistory.length + 1), turnCount],
        summary: parsed.summary,
        topicsDiscussed: parsed.topicsDiscussed ?? [],
        openQuestions: parsed.openQuestions ?? [],
        createdAt: new Date().toISOString()
      }

      writeSessionSummary(projectPath, summary)

      if (debug) {
        console.log(`[Summary] Generated session summary at turn ${turnCount}: ${parsed.summary.slice(0, 80)}...`)
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
        const hasModuleIntent = ['email', 'calendar', 'docs', 'memory', 'scheduler']
          .some(i => intents.has(i as IntentLabel))
        if (!hasModuleIntent) {
          const label = await classifyIntentWithLLM(intentRouterClient, message)
          if (label !== 'general') intents.add(label)
        }

        preloadSkillsForIntents(intents, agent.runtime.skillManager)

        const baseAdditionalInstructions = buildAdditionalInstructions(intents, toolContracts, capabilities)

        const agentMdRecord = findArtifactById(projectPath, AGENT_MD_ID)
        const agentMdContent = agentMdRecord?.artifact?.type === 'note'
          ? (agentMdRecord.artifact as NoteArtifact).content
          : ''
        const additionalInstructions = agentMdContent
          ? `## User Instructions (agent.md)\n\n${agentMdContent}\n\n${baseAdditionalInstructions ?? ''}`
          : baseAdditionalInstructions

        const persistence = classifyPersistenceDecision(message)

        const mentionSelections = buildMentionSelections(mentions)
        const latestSummary = readLatestSessionSummary(projectPath, sessionId)
        const summarySelection = latestSummary ? buildSessionSummarySelection(latestSummary) : null
        const summaryTokens = summarySelection
          ? countTokens(`Session summary (~${latestSummary!.turnRange[0]}-${latestSummary!.turnRange[1]})`)
          : 0

        const selectedContext: ContextSelection[] = [
          ...mentionSelections,
          ...(summarySelection ? [summarySelection] : [])
        ]

        const explain: TurnExplainSnapshot = {
          timestamp: new Date().toISOString(),
          sessionId,
          intents: Array.from(intents),
          selectedContext: {
            mentionSelections: mentionSelections.length,
            approxTokens: summaryTokens
          },
          persistence: {
            decision: persistence.decision,
            reason: persistence.reason
          },
          sessionSummary: {
            included: !!summarySelection,
            turnRange: latestSummary?.turnRange,
            approxTokens: summaryTokens
          },
          budget: {
            model: model ?? 'default'
          }
        }

        if (debug) {
          const intentList = Array.from(intents).join(', ') || 'none'
          console.log(`[Chat] Intents: ${intentList}`)
          console.log(`[Chat] Sending message to agent (${mentionSelections.length} mention selections, summary=${!!summarySelection})...`)
        }

        let perTurnToolCallCount = 0
        activeTurnToolCallCount = 0
        let result: Awaited<ReturnType<Agent['run']>>
        try {
          result = await agent.run(message, {
            ...(selectedContext.length > 0 ? { selectedContext } : {}),
            ...(additionalInstructions ? { additionalInstructions } : {})
          })
          perTurnToolCallCount = activeTurnToolCallCount ?? 0
        } finally {
          activeTurnToolCallCount = null
        }

        if (result.usage?.tokens) {
          explain.budget.promptTokens = result.usage.tokens.promptTokens
          explain.budget.completionTokens = result.usage.tokens.completionTokens
          explain.budget.totalTokens = result.usage.tokens.totalTokens
        }

        writeExplainSnapshot(projectPath, explain)

        turnCount++
        turnHistory.push({
          userMessage: message.slice(0, 300),
          response: (result.output ?? '').slice(0, 300),
          toolCallCount: perTurnToolCallCount,
          timestamp: new Date().toISOString()
        })
        if (turnHistory.length > 8) turnHistory.shift()

        void maybeGenerateSummary()

        if (debug) {
          console.log(`[Chat] Result: success=${result.success}, hasOutput=${!!result.output}, turn=${turnCount}`)
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
