/**
 * `edit` (pi-coding-agent) provenance adapter.
 *
 * Args: { path, edits: [...] }. Returns plain-text result like
 *   "Successfully replaced N block(s) in {path}".
 *
 * Provenance shape:
 *   - one `computation` node for the edit operation
 *   - one `workspace-file` node for the new file version (default-snapshotted)
 *   - `derived-from` edge: prior workspace-file version → new workspace-file
 *     (auto-emitted by emitNodeWithVersionLink in capture.ts)
 */

import type { ProvenanceAdapter, ProvenanceFacts, OutputFact } from '../types.js'

export const editAdapter: ProvenanceAdapter = (args, _result, _ctx): ProvenanceFacts | null => {
  const path = typeof args.path === 'string' ? args.path
            : typeof args.file_path === 'string' ? args.file_path
            : null
  if (!path) return null

  const editsCount = Array.isArray(args.edits) ? args.edits.length : 0
  const synthetic = `edit:${path}:${editsCount}`

  const outputs: OutputFact[] = [
    {
      kind: 'computation',
      ref: { kind: 'computation', toolCallId: synthetic },
      label: `edit ${path} (${editsCount} block${editsCount === 1 ? '' : 's'})`
    },
    {
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path },
      label: path
    }
  ]

  return { outputs, inputs: [] }
}
