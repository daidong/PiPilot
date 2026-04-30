/**
 * convert_document provenance adapter.
 *
 * The tool reads a PDF/DOCX (or downloads a URL) and writes the converted
 * markdown/text to {projectPath}/.research-pilot/cache/converted/...
 *
 * Output: one workspace-file at `output_path`.
 * Input:  the source file (when input_path is provided) or none for URL fetches.
 */

import type { ProvenanceAdapter, ProvenanceFacts, NodeRef } from '../types.js'
import { parseResultJson } from './index.js'

export const convertDocumentAdapter: ProvenanceAdapter = (args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const outputPath = typeof data.output_path === 'string' ? data.output_path : null
  if (!outputPath) return null // tool returned inline content only — no workspace artifact to track

  const inputs: NodeRef[] = []
  const inputPath = typeof data.input_path === 'string' ? data.input_path : (typeof args.path === 'string' ? args.path : null)
  if (inputPath) {
    inputs.push({ kind: 'workspace-file', path: inputPath })
  }

  const sourceLabel = typeof data.downloaded_from_url === 'string'
    ? data.downloaded_from_url
    : (inputPath ?? 'document')

  return {
    outputs: [{
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path: outputPath },
      label: `convert: ${sourceLabel}`
    }],
    inputs
  }
}
