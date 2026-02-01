/**
 * Coordinator Agent
 *
 * Main chat agent using the framework's context pipeline:
 * - Pinned/selected entities loaded directly from disk as ContextSelections
 * - @-mentions passed as selectedContext for the selected phase
 * - Session memory (ephemeral) via kvMemory namespace="session"
 * - Token budgeting, history compression, and ctx-expand come for free
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { createAgent, packs, definePack, defineTool } from '../../../src/index.js'
import { createSaveNoteTool, createSaveDocTool, createUpdateNoteTool } from '../tools/entity-tools.js'
import type { Agent } from '../../../src/types/agent.js'
import type { ContextSelection } from '../../../src/types/context-pipeline.js'
import { PATHS, Entity, Note, Doc } from '../types.js'
import type { ResolvedMention } from '../mentions/index.js'
import { countTokens } from '../../../src/utils/tokenizer.js'
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

  if (entity.type === 'doc') {
    const doc = entity as Doc
    const desc = doc.description ? `\nDescription: ${doc.description}` : ''
    const mime = doc.mimeType ? ` (${doc.mimeType})` : ''
    return `### Doc: ${doc.title}${mime}\nFile: ${doc.filePath}${desc}`
  }

  return `### ${entity.type}: ${entity.id}`
}

/**
 * Build ContextSelection[] from disk entities that are pinned or selected.
 * Reads directly from disk — no kvMemory middleman.
 */
function buildEntitySelections(projectPath: string, debug: boolean): ContextSelection[] {
  const allEntities: Entity[] = [
    ...loadEntitiesFromDisk(join(projectPath, PATHS.notes)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.docs))
  ]

  const pinned = allEntities.filter(e => e.pinned)
  const selected = allEntities.filter(e => e.selectedForAI && !e.pinned)

  if (debug) {
    console.log(`[Context] Entities: ${allEntities.length} total, ${pinned.length} pinned, ${selected.length} selected`)
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

  return [
    ...pinned.map(e => toSelection(e, `pinned:${e.type}.${e.id}`)),
    ...selected.map(e => toSelection(e, `selected:${e.type}.${e.id}`))
  ]
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
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
}

export async function createCoordinator(config: CoordinatorConfig): Promise<{
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  clearSessionMemory: () => Promise<void>
  destroy: () => Promise<void>
}> {
  const { apiKey, model, projectPath = process.cwd(), debug = false, sessionId, emailDbPath, onStream, onToolCall, onToolResult } = config

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
      if (debug) {
        console.warn(`[Coordinator] Failed to initialize SQLite pack for ${emailDbPath}:`, err)
      }
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

  const entityPack = definePack({
    id: 'entity-tools',
    name: 'Entity Tools',
    description: 'Note and document saving tools',
    tools: [saveNoteTool, saveDocTool, updateNoteTool]
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

  const agent = createAgent({
    apiKey,
    model,
    projectPath,
    reasoningEffort: 'high',
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
        // Build context selections directly from disk (no kvMemory middleman)
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
