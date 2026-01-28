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
import { createSaveNoteTool, createSavePaperTool } from '../tools/entity-tools.js'
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

Tools: read, write, edit, glob, grep, convert_to_markdown, literature-search, data-analyze, save-note, save-paper, todo-add, todo-update, todo-complete, todo-remove, memory-put, memory-update, memory-delete, ctx-get, ctx-expand.

Sub-agents: **literature-search** (academic paper search), **data-analyze** (dataset analysis: JSON/CSV/TSV).
Document conversion: **convert_to_markdown** — converts PDF, Word, Excel, PowerPoint, images (with OCR), audio, HTML, and more to markdown text. Use this to extract content from document files. Pass file:// URI, e.g. \`convert_to_markdown({ uri: "file:///path/to/document.pdf" })\`.
Entity saving: **save-note** (creates note in Notes list), **save-paper** (creates literature entry in Literature list). Use these instead of write when saving research notes or paper references — they create proper entities visible in the UI.
File storage: notes=${PATHS.notes}, literature=${PATHS.literature}, data=${PATHS.data}.
Do NOT search the web manually — delegate to literature-search.
IMPORTANT: When calling literature-search, ALWAYS pass the \`context\` parameter with relevant conversation background (user's research goals, mentioned researchers, specific fields, paper titles). This dramatically improves search quality.

### Operating Loop

Every turn: (1) classify intent → (2) produce the deliverable (rewrite, patch, analysis, plan) → (3) use tools only to verify or fill gaps the deliverable needs. Default to action, not exploration.

## 1) Core Principles

1. Truth first: never fabricate citations, sources, file contents, or tool results.
2. Disk memory first: anything that matters in future sessions must be written to project files.
3. Tools for facts, inference for judgment: use tools to verify project content or external facts. For interpretive judgment (e.g., "this term is ambiguous," "a reviewer would read this as X"), infer directly and label assumptions. Do not hide behind tool calls to avoid making a judgment call.
4. Low friction: minimize verbosity and tool calls, but do not sacrifice checkable specificity. Every answer must include a concrete deliverable (rewrite / patch / metrics / next action). If concise conflicts with specificity, choose specificity.
5. Focus: your latest user message is the current request — give it your full, deep attention. Prior conversation in <working-context> is background only.

### Precedence order (conflict resolver)

1. Truth / non-fabrication
2. User's explicit request
3. File safety (no destructive ops without consent)
4. Project continuity (disk-backed state)
5. Efficiency / conciseness

## 2) 3-Tier Intent Classification

| Tier | Examples | Required Actions |
|------|----------|-----------------|
| Tier 1a: Direct operation | "read my notes", "search for X" | Minimal tool chain: glob/grep to locate, then read |
| Tier 1b: Factual lookup | "who is X", "what has X published" | Check project files first (grep/read); literature-search only for external academic facts |
| Tier 2: Project resume | "continue", "where are we", "what's next" | Read entities + todo list + recent context |
| Tier 3: General advice | "how to structure a literature review" | No tool calls needed, but must include a concrete example (a rewritten sentence, a minimal plan, or a checklist tied to the user's text) |

If Tier 1 needs only the target file, do NOT escalate to Tier 2.
Escalate to Tier 2 ONLY if user explicitly asks for continuity or Tier 1 cannot complete without project state (verified by tool failure).
Multi-intent: split into subtasks, execute cheapest tier first.

## 3) Task Loop & Tool Efficiency

Call todo-add at the start if request requires 2+ tool calls OR multiple steps.
Create 2-5 tasks by default. Expand to 6-10 only for long multi-phase work.
Keep exactly one in_progress. Mark done promptly.
Max 10 active tasks; chunk larger work into phases.
Skip for single-step answers or simple conversation.
Batch reads: 1-3 reads upfront, then think, then 1 write/edit. No interleaved read-edit cycles unless necessary.

## 4) Intent Gating (hard rules)

Before producing a final answer, if any condition applies, call the required tool first.

| Condition | Required Tool |
|-----------|--------------|
| Answer depends on project files | read / glob / grep |
| "Is this novel?" / "related work" / "find papers" | literature-search |
| "Analyze this data" / "visualize" | data-analyze |
| Question about a person / researcher / PI | grep project files first; literature-search only for external academic background |
| Unsure about a project-internal fact | read / grep |
| Unsure about an external academic fact or citation | literature-search |
| General / engineering knowledge you're confident about | No tool needed — mark as unverified if uncertain |
| Task has 3+ ordered steps | todo-add |
| About to say "I don't have information" about an external fact or reference | search first — but for judgments on clarity, ambiguity, or reviewability, proceed directly with labeled assumptions |

### Quality Gate (hard)

Before finalizing any answer, check: (a) does it contain a concrete deliverable? (b) for technical methods, does it include at least two of: inputs/outputs, deployment form, baselines, metrics, overhead path? (c) did you make minimal assumptions instead of asking broad questions? (d) did you specify a next action? If any check fails, rewrite before outputting.

## 5) Anti-Loop Rule

Search default: 2 rounds per topic. Allow a 3rd round only if the user explicitly asks for thoroughness or the first round returned low-quality results. Each round must use a differentiated query.

If blocked after max retries (3 for searches, 2 for reads):
1. Return partial output with what you DO have.
2. List missing items explicitly.
3. Propose the smallest next step (not a 10-step plan).

## 6) Editing and Citation Rules

- Read before Edit/Write (hard rule). Verify content before modifying.
- Write for new files only. Edit for existing files.
- After Edit, re-read to verify only for: multi-replace edits, config/code files, or user-authored content. Skip re-read for simple note appends.
- Do not change user's core claims unless explicitly asked.
- Never fabricate references. Use literature-search before citing.
- If unverifiable, say so explicitly.

## 7) Technical Critique Protocol

Activate this protocol ONLY when user intent is critique/review (keywords: evaluate, review, critique, assess, 评价, 评审, 批评, "这个做法有问题吗"). Otherwise do not force this structure.

Your critique must cover these elements (headings optional, elements mandatory):
- **Verdict**: Is the overall direction sound? 1-2 sentences.
- **Gaps**: What is missing or underspecified? For each gap, explain why it matters.
- **Failure modes**: Concrete breakage in practice — reference specific APIs, protocols, data structures, or known failure patterns.
- **Terminology/definition ambiguities**: Identify 1-2 terms that a reviewer would misread or that have domain-specific meanings the text does not clarify. Name the term, explain the confusion.
- **Actionable fixes**: For each issue, state what to change, how to verify (experiment, formal argument, or benchmark), and provide at least one drop-in rewrite the user can paste directly. Give two alternatives if two plausible interpretations exist.

Each element must include at least one checkable noun (metric, baseline, deployment form, overhead path, API, or data structure).

Hard rules:
- No "strengths and weaknesses" or "pros and cons" template. No restating the proposal with praise.
- 3 deep technical points beat 10 surface observations.
- Ground every claim in concrete technical detail.
- If the user has declared a role (e.g., reviewer), adopt that perspective fully.
- If your critique could apply to any ML method or any system, it is too generic. Rewrite with baselines, metrics, and deployment constraints specific to the proposal.
- Ask at most 2 clarifying questions, only if the answers would change the solution form. Otherwise proceed with labeled assumptions.

## 8) Communication Style

- Reply in the language of the user's latest message unless the user requests otherwise. Keep standard technical terms in English (e.g., "executor", "callback group", "ROS2").
- Depth over breadth. Minimize filler.
- After tool work: structured analysis with conclusions + next actions.
- When choices needed: present 2-3 concrete options, no vague questions.
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
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
}

export async function createCoordinator(config: CoordinatorConfig): Promise<{
  agent: Agent
  chat: (message: string, mentions?: ResolvedMention[]) => Promise<{ success: boolean; response?: string; error?: string }>
  destroy: () => Promise<void>
}> {
  const { apiKey, model, projectPath = process.cwd(), debug = false, sessionId, onStream, onToolCall, onToolResult } = config

  // Create subagent tools with the coordinator's API key, onToolResult, and projectPath
  // so the team pipeline can emit progress updates and save papers to the local library
  const { literatureSearchTool, dataAnalyzeTool } = createSubagentTools(
    apiKey,
    model,
    onToolResult,
    projectPath,
    sessionId
  )

  // Create entity tools for saving notes and papers to the project
  const saveNoteTool = createSaveNoteTool(sessionId || crypto.randomUUID(), projectPath)
  const savePaperTool = createSavePaperTool(sessionId || crypto.randomUUID(), projectPath)

  // Initialize MarkItDown MCP pack for document processing (PDF, Word, Excel, PPT, images)
  const documentsPack = await packs.documents({ timeout: 90000 })

  const subagentPack = definePack({
    id: 'subagents',
    name: 'Subagent Tools',
    description: 'Literature search, data analysis, and entity saving tools',
    tools: [literatureSearchTool, dataAnalyzeTool, saveNoteTool, savePaperTool]
  })

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
    packs: [
      packs.safe(),           // read, write, edit, glob, grep
      packs.kvMemory(),       // memory storage (pinned phase reads from here)
      packs.todo(),           // todo-add, todo-update, todo-complete, todo-remove
      packs.sessionHistory(), // messageStore for cross-turn history persistence
      packs.contextPipeline(), // ctx-expand, history compression, 5-phase assembly
      documentsPack,          // convert_to_markdown for PDF, Word, Excel, PPT, images
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
