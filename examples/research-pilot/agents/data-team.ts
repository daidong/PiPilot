/**
 * Data Analysis Team
 *
 * Self-contained data analysis using the AgentFoundry Team module.
 * Flow: schemaInferrer (tool) → analyzer (LLM)
 */

import { existsSync, readFileSync } from 'fs'
import { basename, extname } from 'path'

import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  createAutoTeamRuntime,
  simpleStep
} from '../../../src/team/index.js'

import {
  defineAgent as defineSimpleAgent,
  createAgentContext,
  type Agent as SimpleAgent,
  type AgentContext
} from '../../../src/agent/define-simple-agent.js'

import { getLanguageModelByModelId } from '../../../src/index.js'

// ============================================================================
// Schema Inferrer (Tool agent, no LLM)
// ============================================================================

interface ColumnSchema {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'null' | 'mixed'
  nullCount: number
  sampleValues: unknown[]
}

interface InferredSchema {
  fileName: string
  format: string
  columns: ColumnSchema[]
  rowCount: number
  sampleRows: Record<string, unknown>[]
  fileSizeBytes: number
}

function createSchemaInferrer() {
  return {
    id: 'schemaInferrer',
    kind: 'tool-agent' as const,

    async run(input: { filePath: string; question?: string }): Promise<{ output: { schema: InferredSchema; question?: string } }> {
      const { filePath, question } = input

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`)
      }

      const raw = readFileSync(filePath, 'utf-8')
      const ext = extname(filePath).toLowerCase()
      const fileName = basename(filePath)
      const fileSizeBytes = Buffer.byteLength(raw, 'utf-8')

      let rows: Record<string, unknown>[]

      if (ext === '.json') {
        const parsed = JSON.parse(raw)
        rows = Array.isArray(parsed) ? parsed : [parsed]
      } else if (ext === '.csv' || ext === '.tsv') {
        const delimiter = ext === '.tsv' ? '\t' : ','
        const lines = raw.split('\n').filter(l => l.trim())
        if (lines.length < 1) throw new Error('Empty CSV/TSV file')
        const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''))
        rows = lines.slice(1).map(line => {
          const values = line.split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''))
          const row: Record<string, unknown> = {}
          headers.forEach((h, i) => { row[h] = values[i] ?? null })
          return row
        })
      } else {
        throw new Error(`Unsupported file format: ${ext}`)
      }

      // Infer column types
      const allKeys = new Set<string>()
      rows.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)))

      const columns: ColumnSchema[] = Array.from(allKeys).map(name => {
        const values = rows.map(r => r[name])
        const nonNull = values.filter(v => v !== null && v !== undefined && v !== '')
        let type: ColumnSchema['type'] = 'string'

        if (nonNull.length > 0) {
          const types = new Set(nonNull.map(v => {
            if (typeof v === 'number' || (!isNaN(Number(v)) && v !== '')) return 'number'
            if (typeof v === 'boolean' || v === 'true' || v === 'false') return 'boolean'
            if (typeof v === 'string' && !isNaN(Date.parse(v)) && v.length > 6) return 'date'
            return 'string'
          }))
          type = types.size === 1 ? (types.values().next().value as ColumnSchema['type']) : 'mixed'
        }

        return {
          name, type,
          nullCount: values.length - nonNull.length,
          sampleValues: nonNull.slice(0, 3)
        }
      })

      const schema: InferredSchema = {
        fileName, format: ext.replace('.', ''),
        columns, rowCount: rows.length,
        sampleRows: rows.slice(0, 5),
        fileSizeBytes
      }

      return { output: { schema, question } }
    }
  }
}

// ============================================================================
// Analyzer Agent (LLM)
// ============================================================================

const analyzer = defineSimpleAgent({
  id: 'analyzer',
  description: 'Data Analysis Specialist who examines datasets',

  system: `You are a Data Analysis Specialist. Given a dataset schema, sample data, and optionally a question,
provide a thorough analysis.

Output JSON:
{
  "datasetName": "string",
  "overview": "string describing the dataset",
  "quality": {
    "score": number (0-1),
    "issues": ["issue1", "issue2"],
    "recommendations": ["rec1"]
  },
  "insights": [
    { "title": "string", "description": "string", "confidence": number }
  ],
  "suggestedAnalyses": ["analysis1", "analysis2"],
  "visualizations": [
    { "type": "bar|line|scatter|heatmap|pie", "x": "column", "y": "column", "description": "string" }
  ]
}`,

  prompt: (input) => {
    const data = input as { schema?: InferredSchema; question?: string }
    const schema = data?.schema
    if (!schema) return 'No schema provided.'

    const colInfo = schema.columns
      .map(c => `  - ${c.name} (${c.type}, ${c.nullCount} nulls, samples: ${c.sampleValues.slice(0, 2).join(', ')})`)
      .join('\n')

    const sampleData = JSON.stringify(schema.sampleRows?.slice(0, 3), null, 2)
    const questionStr = data.question ? `\n\nUser question: ${data.question}` : ''

    return `Analyze this dataset:\n\nFile: ${schema.fileName} (${schema.format}, ${schema.rowCount} rows)\n\nColumns:\n${colInfo}\n\nSample data:\n${sampleData}${questionStr}`
  }
})

// ============================================================================
// Team Definition & Factory
// ============================================================================

export function createDataTeam(config: {
  apiKey: string
  model?: string
}) {
  const { apiKey, model = 'gpt-5.2' } = config
  if (!apiKey) throw new Error('API key is required')

  const languageModel = getLanguageModelByModelId(model, { apiKey })
  const schemaInferrer = createSchemaInferrer()

  const agentCtx: AgentContext = {
    getLanguageModel: () => languageModel
  }

  const createLLMRunner = (agent: SimpleAgent) => {
    return async (input: unknown) => {
      const result = await agent.run(input, agentCtx)
      if (!result.success) throw new Error(result.error ?? 'Agent execution failed')
      return result.output
    }
  }

  const createSchemaRunner = () => {
    return async (input: unknown) => {
      const data = input as { filePath?: string; question?: string }
      if (!data?.filePath) throw new Error('filePath is required')
      const result = await schemaInferrer.run({ filePath: data.filePath, question: data.question })
      return result.output
    }
  }

  const team = defineTeam({
    id: 'data-analysis',
    name: 'Data Analysis Team',
    agents: {
      schemaInferrer: agentHandle('schemaInferrer', schemaInferrer, { runner: createSchemaRunner() }),
      analyzer: agentHandle('analyzer', analyzer, { runner: createLLMRunner(analyzer) })
    },
    state: stateConfig.memory('data-analysis'),
    flow: seq(
      simpleStep('schemaInferrer').from('initial').to('schema'),
      simpleStep('analyzer').from('schema').to('analysis')
    ),
    defaults: {
      concurrency: 1,
      timeouts: { agentSec: 60, flowSec: 180 }
    }
  })

  const runtime = createAutoTeamRuntime({ team, context: agentCtx })

  return {
    runtime,

    async analyze(input: { filePath: string; question?: string }): Promise<{
      success: boolean
      analysis?: unknown
      error?: string
      steps: number
      durationMs: number
    }> {
      const result = await runtime.run(input)

      if (result.success && result.finalState) {
        const stateData = result.finalState['data-analysis'] as Record<string, unknown> | undefined
        const analysis = stateData?.analysis
        return { success: true, analysis, steps: result.steps, durationMs: result.durationMs }
      }

      return { success: false, error: result.error, steps: result.steps, durationMs: result.durationMs }
    }
  }
}
