/**
 * Coordinator Agent
 *
 * Main chat agent using the framework's context pipeline:
 * - Project Cards synced to memoryStorage → project-cards phase (reserved budget)
 * - WorkingSet built per turn from disk index → workingset phase (percentage budget)
 * - @-mentions: entity mentions → workingset, file/url mentions → selected phase
 * - Session memory (ephemeral) via kvMemory namespace="session"
 * - Token budgeting, history compression, and ctx-expand come for free
 */

import os from 'os'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { createAgent, packs, definePack, defineTool } from '@framework/index.js'
import { createLLMClientFromModelId } from '@framework/llm/index.js'
import { applyProjectCardPolicy } from '@framework/core/project-card-policy.js'
import { generateSummaryCard } from '@framework/core/summary-card.js'
import { createSaveNoteTool, createSaveDocTool, createUpdateNoteTool, createToggleCompleteTool } from '../tools/entity-tools.js'
import { createCalendarTool } from '../tools/calendar-tool.js'
import { createGmailTool } from '../tools/gmail-tool.js'
import { noGmailDelete } from '../policies/no-gmail-delete.js'
import type { Agent } from '@framework/types/agent.js'
import type { Policy } from '@framework/types/policy.js'
import type { ContextSelection } from '@framework/types/context-pipeline.js'
import { PATHS, Entity, Note, Todo, Doc } from '../types.js'
import type { EntityIndex, WorkingSetResolvedEntity } from '@framework/context/index.js'
import type { ResolvedMention } from '../mentions/index.js'
import { countTokens } from '@framework/utils/tokenizer.js'
import { loadPrompt } from './prompts/index.js'
import { getWorkingSetIds } from '../commands/select.js'

/**
 * System prompt for the coordinator (loaded from prompts/coordinator-system)
 */
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

const INTENT_MODULES: Partial<Record<IntentLabel, string>> = {
  email: 'coordinator-module-email',
  calendar: 'coordinator-module-calendar',
  docs: 'coordinator-module-docs',
  memory: 'coordinator-module-memory',
  scheduler: 'coordinator-module-scheduler'
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
  if (name === 'literature-search') return 'summary + file paths'
  if (name === 'data-analyze') return 'outputs/manifest'
  if (name.startsWith('brave_')) return 'ranked results'
  if (name.startsWith('sqlite_')) return 'JSON text'
  if (name.startsWith('todo-')) return 'internal task (progress)'
  if (name.startsWith('memory-')) return 'memory item'
  if (name === 'gmail') return 'gmail action result'
  if (name === 'calendar') return 'events text'
  if (name.startsWith('save-') || name.startsWith('update-') || name === 'toggle-complete' || name === 'toggle-pin') return 'entity result'
  if (name === 'ctx-get') return 'rendered context'
  if (name === 'ctx-expand') return 'expanded context'
  if (name === 'bash') return 'stdout/stderr'
  return 'result'
}

function buildToolContracts(toolRegistry: { getAll: () => Array<{ name: string; parameters?: Record<string, { required?: boolean }> }> }): string {
  const tools = toolRegistry.getAll().slice().sort((a, b) => a.name.localeCompare(b.name))
  const lines: string[] = ['## Tool contracts (minimal)']
  for (const tool of tools) {
    const params = tool.parameters ?? {}
    const names = Object.entries(params).map(([name, def]) => {
      let label = def?.required === false ? `${name}?` : name
      if (tool.name === 'memory-put' && name === 'value') {
        label = def?.required === false ? `${name}?(JSON string)` : `${name}(JSON string)`
      }
      return label
    })
    const argList = names.length > 0 ? `{ ${names.join(', ')} }` : '{}'
    lines.push(`- ${tool.name}(${argList}) → ${describeToolReturn(tool.name)}`)
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

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load all entities from a directory on disk
 */
function loadEntitiesFromDisk(dir: string): Entity[] {
  if (!existsSync(dir)) return []

  const entities: Entity[] = []
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8')
      entities.push(JSON.parse(content) as Entity)
    } catch {
      // Skip invalid files
    }
  }

  return entities
}

/**
 * Format entity as human-readable text for context
 */
function formatEntityForContext(entity: Entity): string {
  if (entity.type === 'note') {
    const note = entity as Note
    const tags = note.tags.length > 0 ? `\nTags: ${note.tags.join(', ')}` : ''
    return `### Note: ${note.title}${tags}\n\n${note.content}`
  }

  if (entity.type === 'todo') {
    const todo = entity as Todo
    const tags = todo.tags.length > 0 ? `\nTags: ${todo.tags.join(', ')}` : ''
    const statusLabel = todo.status === 'completed' ? '[COMPLETED]' : '[PENDING]'
    return `### Todo ${statusLabel}: ${todo.title}${tags}\n\n${todo.content}`
  }

  if (entity.type === 'doc') {
    const doc = entity as Doc
    const desc = doc.description ? `\nDescription: ${doc.description}` : ''
    const mime = doc.mimeType ? ` (${doc.mimeType})` : ''
    return `### Doc: ${doc.title}${mime}\nFile: ${doc.filePath}${desc}`
  }

  return `### ${entity.type}: ${entity.id}`
}

const PROJECT_CARD_NAMESPACE = 'project'

function getEntityTitle(entity: Entity): string {
  return entity.title
}

function getEntityDir(entity: Entity): string {
  switch (entity.type) {
    case 'note': return PATHS.notes
    case 'todo': return PATHS.todos
    case 'doc': return PATHS.docs
    default: return PATHS.notes
  }
}

function writeEntityToDisk(entity: Entity, projectPath: string): void {
  const dir = join(projectPath, getEntityDir(entity))
  const filePath = join(dir, `${entity.id}.json`)
  writeFileSync(filePath, JSON.stringify(entity, null, 2))
}

function extractSummaryInput(entity: Entity): { type: 'note' | 'task' | 'data'; title: string; content: string; tags: string[] } {
  if (entity.type === 'note') {
    const note = entity as Note
    return { type: 'note', title: note.title, content: note.content, tags: note.tags ?? [] }
  }
  if (entity.type === 'todo') {
    const todo = entity as Todo
    return { type: 'task', title: todo.title, content: todo.content, tags: todo.tags ?? [] }
  }
  const doc = entity as Doc
  const content = doc.description || `File: ${doc.filePath}`
  return { type: 'data', title: doc.title, content, tags: doc.tags ?? [] }
}

async function ensureSummaryCard(entity: Entity): Promise<boolean> {
  if (entity.summaryCard && entity.summaryCard.trim().length > 0) {
    return false
  }

  const input = extractSummaryInput(entity)
  const summary = await generateSummaryCard({
    type: input.type,
    title: input.title,
    content: input.content,
    tags: input.tags
  })

  entity.summaryCard = summary.summaryCard
  entity.summaryCardMethod = summary.method
  entity.summaryCardHash = summary.contentHash
  return true
}

async function normalizeEntities(projectPath: string, entities: Entity[], debug: boolean): Promise<Entity[]> {
  const changedIds = new Set<string>()

  for (const entity of entities) {
    let changed = false

    if ('pinned' in entity) {
      const legacyPinned = (entity as Record<string, unknown>).pinned === true
      if (!('projectCard' in entity)) {
        entity.projectCard = legacyPinned
      }
      if (legacyPinned && !entity.projectCardSource) {
        entity.projectCardSource = 'manual'
      }
      delete (entity as Record<string, unknown>).pinned
      changed = true
    }

    if ('selectedForAI' in entity) {
      delete (entity as Record<string, unknown>).selectedForAI
      changed = true
    }

    if (!('projectCard' in entity)) {
      entity.projectCard = false
      changed = true
    }

    if (entity.projectCard && !entity.projectCardSource) {
      entity.projectCardSource = 'manual'
      changed = true
    }

    if (await ensureSummaryCard(entity)) {
      changed = true
    }

    if (changed) {
      changedIds.add(entity.id)
    }
  }

  const { changes } = applyProjectCardPolicy(entities)
  if (changes.length > 0) {
    for (const change of changes) {
      changedIds.add(change.id)
    }
  }

  if (changedIds.size > 0) {
    const now = new Date().toISOString()
    for (const entity of entities) {
      if (!changedIds.has(entity.id)) continue
      entity.updatedAt = now
      writeEntityToDisk(entity, projectPath)
    }
    if (debug) {
      console.log(`[Context] Project Card policy updated ${changedIds.size} entities`)
    }
  }

  return entities
}

async function loadAndNormalizeEntities(projectPath: string, debug: boolean): Promise<Entity[]> {
  const allEntities: Entity[] = [
    ...loadEntitiesFromDisk(join(projectPath, PATHS.notes)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.todos)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.docs))
  ]
  return normalizeEntities(projectPath, allEntities, debug)
}

async function buildEntityIndex(projectPath: string, debug: boolean): Promise<EntityIndex[]> {
  const entities = await loadAndNormalizeEntities(projectPath, debug)
  return entities.map(entity => ({
    id: entity.id,
    title: getEntityTitle(entity),
    tags: entity.tags ?? [],
    summaryCard: entity.summaryCard ?? getEntityTitle(entity),
    projectCard: entity.projectCard ?? false,
    type: entity.type,
    updatedAt: entity.updatedAt
  }))
}

function findEntityById(entityId: string, projectPath: string): { entity: Entity; filePath: string } | null {
  const dirs = [PATHS.notes, PATHS.todos, PATHS.docs].map(p => join(projectPath, p))

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = join(dir, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity
        if (entity.id === entityId || entity.id.startsWith(entityId) || file.includes(entityId)) {
          return { entity, filePath }
        }
      } catch {
        // skip
      }
    }
  }

  return null
}

async function resolveWorkingSetEntity(
  entityId: string,
  projectPath: string,
  debug: boolean
): Promise<WorkingSetResolvedEntity | null> {
  const result = findEntityById(entityId, projectPath)
  if (!result) return null

  const { entity } = result

  let changed = false
  if (!('projectCard' in entity)) {
    entity.projectCard = false
    changed = true
  }
  if (await ensureSummaryCard(entity)) {
    changed = true
  }
  if (changed) {
    entity.updatedAt = new Date().toISOString()
    writeEntityToDisk(entity, projectPath)
    if (debug) {
      console.log(`[Context] Updated summaryCard for ${entity.id.slice(0, 8)}`)
    }
  }

  const title = getEntityTitle(entity)
  const summary = entity.summaryCard ?? title
  const cardContent = `### ${title}\n\n${summary}`

  return {
    id: entity.id,
    title,
    tags: entity.tags ?? [],
    summaryCard: entity.summaryCard,
    projectCard: entity.projectCard ?? false,
    type: entity.type,
    content: {
      full: formatEntityForContext(entity),
      card: cardContent,
      indexLine: `- ${title} [id:${entity.id}]`
    }
  }
}

/**
 * Build ContextSelection[] from disk entities.
 * Project Cards are synced to memoryStorage separately for the framework's project-cards phase.
 * WorkingSet is built at runtime from explicit selections + query, not from entity fields.
 *
 * RFC-009: selectedForAI field is no longer used - WorkingSet is runtime-only.
 */
/**
 * Sync Project Cards (long-term memory entities) from disk to memoryStorage.
 * RFC-009: Project Cards get reserved budget and are budgeted via project-cards phase.
 *
 * Legacy 'pinned' fields are migrated to projectCard during normalization.
 */
async function syncProjectCardsToMemoryStorage(
  projectPath: string,
  memoryStorage: any,
  debug: boolean
): Promise<void> {
  const allEntities = await loadAndNormalizeEntities(projectPath, debug)
  const projectCards = allEntities.filter(e => e.projectCard)

  // Get existing project-card items in memoryStorage to detect removals
  const existing = await memoryStorage.list({ namespace: PROJECT_CARD_NAMESPACE, tags: ['project-card'], status: 'active' })
  const existingKeys = new Set(existing.items.map((i: any) => i.key))
  const legacyExisting = await memoryStorage.list({ namespace: 'pinned', tags: ['project-card'], status: 'active' })
  const legacyKeys = new Set(legacyExisting.items.map((i: any) => i.key))

  // Upsert current project card entities
  const currentKeys = new Set<string>()
  for (const entity of projectCards) {
    // Memory keys must start with a letter; use {type}.{uuid} format
    const key = `${entity.type}.${entity.id.toLowerCase()}`
    currentKeys.add(key)
    const content = formatEntityForContext(entity)
    await memoryStorage.put({
      namespace: PROJECT_CARD_NAMESPACE,
      key,
      value: { entityId: entity.id, type: entity.type, title: getEntityTitle(entity) },
      valueText: content,
      tags: ['project-card', entity.type],
      overwrite: true
    })
  }

  // Remove items that are no longer project cards
  for (const oldKey of existingKeys) {
    if (!currentKeys.has(oldKey)) {
      await memoryStorage.delete(PROJECT_CARD_NAMESPACE, oldKey, 'removed-from-project-cards')
    }
  }
  // Clean legacy namespace to avoid duplicates
  for (const oldKey of legacyKeys) {
    if (!currentKeys.has(oldKey)) {
      await memoryStorage.delete('pinned', oldKey, 'removed-from-project-cards')
    } else {
      await memoryStorage.delete('pinned', oldKey, 'project-cards-namespace-migrated')
    }
  }

  if (debug) {
    console.log(`[Context] Synced ${projectCards.length} project cards to memoryStorage`)
  }
}

/**
 * Extract WorkingSet entity IDs from resolved @-mentions.
 * Entity mentions (note/doc) go to the WorkingSet, not selected context.
 */
function getMentionWorkingSetIds(mentions?: ResolvedMention[]): string[] {
  if (!mentions || mentions.length === 0) return []

  const ids: string[] = []
  for (const mention of mentions) {
    if (mention.error) continue
    if ((mention.ref.type === 'note' || mention.ref.type === 'doc') && mention.entityId) {
      ids.push(mention.entityId)
    }
  }
  return ids
}

/**
 * Build ContextSelection[] from resolved @-mentions.
 * Non-entity mentions (file/url) are still injected via selected context.
 */
function buildMentionSelections(mentions?: ResolvedMention[]): ContextSelection[] {
  if (!mentions || mentions.length === 0) return []

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

/**
 * Build ContextSelection[] from bootstrap memory files (USER.md, MEMORY.md, daily logs).
 * These are injected as selected context every turn so the agent always has memory access.
 */
function buildBootstrapSelections(projectPath: string): ContextSelection[] {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  const files = [
    { path: PATHS.userProfile, maxChars: 5000 },
    { path: PATHS.memoryFile, maxChars: 20000 },
    { path: `${PATHS.memory}/${fmt(today)}.md`, maxChars: 10000 },
    { path: `${PATHS.memory}/${fmt(yesterday)}.md`, maxChars: 10000 },
  ]

  return files
    .filter(f => existsSync(join(projectPath, f.path)))
    .map(f => ({
      type: 'custom' as const,
      ref: `bootstrap:${f.path}`,
      resolve: async () => {
        let content = readFileSync(join(projectPath, f.path), 'utf-8')
        if (content.length > f.maxChars) {
          content = content.slice(0, f.maxChars) + '\n\n_(truncated)_'
        }
        return { source: `bootstrap:${f.path}`, content, tokens: countTokens(content) }
      }
    }))
}

// ============================================================================
// Coordinator
// ============================================================================

export interface CoordinatorConfig {
  apiKey: string
  model?: string
  projectPath?: string
  debug?: boolean
  /** Persistent session ID for history continuity across restarts */
  sessionId?: string
  /** Optional path to a SQLite database for email/calendar access */
  emailDbPath?: string
  /** Reasoning effort level for GPT-5 models ('high' | 'medium' | 'low') */
  reasoningEffort?: 'high' | 'medium' | 'low'
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
  /** Callback fired after each LLM call with token usage and cost info */
  onUsage?: (usage: any, cost: any) => void
}

export async function createCoordinator(config: CoordinatorConfig): Promise<{
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  clearSessionMemory: () => Promise<void>
  destroy: () => Promise<void>
}> {
  const { apiKey, model, projectPath = process.cwd(), debug = false, sessionId, reasoningEffort = 'high', onStream, onToolCall, onToolResult, onUsage } = config
  // Resolve ~ to the user's home directory (dotenv / Node don't expand shell tilde)
  const emailDbPath = config.emailDbPath?.replace(/^~(?=\/|$)/, os.homedir())

  // Flag to guard against using internal todo tools for user-facing tasks
  let userTodoIntent = false
  const userTodoPolicy: Policy = {
    id: 'deny-internal-todo-for-user',
    description: 'Block todo-* tools when the user requests user-facing Todos',
    phase: 'guard',
    match: (ctx) => userTodoIntent && ctx.tool.startsWith('todo-'),
    decide: () => ({
      action: 'deny',
      reason: 'User-facing tasks must be saved via save-note({ type: "todo", ... }) (Todos tab).'
    })
  }

  // Cheap intent router (fallback only when no strong rule-based signals)
  let intentRouterClient: ReturnType<typeof createLLMClientFromModelId> | null = null
  try {
    intentRouterClient = createLLMClientFromModelId('gpt-5-nano', { apiKey })
  } catch (err) {
    if (debug) {
      console.warn('[IntentRouter] Failed to init gpt-5-nano:', err)
    }
  }

  // Create entity tools for saving, updating notes and docs
  const saveNoteTool = createSaveNoteTool(sessionId || crypto.randomUUID(), projectPath)
  const saveDocTool = createSaveDocTool(sessionId || crypto.randomUUID(), projectPath)
  const updateNoteTool = createUpdateNoteTool(projectPath)

  // Initialize MarkItDown MCP pack for document processing (PDF, Word, Excel, PPT, images)
  const documentsPack = await packs.documents({ timeout: 90000 })

  // Find the raw convert_to_markdown tool from the MCP pack
  const rawConvertTool = documentsPack.tools?.find(t => t.name === 'convert_to_markdown')

  // Wrapper: calls convert_to_markdown, saves full output to a local .md file,
  // and returns just the file path + stats so the LLM can read it with offset/limit.
  const convertToMarkdownTool = defineTool({
    name: 'convert_to_markdown',
    description: 'Convert a document (PDF, Word, Excel, PPT, images, etc.) to markdown. ' +
      'Saves the extracted text to a local .md file and returns the file path. ' +
      'Returns a preview (head/tail/outline) so you can navigate with read({ path, offset, limit }) for specific sections. ' +
      'Pass a relative filename, e.g. convert_to_markdown({ path: "report.pdf" }).',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative path to the document file (e.g. "report.pdf")',
        required: true
      }
    },
    execute: async (input: { path: string }, context) => {
      if (!rawConvertTool) {
        return { success: false, error: 'convert_to_markdown MCP tool not available' }
      }

      const fileName = input.path
      const absPath = join(process.cwd(), fileName)
      if (!existsSync(absPath)) {
        return { success: false, error: `File not found: ${fileName}` }
      }

      // Call the underlying MCP tool with proper file:// URI
      const uri = `file://${absPath}`
      const result = await rawConvertTool.execute({ uri }, context)
      if (!result.success) {
        return result
      }

      // Extract text content from MCP result
      const data = result.data as { text?: string } | undefined
      const text = data?.text || ''
      if (!text) {
        return { success: false, error: 'No text extracted from document' }
      }

      // Write to local .md file
      const outputName = basename(fileName, '.pdf') + '.extracted.md'
      const outputPath = join(process.cwd(), outputName)
      writeFileSync(outputPath, text, 'utf-8')
      const allLines = text.split('\n')
      const lines = allLines.length

      // Build structural preview so the LLM can navigate without blind grep
      const headings = allLines
        .map((l, i) => ({ line: i + 1, text: l }))
        .filter(({ text: t }) => /^#{1,4}\s/.test(t))
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
          message: `Extracted ${lines} lines. Head/tail preview and outline included in result. Use read({ path: "${outputName}", offset, limit }) for specific sections. Do NOT grep for structure — use the preview.`
        }
      }
    }
  })

  // Initialize web pack for general-purpose web search (brave_web_search, fetch)
  const webPack = await packs.web({ timeout: 30000 })

  // Optional SQLite pack for email/calendar database access
  // RFC-002: will be used for long-term memory and email integration
  let sqlitePack: any = null
  if (emailDbPath) {
    try {
      sqlitePack = await packs.sqlite({ dbPath: emailDbPath, toolPrefix: 'sqlite' })
    } catch (err) {
      console.warn(`[Coordinator] Failed to initialize SQLite pack for "${emailDbPath}":`, err)
    }
  }

  // Create memory directory on init
  const memoryDir = join(projectPath, PATHS.memory)
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true })
  }

  // Seed MEMORY.md if it doesn't exist
  const memoryFilePath = join(projectPath, PATHS.memoryFile)
  if (!existsSync(memoryFilePath)) {
    writeFileSync(memoryFilePath, `# Long-Term Memory

## Preferences
_(none yet)_

## Corrections
_(none yet)_

## Relationships
_(none yet)_

## Work
_(none yet)_

## Workflows
_(none yet)_
`, 'utf-8')
  }

  // Seed USER.md if it doesn't exist
  const userProfilePath = join(projectPath, PATHS.userProfile)
  if (!existsSync(userProfilePath)) {
    writeFileSync(userProfilePath, `# User Profile

- **Name:** _(unknown)_
- **Role:** _(unknown)_
- **Timezone:** _(unknown)_
- **Languages:** _(unknown)_
`, 'utf-8')
  }

  // Gmail tool for write operations (mark read, star, send, reply)
  const gmailTool = emailDbPath ? createGmailTool(emailDbPath) : null

  // Create toggle-complete tool for todos
  const toggleCompleteTool = createToggleCompleteTool(projectPath)

  const entityPack = definePack({
    id: 'entity-tools',
    name: 'Entity Tools',
    description: 'Note, todo, and document management tools',
    tools: [saveNoteTool, saveDocTool, updateNoteTool, toggleCompleteTool, createCalendarTool()]
  })

  const agentPacks = [
    packs.safe(),           // read, write, edit, glob, grep
    packs.kvMemory(),       // session memory (ephemeral scratchpad via namespace=session)
    packs.todo(),           // todo-add, todo-update, todo-complete, todo-remove
    packs.sessionHistory(), // messageStore for cross-turn history persistence
    packs.contextPipeline(), // ctx-expand, history compression, 5-phase assembly
    definePack({
      id: 'documents-wrapper',
      description: 'Document conversion (saves to local file)',
      tools: [convertToMarkdownTool as any]
    }),
    webPack,                // brave_web_search, fetch for general web queries
    entityPack,             // save-note, save-doc, update-note
  ]

  // Add SQLite pack if available
  if (sqlitePack) {
    agentPacks.push(sqlitePack)
  }

  // Add Gmail tool pack if email DB is available
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
        console.log(`  [Tool] ${name}(${JSON.stringify(args).slice(0, 80)}...)`)
      }
    },
    onToolResult,
    sessionId,
    debug,

    // Budget management
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
      priorityTools: ['read', 'write', 'edit', 'grep', 'glob',
                      'sqlite_read_query', 'sqlite_list_tables']
    },

    toolLoopThreshold: 15,
    maxConsecutiveToolRounds: 20,

    // Token usage tracking
    onUsage,

    // Pre-compaction flush: save important context to daily log before compaction
    onPreCompaction: async (agentRef) => {
      const today = new Date().toISOString().slice(0, 10)
      const logPath = `${PATHS.memory}/${today}.md`
      await agentRef.run(
        '[SYSTEM] Context approaching limit. Review the conversation and write any ' +
        'important context, decisions, facts, or preferences to today\'s daily log ' +
        `(${logPath}) before compaction occurs. Use edit() to append to the file.`
      )
    }
  })

  // Initialize packs eagerly so memoryStorage is available before first run()
  await agent.ensureInit()
  agent.runtime.entityIndexProvider = async () => buildEntityIndex(projectPath, debug)
  agent.runtime.entityResolver = async (id: string) => resolveWorkingSetEntity(id, projectPath, debug)

  // Build minimal tool contracts from actual tool schemas
  const toolContracts = buildToolContracts(agent.runtime.toolRegistry as any)

  // Helper: clear all items in the 'session' namespace
  async function clearSessionMemory() {
    const storage = (agent.runtime as any).memoryStorage
    if (!storage) return
    const { items } = await storage.list({ namespace: 'session', status: 'active' })
    for (const item of items) {
      await storage.delete('session', item.key, 'session-clear')
    }
  }

  // Clear ephemeral session memory from previous run
  await clearSessionMemory()

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[]) {
      try {
        // RFC-009: Sync project cards to memoryStorage for framework's project-cards-phase (reserved ∞ budget)
        const storage = (agent.runtime as any).memoryStorage
        if (storage) {
          await syncProjectCardsToMemoryStorage(projectPath, storage, debug)
        }

        // Intent routing → inject minimal task modules per request
        const intents = detectIntentsByRules(message)
        userTodoIntent = /(todo|to-do|action items|tasks|task list|待办|清单|事项)/i.test(message)
        const hasModuleIntent = ['email', 'calendar', 'docs', 'memory', 'scheduler'].some(i => intents.has(i as IntentLabel))
        if (!hasModuleIntent) {
          const label = await classifyIntentWithLLM(intentRouterClient, message)
          if (label !== 'general') intents.add(label)
        }
        const additionalInstructions = buildAdditionalInstructions(intents, toolContracts)

        // RFC-009: WorkingSet is built from explicit selections + query each turn
        const mentionSelections = buildMentionSelections(mentions)
        const bootstrapSelections = buildBootstrapSelections(projectPath)

        const selectedContext = [...bootstrapSelections, ...mentionSelections]
        const mentionWorkingSetIds = getMentionWorkingSetIds(mentions)
        const workingSetIds = Array.from(new Set([
          ...getWorkingSetIds(sessionId || 'default'),
          ...mentionWorkingSetIds
        ]))

        if (debug) {
          const intentList = Array.from(intents).join(', ') || 'none'
          console.log(`[Chat] Intents: ${intentList}`)
          console.log(`[Chat] Sending message to agent (${mentionSelections.length} mention selections, ${bootstrapSelections.length} bootstrap selections, ${workingSetIds.length} WorkingSet IDs)...`)
        }

        // RFC-009: Session memory is now budgeted via state-summary-phase, no prefix injection needed
        const result = await agent.run(message, {
          ...(selectedContext.length > 0 && { selectedContext }),
          workingSet: {
            explicitIds: workingSetIds,
            query: message
          },
          ...(additionalInstructions ? { additionalInstructions } : {})
        })

        if (debug) {
          console.log(`[Chat] Result: success=${result.success}, hasOutput=${!!result.output}`)
        }

        // RFC-002: onAfterChat hook will be added here
        // (reserved for auto-summary on conversation end, daily log append, etc.)

        if (result.success) {
          const workingSetRuntime = agent.runtime.sessionState.get('workingSetRuntime')
          return { success: true, response: result.output, workingSetRuntime }
        } else {
          const errorMsg = result.error || 'Agent failed (no error message)'
          return { success: false, error: errorMsg }
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

// Legacy export
export { createCoordinator as createCoordinatorRunner }
