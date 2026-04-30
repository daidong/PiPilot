/**
 * `write` (pi-coding-agent) provenance adapter.
 *
 * Args: { path, content }. Returns plain-text result like
 *   "Successfully wrote N bytes to {path}".
 *
 * Provenance shape:
 *   - one `computation` node for the act of writing
 *   - one `workspace-file` node for the target path (default-snapshotted)
 *   - `derived-from` edge: computation → workspace-file (added below)
 *
 * The workspace-file's content is read by capture.ts after the call, so the
 * snapshot reflects what was actually written.
 */

import type { ProvenanceAdapter, ProvenanceFacts, OutputFact } from '../types.js'

export const writeAdapter: ProvenanceAdapter = (args, _result, _ctx): ProvenanceFacts | null => {
  const path = typeof args.path === 'string' ? args.path
            : typeof args.file_path === 'string' ? args.file_path
            : null
  if (!path) return null

  // Synthetic toolCallId for the computation ref. capture.ts re-uses parametersHash
  // for identity, so this string just needs to be stable per call. Using the path +
  // content size from args gives us idempotence on replay.
  const synthetic = `write:${path}`

  const outputs: OutputFact[] = [
    {
      kind: 'computation',
      ref: { kind: 'computation', toolCallId: synthetic },
      label: `write ${path}`
    },
    {
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path },
      label: path
    }
  ]

  return { outputs, inputs: [] }
}
