/**
 * Coordinator Agent
 *
 * Main chat agent using the framework's context pipeline:
 * - Pinned/selected entities loaded directly from disk as ContextSelections
 * - @-mentions passed as selectedContext for the selected phase
 * - Session memory (ephemeral) via kvMemory namespace="session"
 * - Token budgeting, history compression, and ctx-expand come for free
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { createAgent, packs, definePack, defineTool } from '../../../src/index.js'
import { createSubagentTools } from './subagent-tools.js'
import { createSaveNoteTool, createSavePaperTool, createUpdateNoteTool } from '../tools/entity-tools.js'
import type { Agent } from '../../../src/types/agent.js'
import type { ContextSelection } from '../../../src/types/context-pipeline.js'
import { PATHS, Entity, Note, Literature, DataAttachment } from '../types.js'
import type { ResolvedMention } from '../mentions/index.js'
import { countTokens } from '../../../src/utils/tokenizer.js'

/**
 * System prompt for the coordinator
 */
const SYSTEM_PROMPT = `You are Research Pilot, an AI research assistant. You are an execution agent that takes action via tools, not only an advisor. Your long-term memory is the project directory on disk. You must use tools to read and write project files so the next session can resume reliably.

## 0) Working Directory & File Paths

All file operations happen relative to the current working directory (the user's project folder). Always use **relative paths** (e.g. \`report.pdf\`, \`notes/summary.md\`). NEVER fabricate absolute paths like \`/mnt/data/\`, \`/tmp/\`, or \`/home/user/\` — you do not know the absolute path and must not guess it.

For **convert_to_markdown**, pass the relative filename: \`convert_to_markdown({ path: "report.pdf" })\`. It saves the extracted text to a local .md file and returns the path. Then use \`read\` to access the content.

## 1) Available Tools

Tools: read, write, edit, glob, grep, convert_to_markdown, brave_web_search, fetch, literature-search, data-analyze, save-note, update-note, save-paper, todo-add, todo-update, todo-complete, todo-remove, memory-put, memory-update, memory-delete, ctx-get, ctx-expand.
Note: ctx-get retrieves context from registered sources (memory, session history). Do NOT use ctx-get to discover tools — all available tools are listed here.

Sub-agents: **literature-search** (academic paper search), **data-analyze** (Python-powered: statistics, plots, data transformation, modeling — outputs appear in Data tab).

**Data Analysis Rules (HARD)**
- ALWAYS use data-analyze for ANY data analysis, visualization, statistics, or data exploration
- NEVER read raw data files (CSV, JSON, TSV, log) directly with read/glob/grep for analysis purposes
- data-analyze executes Python code — it can create plots, compute stats, transform data, build models
- To use: call data-analyze with filePath (relative path to data file) and instructions (what you want)
- Generated outputs (figures, tables) are automatically saved to the Data tab
Web search: **brave_web_search** — general-purpose web search for non-academic queries (news, technology, events, tutorials, documentation, products, people bios). **fetch** — retrieve content from a specific URL.
Document conversion: **convert_to_markdown** — converts PDF, Word, Excel, PowerPoint, images (with OCR), audio, HTML, etc. to markdown. Saves output to a local .md file and returns the path. Use \`read\` to access the content afterward. Example: \`convert_to_markdown({ path: "document.pdf" })\`.
Entity management: **save-note** (creates new pinned note), **update-note** (updates existing note by ID), **save-paper** (creates literature entry). Use these instead of write when managing research entities — they create proper entities visible in the UI.
File storage: notes=${PATHS.notes}, literature=${PATHS.literature}, data=${PATHS.data}.
Use brave_web_search for general web queries and literature-search for academic paper search. Never use brave_web_search to find academic papers — always use literature-search for that.
IMPORTANT: When calling literature-search, ALWAYS pass the \`context\` parameter with relevant conversation background (user's research goals, mentioned researchers, specific fields, paper titles). This dramatically improves search quality.

### Tool Selection: literature-search vs brave_web_search

| What you need | Use | Example query |
|---|---|---|
| Academic papers, citations, related work | literature-search | "Find papers on graph neural networks for drug discovery" |
| General knowledge, current events, docs | brave_web_search | "What is the latest version of PyTorch?" |
| News, tutorials, blog posts, product info | brave_web_search | "How does vLLM handle KV cache offloading?" |
| A researcher's publications | literature-search | "Find papers by Yann LeCun on self-supervised learning" |
| A researcher's bio, lab, affiliations | brave_web_search | "What university is Yann LeCun affiliated with?" |
| Conference deadlines, CFPs | brave_web_search | "NeurIPS 2026 submission deadline" |
| Read a specific URL | fetch | fetch({ url: "https://..." }) |

Rule: if the answer lives in an academic database → literature-search. If it lives on a regular website → brave_web_search.

### Operating Loop

Every turn: (1) classify intent → (2) produce the deliverable (rewrite, patch, analysis, plan) → (3) use tools only to verify or fill gaps the deliverable needs. Default to action, not exploration.
IMPORTANT: Always end your turn with a text response summarizing what you did and any next steps. Never end on a bare tool call with no text — the user must see a final message.
When a tool returns large content (e.g. document extraction), you may save it locally for reference, but always continue to complete the user's actual request in the same turn — do not stop after saving intermediate results.

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
| "Is this novel?" / "related work" / "find papers" | literature-search (NOT brave_web_search) |
| "Analyze this data" / "visualize" / statistics / data exploration | data-analyze |
| General/technical web question (not academic papers) | brave_web_search |
| Need to read content at a specific URL | fetch |
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
- When insights worth saving: remind user they can save as note.

## 9) Session Memory (Ephemeral Scratchpad)
Use memory-put with namespace="session" to store SHORT critical facts for this conversation.
- Memory is cleared when the app restarts
- Keep entries brief (1-2 sentences max)
- Use descriptive keys: "user-goal", "dataset-columns", "analysis-approach"
- Same key overwrites the old value — use this to update evolving facts
- Memory is ALWAYS visible to you in every turn — do not re-read it
- Do NOT store large content — use save-note for that

## 10) Notes (Persistent Research Notes)
Every note you create is **automatically pinned** and visible in your context every turn.

### Create responsibly
- Only create notes for valuable persistent artifacts: research summaries, key findings, methodology decisions, conclusions
- NOT for ephemeral facts (use session memory), NOT for raw search results, NOT for intermediate thoughts
- Keep notes concise and easy to read — humans have to read these

### Update, don't duplicate
- All your notes are pinned, so you can SEE them in context. Before calling save-note, check if a note on the same topic already exists.
- If one exists, use **update-note** with its ID to revise the content — do NOT create a second note
- When the research focus shifts, update existing notes or create new notes to reflect the new direction`

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
 * Build ContextSelection[] from disk entities that are pinned or selected.
 * Reads directly from disk — no kvMemory middleman.
 */
function buildEntitySelections(projectPath: string, debug: boolean): ContextSelection[] {
  const allEntities: Entity[] = [
    ...loadEntitiesFromDisk(join(projectPath, PATHS.notes)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.literature)),
    ...loadEntitiesFromDisk(join(projectPath, PATHS.data))
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
  clearSessionMemory: () => Promise<void>
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

  // Create entity tools for saving, updating notes and papers
  const saveNoteTool = createSaveNoteTool(sessionId || crypto.randomUUID(), projectPath)
  const savePaperTool = createSavePaperTool(sessionId || crypto.randomUUID(), projectPath)
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
      'Use the read tool with offset/limit to access the content afterward. ' +
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
      const lines = text.split('\n').length

      return {
        success: true,
        data: {
          outputFile: outputName,
          lines,
          bytes: text.length,
          message: `Extracted ${lines} lines from ${fileName}. Use read tool to access: read({ path: "${outputName}" })`
        }
      }
    }
  })

  // Initialize web pack for general-purpose web search (brave_web_search, fetch)
  const webPack = await packs.web({ timeout: 30000 })

  const subagentPack = definePack({
    id: 'subagents',
    name: 'Subagent Tools',
    description: 'Literature search, data analysis, and entity saving tools',
    tools: [literatureSearchTool, dataAnalyzeTool, saveNoteTool, savePaperTool, updateNoteTool]
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
    debug,

    // Budget management: research profile with dynamic output reserve
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
      priorityTools: ['read', 'write', 'edit', 'grep', 'glob', 'literature-search']
    },

    // Research agents need many consecutive tool rounds (fetch, search, save)
    toolLoopThreshold: 15
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
        const selectedContext = [...entitySelections, ...mentionSelections]

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
