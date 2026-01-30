/**
 * Subagent Tools
 *
 * Factory that creates custom tools wrapping the literature and data teams.
 * The coordinator passes its API key and onToolResult callback at creation time.
 *
 * Each tool emits synthetic todo-update events so the desktop app's
 * right panel can show real-time progress of the multi-agent pipeline.
 */

import { defineTool } from '../../../src/factories/define-tool.js'
import { createLiteratureTeam } from './literature-team.js'
import { createDataAnalyzer } from './data-team.js'
import type { Tool } from '../../../src/types/tool.js'
import type { TodoItem } from '../../../src/types/todo.js'

// Agent-step labels displayed in the progress panel
const LIT_STEPS: Record<string, string> = {
  planner: 'Planning search strategy',
  searcher: 'Searching academic databases',
  reviewer: 'Reviewing search results',
  summarizer: 'Synthesizing literature review'
}

const DATA_STEPS: Record<string, string> = {
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
  // The IPC layer in ipc.ts filters for tool names starting with 'todo-'
  // and looks for { success: true, item: TodoItem }
  cb('todo-update', { success: true, item })
}

export function createSubagentTools(
  apiKey: string,
  model?: string,
  onToolResult?: ToolResultCallback,
  projectPath?: string,
  sessionId?: string
): {
  literatureSearchTool: Tool
  dataAnalyzeTool: Tool
} {
  let literatureTeam: ReturnType<typeof createLiteratureTeam> | null = null
  let dataAnalyzer: ReturnType<typeof createDataAnalyzer> | null = null

  const literatureSearchTool = defineTool({
    name: 'literature-search',
    description: 'Search academic papers on a topic using a multi-agent literature research team. Returns a structured summary with papers, themes, key findings, and research gaps. Also auto-saves high-relevance papers to the local library for future searches. IMPORTANT: Always include relevant context from the conversation to help the search planner generate better queries.',
    parameters: {
      query: { type: 'string', description: 'The research topic or question to search for', required: true },
      context: { type: 'string', description: 'Additional context from the conversation that helps refine the search (e.g. researcher names, institutions, specific fields, paper titles mentioned by the user)', required: false }
    },
    execute: async (input: { query: string; context?: string }) => {
      try {
        if (!literatureTeam) {
          literatureTeam = createLiteratureTeam({
            apiKey,
            model,
            projectPath,
            sessionId: sessionId || 'default'
          })
        }

        // Emit initial todo items so the panel shows what's happening
        const stepIds = Object.keys(LIT_STEPS)
        for (const stepId of stepIds) {
          emitTodo(onToolResult, makeTodoItem(
            `lit-${stepId}`, LIT_STEPS[stepId], 'pending'
          ))
        }

        // Subscribe to agent events for real-time progress
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
          // Emit activity log for auto-saved papers
          if (result.savedPapers && result.savedPapers > 0) {
            emitTodo(onToolResult, makeTodoItem(
              'lit-save',
              `Saved ${result.savedPapers} papers to library`,
              'done'
            ))
          }

          return {
            success: true,
            data: {
              summary: result.summary,
              steps: result.steps,
              durationMs: result.durationMs,
              // Local paper caching stats
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

        // Manual progress: codegen
        emitTodo(onToolResult, makeTodoItem('data-codegen', DATA_STEPS.codegen, 'in_progress'))

        const result = await dataAnalyzer.analyze({
          filePath: input.filePath,
          taskType: (input.taskType as 'analyze' | 'visualize' | 'transform' | 'model') || 'analyze',
          instructions: input.instructions
        })

        // Mark codegen done, execute done
        emitTodo(onToolResult, makeTodoItem('data-codegen', DATA_STEPS.codegen, 'done'))
        emitTodo(onToolResult, makeTodoItem('data-execute', DATA_STEPS.execute, result.success ? 'done' : 'blocked'))
        emitTodo(onToolResult, makeTodoItem('data-collect', DATA_STEPS.collect, result.success ? 'done' : 'blocked'))

        if (result.success) {
          return {
            success: true,
            data: {
              stdout: result.stdout,
              outputs: result.outputs.map(o => ({ name: o.name, category: o.category, path: o.path })),
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
