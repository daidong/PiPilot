/**
 * generate_diagram provenance adapter.
 *
 * Tool produces:
 *   - one diagram file at outputPath (PNG/SVG)
 *   - one review log at reviewLogPath
 * Inputs: optional reference image path in args.reference_path.
 */

import type { ProvenanceAdapter, ProvenanceFacts, NodeRef, OutputFact } from '../types.js'
import { parseResultJson } from './index.js'

export const generateDiagramAdapter: ProvenanceAdapter = (args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const outputPath = typeof data.outputPath === 'string' ? data.outputPath : null
  if (!outputPath) return null

  const reviewLogPath = typeof data.reviewLogPath === 'string' ? data.reviewLogPath : null
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''

  const outputs: OutputFact[] = [{
    kind: 'workspace-file',
    ref: { kind: 'workspace-file', path: outputPath },
    label: `diagram: ${truncate(prompt, 60)}`
  }]

  if (reviewLogPath) {
    outputs.push({
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path: reviewLogPath },
      label: `diagram review log`
    })
  }

  const inputs: NodeRef[] = []
  const referencePath = typeof args.reference_path === 'string' ? args.reference_path : null
  if (referencePath) inputs.push({ kind: 'workspace-file', path: referencePath })

  return { outputs, inputs }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
