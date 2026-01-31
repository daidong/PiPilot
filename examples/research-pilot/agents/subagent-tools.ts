/**
 * Subagent Tools v2 (RFC-008)
 *
 * Factory that creates custom tools wrapping the literature and data teams.
 * The coordinator passes its API key and onToolResult callback at creation time.
 *
 * v2 changes:
 * - Per-turn invocation counter (max 2 literature-search calls per turn)
 * - Pass coordinator messages to literature team for filtered passthrough
 * - Sub-topic progress broadcast after planner completes
 * - Return compressed LiteratureSearchResult instead of full summary
 */

import { defineTool } from '../../../src/factories/define-tool.js'
import { createLiteratureTeam, type SearcherActivityCallback } from './literature-team.js'
import { createDataAnalyzer } from './data-team.js'
import type { Tool, ToolContext } from '../../../src/types/tool.js'
import type { TodoItem } from '../../../src/types/todo.js'

// Agent-step labels displayed in the progress panel
const LIT_STEPS: Record<string, string> = {
  planner: 'Planning search strategy',
  searcher: 'Searching academic databases',
  reviewer: 'Reviewing search results',
  summarizer: 'Synthesizing literature review'
}

const DATA_STEPS: Record<string, string> = {
  preflight: 'Checking Python dependencies',
  codegen: 'Generating analysis code',
  execute: 'Running Python script',
  collect: 'Collecting results'
}

function makeTodoItem(id: string, title: string, status: TodoItem['status']): TodoItem {
  const now = new Date().toISOString()
  return {
    id,
    title,
    status,
    priority: 'medium',
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: now } : {})
  }
}

/**
 * Callback type matching the coordinator's onToolResult signature.
 * Used to emit synthetic todo events into the IPC pipeline.
 */
type ToolResultCallback = (tool: string, result: unknown) => void

function emitTodo(cb: ToolResultCallback | undefined, item: TodoItem): void {
  if (!cb) return
  cb('todo-update', { success: true, item })
}

/**
 * Emit an activity event (appears in the Activity log, not the PROGRESS/todo panel).
 * Uses the tool-call → tool-result merge pattern in the activity store:
 *   onToolCall  → type: 'tool-call' (spinner)
 *   onToolResult → type: 'tool-result' (checkmark or error), merges into the call
 */
function emitActivityStart(
  callCb: ((tool: string, args: unknown) => void) | undefined,
  toolName: string,
  args: { _summary: string }
): void {
  if (!callCb) return
  callCb(toolName, args)
}

function emitActivityDone(
  resultCb: ToolResultCallback | undefined,
  toolName: string,
  summary: string,
  success: boolean = true
): void {
  if (!resultCb) return
  resultCb(toolName, { success, data: summary, error: success ? undefined : summary })
}

export function createSubagentTools(
  apiKey: string,
  model?: string,
  onToolResult?: ToolResultCallback,
  projectPath?: string,
  sessionId?: string,
  onToolCall?: (tool: string, args: unknown) => void
): {
  literatureSearchTool: Tool
  dataAnalyzeTool: Tool
} {
  let literatureTeam: ReturnType<typeof createLiteratureTeam> | null = null
  let dataAnalyzer: ReturnType<typeof createDataAnalyzer> | null = null

  // Per-turn invocation counter for literature-search (RFC-008 §3.3)
  let litInvocationCount = 0
  let lastLitTurnStep = -1

  const literatureSearchTool = defineTool({
    name: 'literature-search',
    description: 'Search academic papers on a topic using a multi-agent literature research team. The team internally plans sub-topics, searches multiple sources, reviews/scores papers, and refines coverage — all in a SINGLE call. Returns a compressed result with coverage state, paper counts, and disk paths to full review. Do NOT call this tool multiple times for the same study — one call already runs a comprehensive multi-round search with internal refinement. Only call again if the user explicitly asks for additional searching or a completely different topic.',
    parameters: {
      query: { type: 'string', description: 'The research topic or question to search for', required: true },
      context: { type: 'string', description: 'Additional context from the conversation that helps refine the search (e.g. researcher names, institutions, specific fields, paper titles mentioned by the user)', required: false }
    },
    execute: async (input: { query: string; context?: string }, toolContext?: ToolContext) => {
      try {
        // Per-turn invocation limit (RFC-008 §3.3)
        const currentStep = toolContext?.step ?? 0
        if (currentStep !== lastLitTurnStep) {
          // New turn — reset counter
          litInvocationCount = 0
          lastLitTurnStep = currentStep
        }
        litInvocationCount++

        if (litInvocationCount > 2) {
          return {
            success: false,
            error: 'Already ran 2 literature searches this turn. Review existing results first. Use a single comprehensive query instead of multiple narrow ones.'
          }
        }

        // Get coordinator messages from tool context for filtered passthrough
        const coordinatorMessages = toolContext?.messages

        // Always create a fresh team per invocation so runtime state doesn't leak
        // between calls. The planner gets conversation context via filtered messages.
        {
          const searcherActivity: SearcherActivityCallback = (phase, detail) => {
            if (phase === 'search-batch-start') {
              emitActivityStart(onToolCall, 'lit-subtopic', { _summary: detail })
            } else if (phase === 'search-batch-done') {
              emitActivityDone(onToolResult, 'lit-subtopic', detail)
            } else if (phase === 'enrich-start') {
              emitActivityStart(onToolCall, 'lit-enrich', { _summary: detail })
            } else if (phase === 'enrich-done') {
              emitActivityDone(onToolResult, 'lit-enrich', detail)
            }
          }

          literatureTeam = createLiteratureTeam({
            apiKey,
            model,
            projectPath,
            sessionId: sessionId || 'default',
            messages: coordinatorMessages as unknown[] | undefined,
            onSearcherActivity: searcherActivity
          })
        }

        // Emit initial todo items so the panel shows what's happening
        const stepIds = Object.keys(LIT_STEPS)
        for (const stepId of stepIds) {
          emitTodo(onToolResult, makeTodoItem(
            `lit-${stepId}`, LIT_STEPS[stepId], 'pending'
          ))
        }

        // Subscribe to agent events for real-time progress (PROGRESS panel)
        // Sub-topic and enrichment activity events are now emitted from inside the
        // searcher via onSearcherActivity callback — not from agent lifecycle events.
        const rt = literatureTeam.runtime
        const unsub1 = rt.on('agent.started', ({ agentId }) => {
          const label = LIT_STEPS[agentId]
          if (label) {
            emitTodo(onToolResult, makeTodoItem(
              `lit-${agentId}`, label, 'in_progress'
            ))
          }
        })
        const unsub2 = rt.on('agent.completed', ({ agentId }) => {
          const label = LIT_STEPS[agentId]
          if (label) {
            emitTodo(onToolResult, makeTodoItem(
              `lit-${agentId}`, label, 'done'
            ))
          }

          // Emit activity for refinement queries from reviewer (second searcher run)
          if (agentId === 'reviewer') {
            // nothing extra needed — the searcher's onActivity callback will emit
            // per-batch activity items for refinement queries too
          }
        })
        const unsub3 = rt.on('agent.failed', ({ agentId }) => {
          const label = LIT_STEPS[agentId]
          if (label) {
            emitTodo(onToolResult, makeTodoItem(
              `lit-${agentId}`, label, 'blocked'
            ))
          }
        })

        // Pass context alongside query so the planner can generate better search terms
        const searchRequest = input.context
          ? `${input.query}\n\nAdditional context: ${input.context}`
          : input.query
        const result = await literatureTeam.research(searchRequest)

        // Clean up subscriptions
        unsub1()
        unsub2()
        unsub3()

        if (result.success) {
          // Emit auto-saved papers to ACTIVITY log
          if (result.savedPapers && result.savedPapers > 0) {
            emitActivityStart(onToolCall, 'lit-autosave', { _summary: `Auto-saving ${result.savedPapers} papers to library` })
            emitActivityDone(onToolResult, 'lit-autosave', `Saved ${result.savedPapers} papers to library`)
          }

          // Return compressed result (RFC-008 §3.2g)
          if (result.result) {
            return {
              success: true,
              data: result.result.data
            }
          }

          // Fallback to v1 format if result.result not available
          return {
            success: true,
            data: {
              summary: result.summary,
              steps: result.steps,
              durationMs: result.durationMs,
              savedPapers: result.savedPapers,
              localPapersUsed: result.localPapersUsed,
              externalPapersUsed: result.externalPapersUsed
            }
          }
        }
        return { success: false, error: result.error ?? 'Literature search failed' }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Literature search error: ${msg}` }
      }
    }
  })

  const dataAnalyzeTool = defineTool({
    name: 'data-analyze',
    description: 'Analyze a dataset file using Python code execution. Supports statistics, visualization (matplotlib/seaborn plots), data transformation, and modeling. Generated outputs (figures, tables) appear in the Data tab.',
    parameters: {
      filePath: { type: 'string', description: 'Relative path to the data file (CSV, JSON, TSV)', required: true },
      taskType: { type: 'string', description: 'Type of analysis: analyze | visualize | transform | model (default: analyze)', required: false },
      instructions: { type: 'string', description: 'What to do with the data (e.g. "compute correlations", "scatter plot of X vs Y")', required: true }
    },
    execute: async (input: { filePath: string; taskType?: string; instructions: string }) => {
      try {
        if (!dataAnalyzer) {
          dataAnalyzer = createDataAnalyzer({
            apiKey,
            model,
            projectPath: projectPath || process.cwd(),
            sessionId
          })
        }

        // Emit initial todo items for progress tracking
        const stepIds = Object.keys(DATA_STEPS)
        for (const stepId of stepIds) {
          emitTodo(onToolResult, makeTodoItem(
            `data-${stepId}`, DATA_STEPS[stepId], 'pending'
          ))
        }

        // Manual progress: preflight → codegen
        emitTodo(onToolResult, makeTodoItem('data-preflight', DATA_STEPS.preflight, 'in_progress'))

        const result = await dataAnalyzer.analyze({
          filePath: input.filePath,
          taskType: (input.taskType as 'analyze' | 'visualize' | 'transform' | 'model') || 'analyze',
          instructions: input.instructions,
          onStdout: (line) => {
            if (onToolResult) {
              onToolResult('data-stdout', { line, stream: 'stdout' })
            }
          },
          onStderr: (line) => {
            if (onToolResult) {
              onToolResult('data-stderr', { line, stream: 'stderr' })
            }
          }
        })

        // Mark preflight done, codegen done, execute/collect status
        emitTodo(onToolResult, makeTodoItem('data-preflight', DATA_STEPS.preflight, result.errorCategory === 'resource' && result.attempts === 0 ? 'blocked' : 'done'))
        emitTodo(onToolResult, makeTodoItem('data-codegen', DATA_STEPS.codegen, result.errorCategory === 'resource' && result.attempts === 0 ? 'blocked' : 'done'))
        emitTodo(onToolResult, makeTodoItem('data-execute', DATA_STEPS.execute, result.success ? 'done' : 'blocked'))
        emitTodo(onToolResult, makeTodoItem('data-collect', DATA_STEPS.collect, result.success ? 'done' : 'blocked'))

        if (result.success) {
          return {
            success: true,
            data: {
              stdout: result.stdout,
              outputs: result.outputs.map(o => ({ name: o.name, category: o.category, path: o.path, title: (o as { title?: string }).title })),
              manifest: result.manifest ? { summary: result.manifest.summary, warnings: result.manifest.warnings } : undefined,
              attempts: result.attempts
            }
          }
        }
        return { success: false, error: result.error ?? 'Data analysis failed' }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Data analysis error: ${msg}` }
      }
    }
  })

  return { literatureSearchTool, dataAnalyzeTool }
}
