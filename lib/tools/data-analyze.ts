/**
 * Data Analysis Tool
 *
 * Executes Python scripts for data analysis:
 * 1. Takes a data file + instructions + task type
 * 2. Generates Python code via LLM using the data-analysis-system prompt
 * 3. Executes via child_process.execFile('python3', ...)
 * 4. Collects outputs (figures, tables) from output directories
 * 5. Returns structured results
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError, type ToolResult } from './tool-utils.js'
import type { ResearchToolContext } from './types.js'
import { loadPrompt } from '../agents/prompts/index.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Prompts (loaded once from prompt registry)
// ---------------------------------------------------------------------------

const DATA_ANALYSIS_SYSTEM = loadPrompt('data-analysis-system')
const DATA_ANALYSIS_TASKS = loadPrompt('data-analysis-tasks')
const DATA_CODE_TEMPLATE = loadPrompt('data-code-template')

// ---------------------------------------------------------------------------
// Task type descriptions (extracted from the tasks prompt)
// ---------------------------------------------------------------------------

const TASK_DESCRIPTIONS: Record<string, string> = {
  analyze: 'Statistical Analysis',
  visualize: 'Data Visualization',
  transform: 'Data Transformation',
  model: 'Statistical Modeling'
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DataAnalyzeSchema = Type.Object({
  file_path: Type.String({ description: 'Relative path to data file (CSV, JSON, TSV, XLSX)' }),
  instructions: Type.String({ description: 'What analysis to perform' }),
  task_type: Type.Optional(
    Type.String({ description: 'analyze | visualize | transform | model (default: analyze)' })
  )
})

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDataAnalyzeTool(ctx: ResearchToolContext): AgentTool {
  return {
    name: 'data_analyze',
    label: 'Data Analysis',
    description:
      'Analyze a dataset using Python. Supports statistics, visualization (matplotlib/seaborn), ' +
      'data transformation, and modeling. Generated outputs (figures, tables) are saved to disk.\n' +
      'Usage guidelines: (1) Use this tool for ANY analysis, visualization, statistics, or modeling — do not compute from raw data with read/grep. ' +
      '(2) Generate only the outputs the user requested; no extras.',
    parameters: DataAnalyzeSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const filePath = typeof params.file_path === 'string' ? params.file_path.trim() : ''
      const instructions = typeof params.instructions === 'string' ? params.instructions.trim() : ''
      const taskType = typeof params.task_type === 'string' ? params.task_type.trim().toLowerCase() : 'analyze'

      if (!filePath) {
        return toAgentResult('data_analyze', toolError('MISSING_PARAMETER', 'Missing file_path.', {
          suggestions: ['Provide a relative path to the data file (CSV, JSON, TSV, or XLSX).']
        }))
      }
      if (!instructions) {
        return toAgentResult('data_analyze', toolError('MISSING_PARAMETER', 'Missing instructions.', {
          suggestions: ['Describe what analysis to perform on the data.']
        }))
      }
      if (!['analyze', 'visualize', 'transform', 'model'].includes(taskType)) {
        return toAgentResult('data_analyze', toolError('INVALID_PARAMETER', `Invalid task_type: ${taskType}. Use: analyze | visualize | transform | model.`, {
          suggestions: ['Valid task types: analyze, visualize, transform, model.']
        }))
      }

      // 1. Resolve data file path
      const absDataFile = path.resolve(ctx.workspacePath, filePath)
      if (!fs.existsSync(absDataFile)) {
        return toAgentResult('data_analyze', toolError('FILE_NOT_FOUND', `File not found: ${filePath}`, {
          suggestions: [
            'Verify the file path is relative to the workspace root.',
            'Use the find or glob tool to locate the data file.',
          ],
          context: { workspacePath: ctx.workspacePath, resolvedPath: absDataFile }
        }))
      }

      ctx.onToolCall?.('data_analyze', { file_path: filePath, instructions, task_type: taskType })

      // 2. Create output directories
      const runId = Date.now().toString(36)
      const outputBase = path.join(ctx.workspacePath, '.research-pilot', 'data-runs', runId)
      const figuresDir = path.join(outputBase, 'figures')
      const tablesDir = path.join(outputBase, 'tables')
      const dataDir = path.join(outputBase, 'data')
      fs.mkdirSync(figuresDir, { recursive: true })
      fs.mkdirSync(tablesDir, { recursive: true })
      fs.mkdirSync(dataDir, { recursive: true })

      const resultsFile = path.join(outputBase, 'results.json')

      // 3. Read data preview for LLM context
      const rawPreview = fs.readFileSync(absDataFile, 'utf-8').slice(0, 2000)
      const ext = path.extname(absDataFile).toLowerCase()
      const formatHint = ext === '.csv' ? 'CSV' : ext === '.tsv' ? 'TSV' : ext === '.json' ? 'JSON' : ext === '.xlsx' ? 'XLSX' : 'unknown'

      // 4. Generate Python code via LLM
      if (!ctx.callLlm) {
        return toAgentResult('data_analyze', toolError('LLM_UNAVAILABLE', 'LLM not available for code generation.', {
          suggestions: ['Ensure the agent runtime has an LLM provider configured (callLlm in ResearchToolContext).']
        }))
      }

      // Extract the relevant task description section
      const taskSection = DATA_ANALYSIS_TASKS
        .split(/^## /m)
        .find(s => s.startsWith(taskType))
      const taskDesc = taskSection ? `## ${taskSection}` : ''

      const userPrompt = [
        `Task type: ${taskType} (${TASK_DESCRIPTIONS[taskType] ?? 'Analysis'})`,
        '',
        taskDesc,
        '',
        `Data file format: ${formatHint}`,
        `Data file preview (first 2000 chars):`,
        '```',
        rawPreview,
        '```',
        '',
        `Instructions: ${instructions}`,
        '',
        'IMPORTANT: Use the pre-defined path variables (DATA_FILE, FIGURES_DIR, TABLES_DIR, DATA_DIR, RESULTS_FILE).',
        'Call write_results() at the end with your outputs list and summary dict.',
        'Output ONLY the Python code in a ```python code block.'
      ].join('\n')

      let generatedCode: string
      try {
        const llmResponse = await ctx.callLlm(DATA_ANALYSIS_SYSTEM, userPrompt)

        // 5. Extract Python code from LLM response
        const codeMatch = llmResponse.match(/```python\n([\s\S]*?)```/) || llmResponse.match(/```\n([\s\S]*?)```/)
        generatedCode = codeMatch ? codeMatch[1] : llmResponse
      } catch (err: any) {
        return toAgentResult('data_analyze', toolError('EXECUTION_FAILED', `Code generation failed: ${err.message}`, {
          retryable: true,
          suggestions: ['Retry — the LLM may produce valid code on a subsequent attempt.', 'Try simplifying the instructions.'],
        }))
      }

      // 6. Build full script with template header + pre-defined paths
      const pathDefinitions = [
        '',
        '# Pre-defined paths (set by the tool runtime)',
        `DATA_FILE = ${JSON.stringify(absDataFile)}`,
        `FIGURES_DIR = ${JSON.stringify(figuresDir)}`,
        `TABLES_DIR = ${JSON.stringify(tablesDir)}`,
        `DATA_DIR = ${JSON.stringify(dataDir)}`,
        `RESULTS_FILE = ${JSON.stringify(resultsFile)}`,
        ''
      ].join('\n')

      const fullScript = DATA_CODE_TEMPLATE + pathDefinitions + '\n' + generatedCode
      const scriptPath = path.join(outputBase, 'script.py')
      fs.writeFileSync(scriptPath, fullScript, 'utf-8')

      // 7. Execute Python
      try {
        const { stdout, stderr } = await execFileAsync('python3', [scriptPath], {
          cwd: ctx.workspacePath,
          timeout: 120_000, // 2 minutes
          maxBuffer: 10 * 1024 * 1024
        })

        // 8. Read results manifest
        let manifest: { outputs?: any[]; summary?: Record<string, unknown>; warnings?: string[] } | null = null
        if (fs.existsSync(resultsFile)) {
          try {
            manifest = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'))
          } catch {
            // manifest parsing failed, continue without
          }
        }

        // 9. Collect output files from directories
        const outputs: Array<{ name: string; type: string; path: string }> = []
        for (const [dir, type] of [
          [figuresDir, 'figure'],
          [tablesDir, 'table'],
          [dataDir, 'data']
        ] as const) {
          if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              outputs.push({
                name: f,
                type,
                path: path.relative(ctx.workspacePath, path.join(dir, f))
              })
            }
          }
        }

        const payload = {
          stdout: stdout.slice(0, 4000),
          stderr: stderr ? stderr.slice(0, 1000) : undefined,
          outputs,
          manifest: manifest ? {
            summary: manifest.summary,
            warnings: manifest.warnings
          } : undefined,
          scriptPath: path.relative(ctx.workspacePath, scriptPath),
          runId
        }

        ctx.onToolResult?.('data_analyze', payload)

        return toAgentResult('data_analyze', { success: true, data: payload })
      } catch (err: any) {
        const errorDetail = err.stderr?.slice(0, 2000) || err.message
        return toAgentResult('data_analyze', toolError('EXECUTION_FAILED', `Python execution failed: ${errorDetail}`, {
          retryable: true,
          suggestions: [
            `Review the generated script at ${path.relative(ctx.workspacePath, scriptPath)} for errors.`,
            'Check that required Python packages (pandas, matplotlib, seaborn, etc.) are installed.',
            'Try simplifying the analysis instructions.',
          ],
          context: {
            scriptPath: path.relative(ctx.workspacePath, scriptPath),
            runId,
          },
          data: {
            scriptPath: path.relative(ctx.workspacePath, scriptPath),
            runId
          }
        }))
      }
    }
  }
}
