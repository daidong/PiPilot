/**
 * EC2 instance ledger (RFC-009 §0.2 Phase 1 acceptance criterion #5).
 *
 * Persists every EC2 run so a mid-run app crash can rediscover the live
 * instance and either reattach or terminate it. The central invariant is:
 *
 *   ────────────────────────────────────────────────────────────────────
 *   ZERO orphan instances. EVER. The store is the authoritative record
 *   of which AWS instances this app started — terminate decisions read
 *   from here on hydrate(), and the runner writes here BEFORE returning
 *   from submit() so a crash between RunInstances and a successful
 *   write cannot lose track of an instance.
 *   ────────────────────────────────────────────────────────────────────
 *
 * Thin subclass of the shared JsonlRunStore (lib/compute/jsonl-run-store.ts).
 * The instance ledger needs one extra synchronous-flush trigger beyond the
 * shared terminal-transition rule: any change to `instanceId` is flushed
 * immediately, because losing that write is what would orphan an instance.
 *
 * Storage: JSONL at <projectPath>/.research-pilot/compute-runs/aws-ec2-runs.jsonl
 */

import path from 'node:path'
import { JsonlRunStore } from '../compute/jsonl-run-store.js'
import { type AwsEc2RunRecord, type AwsEc2RunState, isEc2Terminal } from './types.js'

export class AwsEc2RunStore extends JsonlRunStore<AwsEc2RunState, AwsEc2RunRecord> {
  constructor(projectPath: string) {
    super({
      dir: path.join(projectPath, '.research-pilot', 'compute-runs'),
      fileName: 'aws-ec2-runs.jsonl',
      outputFileName: 'output.log',
      isTerminal: isEc2Terminal,
      flushImmediatelyOn: (patch, existing) =>
        patch.instanceId !== undefined && patch.instanceId !== existing.instanceId,
    })
  }
}
