/**
 * Run Store — JSONL persistence for local compute run records.
 *
 * Thin subclass of the shared JsonlRunStore. Storage lives at
 * .research-pilot/compute-runs/runs.jsonl; stdout and stderr are kept in
 * separate per-run files (local is the only backend that separates streams).
 * All persistence behavior (debounced flush, atomic rename, eviction) is
 * inherited — see lib/compute/jsonl-run-store.ts.
 */

import path from 'node:path'
import { JsonlRunStore } from '../compute/jsonl-run-store.js'
import { type RunRecord, type RunState, isTerminal } from './types.js'

export class RunStore extends JsonlRunStore<RunState, RunRecord> {
  constructor(projectPath: string) {
    super({
      dir: path.join(projectPath, '.research-pilot', 'compute-runs'),
      fileName: 'runs.jsonl',
      outputFileName: 'output.log',
      stderrFileName: 'output.log.stderr',
      isTerminal,
    })
  }
}
