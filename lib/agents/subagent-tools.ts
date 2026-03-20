/**
 * Subagent Tools v2 (RFC-008)
 *
 * Rewritten to use simple ResearchTool interface instead of AgentFoundry's defineTool.
 * Literature and data tools are stubbed during pi-mono migration.
 */

import type { ResearchTool } from '../tools/entity-tools.js'

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

interface TodoItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  priority: string
  createdAt: string
  updatedAt: string
  completedAt?: string
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

export function createSubagentTools(
  apiKey: string,
  model?: string,
  onToolResult?: ToolResultCallback,
  projectPath?: string,
  sessionId?: string,
  onToolCall?: (tool: string, args: unknown) => void
): {
  literatureSearchTool: ResearchTool
  dataAnalyzeTool: ResearchTool
} {
  // TODO: Re-implement with pi-mono agent
  const literatureSearchTool: ResearchTool = {
    name: 'literature-search',
    description: 'Search academic papers on a topic using a multi-agent literature research team. The team internally plans sub-topics, searches multiple sources, reviews/scores papers, and refines coverage — all in a SINGLE call. Returns a compressed result with coverage state, paper counts, and disk paths to full review. Do NOT call this tool multiple times for the same study — one call already runs a comprehensive multi-round search with internal refinement. Only call again if the user explicitly asks for additional searching or a completely different topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research topic or question to search for' },
        context: { type: 'string', description: 'Additional context from the conversation that helps refine the search (e.g. researcher names, institutions, specific fields, paper titles mentioned by the user)' }
      },
      required: ['query']
    },
    execute: async (input) => {
      // TODO: Re-implement with pi-mono agent
      // The original implementation used createLiteratureTeam which depended on
      // AgentFoundry's team system (defineTeam, agentHandle, seq, loop, etc.)
      return {
        success: false,
        error: 'Literature search is being migrated to pi-mono. This feature will be available soon.'
      }
    }
  }

  // TODO: Re-implement with pi-mono agent
  const dataAnalyzeTool: ResearchTool = {
    name: 'data-analyze',
    description: 'Analyze a dataset file using Python code execution. Supports statistics, visualization (matplotlib/seaborn plots), data transformation, and modeling. Generated outputs (figures, tables) appear in the Data tab.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative path to the data file (CSV, JSON, TSV)' },
        taskType: { type: 'string', description: 'Type of analysis: analyze | visualize | transform | model (default: analyze)' },
        instructions: { type: 'string', description: 'What to do with the data (e.g. "compute correlations", "scatter plot of X vs Y")' }
      },
      required: ['filePath', 'instructions']
    },
    execute: async (input) => {
      // TODO: Re-implement with pi-mono agent
      // The original implementation used createDataAnalyzer which depended on
      // AgentFoundry's getLanguageModelByModelId, PythonBridge, RetryBudget, etc.
      return {
        success: false,
        error: 'Data analysis is being migrated to pi-mono. This feature will be available soon.'
      }
    }
  }

  return { literatureSearchTool, dataAnalyzeTool }
}
