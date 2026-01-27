/**
 * Coordinator Agent
 *
 * Main chat agent using the framework's 5-phase context pipeline:
 * - Syncs disk entities into kvMemory before each chat
 * - Pipeline auto-includes pinned/selected items via tags
 * - @-mentions passed as selectedContext for the selected phase
 * - Token budgeting, history compression, and ctx-expand come for free
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createAgent, packs, definePack } from '../../../src/index.js'
import { createSubagentTools } from './subagent-tools.js'
import type { Agent } from '../../../src/types/agent.js'
import type { Runtime } from '../../../src/types/runtime.js'
import type { ContextSelection } from '../../../src/types/context-pipeline.js'
import { PATHS, Entity, Note, Literature, DataAttachment } from '../types.js'
import type { ResolvedMention } from '../mentions/index.js'
import { countTokens } from '../../../src/utils/tokenizer.js'

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

## Subagent Tools

For research tasks requiring external knowledge:
- **literature-search**: Search academic papers on a topic. Input: { query: "..." }
  Returns structured summary with papers, themes, key findings, and research gaps.
- **data-analyze**: Analyze a dataset file. Input: { filePath: "...", question?: "..." }
  Returns schema, quality assessment, insights, and visualization suggestions.

Use these tools when the user asks to research a topic or analyze data.
Do NOT attempt to search the web manually — use literature-search instead.

## Best Practices

- Be concise and focused
- When providing insights worth saving, remind users about /save-note --from-last
- Use glob/read to access entity content
- Cite sources when discussing literature

## Task Planning

For non-trivial requests that require multiple steps (research, multi-file
analysis, complex synthesis, comparative work):
1. Create a plan of up to 10 tasks using todo-add BEFORE starting work
2. Update each task to in_progress as you begin it (todo-update)
3. Mark each task done when finished (todo-complete)

Skip planning for simple conversational questions or single-step answers.`

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
 * Sync disk entities into runtime.memoryStorage with pinned/selected tags.
 * The context pipeline's pinned phase auto-includes items tagged 'pinned',
 * and the selected phase auto-includes items tagged 'selected'.
 */
async function syncEntitiesToMemory(runtime: Runtime, projectPath: string, debug: boolean): Promise<void> {
  const storage = (runtime as any).memoryStorage
  if (!storage) {
    if (debug) console.log('[Sync] No memoryStorage on runtime, skipping sync')
    return
  }

  const allEntities: Entity[] = [
    ...loadEntitiesFromDisk(join(projectPath, PATHS.notes)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.literature)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.data))
  ]

  if (debug) {
    const pinned = allEntities.filter(e => e.pinned).length
    const selected = allEntities.filter(e => e.selectedForAI).length
    console.log(`[Sync] Entities: ${allEntities.length} total, ${pinned} pinned, ${selected} selected`)
  }

  for (const entity of allEntities) {
    const tags: string[] = []
    if (entity.pinned) tags.push('pinned')
    if (entity.selectedForAI && !entity.pinned) tags.push('selected')

    const valueText = formatEntityForContext(entity)

    await storage.put({
      namespace: 'research',
      key: `${entity.type}.${entity.id}`.toLowerCase(),
      value: entity,
      valueText,
      tags,
      sensitivity: 'public' as const,
      overwrite: true,
      provenance: { createdBy: 'system' }
    })
  }
}

/**
 * Build ContextSelection[] from resolved @-mentions.
 * These are passed to agent.run() as selectedContext so the pipeline's
 * selected phase includes them alongside tagged 'selected' memory items.
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

// ============================================================================
// Coordinator
// ============================================================================

export interface CoordinatorConfig {
  apiKey: string
  model?: string
  projectPath?: string
  debug?: boolean
  onStream?: (text: string) => void
  onToolResult?: (tool: string, result: unknown) => void
}

export function createCoordinator(config: CoordinatorConfig): {
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  destroy: () => Promise<void>
} {
  const { apiKey, model, projectPath = process.cwd(), debug = false, onStream, onToolResult } = config

  // Create subagent tools with the coordinator's API key and onToolResult
  // so the team pipeline can emit progress updates to the desktop app's panel
  const { literatureSearchTool, dataAnalyzeTool } = createSubagentTools(apiKey, onToolResult)

  const subagentPack = definePack({
    id: 'subagents',
    name: 'Subagent Tools',
    description: 'Literature search and data analysis subagent tools',
    tools: [literatureSearchTool, dataAnalyzeTool]
  })

  const agent = createAgent({
    apiKey,
    model,
    projectPath,
    identity: SYSTEM_PROMPT,
    packs: [
      packs.safe(),           // read, write, edit, glob, grep
      packs.kvMemory(),       // memory storage (pinned phase reads from here)
      packs.todo(),           // todo-add, todo-update, todo-complete, todo-remove
      packs.contextPipeline(), // ctx-expand, history compression, 5-phase assembly
      subagentPack             // literature-search, data-analyze
    ],
    onStream,
    onToolResult,
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
        // Sync disk entities into memory so the pipeline picks them up
        await syncEntitiesToMemory(agent.runtime, projectPath, debug)

        // Build selectedContext from @-mentions
        const selectedContext = buildMentionSelections(mentions)

        if (debug) {
          console.log(`[Chat] Sending message to agent (${selectedContext.length} mention selections)...`)
        }

        const result = await agent.run(message, {
          ...(selectedContext.length > 0 && { selectedContext })
        })

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
