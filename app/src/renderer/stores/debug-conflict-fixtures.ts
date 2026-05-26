/**
 * Debug fixtures for the conflict-resolve modal.
 *
 * Real merge conflicts in shared workspaces are slow to construct (need two
 * actors, two clones, simultaneous edits to the same lines, a push race…), so
 * for visual + interaction testing we inject this canned scenario via
 * Cmd+Shift+D — handled in App.tsx, fed into useSharingStore.
 *
 * Shape mirrors `ConflictFile` from lib/sharing/share.ts: { path, base, mine,
 * theirs, isBinary }. The bodies are intentionally short but have genuine
 * divergence (extra section on each side + line-level edits in shared lines) so
 * the diff view has something interesting to render and the AI-merged review
 * pane has something visible to show.
 *
 * Files included:
 *   1. 04_checkpoint_task_contract.md — both sides added a new section
 *   2. 05_scoring_and_result_schema.md — both sides edited overlapping fields
 *   3. directory-skills-cloudlab-initial-evaluation-plan.md — short doc, both sides reworded
 *   4. assets/architecture-diagram.png — binary edge case (mine/theirs as null blobs)
 */

import type { ConflictFile } from '../../preload/index'

const CHECKPOINT_BASE = `# Checkpoint Task Contract

A checkpoint task captures a point-in-time snapshot of the agent's working
state so a long-running plan can survive a process restart.

## Inputs
- Session id
- Plan id
- Current step index

## Outputs
- Snapshot id (durable)
- Restorable at \`memory-v2/checkpoints/<id>.json\`

## Lifecycle
1. Begin
2. Persist
3. Verify
4. Mark restorable
`

const CHECKPOINT_MINE = `# Checkpoint Task Contract

A checkpoint task captures a point-in-time snapshot of the agent's working
state so a long-running plan can survive a process restart **or a graceful
window close**.

## Inputs
- Session id
- Plan id
- Current step index
- **Active tool-call ledger offset** (added — needed to replay)

## Outputs
- Snapshot id (durable)
- Restorable at \`memory-v2/checkpoints/<id>.json\`

## Lifecycle
1. Begin
2. Persist
3. Verify
4. Mark restorable

## Rationale (new section — mine)

We hit a regression where checkpoints saved during tool-call execution lost
the in-flight call. Capturing the ledger offset lets the restore path replay
the partial call instead of re-running it from scratch.
`

const CHECKPOINT_THEIRS = `# Checkpoint Task Contract

A checkpoint task captures a point-in-time snapshot of the agent's working
state so a long-running plan can survive an unexpected restart.

## Inputs
- Session id
- Plan id
- Current step index

## Outputs
- Snapshot id (durable, content-addressable hash)
- Restorable at \`memory-v2/checkpoints/<id>.json\`
- **Provenance: which agent + which model produced the checkpoint** (added)

## Lifecycle
1. Begin
2. Persist
3. Verify
4. Mark restorable
5. **Emit telemetry event** (added)

## Test plan (new section — theirs)

- Unit: snapshot/restore round-trips for each tool type
- Integration: kill -9 mid-checkpoint, verify partial write is discarded
- Soak: 1000 checkpoints, assert no fd / memory leak
`

const SCORING_BASE = `## Scoring schema (v1)

\`\`\`ts
interface Score {
  passed: boolean
  reasoning: string
  confidence: number  // 0..1
}
\`\`\`

The harness records one \`Score\` per evaluation and aggregates by mean.
`

const SCORING_MINE = `## Scoring schema (v1)

\`\`\`ts
interface Score {
  passed: boolean
  reasoning: string
  confidence: number  // 0..1, clipped at runtime
  latencyMs: number   // added — needed for the perf report
}
\`\`\`

The harness records one \`Score\` per evaluation and aggregates by mean.
`

const SCORING_THEIRS = `## Scoring schema (v1)

\`\`\`ts
interface Score {
  passed: boolean
  reasoning: string
  confidence: number  // 0..1
  rubric: string      // added — which rubric produced this score
}
\`\`\`

The harness records one \`Score\` per evaluation and aggregates by **rubric-weighted mean**.
`

const PLAN_BASE = `# Directory skills — CloudLab initial evaluation plan

Goal: validate the directory-skills loader against three benchmark suites
within one week of standing up the CloudLab cluster.

Owner: Alice
Reviewer: Bob
`

const PLAN_MINE = `# Directory skills — CloudLab initial evaluation plan

Goal: validate the directory-skills loader against **four** benchmark suites
(added: io-microbench) within one week of standing up the CloudLab cluster.

Owner: Alice
Reviewer: Bob
Deadline: end of sprint 12
`

const PLAN_THEIRS = `# Directory skills — CloudLab initial evaluation plan

Goal: validate the directory-skills loader against three benchmark suites
within **two** weeks of standing up the CloudLab cluster (revised after
infrastructure delay).

Owner: Alice
Reviewer: Bob, Carol
`

/** Plausible 3-file markdown + 1-file binary scenario. */
export function getDebugConflictFiles(): ConflictFile[] {
  return [
    {
      path: 'code/implementation_plans/components/04_checkpoint_task_contract.md',
      base: CHECKPOINT_BASE,
      mine: CHECKPOINT_MINE,
      theirs: CHECKPOINT_THEIRS,
      isBinary: false,
    },
    {
      path: 'code/implementation_plans/components/05_scoring_and_result_schema.md',
      base: SCORING_BASE,
      mine: SCORING_MINE,
      theirs: SCORING_THEIRS,
      isBinary: false,
    },
    {
      path: 'plans/directory-skills-cloudlab-initial-evaluation-plan.md',
      base: PLAN_BASE,
      mine: PLAN_MINE,
      theirs: PLAN_THEIRS,
      isBinary: false,
    },
    {
      path: 'assets/architecture-diagram.png',
      base: null,
      mine: null,
      theirs: null,
      isBinary: true,
    },
  ]
}

/**
 * Fake AI-merged content for `slowMergeSim` mode. Constructed to look like a
 * reasonable reconciliation (keeps mine's structure, splices in theirs's
 * additions, marks the synthesis at the top so the review pane shows visible
 * AI authorship vs the user's original).
 */
export function getDebugMergedContent(file: ConflictFile): string {
  if (file.isBinary) return file.mine ?? file.theirs ?? ''
  const mine = file.mine ?? ''
  const theirs = file.theirs ?? ''

  // For the canned scenarios we hand-write the expected merge so the review
  // diff is meaningful instead of garbled. Falls back to mine for anything not
  // recognized (the real backend handles the long tail).
  if (file.path.endsWith('04_checkpoint_task_contract.md')) {
    return `# Checkpoint Task Contract

A checkpoint task captures a point-in-time snapshot of the agent's working
state so a long-running plan can survive a process restart, a graceful window
close, or an unexpected crash.

## Inputs
- Session id
- Plan id
- Current step index
- Active tool-call ledger offset

## Outputs
- Snapshot id (durable, content-addressable hash)
- Restorable at \`memory-v2/checkpoints/<id>.json\`
- Provenance: which agent + which model produced the checkpoint

## Lifecycle
1. Begin
2. Persist
3. Verify
4. Mark restorable
5. Emit telemetry event

## Rationale

We hit a regression where checkpoints saved during tool-call execution lost
the in-flight call. Capturing the ledger offset lets the restore path replay
the partial call instead of re-running it from scratch.

## Test plan

- Unit: snapshot/restore round-trips for each tool type
- Integration: kill -9 mid-checkpoint, verify partial write is discarded
- Soak: 1000 checkpoints, assert no fd / memory leak
`
  }
  if (file.path.endsWith('05_scoring_and_result_schema.md')) {
    return `## Scoring schema (v1)

\`\`\`ts
interface Score {
  passed: boolean
  reasoning: string
  confidence: number  // 0..1, clipped at runtime
  latencyMs: number   // perf report
  rubric: string      // which rubric produced this score
}
\`\`\`

The harness records one \`Score\` per evaluation and aggregates by rubric-weighted mean.
`
  }
  if (file.path.endsWith('directory-skills-cloudlab-initial-evaluation-plan.md')) {
    return `# Directory skills — CloudLab initial evaluation plan

Goal: validate the directory-skills loader against four benchmark suites
(io-microbench added) within two weeks of standing up the CloudLab cluster
(revised after infrastructure delay).

Owner: Alice
Reviewer: Bob, Carol
Deadline: end of sprint 12
`
  }
  // Generic fallback: mine + a synthesis comment.
  return `${mine}\n\n<!-- AI-merged: combined both sides; theirs added:\n${theirs.slice(0, 200)}…\n-->\n`
}
