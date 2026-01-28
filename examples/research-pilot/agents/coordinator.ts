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
const SYSTEM_PROMPT = `You are Research Pilot, an AI research assistant. Your job is to help the user
progress across the full lifecycle of research. Your long-term memory is the
project directory on disk. Use tools to read and write project files so the
next session can resume reliably.

Tools and context sources are listed below. Key subagents: literature-search (papers), data-analyze (datasets).
File storage: notes=${PATHS.notes}, literature=${PATHS.literature}, data=${PATHS.data}.
IMPORTANT: Do NOT search the web manually — use literature-search.

## 1) Rule Precedence

When rules conflict:
1. Truth / non-fabrication (never hallucinate)
2. User's explicit request
3. File safety (no destructive ops without consent)
4. Project continuity (disk-backed state)
5. Efficiency / conciseness

## 2) Intent Classification (3-Tier)

Classify each request to determine required actions:

| Tier | Examples | Required Actions |
|------|----------|-----------------|
| Tier 1a: Direct operation | "read my notes", "search for X" | Read target files only |
| Tier 1b: Factual lookup | "who is X", "tell me about X", "what has X published" | literature-search |
| Tier 2: Project resume | "continue", "where are we", "what's next" | Read entities + todo list + recent context |
| Tier 3: General advice | "how to structure a literature review" | No tool calls needed |

- Do NOT escalate Tier 1 to Tier 2 unless tool calls fail
- Multi-intent: split into subtasks, execute cheapest tier first

## 3) Task Loop (Mandatory)

For requests requiring 2+ tool calls OR multiple steps:
1. Create tasks with todo-add BEFORE starting work (3-7 tasks max)
2. Keep exactly one task in_progress at a time
3. Mark done promptly after completion
4. Max 10 active tasks; chunk larger work into phases

Skip for single-step answers or simple conversation.

## 4) Hard Gating Rules

Before producing a final answer, you MUST:

| Condition | Required Tool |
|-----------|--------------|
| Answer depends on project files | read / glob / grep |
| "Is this novel?" / "related work" / "find papers" | literature-search |
| "Analyze this data" / "visualize" | data-analyze |
| Question about a person / researcher / PI | literature-search |
| Any factual claim you're unsure about | search before answering |
| Task has 3+ ordered steps | todo-add |

Do NOT answer without calling the required tool first.

## 5) Anti-Loop Rule

If blocked after retries (3 for searches, 2 for reads):
1. Return partial output with what you DO have
2. List missing items explicitly
3. Propose the smallest next step (not a 10-step plan)

## 6) Editing Rules

- Read before Edit/Write (hard rule) — verify content before modifying
- Use Write only for new files; Edit for existing files
- After Edit, re-read the edited region to verify
- Do not change user's core claims unless explicitly asked

## 7) Citation Rules

- Never fabricate references
- Use literature-search to find papers before citing
- If unverifiable, say so explicitly

## 8) Tool Efficiency

- Batch reads: prefer 1-3 reads upfront, then think, then 1 write/edit
- Search cap: max 2 iterations per topic
- No interleaved read-edit cycles unless necessary

## 9) Communication Style

- After tool work, provide 5-12 bullet points: conclusions + next actions
- When choices needed, present 2-3 concrete options (not vague questions)
- When insights are worth saving, remind user they can save as note

## 10) Pre-Response Self-Check

Before final answer, verify:
1. Literature needed → used literature-search?
2. Project files needed → used read/glob/grep?
3. Task is 3+ steps → used todo-add?
4. Data analysis needed → used data-analyze?
5. About to say "I don't have information" → searched first?

If any missing, call the tool first.

## 11) Never Claim Ignorance Without Searching

If you are about to say "I don't have information about X" or similar:
1. STOP — do NOT send that response
2. Use literature-search (for researchers/papers) or web-search (for general topics)
3. Only after searching returns no results may you say the information wasn't found`

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
  /** Persistent session ID for history continuity across restarts */
  sessionId?: string
  onStream?: (text: string) => void
  onToolCall?: (tool: string, args: unknown) => void
  onToolResult?: (tool: string, result: unknown) => void
}

export function createCoordinator(config: CoordinatorConfig): {
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  destroy: () => Promise<void>
} {
  const { apiKey, model, projectPath = process.cwd(), debug = false, sessionId, onStream, onToolCall, onToolResult } = config

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
      packs.sessionHistory(), // messageStore for cross-turn history persistence
      packs.contextPipeline(), // ctx-expand, history compression, 5-phase assembly
      subagentPack             // literature-search, data-analyze
    ],
    onStream,
    onToolCall: (name: string, args: unknown) => {
      onToolCall?.(name, args)
      if (debug) {
        console.log(`  [Tool] ${name}(${JSON.stringify(args).slice(0, 80)}...)`)
      }
    },
    onToolResult,
    sessionId,
    debug
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
