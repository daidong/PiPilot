/**
 * Data Analysis Module
 *
 * Python code execution powered data analysis.
 * Flow: preflight → rich schema inference → adaptive summary → LLM codegen
 *       → execute Python (streaming) → collect outputs via manifest → register entities
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename, extname, resolve, relative, dirname } from 'path'
import { execFileSync } from 'child_process'
import { generateText } from 'ai'

import { getLanguageModelByModelId } from '../../../src/index.js'
import { PythonBridge } from '../../../src/python/bridge.js'
import { executionFailureFeedback, formatFeedbackAsToolResult } from '../../../src/core/feedback.js'
import { createPythonError } from '../../../src/core/errors.js'
import { RetryBudget, DEFAULT_BUDGET_CONFIG } from '../../../src/core/retry.js'
import { saveData } from '../commands/save-data.js'
import { loadPrompt } from './prompts/index.js'
import type { CLIContext, ColumnSchemaDetailed, ResultsManifest } from '../types.js'

// ============================================================================
// Types
// ============================================================================

interface DataContext {
  summary: string
  schema: ColumnSchemaDetailed[]
  fileName: string
  rowCount: number
  isStructured: boolean
}

interface AnalyzeInput {
  filePath: string
  taskType?: 'analyze' | 'visualize' | 'transform' | 'model'
  instructions: string
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

interface OutputFile {
  path: string
  name: string
  category: 'figures' | 'tables' | 'data'
  title?: string
  description?: string
}

export interface AnalyzeResult {
  success: boolean
  stdout?: string
  stderr?: string
  outputs: OutputFile[]
  code?: string
  attempts: number
  error?: string
  manifest?: ResultsManifest
  errorCategory?: import('../../../src/core/errors.js').ErrorCategory
}

// ============================================================================
// Dependency Preflight
// ============================================================================

let depsChecked = false

function checkPythonDeps(): { ok: boolean; error?: string } {
  if (depsChecked) return { ok: true }

  try {
    execFileSync('python3', ['-c', 'import pandas, numpy, matplotlib, seaborn'], {
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    depsChecked = true
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `Missing Python dependencies. Install with: pip install pandas numpy matplotlib seaborn\n${msg}`
    }
  }
}

// ============================================================================
// Prompts
// ============================================================================

const BASE_ANALYSIS_PROMPT = loadPrompt('data-analysis-system')

/**
 * Parse task instructions from the markdown file.
 * The file uses ## headings as task keys with content below each.
 */
function parseTaskInstructions(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  const sections = raw.split(/^## /m).filter(Boolean)
  for (const section of sections) {
    const newlineIdx = section.indexOf('\n')
    if (newlineIdx === -1) continue
    const key = section.slice(0, newlineIdx).trim()
    const body = section.slice(newlineIdx + 1).trim()
    result[key] = body
  }
  return result
}

const TASK_INSTRUCTIONS: Record<string, string> = parseTaskInstructions(loadPrompt('data-analysis-tasks'))

const CODE_TEMPLATE_HEADER = loadPrompt('data-code-template')

// ============================================================================
// Schema Inference
// ============================================================================

const SCHEMA_SCRIPT = join(dirname(new URL(import.meta.url).pathname), 'schema-inference.py')

interface SchemaInferenceResult {
  isStructured: boolean
  rowCount: number
  columns: ColumnSchemaDetailed[]
  sampleRows?: unknown[][]
  firstLines?: string[]
  lineCount?: number
  patterns?: { hasTimestamps: boolean; hasDelimiters: boolean; hasKeyValue: boolean }
  error?: string
  inferenceWarning?: string
}

/**
 * Run rich schema inference via the Python script. Falls back to TS-based inference on failure.
 */
function inferDataSchemaRich(filePath: string): SchemaInferenceResult {
  try {
    const output = execFileSync('python3', [SCHEMA_SCRIPT, filePath], {
      timeout: 30000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return JSON.parse(output) as SchemaInferenceResult
  } catch {
    // Fallback: basic TS-based inference
    return inferDataSchemaFallback(filePath)
  }
}

/**
 * Fallback TS-based schema inference (legacy logic)
 */
function inferDataSchemaFallback(filePath: string): SchemaInferenceResult {
  const ext = extname(filePath).toLowerCase()
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      if (rows.length === 0) return { isStructured: true, rowCount: 0, columns: [] }
      const firstRow = rows[0]
      const columns: ColumnSchemaDetailed[] = Object.keys(firstRow).map(name => ({
        name,
        dtype: typeof firstRow[name],
        missingRate: 0
      }))
      return { isStructured: true, rowCount: rows.length, columns }
    } catch {
      return { isStructured: false, rowCount: lines.length, columns: [], firstLines: lines.slice(0, 20) }
    }
  }

  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ','
    if (lines.length < 1) return { isStructured: true, rowCount: 0, columns: [] }

    const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''))
    const firstDataLine = lines.length > 1 ? lines[1].split(delimiter).map(v => v.trim().replace(/^"|"$/g, '')) : []
    const columns: ColumnSchemaDetailed[] = headers.map((name, i) => {
      const val = firstDataLine[i]
      let dtype = 'object'
      if (val !== undefined && val !== '') {
        if (!isNaN(Number(val))) dtype = 'float64'
        else if (val === 'true' || val === 'false') dtype = 'bool'
      }
      return { name, dtype, missingRate: 0 }
    })

    return { isStructured: true, rowCount: Math.max(0, lines.length - 1), columns }
  }

  // Unstructured
  return { isStructured: false, rowCount: lines.length, columns: [], firstLines: lines.slice(0, 20) }
}

// ============================================================================
// Adaptive Summary
// ============================================================================

/**
 * Build an LLM-friendly text summary from the rich schema inference result
 */
function buildAdaptiveSummary(schema: SchemaInferenceResult): string {
  if (schema.isStructured && schema.columns.length > 0) {
    const parts: string[] = []
    parts.push(`Structured data: ${schema.rowCount} rows, ${schema.columns.length} columns\n`)
    parts.push('Column details:')
    for (const col of schema.columns) {
      let line = `  - ${col.name} (${col.dtype}, ${(col.missingRate * 100).toFixed(1)}% missing)`
      if (col.min !== undefined) {
        line += ` | range: [${col.min}, ${col.max}] | mean: ${col.mean}`
      }
      if (col.topKValues && col.topKValues.length > 0) {
        const top = col.topKValues.slice(0, 3).map(v => `"${v.value}"(${v.count})`).join(', ')
        line += ` | top values: ${top}`
      }
      parts.push(line)
    }

    if (schema.sampleRows && schema.sampleRows.length > 0) {
      parts.push('\nSample rows:')
      const headers = schema.columns.map(c => c.name)
      parts.push(`  ${headers.join(' | ')}`)
      for (const row of schema.sampleRows) {
        parts.push(`  ${row.map(v => v === null ? 'NA' : String(v)).join(' | ')}`)
      }
    }

    return parts.join('\n')
  }

  // Unstructured
  const parts: string[] = []
  parts.push(`Unstructured text file: ${schema.lineCount ?? schema.rowCount} lines\n`)
  if (schema.patterns) {
    const flags: string[] = []
    if (schema.patterns.hasTimestamps) flags.push('timestamps detected')
    if (schema.patterns.hasDelimiters) flags.push('delimiters detected')
    if (schema.patterns.hasKeyValue) flags.push('key=value pairs detected')
    if (flags.length > 0) parts.push(`Detected patterns: ${flags.join(', ')}`)
  }
  if (schema.firstLines && schema.firstLines.length > 0) {
    parts.push('\nFirst 20 lines:')
    for (const line of schema.firstLines) {
      parts.push(`  ${line}`)
    }
  }

  return parts.join('\n')
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract Python code from LLM response
 */
function extractPythonCode(response: string): string | null {
  const blockMatch = response.match(/```python\s*\n([\s\S]*?)```/)
  if (blockMatch) return blockMatch[1].trim()

  const lines = response.split('\n')
  const importIdx = lines.findIndex(l => l.startsWith('import ') || l.startsWith('from '))
  if (importIdx >= 0) {
    return lines.slice(importIdx).join('\n').trim()
  }

  return null
}

/**
 * Execute a Python script using the framework's PythonBridge (script mode).
 * Timeout is handled by PythonBridge's built-in graceful timeout.
 */
async function executeScript(
  scriptPath: string,
  cwd: string,
  options?: {
    onStdout?: (line: string) => void
    onStderr?: (line: string) => void
    executionTimeout?: number
    gracePeriod?: number
  }
): Promise<{ success: boolean; stdout: string; error?: string }> {
  const bridge = new PythonBridge({
    script: scriptPath,
    mode: 'script',
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: '1' },
    executionTimeout: options?.executionTimeout ?? 120000,
    gracePeriod: options?.gracePeriod ?? 5000
  })

  // Attach streaming callbacks if provided
  if (options?.onStdout) {
    bridge.on('stdout', options.onStdout)
  }
  if (options?.onStderr) {
    bridge.on('stderr', options.onStderr)
  }

  const result = await bridge.call<string>('run')

  if (!result.success) {
    return { success: false, stdout: '', error: result.error || 'Script failed' }
  }

  const stdout = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')
  return { success: true, stdout }
}

/**
 * Collect output files from the output directories (fallback when no manifest)
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
 * Validate that an output path is within allowed directories
 */
function validateOutputPath(outputPath: string, allowedBase: string): boolean {
  const rel = relative(allowedBase, outputPath)
  return !rel.startsWith('..') && !rel.startsWith('/')
}

/**
 * Collect outputs using the results manifest file, falling back to directory scan
 */
function collectOutputsFromManifest(
  manifestPath: string,
  runOutputBase: string
): { outputs: OutputFile[]; manifest?: ResultsManifest } {
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, 'utf-8')
      const manifest = JSON.parse(raw) as ResultsManifest

      const outputs: OutputFile[] = manifest.outputs
        .filter(o => validateOutputPath(o.path, runOutputBase))
        .map(o => {
          const categoryMap: Record<string, OutputFile['category']> = {
            figure: 'figures',
            table: 'tables',
            data: 'data'
          }
          return {
            path: o.path,
            name: basename(o.path),
            category: categoryMap[o.type] || 'data',
            title: o.title,
            description: o.description
          }
        })

      return { outputs, manifest }
    } catch {
      // Manifest exists but is malformed — fall through to directory scan
    }
  }

  // Fallback: directory scan
  return { outputs: collectOutputs(runOutputBase) }
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
  resultsFilePath: string,
  previousError?: string
): string {
  let prompt = `Data file: ${context.fileName} (${context.rowCount} ${context.isStructured ? 'rows' : 'lines'})

${context.summary}

The following variables are ALREADY DEFINED before your code runs — use them directly:
- DATA_FILE  → read input with: pd.read_csv(DATA_FILE) or json.load(open(DATA_FILE))
- FIGURES_DIR → save figures with: plt.savefig(os.path.join(FIGURES_DIR, "name.png"))
- TABLES_DIR  → save tables with: df.to_csv(os.path.join(TABLES_DIR, "name.csv"))
- DATA_DIR    → save data with: df.to_csv(os.path.join(DATA_DIR, "name.csv"))
- RESULTS_FILE → call write_results() at the end (already defined)

Do NOT derive or redefine any paths. They are absolute and correct.
Remember to call write_results() at the very end of your script.

Instructions: ${instructions}

Write a complete Python script. Use DATA_FILE to load the data. Do NOT define your own paths.`

  if (previousError) {
    prompt += `\n\nPREVIOUS ATTEMPT FAILED with this error:\n\`\`\`\n${previousError}\n\`\`\``
    if (context.isStructured && context.schema.length > 0) {
      prompt += `\n\nAvailable columns: ${context.schema.map(c => c.name).join(', ')}`
      prompt += `\nRemember to call write_results() at the end.`
    }
    prompt += `\nFix the error and try a different approach if needed.`
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
  const { apiKey, model, projectPath, sessionId } = config
  if (!model) throw new Error('data-team: model is required')
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
      const { filePath, taskType = 'analyze', instructions, onStdout, onStderr } = input

      // Dependency preflight check
      const depsResult = checkPythonDeps()
      if (!depsResult.ok) {
        return {
          success: false,
          outputs: [],
          attempts: 0,
          error: depsResult.error,
          errorCategory: 'resource'
        }
      }

      // Resolve file path relative to projectPath
      const absPath = resolve(projectPath, filePath)
      if (!existsSync(absPath)) {
        return { success: false, outputs: [], attempts: 0, error: `File not found: ${filePath}` }
      }

      // Create per-run output directory
      const runId = `run_${Date.now()}`
      const runLabel = instructions.slice(0, 50).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'analysis'
      const runOutputBase = join(outputBase, runId)
      for (const sub of ['figures', 'tables', 'data']) {
        mkdirSync(join(runOutputBase, sub), { recursive: true })
      }

      // Results manifest path for this run
      const resultsFilePath = join(runOutputBase, `results_${runId}.json`)

      // Rich schema inference
      const schemaResult = inferDataSchemaRich(absPath)
      const fileName = basename(absPath)
      const adaptiveSummary = buildAdaptiveSummary(schemaResult)

      const dataContext: DataContext = {
        summary: adaptiveSummary,
        schema: schemaResult.columns,
        fileName,
        rowCount: schemaResult.rowCount,
        isStructured: schemaResult.isStructured
      }
      const systemPrompt = buildSystemPrompt(taskType)

      let previousError: string | undefined
      const maxAttempts = 3
      const retryBudget = new RetryBudget(DEFAULT_BUDGET_CONFIG)

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const userPrompt = buildUserPrompt(instructions, dataContext, runOutputBase, resultsFilePath, previousError)

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

        // Prepend standard imports, path variables, and write_results() helper
        const fullCode = `${CODE_TEMPLATE_HEADER}
# ===== DO NOT MODIFY: Runtime-injected paths =====
DATA_FILE = r"${absPath}"
FIGURES_DIR = r"${join(runOutputBase, 'figures')}"
TABLES_DIR = r"${join(runOutputBase, 'tables')}"
DATA_DIR = r"${join(runOutputBase, 'data')}"
RESULTS_FILE = r"${resultsFilePath}"
for _d in [FIGURES_DIR, TABLES_DIR, DATA_DIR]:
    os.makedirs(_d, exist_ok=True)
# ===== END runtime paths =====

${code}`

        // Write script
        const timestamp = Date.now()
        const scriptPath = join(scriptsDir, `analysis_${timestamp}.py`)
        writeFileSync(scriptPath, fullCode, 'utf-8')

        // Execute via PythonBridge with streaming
        const execResult = await executeScript(scriptPath, projectPath, {
          onStdout,
          onStderr,
          executionTimeout: 120000,
          gracePeriod: 5000
        })

        if (!execResult.success) {
          const agentError = createPythonError(execResult.error || 'Script failed')
          const feedback = executionFailureFeedback(agentError)
          previousError = formatFeedbackAsToolResult(feedback)

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
            error: `Python script failed after ${attempt} attempts: ${agentError.message}`,
            errorCategory: agentError.category
          }
        }

        // Collect outputs via manifest (with fallback to directory scan)
        const { outputs, manifest } = collectOutputsFromManifest(resultsFilePath, runOutputBase)

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

          // Find matching manifest entry for metadata
          const manifestEntry = manifest?.outputs.find(o => basename(o.path) === output.name)

          saveData(
            output.title || output.name,
            {
              filePath: output.path,
              mimeType: mimeMap[ext] || 'application/octet-stream',
              tags: [
                taskType,
                'auto-generated',
                ...(manifestEntry?.tags || [])
              ],
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
          attempts: attempt,
          manifest
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
