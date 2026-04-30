/**
 * data_analyze provenance adapter.
 *
 * The tool runs LLM-generated Python against a dataset and produces:
 *   - one Python script at scriptPath (workspace-file)
 *   - zero or more output files under figures/, tables/, data/ subdirs
 *   - structured stdout in the result payload
 *
 * Provenance shape:
 *   - One `computation` node represents the analysis run (the *act*).
 *   - One `workspace-file` for the generated script (input to the computation).
 *   - One `workspace-file` per produced output, each linked back to the computation.
 *   - Input edges from the source dataset (args.file_path) to the computation.
 *
 * Note: a `computation` node's ref carries `toolCallId`, which is not in `args`.
 * We use the runId from the payload as a stable correlation id instead — it
 * survives replays and is meaningful to the user when they read `graph.jsonl`.
 */

import type { ProvenanceAdapter, ProvenanceFacts, NodeRef, OutputFact } from '../types.js'
import { parseResultJson } from './index.js'

export const dataAnalyzeAdapter: ProvenanceAdapter = (args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const runId = typeof data.runId === 'string' ? data.runId : null
  const scriptPath = typeof data.scriptPath === 'string' ? data.scriptPath : null
  if (!runId) return null

  const filePath = typeof args.file_path === 'string' ? args.file_path : null
  const taskType = typeof args.task_type === 'string' ? args.task_type : 'analyze'
  const instructions = typeof args.instructions === 'string' ? args.instructions : ''

  const outputs: OutputFact[] = []

  // Computation node — the *act* of running this analysis.
  outputs.push({
    kind: 'computation',
    ref: { kind: 'computation', toolCallId: runId },
    label: `data-analyze (${taskType}): ${truncate(instructions, 60)}`
  })

  // The generated script as a workspace-file (also default-snapshotted; usually small).
  if (scriptPath) {
    outputs.push({
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path: scriptPath },
      label: `analysis script ${runId}`
    })
  }

  // Each produced output file (figures, tables, data).
  const producedFiles = Array.isArray(data.outputs) ? data.outputs as Array<{ path?: unknown; type?: unknown; name?: unknown }> : []
  for (const f of producedFiles) {
    if (typeof f?.path !== 'string') continue
    outputs.push({
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path: f.path },
      label: `${typeof f.type === 'string' ? f.type : 'output'}: ${typeof f.name === 'string' ? f.name : f.path}`
    })
  }

  // Inputs: the source dataset.
  const inputs: NodeRef[] = []
  if (filePath) inputs.push({ kind: 'workspace-file', path: filePath })

  return { outputs, inputs }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
