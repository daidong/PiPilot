/**
 * Data Analysis Module
 *
 * Python code execution powered data analysis.
 * Flow: read preview → infer schema → LLM codegen → execute Python → collect outputs → register entities
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename, extname, resolve } from 'path'
import { generateText } from 'ai'

import { getLanguageModelByModelId } from '../../../src/index.js'
import { PythonBridge } from '../../../src/python/bridge.js'
import { executionFailureFeedback, formatFeedbackAsToolResult } from '../../../src/core/feedback.js'
import { createPythonError } from '../../../src/core/errors.js'
import { RetryBudget, DEFAULT_BUDGET_CONFIG } from '../../../src/core/retry.js'
import { saveData } from '../commands/save-data.js'
import type { CLIContext } from '../types.js'

// ============================================================================
// Types
// ============================================================================

interface ColumnSchema {
  name: string
  type: string
}

interface DataContext {
  preview: string
  schema: ColumnSchema[]
  fileName: string
  rowCount: number
}

interface AnalyzeInput {
  filePath: string
  taskType?: 'analyze' | 'visualize' | 'transform' | 'model'
  instructions: string
}

interface OutputFile {
  path: string
  name: string
  category: 'figures' | 'tables' | 'data'
}

export interface AnalyzeResult {
  success: boolean
  stdout?: string
  stderr?: string
  outputs: OutputFile[]
  code?: string
  attempts: number
  error?: string
}

// ============================================================================
// Prompts (inlined from academic-writing reference)
// ============================================================================

const BASE_ANALYSIS_PROMPT = `You are an expert Python data analyst. You write clean, efficient Python code for data analysis tasks.

CRITICAL PATH RULES — you MUST follow these exactly:
- The runtime pre-defines these variables before your code runs:
    DATA_FILE  — absolute path to the input data file
    FIGURES_DIR — absolute path to save figures
    TABLES_DIR  — absolute path to save CSV tables
    DATA_DIR    — absolute path to save transformed data
- You MUST use DATA_FILE to read the input. Do NOT compute, derive, or hardcode any file path.
- You MUST use FIGURES_DIR, TABLES_DIR, DATA_DIR for outputs. Use os.path.join(FIGURES_DIR, "name.png") etc.
- Do NOT use os.path.dirname(__file__) or any path derivation logic. The paths are already absolute.
- Do NOT save outputs to any other directory. Only use FIGURES_DIR, TABLES_DIR, DATA_DIR.

STRICT MINIMAL OUTPUT RULE — violation of this rule is a failure:
- Generate ONLY the outputs the user explicitly asked for. NOTHING more.
- Count the nouns in the user's request: "a plot" = 1 figure, "two charts" = 2 figures.
- If the user asks for "a plot", produce EXACTLY 1 PNG file. Not 2, not 5. ONE.
- If the user asks for "statistics", produce EXACTLY 1 summary CSV. Not 10.
- Do NOT generate summary tables, extra analyses, or supplementary files unless the user explicitly asks.
- Do NOT save intermediate DataFrames as CSV.
- Do NOT create "bonus" outputs like activity plots, summary CSVs, or top-N tables.
- Before writing any plt.savefig() or df.to_csv(), ask yourself: "Did the user request this specific output?" If no, DELETE that code.
- The number of output files must exactly match the number of outputs the user requested.

Other rules:
- Always use the standard imports provided in the template header
- Save figures as PNG (use plt.savefig(), NOT plt.show())
- Save tables as CSV files
- Use descriptive filenames for all outputs
- Print a summary of results to stdout
- Handle missing data gracefully
- Use tight_layout() for all matplotlib figures
- Set figure DPI to 150 for good quality
- Always close figures after saving (plt.close())
`

const TASK_INSTRUCTIONS: Record<string, string> = {
  analyze: `Task: Statistical Analysis
- Compute descriptive statistics (mean, median, std, quartiles)
- Identify correlations between numeric columns
- Detect outliers using IQR or z-score methods
- Print key findings to stdout
- Save summary statistics as a CSV table`,

  visualize: `Task: Data Visualization
- Create appropriate plots based on the data types and user instructions
- Use matplotlib and seaborn for publication-quality figures
- Add proper titles, axis labels, and legends
- Use a clean style (seaborn whitegrid or similar)
- Save each figure as a separate PNG file`,

  transform: `Task: Data Transformation
- Clean, reshape, or transform the data as instructed
- Handle missing values, type conversions, and encoding issues
- Save the transformed dataset as a CSV file
- Print a summary of changes made`,

  model: `Task: Statistical Modeling
- Build appropriate statistical or machine learning models
- Use sklearn or statsmodels as appropriate
- Report model performance metrics
- Save results summary as a CSV table
- Print key metrics to stdout`
}

const CODE_TEMPLATE_HEADER = `import os
import json
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
import warnings
warnings.filterwarnings('ignore')
`

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Read first N lines of a file for preview
 */
function readDataPreview(filePath: string, maxLines = 50): string {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  return lines.slice(0, maxLines).join('\n')
}

/**
 * Infer column schema from file header/first row
 */
function inferDataSchema(filePath: string): { columns: ColumnSchema[]; rowCount: number } {
  const ext = extname(filePath).toLowerCase()
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      if (rows.length === 0) return { columns: [], rowCount: 0 }
      const firstRow = rows[0]
      const columns = Object.keys(firstRow).map(name => ({
        name,
        type: typeof firstRow[name]
      }))
      return { columns, rowCount: rows.length }
    } catch {
      // Malformed JSON — treat as unstructured text
      return { columns: [], rowCount: lines.length }
    }
  }

  // Only attempt CSV/TSV parsing for known tabular extensions
  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ','
    if (lines.length < 1) return { columns: [], rowCount: 0 }

    const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''))

    // Infer types from first data row
    const firstDataLine = lines.length > 1 ? lines[1].split(delimiter).map(v => v.trim().replace(/^"|"$/g, '')) : []
    const columns = headers.map((name, i) => {
      const val = firstDataLine[i]
      let type = 'string'
      if (val !== undefined && val !== '') {
        if (!isNaN(Number(val))) type = 'number'
        else if (val === 'true' || val === 'false') type = 'boolean'
      }
      return { name, type }
    })

    return { columns, rowCount: Math.max(0, lines.length - 1) }
  }

  // Unstructured files (.log, .txt, etc.) — no column schema, just line count
  return { columns: [], rowCount: lines.length }
}

/**
 * Extract Python code from LLM response
 */
function extractPythonCode(response: string): string | null {
  // Try markdown code block first
  const blockMatch = response.match(/```python\s*\n([\s\S]*?)```/)
  if (blockMatch) return blockMatch[1].trim()

  // Fallback: look for import statements as code start
  const lines = response.split('\n')
  const importIdx = lines.findIndex(l => l.startsWith('import ') || l.startsWith('from '))
  if (importIdx >= 0) {
    return lines.slice(importIdx).join('\n').trim()
  }

  return null
}

/**
 * Execute a Python script using the framework's PythonBridge (script mode).
 * Wraps with a 120s timeout since PythonBridge script mode has no built-in timeout.
 */
async function executeScript(scriptPath: string, cwd: string): Promise<{ success: boolean; stdout: string; error?: string }> {
  const bridge = new PythonBridge({
    script: scriptPath,
    mode: 'script',
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: '1' }
  })

  const timeoutMs = 120000
  const result = await Promise.race([
    bridge.call<string>('run'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Python script timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    )
  ])

  if (!result.success) {
    return { success: false, stdout: '', error: result.error || 'Script failed' }
  }

  // PythonBridge returns stdout as data (string) on success
  const stdout = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')
  return { success: true, stdout }
}

/**
 * Collect output files from the output directories
 */
function collectOutputs(outputBase: string): OutputFile[] {
  const outputs: OutputFile[] = []
  const categories = ['figures', 'tables', 'data'] as const

  for (const category of categories) {
    const dir = join(outputBase, category)
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter(f => !f.startsWith('.'))
    for (const file of files) {
      outputs.push({
        path: join(dir, file),
        name: file,
        category
      })
    }
  }

  return outputs
}

/**
 * Build system prompt based on task type
 */
function buildSystemPrompt(taskType: string): string {
  const taskInstr = TASK_INSTRUCTIONS[taskType] || TASK_INSTRUCTIONS.analyze
  return `${BASE_ANALYSIS_PROMPT}\n\n${taskInstr}`
}

/**
 * Build user prompt with data context and output paths
 */
function buildUserPrompt(
  instructions: string,
  context: DataContext,
  outputBase: string,
  previousError?: string
): string {
  const schemaStr = context.schema.length > 0
    ? 'Schema:\n' + context.schema.map(c => `  - ${c.name} (${c.type})`).join('\n')
    : 'This is an unstructured text file (not CSV). Parse it line-by-line as needed.'

  let prompt = `Data file: ${context.fileName} (${context.rowCount} lines)

${schemaStr}

Data preview (first lines):
\`\`\`
${context.preview}
\`\`\`

The following variables are ALREADY DEFINED before your code runs — use them directly:
- DATA_FILE  → read input with: pd.read_csv(DATA_FILE) or json.load(open(DATA_FILE))
- FIGURES_DIR → save figures with: plt.savefig(os.path.join(FIGURES_DIR, "name.png"))
- TABLES_DIR  → save tables with: df.to_csv(os.path.join(TABLES_DIR, "name.csv"))
- DATA_DIR    → save data with: df.to_csv(os.path.join(DATA_DIR, "name.csv"))

Do NOT derive or redefine any paths. They are absolute and correct.

Instructions: ${instructions}

Write a complete Python script. Use DATA_FILE to load the data. Do NOT define your own paths.`

  if (previousError) {
    prompt += `\n\nPREVIOUS ATTEMPT FAILED with this error:\n\`\`\`\n${previousError}\n\`\`\`\nFix the error and try a different approach if needed.`
  }

  return prompt
}

// ============================================================================
// Main Factory
// ============================================================================

export function createDataAnalyzer(config: {
  apiKey: string
  model?: string
  projectPath: string
  sessionId?: string
}) {
  const { apiKey, model = 'gpt-5.2', projectPath, sessionId } = config
  const languageModel = getLanguageModelByModelId(model, { apiKey })

  const outputBase = join(projectPath, '.research-pilot', 'outputs')
  const scriptsDir = join(projectPath, '.research-pilot', 'analysis', 'scripts')

  // Ensure output directories exist
  for (const sub of ['figures', 'tables', 'data']) {
    mkdirSync(join(outputBase, sub), { recursive: true })
  }
  mkdirSync(scriptsDir, { recursive: true })

  return {
    async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
      const { filePath, taskType = 'analyze', instructions } = input

      // Resolve file path relative to projectPath
      const absPath = resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, outputs: [], attempts: 0, error: `File not found: ${filePath}` }
      }

      // Create per-run output directory to isolate this analysis from previous runs.
      // This prevents old outputs from being re-registered as new entities.
      const runId = `run_${Date.now()}`
      const runLabel = instructions.slice(0, 50).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'analysis'
      const runOutputBase = join(outputBase, runId)
      for (const sub of ['figures', 'tables', 'data']) {
        mkdirSync(join(runOutputBase, sub), { recursive: true })
      }

      // Read data preview and infer schema
      const preview = readDataPreview(absPath)
      const { columns, rowCount } = inferDataSchema(absPath)
      const fileName = basename(absPath)

      const dataContext: DataContext = { preview, schema: columns, fileName, rowCount }
      const systemPrompt = buildSystemPrompt(taskType)

      let previousError: string | undefined
      const maxAttempts = 3
      const retryBudget = new RetryBudget(DEFAULT_BUDGET_CONFIG)

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Build prompt and call LLM
        const userPrompt = buildUserPrompt(instructions, dataContext, runOutputBase, previousError)

        const result = await generateText({
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt
        })

        const responseText = result.text
        const code = extractPythonCode(responseText)

        if (!code) {
          previousError = 'Failed to extract Python code from LLM response'
          continue
        }

        // Prepend standard imports, data file path, and output directories.
        // The "DO NOT MODIFY" block prevents the LLM-generated code from
        // overriding these paths with its own derivation logic.
        const fullCode = `${CODE_TEMPLATE_HEADER}
# ===== DO NOT MODIFY: Runtime-injected paths =====
DATA_FILE = r"${absPath}"
FIGURES_DIR = r"${join(runOutputBase, 'figures')}"
TABLES_DIR = r"${join(runOutputBase, 'tables')}"
DATA_DIR = r"${join(runOutputBase, 'data')}"
for _d in [FIGURES_DIR, TABLES_DIR, DATA_DIR]:
    os.makedirs(_d, exist_ok=True)
# ===== END runtime paths =====

${code}`

        // Write script
        const timestamp = Date.now()
        const scriptPath = join(scriptsDir, `analysis_${timestamp}.py`)
        writeFileSync(scriptPath, fullCode, 'utf-8')

        // Execute via PythonBridge
        const execResult = await executeScript(scriptPath, projectPath)

        if (!execResult.success) {
          // Build structured error feedback for the LLM
          const agentError = createPythonError(execResult.error || 'Script failed')
          const feedback = executionFailureFeedback(agentError)
          previousError = formatFeedbackAsToolResult(feedback)

          // Check retry budget before continuing
          if (attempt < maxAttempts && retryBudget.canRetry(agentError.category, agentError.recoverability)) {
            retryBudget.record(agentError.category)
            continue
          }

          return {
            success: false,
            stdout: execResult.stdout,
            stderr: execResult.error,
            outputs: [],
            code: fullCode,
            attempts: attempt,
            error: `Python script failed after ${attempt} attempts: ${agentError.message}`
          }
        }

        // Collect outputs only from this run's directory (not shared/old outputs)
        const outputs = collectOutputs(runOutputBase)

        // Register each output as a DataAttachment entity
        const cliContext: CLIContext = {
          sessionId: sessionId || 'data-analyzer',
          projectPath
        }

        for (const output of outputs) {
          const ext = extname(output.name).toLowerCase()
          const mimeMap: Record<string, string> = {
            '.png': 'image/png',
            '.csv': 'text/csv',
            '.json': 'application/json',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg'
          }
          saveData(
            output.name,
            {
              filePath: output.path,
              mimeType: mimeMap[ext] || 'application/octet-stream',
              tags: [taskType, 'auto-generated'],
              runId,
              runLabel
            },
            cliContext
          )
        }

        return {
          success: true,
          stdout: execResult.stdout,
          outputs,
          code: fullCode,
          attempts: attempt
        }
      }

      return {
        success: false,
        outputs: [],
        attempts: maxAttempts,
        error: previousError || 'Unknown error'
      }
    }
  }
}
