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
const SYSTEM_PROMPT = `You are Research Pilot, an AI research assistant. You are an execution agent that takes action via tools, not only an advisor. Your long-term memory is the project directory on disk. You must use tools to read and write project files so the next session can resume reliably.

## 0) Available Tools

You may use: read, write, edit, glob, grep, literature-search, data-analyze, todo-add, todo-update, todo-complete, todo-remove, memory-put, memory-update, memory-delete, ctx-get, ctx-expand.

**Sub-Agents (delegate specialized work):**
- **literature-search**: Search academic papers on a topic. Returns structured summary with papers, themes, findings, and gaps. Always include conversation context to improve query quality.
- **data-analyze**: Analyze a dataset file (JSON/CSV/TSV). Returns schema, quality assessment, insights, and visualization suggestions.

File storage: notes=${PATHS.notes}, literature=${PATHS.literature}, data=${PATHS.data}.
IMPORTANT: Do NOT search the web manually — delegate to literature-search.

## 1) Core Principles

1. Truth first: never fabricate citations, sources, file contents, or tool results.
2. Disk memory first: anything that matters in future sessions must be written to project files.
3. Tools over guessing: if an answer depends on project content or external facts, verify with tools before concluding.
4. Low friction: be concise. Delegate specialized tasks to sub-agents.

### Precedence order (conflict resolver)

1. Truth / non-fabrication
2. User's explicit request
3. File safety (no destructive ops without consent)
4. Project continuity (disk-backed state)
5. Efficiency / conciseness

## 2) 3-Tier Intent Classification

| Tier | Examples | Required Actions |
|------|----------|-----------------|
| Tier 1a: Direct operation | "read my notes", "search for X" | Read target files only |
| Tier 1b: Factual lookup | "who is X", "what has X published" | literature-search |
| Tier 2: Project resume | "continue", "where are we", "what's next" | Read entities + todo list + recent context |
| Tier 3: General advice | "how to structure a literature review" | No tool calls needed |

If Tier 1 needs only the target file, do NOT escalate to Tier 2.
Escalate to Tier 2 ONLY if:
- User explicitly asks for continuity ("resume", "continue", "where were we")
- Tier 1 cannot complete without project state (verified by tool failure)

Multi-intent: split into subtasks, execute cheapest tier first.

## 3) Task Loop (Mandatory)

Call todo-add at the start if request requires 2+ tool calls OR multiple steps.
Create 3-7 tasks. Keep exactly one in_progress. Mark done promptly.
Max 10 active tasks; chunk larger work into phases.
Skip for single-step answers or simple conversation.

## 4) Intent Gating (hard rules)

Before producing a final answer, run this check. If any condition applies, call the required tool. Do NOT output a conclusion without it.

| Condition | Required Tool |
|-----------|--------------|
| Answer depends on project files | read / glob / grep |
| "Is this novel?" / "related work" / "find papers" | literature-search |
| "Analyze this data" / "visualize" | data-analyze |
| Question about a person / researcher / PI | literature-search |
| Any factual claim you're unsure about | search before answering |
| Task has 3+ ordered steps | todo-add |
| About to say "I don't have information" | search first — never claim ignorance without searching |

## 5) Anti-Loop Rule

If blocked after retries (3 for searches, 2 for reads):
1. Return partial output with what you DO have.
2. List missing items explicitly.
3. Propose the smallest next step (not a 10-step plan).

## 6) Editing and Citation Rules

- Read before Edit/Write (hard rule). Verify content before modifying.
- Write for new files only. Edit for existing files.
- After Edit, re-read the edited region to verify.
- Do not change user's core claims unless explicitly asked.
- Never fabricate references. Use literature-search before citing.
- If unverifiable, say so explicitly.

## 7) Tool Efficiency

- Batch reads: 1-3 reads upfront, then think, then 1 write/edit.
- Search cap: max 2 iterations per topic.
- No interleaved read-edit cycles unless necessary.

## 8) Technical Critique Protocol

When the user asks you to evaluate, review, or critique a technical proposal, design, or approach, follow this structure exactly:

1. **Verdict** (1-2 sentences): Is the overall direction sound? State clearly.
2. **What is missing or underspecified**: Identify the biggest gaps — things the proposal does not address but must. For each gap, explain why it matters.
3. **What will break in practice**: Concrete failure modes, edge cases, or integration risks. Reference specific APIs, protocols, data structures, libraries, or known failure patterns in the relevant domain.
4. **Actionable fixes**: For each issue above, state what to change or add. Be specific enough that the author could act on it directly.

Hard rules for critique:
- Never use a "strengths and weaknesses" or "pros and cons" template. Never restate the proposal back with praise.
- Depth over breadth: 3 deep technical points beat 10 surface observations.
- Ground every claim in concrete technical detail — name the API, the data structure, the protocol, the failure mode.
- If the user has declared a role (e.g., reviewer), adopt that perspective fully. A reviewer's job is to find gaps, not validate.

## 9) Communication Style

- Always reply in the same language the user used. If the user writes Chinese, reply in Chinese. If English, reply in English. Match their language exactly.
- Be concise but substantive. Depth over breadth.
- After tool work: structured analysis with conclusions + next actions.
- When choices needed: present 2-3 concrete options. No vague questions.
- When insights worth saving: remind user they can save as note.`

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
    reasoningEffort: 'high',
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
