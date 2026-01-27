/**
 * Coordinator Agent
 *
 * Main chat agent with context pipeline integration:
 * - Uses createAgent from the framework
 * - Reads pinned/selected entities directly from JSON files
 * - File tools (read, write, glob, grep) + ctx-expand
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createAgent, packs } from '../../../src/index.js'
import type { Agent } from '../../../src/types/agent.js'
import { PATHS, Entity, Note, Literature, DataAttachment } from '../types.js'
import type { ResolvedMention } from '../mentions/index.js'

/**
 * System prompt for the coordinator
 */
const SYSTEM_PROMPT = `You are Research Pilot, an AI research assistant that helps users manage their research projects.

## Your Capabilities

1. **Research Assistance**: Answer questions, synthesize information, help with analysis
2. **File Access**: You can read and search research entities using the file tools
3. **Context Awareness**: Pinned and selected entities are automatically included in your context

## File Storage Conventions

Research entities are stored as JSON files:
- Notes: ${PATHS.notes}/<id>.json
- Literature: ${PATHS.literature}/<id>.json
- Data: ${PATHS.data}/<id>.json

## Using File Tools

To list entities: glob("${PATHS.notes}/*.json")
To read an entity: read("${PATHS.notes}/<id>.json")
To search: grep("search term", "${PATHS.notes}")

## Best Practices

- Be concise and focused
- When providing insights worth saving, remind users about /save-note --from-last
- Use glob/read to access entity content
- Cite sources when discussing literature`

// ============================================================================
// Helper Functions (Direct Implementation, No Phase Abstraction)
// ============================================================================

/**
 * Load all entities from a directory
 */
function loadEntities(dir: string): Entity[] {
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
 * Format entity for context
 */
function formatEntity(entity: Entity): string {
  if (entity.type === 'note') {
    const note = entity as Note
    const tags = note.tags.length > 0 ? `\nTags: ${note.tags.join(', ')}` : ''
    return `### Note: ${note.title}${tags}\n\n${note.content}`
  }

  if (entity.type === 'literature') {
    const lit = entity as Literature
    const authors = lit.authors.slice(0, 3).join(', ')
    return `### [${lit.citeKey}] ${lit.title}\nAuthors: ${authors}${lit.year ? ` (${lit.year})` : ''}\n\n${lit.abstract}`
  }

  if (entity.type === 'data') {
    const data = entity as DataAttachment
    const schema = data.schema?.columns
      ? `\nColumns: ${data.schema.columns.map(c => c.name).join(', ')}`
      : ''
    return `### Data: ${data.name}\nFile: ${data.filePath}${schema}`
  }

  return `### ${entity.type}: ${entity.id}`
}

/**
 * Build context from pinned and selected entities
 */
function buildResearchContext(projectPath: string, debug: boolean): string {
  // Load all entities
  const allEntities: Entity[] = [
    ...loadEntities(join(projectPath, PATHS.notes)),
    ...loadEntities(join(projectPath, PATHS.literature)),
    ...loadEntities(join(projectPath, PATHS.data))
  ]

  const pinned = allEntities.filter(e => e.pinned)
  const selected = allEntities.filter(e => e.selectedForAI && !e.pinned)

  if (debug) {
    console.log(`[Context] Pinned: ${pinned.length}, Selected: ${selected.length}, Total: ${allEntities.length}`)
  }

  if (pinned.length === 0 && selected.length === 0) {
    return ''
  }

  const parts: string[] = []

  if (pinned.length > 0) {
    parts.push('## Pinned Context\n')
    parts.push(pinned.map(formatEntity).join('\n\n'))
  }

  if (selected.length > 0) {
    parts.push('## Selected Context\n')
    parts.push(selected.map(formatEntity).join('\n\n'))
  }

  // Add brief index of what's available
  if (allEntities.length > pinned.length + selected.length) {
    const other = allEntities.length - pinned.length - selected.length
    parts.push(`\n## Available (not in context)\n${other} more entities. Use /notes, /papers, /data to list.`)
  }

  return parts.join('\n\n')
}

/**
 * Build a context block from resolved @-mentions
 */
function buildMentionedContext(mentions?: ResolvedMention[]): string {
  if (!mentions || mentions.length === 0) return ''

  const parts: string[] = ['## Mentioned\n']

  for (const m of mentions) {
    if (m.error) {
      parts.push(`(Could not resolve: ${m.ref.raw}) — ${m.error}`)
    } else {
      parts.push(`### ${m.label}\n\n${m.content}`)
    }
  }

  return parts.join('\n\n')
}

// ============================================================================
// Coordinator
// ============================================================================

export interface CoordinatorConfig {
  apiKey: string
  model?: string
  projectPath?: string
  debug?: boolean
  onStream?: (text: string) => void
}

export function createCoordinator(config: CoordinatorConfig): {
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  destroy: () => Promise<void>
} {
  const { apiKey, model, projectPath = process.cwd(), debug = false, onStream } = config

  const agent = createAgent({
    apiKey,
    model,
    projectPath,
    identity: SYSTEM_PROMPT,
    packs: [
      packs.safe(),           // read, write, edit, glob, grep
      packs.contextPipeline() // ctx-expand, history compression
    ],
    onStream,
    ...(debug && {
      onToolCall: (name, args) => {
        console.log(`  [Tool] ${name}(${JSON.stringify(args).slice(0, 80)}...)`)
      }
    })
  })

  return {
    agent,

    async chat(message: string, mentions?: ResolvedMention[]) {
      try {
        // Build context from pinned/selected entities
        const context = buildResearchContext(projectPath, debug)

        // Build mentioned-context block from resolved mentions
        const mentionedContext = buildMentionedContext(mentions)

        // Prepend context if any
        const parts: string[] = []
        if (context) parts.push(`<research-context>\n${context}\n</research-context>`)
        if (mentionedContext) parts.push(`<mentioned-context>\n${mentionedContext}\n</mentioned-context>`)
        parts.push(context || mentionedContext ? `User: ${message}` : message)
        const fullMessage = parts.join('\n\n')

        if (debug) {
          console.log('[Chat] Sending message to agent...')
        }

        const result = await agent.run(fullMessage)

        if (debug) {
          console.log(`[Chat] Result: success=${result.success}, hasOutput=${!!result.output}`)
        }

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

    async destroy() {
      await agent.destroy()
    }
  }
}

// Legacy export
export { createCoordinator as createCoordinatorRunner }
