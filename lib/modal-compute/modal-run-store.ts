/**
 * Modal run store — JSONL persistence for Modal compute run records.
 *
 * Thin subclass of the shared JsonlRunStore (lib/compute/jsonl-run-store.ts).
 * Modal interleaves stdout/stderr into a single modal-output.log, so no
 * separate stderr file is configured.
 */

import path from 'node:path'
import { JsonlRunStore } from '../compute/jsonl-run-store.js'
import { type ModalRunRecord, type ModalRunState, isModalTerminal } from './types.js'

export class ModalRunStore extends JsonlRunStore<ModalRunState, ModalRunRecord> {
  constructor(projectPath: string) {
    super({
      dir: path.join(projectPath, '.research-pilot', 'compute-runs'),
      fileName: 'modal-runs.jsonl',
      outputFileName: 'modal-output.log',
      isTerminal: isModalTerminal,
    })
  }
}
