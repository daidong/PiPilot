/**
 * `bash` (pi-coding-agent) provenance adapter.
 *
 * Args: { command, timeout? }. Returns plain text (stdout/stderr).
 *
 * Per RFC §3.5: we record the *act* of running the command but never try to
 * infer what files it produced. Files written by subprocesses (Python scripts
 * etc.) become orphan workspace-file nodes if a later artifact-producing tool
 * consumes them — the auditor surfaces those as `reproducibility` findings.
 *
 * Output: one `computation` node only.
 */

import type { ProvenanceAdapter, ProvenanceFacts, OutputFact } from '../types.js'

export const bashAdapter: ProvenanceAdapter = (args, _result, _ctx): ProvenanceFacts | null => {
  const command = typeof args.command === 'string' ? args.command : null
  if (!command) return null

  const synthetic = `bash:${truncate(command, 80)}`

  const outputs: OutputFact[] = [{
    kind: 'computation',
    ref: { kind: 'computation', toolCallId: synthetic },
    label: `bash: ${truncate(command, 60)}`
  }]

  return { outputs, inputs: [] }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
