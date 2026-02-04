/**
 * Coordinator Agent
 *
 * Main chat agent using the framework's context pipeline:
 * - Pinned entities synced to memoryStorage → framework's pinned-phase (reserved ∞ budget)
 * - Selected (non-pinned) entities loaded as ContextSelections → selected-phase (30% budget)
 * - @-mentions passed as selectedContext for the selected phase
 * - Session memory (ephemeral) via kvMemory namespace="session"
 * - Token budgeting, history compression, and ctx-expand come for free
 */

import os from 'os'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { createAgent, packs, definePack, defineTool } from '@framework/index.js'
import { createSaveNoteTool, createSaveDocTool, createUpdateNoteTool, createToggleCompleteTool } from '../tools/entity-tools.js'
import { createCalendarTool } from '../tools/calendar-tool.js'
import { createGmailTool } from '../tools/gmail-tool.js'
import { noGmailDelete } from '../policies/no-gmail-delete.js'
import type { Agent } from '@framework/types/agent.js'
import type { ContextSelection } from '@framework/types/context-pipeline.js'
import { PATHS, Entity, Note, Todo, Doc } from '../types.js'
import type { ResolvedMention } from '../mentions/index.js'
import { countTokens } from '@framework/utils/tokenizer.js'
import { loadPrompt } from './prompts/index.js'

/**
 * System prompt for the coordinator (loaded from prompts/coordinator-system)
 */
const SYSTEM_PROMPT = loadPrompt('coordinator-system')

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

/**
 * Build ContextSelection[] from disk entities that are selected (non-pinned).
 * Pinned entities are synced to memoryStorage separately for the framework's pinned-phase.
 */
function buildEntitySelections(projectPath: string, debug: boolean): ContextSelection[] {
  const allEntities: Entity[] = [
    ...loadEntitiesFromDisk(join(projectPath, PATHS.notes)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.todos)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.docs))
  ]

  // Pinned entities are handled via syncPinnedToMemoryStorage() → pinned-phase
  const selected = allEntities.filter(e => e.selectedForAI && !e.pinned)

  if (debug) {
    const pinned = allEntities.filter(e => e.pinned)
    console.log(`[Context] Entities: ${allEntities.length} total, ${pinned.length} pinned (via memoryStorage), ${selected.length} selected`)
  }

  const toSelection = (entity: Entity, source: string): ContextSelection => ({
    type: 'custom' as const,
    ref: `${entity.type}:${entity.id}`,
    resolve: async () => {
      const content = formatEntityForContext(entity)
      return {
        source,
        content,
        tokens: countTokens(content)
      }
    }
  })

  // Only return non-pinned selected entities (pinned come through pinned-phase)
  return [
    ...selected.map(e => toSelection(e, `selected:${e.type}.${e.id}`))
  ]
}

/**
 * Sync pinned entities from disk to memoryStorage so the framework's pinned-phase can find them.
 * This gives pinned items reserved (infinite) budget instead of the 30% trimmable selected-phase budget.
 */
async function syncPinnedToMemoryStorage(
  projectPath: string,
  memoryStorage: any,
  debug: boolean
): Promise<void> {
  const allEntities: Entity[] = [
    ...loadEntitiesFromDisk(join(projectPath, PATHS.notes)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.todos)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.docs))
  ]
  const pinned = allEntities.filter(e => e.pinned)

  // Get existing pinned items in memoryStorage to detect removals
  const existing = await memoryStorage.list({ namespace: 'pinned', tags: ['pinned'], status: 'active' })
  const existingKeys = new Set(existing.items.map((i: any) => i.key))

  // Upsert current pinned entities
  const currentKeys = new Set<string>()
  for (const entity of pinned) {
    // Memory keys must start with a letter; use {type}.{uuid} format
    const key = `${entity.type}.${entity.id.toLowerCase()}`
    currentKeys.add(key)
    const content = formatEntityForContext(entity)
    await memoryStorage.put({
      namespace: 'pinned',
      key,
      value: { entityId: entity.id, type: entity.type, title: entity.title },
      valueText: content,
      tags: ['pinned', entity.type],
      overwrite: true
    })
  }

  // Remove items that are no longer pinned
  for (const oldKey of existingKeys) {
    if (!currentKeys.has(oldKey)) {
      await memoryStorage.delete('pinned', oldKey, 'unpinned')
    }
  }

  if (debug) {
    console.log(`[Context] Synced ${pinned.length} pinned entities to memoryStorage`)
  }
}

/**
 * Build ContextSelection[] from resolved @-mentions.
 */
function buildMentionSelections(mentions?: ResolvedMention[]): ContextSelection[] {
  if (!mentions || mentions.length === 0) return []

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

/**
 * Build ContextSelection[] from bootstrap memory files (USER.md, MEMORY.md, daily logs).
 * These are injected as pinned context every turn so the agent always has memory access.
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

  // Helper: clear all items in the 'session' namespace
  async function clearSessionMemory() {
    const storage = (agent.runtime as any).memoryStorage
    if (!storage) return
    const { items } = await storage.list({ namespace: 'session', status: 'active' })
    for (const item of items) {
      await storage.delete('session', item.key, 'session-clear')
    }
  }

  // Helper: build session memory context string for injection
  async function buildSessionMemoryContext(): Promise<string> {
    const storage = (agent.runtime as any).memoryStorage
    if (!storage) return ''
    const { items } = await storage.list({ namespace: 'session', status: 'active' })
    if (items.length === 0) return ''

    const now = Date.now()
    const lines = items.map((item: any) => {
      const ago = Math.round((now - new Date(item.updatedAt).getTime()) / 60000)
      const timeLabel = ago < 1 ? 'just now' : `${ago}min ago`
      const val = typeof item.value === 'string' ? item.value : (item.valueText || JSON.stringify(item.value))
      return `- ${item.key}: ${val} (${timeLabel})`
    })
    return `## Session Memory\n${lines.join('\n')}`
  }

  // Clear ephemeral session memory from previous run
  await clearSessionMemory()

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[]) {
      try {
        // Sync pinned entities to memoryStorage for framework's pinned-phase (reserved ∞ budget)
        const storage = (agent.runtime as any).memoryStorage
        if (storage) {
          await syncPinnedToMemoryStorage(projectPath, storage, debug)
        }

        // Build context selections (non-pinned only, pinned come through pinned-phase now)
        const entitySelections = buildEntitySelections(projectPath, debug)
        const mentionSelections = buildMentionSelections(mentions)
        const bootstrapSelections = buildBootstrapSelections(projectPath)

        const selectedContext = [...entitySelections, ...bootstrapSelections, ...mentionSelections]

        // Build session memory context for injection
        const sessionMemoryCtx = await buildSessionMemoryContext()

        if (debug) {
          console.log(`[Chat] Sending message to agent (${entitySelections.length} entity, ${mentionSelections.length} mention selections, sessionMemory=${sessionMemoryCtx.length > 0})...`)
        }

        // Prepend session memory to message so agent always sees it
        const augmentedMessage = sessionMemoryCtx
          ? `${sessionMemoryCtx}\n\n---\n\n${message}`
          : message

        const result = await agent.run(augmentedMessage, {
          ...(selectedContext.length > 0 && { selectedContext })
        })

        if (debug) {
          console.log(`[Chat] Result: success=${result.success}, hasOutput=${!!result.output}`)
        }

        // RFC-002: onAfterChat hook will be added here
        // (reserved for auto-summary on conversation end, daily log append, etc.)

        if (result.success) {
          return { success: true, response: result.output }
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
