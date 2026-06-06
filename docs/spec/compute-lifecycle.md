# RFC-016: Compute Lifecycle — Ephemeral-Local + Poll-Remote (lessons from Claude Code)

> Spec version: 0.4 (DRAFT — not implemented) | Last updated: 2026-06-06
>
> Status: **PROPOSED**. Replaces the earlier patch-oriented "durable run
> reconciliation" sketch floated in discussion. This RFC reframes three
> separately-reported bugs as symptoms of one architectural mistake and
> converges them onto a single, simpler lifecycle model. With v0.4 it is the
> canonical compute-lifecycle spec; the active design set is **this RFC + RFC-017
> (UI)**.
>
> v0.4: **corrects §4.4** after code review — local is *already*
> `requiresApproval: false` (`local-backend.ts:117`); the real orphan cause is
> that `compute_plan` and `{backend}_execute` are **two separate agent calls**, so
> a born-approved local plan still waits for the second call. "Auto-run local"
> therefore = **fuse plan+execute**, not "remove a gate". Also **folds RFC-015 in**
> (§4.4 / §8): RFC-015 is now the detailed *remote-bridge* reference, not a
> separate track.
>
> v0.3: adds **scheduled / recurring runs** (§4.5) — a thin app-lifetime cron
> *trigger layer*, not a third track. Prompted by multi-day longitudinal
> experiments (e.g. a 14-day cache-TTL probe). Supersedes a briefly-floated
> standalone "RFC-018" — it belongs here because each scheduled tick is just an
> ordinary §4.1/§4.2 run.
>
> v0.2: **local runs auto-execute — no per-task approval** (§4.4). Approval
> becomes a remote/cost concern only. This dissolves the orphan-plan bug for
> local entirely and narrows RFC-015's bridge to remote backends.
>
> **RFC-015 is folded into this RFC** (§4.4 / §8). Its remote confirm→submit
> bridge is now specced here; the RFC-015 file is retained only as the worked-out
> mechanism reference (serialization / idempotency / optional enhancement turn).

## 1. Three bugs, one root cause

Reported separately while running local compute:

1. **Zombie runs.** A run whose process has finished still shows "running"
   forever (green dot, animated bar, `DURATION --`, `0 lines`), and never flips
   to completed/failed.
2. **Orphan plans.** A plan approved in the Compute tab never runs — it sits at
   "approved — waiting for agent to execute" (RFC-015's domain).
3. **Effectively sequential.** Only one run executes at a time even when tasks
   are trivial I/O-bound HTTP probes, and a zombie run permanently occupies the
   single "heavy" slot, starving everything behind it.

These look unrelated. They are the same mistake: **AgentFoundry keeps a
*persisted local "running" state machine* as the source of truth for a task's
liveness, but never continuously reconciles it against where the task actually
lives.** It pays the full cost of persistence without the correctness.

Evidence (as-built):

- Completion is detected only by an **in-memory** promise:
  `handle.wait().then(handleExit)` (`runner.ts:288`). The continuous monitor
  `pollOnce` has **no process-liveness check** — only output-growth, stall,
  output-cap, timeout (`runner.ts:527-608`). So if the runner is reconstructed
  (main-process hot reload, model switch, project reopen → new `LocalBackend` →
  new `ComputeRunner`, empty `handles` map), nothing finalizes the run.
- `reconcileStaleRuns()` is a **one-shot startup check** (`runner.ts:188`, called
  in the constructor) and marks survivors **unconditionally `failed`**
  (`runner.ts:193`) — so a run that *succeeded* but wasn't observed finishing is
  mislabeled.
- The sandbox **never persists the exit code**: `process-sandbox.ts` spawns
  `detached: true` (`:40`) and resolves `wait()` from an in-memory
  `child.on('exit')` (`:60`). After a runner reconstruction the exit code is
  unrecoverable.
- The scheduler classifies weight by **timeout, not resources**
  (`scheduler.ts` `classifyWeight`: `≤2min → light else heavy`; default timeout
  60min → everything "heavy"), caps `MAX_HEAVY_CONCURRENT = 1`, and gates on a
  blanket `MIN_FREE_MEMORY_MB = 500` measured via `os.freemem()`
  (`runner.ts:136`) — which on macOS undercounts available memory badly.

## 2. Reference: how Claude Code does it

Claude Code (decompiled source at `…/claude-code/`) runs background tasks with a
deliberately thinner model:

- **No scheduler.** No admission control, no heavy/light classification, no
  `MAX_CONCURRENT`, no queue for background bash/compute tasks. Tasks run
  concurrently; the model decides how many to spawn; the OS handles contention.
  (The `messageQueueManager` is a *completion-notification* queue, not an
  execution gate.)
- **Task state is in-memory, session-scoped, not persisted.**
  `AppState.tasks: { [id]: TaskState }` (`state/AppStateStore.ts`), explicitly
  "NOT persisted". When Claude Code exits, the local task registry is gone — it
  is never shown as eternally "running", because there is no persisted `running`
  record to drift. (The file-locked `utils/tasks.ts` is the separate *todo-list*
  feature, unrelated to compute.)
- **Task *output* is persisted to disk**, decoupled from state. Per-task
  append-only `<taskId>.output` files (`utils/task/diskOutput.ts`), 5GB cap,
  incremental `getTaskOutputDelta()` and tail `getTaskOutput()`. Observability is
  durable even though state is not.
- **Completion is push, not poll.** In-memory `await result.code` →
  `completed/failed/killed` by exit code (`LocalShellTask.tsx`) → a notification
  is *pushed* into the message queue.
- **Remote tasks poll the remote.** `RemoteAgentTask` registers a
  `registerCompletionChecker` invoked every poll tick that hits the external API;
  `pollStartedAt` is recorded "at spawn **or on restore**". The remote service is
  the source of truth — there is no trusted local liveness flag.
- **No "reconcile stale running" housekeeping.** `backgroundHousekeeping.ts` only
  does generic cleanup (npm cache, old versions). It needs no run reconciliation,
  because local runs are ephemeral and remote runs are re-derived by polling.

## 3. The unifying principle

> **The source of truth for a task's liveness lives where the task lives.**
> Local → the OS (PID) + in-memory await + on-disk output/exit-sentinel.
> Remote → poll the remote API.
> Never a separate, persisted local "running" flag trusted on its own.

Every one of the three bugs is a violation of this single rule, applied to local
tasks. AgentFoundry's mistake is using **one uniform persisted-and-scheduled
model for both local and remote**, when only remote needs durable reconciliation.

## 4. Dual-track design

Split the lifecycle by *where the task lives*, exposed as a backend capability
(e.g. `livenessModel: 'ephemeral-local' | 'remote-poll'`). The `ComputeBackend`
interface and registry are unchanged; only how a run is *tracked to completion*
differs.

### 4.1 Local track — ephemeral state, durable output

- **State**: in-memory run registry. Do **not** keep a persisted `running` state
  machine as the source of truth.
- **Output**: append-only to disk (already have `outputPath`) — durable,
  incremental observability, independent of whether state is in memory.
- **Completion — two paths to the same answer**:
  - *Fast path* (same session): in-memory `handle.wait()` → status by exit code.
    Unchanged.
  - *Slow path* (after a runner reconstruction): the child persists its own exit
    code, so completion is re-derivable. Wrap the command so the **child** writes
    its status: `sh -c '<cmd>; echo $? > <runDir>/exit_code'`. The sentinel is
    written by the child, not by our (now-gone) in-memory handler.
- **Continuous liveness in the monitor**: `pollOnce` gains a liveness check for
  handle-less runs — if `isStaleRun(run)` (PID dead), read `exit_code` and
  finalize: `0 → completed`, `non-zero → failed`, `missing → killed` (SIGKILL
  before write). This makes the monitor — not just the in-memory `handle.wait()` —
  able to finalize, which is what was missing.
- **Startup reconcile uses the sentinel too**: `reconcileStaleRuns()` stops
  marking everything `failed`; it reads the sentinel and assigns the real terminal
  status (fixes the "successful run mislabeled failed on restart" facet).
- **Restart behavior**: on reconstruction, for each prior run re-derive from
  OS + sentinel — alive → re-attach a *liveness poller* (not a handle, which is
  gone); dead → finalize from sentinel. Never leave an unreconciled `running`.
- **Concurrency**: drop the heavy/light scheduler for local. Run concurrently;
  let the OS arbitrate. Keep at most a *soft, configurable* cap for sanity (not a
  blanket memory gate). Resource safety is retained by the existing **OOM
  failure-signal** + **stall detection** (post-hoc), not pre-admission blocking —
  which also dissolves the `MIN_FREE_MEMORY_MB = 500` / macOS-`freemem` bug.
- **History**: persist an **immutable terminal result record** (status, exitCode,
  output path, timings) for the Compute tab's run history. That is fine — it is a
  fact about a finished run. What we stop persisting *as truth* is the **live
  `running`** state.

### 4.2 Remote track — durable handle, poll the source of truth

- **State**: persist a *pointer* (instanceId / jobId / containerId) for
  reconnection — a handle, not a trusted status cache.
- **Liveness/completion**: poll the remote API (Modal API, AWS EC2/SSM,
  `docker inspect`) on a tick; the remote service is the source of truth.
  `hydrate()` re-derives status by polling, never by trusting a stored flag.
- **Concurrency**: remote is elastic — no local serialization.
- This is where persistence + reconciliation is genuinely warranted (the job
  outlives the local process), and it mirrors Claude Code's `RemoteAgentTask`
  completion-checker model.

### 4.3 Backend → track mapping

| Backend | Track |
|---|---|
| `local` (process / docker-local) | ephemeral-local (§4.1) |
| `modal` | remote-poll (§4.2) |
| `aws-ec2` | remote-poll (§4.2) |

Docker-local is interesting: the container *is* queryable (`docker inspect`
returns exit code), so it can use the remote-poll mechanics locally — i.e. the
sentinel approach is for the *process* sandbox; docker reuses `inspect`.

### 4.4 Approval, and why local plans still orphan

**Correction (v0.4, from code review).** Local is **already** un-gated:
`local-backend.ts:117` declares `requiresApproval: false` (only `modal` /
`aws-ec2` are `true`). Effective gating is `forceApprovalForAll ||
backend.requiresApproval`, so a local plan is gated **only** when the user turns
on Settings → Compute → "require approval for all backends". Local's problem was
never "remove an approval gate" — there is none by default.

The real orphan cause is structural: **`compute_plan` and `{backend}_execute`
are two separate agent tool calls.** A non-gated local plan is born `approved:
true`, but it does **not run** until the agent makes the second call. If the
agent plans a batch and its turn ends before executing (or just stops), the plan
sits forever as "approved — waiting for agent to execute". Approval is a
*separate* gate on top; removing it does not close this gap.

The model splits by track:

- **Local → fuse plan + execute (auto-run).** For a non-gated backend, planning
  and submitting are **one step**: either a single `run` tool (plan + submit
  fused) or the registry auto-submits a born-approved plan on `plan()`. No
  "waiting for agent to execute" placeholder, no orphan. The agent still gets the
  plan's risk/recommendations back from the fused call; the run enters the local
  track (§4.1). The controls that matter for local are (1) up-front trust (a
  settings decision, not per-task) and (2) strong *post-start* management —
  observe / stop / kill + the OOM/stall safety signals.
- **Local danger check (rule-based, not LLM).** A cheap pattern check (reuse
  `strategy.ts`'s risk pass) flags *genuinely* dangerous commands (recursive
  delete, network exfil…) for a one-tap confirm — **warn only when risky**, not
  approve-everything. Mirrors Claude Code's destructive-command warnings.
- **Remote → plan → confirm(cost) → submit (the absorbed RFC-015 bridge).**
  Modal/AWS spend real money, so keep the explicit step. On a user *confirm*, the
  main process **deterministically `submit()`s** the plan (the "spine") using its
  captured `recommendations`, idempotently (submit is already memoized and clears
  the plan on success); an optional lightweight agent turn narrates + monitors.
  The run enters the remote track (§4.2). *(Mechanism formerly RFC-015, folded
  here; see that file for the worked serialization / idempotency / enhancement-turn
  detail.)*
- **`forceApprovalForAll` stays** as the escape hatch: a paranoid / shared-lab
  user re-imposes a gate on local, which then routes through the same confirm
  step as remote.

Consequence: the orphan-plan bug closes by **fusing plan+execute for local** and
**deterministic submit-on-confirm for remote** — not by per-task approval
machinery.

### 4.5 Scheduled / recurring runs (a trigger layer, not a third track)

Multi-day longitudinal experiments are not one-shot runs and are **not a third
track** — they are a thin **trigger layer** that fires ordinary runs (§4.1/§4.2)
on a schedule. Motivating shape: a 14-day cache-TTL probe — insert a fresh prefix
hourly (unique seed avoids pollution), check hits at +1m/+10m/+1h/+6h/+12h/+24h,
≈336 hourly samples per provider.

Model — deliberately minimal; **the app stays dumb**:

- A **cron task** = `{ id, schedule (cron expr / interval), command, workDir,
  backend, enabled }`, persisted as `~/.research-pilot/cron/<id>.json` —
  **home-scoped** (a standing task, not tied to one project).
- A **scanner** runs while the app is open: every ~1 min it checks each enabled
  task and, when due, **submits the command as a normal run** (ephemeral-local
  §4.1 or remote §4.2). Each tick shows up in the Compute run history like any
  other run.
- **The app owns recurrence only.** Per-tick experiment logic (which prefix to
  insert, which offset checks are due) lives in the **script**, which reads its
  own state file. The app does not model offsets — it only guarantees periodic
  invocation. (Materializing every check into an app-side ledger was the
  needless complexity in the first sketch; the script owns its own cadence.)

Honest property — **best-effort, app-open only**:

- The scanner ticks only while the app is running. Ticks due during downtime (app
  closed, laptop asleep) are **skipped by default**, not backfilled. Surface
  `lastRun / nextDue / missedSinceLastOpen` so gaps are **visible, not silent**.
- For *time-critical* experiments (the probe's exact offsets), a skipped tick is a
  **lost sample**. That is a **per-experiment substrate choice**, not a scanner
  feature to engineer around: tolerate gaps → run locally; need zero gaps → run on
  a remote always-on backend (§4.2 — Modal scheduled functions / an always-on
  instance). The scanner stays simple either way.

Composition + approval: a scheduled tick reuses §4.1/§4.2 wholesale — completion,
output persistence, and re-derived truth all apply unchanged. Per §4.4, local
ticks auto-run; a remote scheduled task confirms cost **once at creation**
(RFC-015), not per tick.

Decisions (defaults chosen; override in settings):
- Scope: **home-scoped** (`~/.research-pilot/cron/`).
- Missed ticks: **skip** (optional per-task "catch up once on reopen").
- Each tick → an ordinary §4.1/§4.2 run.

UI: managed in the Compute tab's **Scheduled** section (RFC-017 §4.5) — list,
enable/disable, next-due, last-run, missed count, edit, delete.

## 5. How each bug dissolves

| Bug | Why it happens today | Dissolved by |
|---|---|---|
| Zombie runs | persisted `running` + in-memory-only exit detection + one-shot reconcile + no exit-code on disk | §4.1: continuous liveness in monitor + child-written exit sentinel; state is no longer a trusted persisted flag |
| Sequential | timeout-based heavy/light + single heavy slot + zombie occupying it | §4.1: drop the local scheduler (OS-managed concurrency); zombies gone so no slot is held |
| Orphan plans | `compute_plan` and `execute` are two agent calls; an (already) approved plan never runs until the 2nd call, which may never come | **Local**: §4.4 fuses plan+execute (no 2nd call to miss). **Remote**: deterministic submit on cost-confirm (§4.4) |

The blanket-memory-gate bug (a 4th, raised separately) also dissolves: §4.1
removes pre-admission resource gating in favour of OS arbitration + post-hoc OOM
signals.

## 6. Where AgentFoundry should refine, not copy, Claude Code

Claude Code abandons local tasks on exit (session-scoped, mostly short). 
AgentFoundry runs **long, detached local compute** (60-min probes) the user
wants to observe across app restarts. So we keep CC's *ephemeral state* but add
**recoverability**: detached process + child-written exit sentinel + PID
re-derivation. This is the one intentional divergence — "ephemeral state, but the
*facts* (output + exit code) are on disk so a reopened app can reconstruct
truth." We do **not** add back a trusted persisted `running` flag.

Open product decision: on app quit, do we (a) leave local runs detached and
reconcile on reopen, or (b) kill them (CC-style)? Given 60-min jobs, default to
(a). See §10.

## 7. Concrete change set (by track)

**Local track**
- `lib/local-compute/sandbox/process-sandbox.ts`: wrap command to write
  `<runDir>/exit_code`; expose the sentinel path on the run record.
- `lib/local-compute/runner.ts`: add liveness+sentinel finalization to
  `pollOnce`; make `reconcileStaleRuns` read the sentinel; resume a liveness
  poller (not a handle) for alive runs after reconstruction.
- `lib/local-compute/scheduler.ts`: remove heavy/light + `MIN_FREE_MEMORY_MB`
  hard gate; optional soft `MAX_TOTAL_CONCURRENT` (config). Keep OOM/stall.
- run-store: split "live state" (in-memory) from "terminal result record"
  (persisted, immutable). Stop persisting `running` as source of truth.

**Remote track**
- `lib/compute/backends/{modal,aws-ec2}/*`: `hydrate()` + a poll tick re-derive
  status from the remote API; persist only the reconnection pointer.

**Shared**
- `ComputeBackend` capability `livenessModel`; registry routes finalization logic
  by it.

## 8. RFC-015 (folded in)

RFC-015's remote approval→execution bridge is **folded into §4.4** as of v0.4 —
the canonical spec is now this document. The RFC-015 file is retained only as the
detailed mechanism reference (turn serialization, idempotency, the optional
enhancement turn) for the remote confirm→submit step. There is no separate
"RFC-015 track": local fuses plan+execute (§4.4); remote confirms-then-submits
(§4.4) and the run enters the remote track (§4.2). Active design = **this RFC +
RFC-017 (UI)**.

## 9. Migration / rollout

- **Phase 1 — stop the bleeding (covers bug 1, unblocks bug 3).** Child exit
  sentinel + `pollOnce` liveness finalization + sentinel-aware `reconcileStaleRuns`.
  Smallest change; kills zombies and frees the heavy slot.
- **Phase 2 — simplify local concurrency (bug 3 + memory-gate bug).** Drop
  heavy/light + blanket memory gate; OS-managed concurrency with an optional soft
  cap. Split live-state from terminal-result history.
- **Phase 3 — fuse plan+execute for local + danger check (bug 2, local).**
  Non-gated local plans plan-and-submit in one step (no separate execute call to
  orphan on); add the rule-based danger check (§4.4). Delete the "approved —
  waiting for agent to execute" placeholder. (`requiresApproval` is *already*
  false for local — this is the structural fix, not a flag flip.)
- **Phase 4 — remote track + remote confirm.** Make Modal/AWS `hydrate()` poll the
  remote source of truth; formalize the `livenessModel` capability; land RFC-015's
  cost-confirm→submit for remote.
- **Phase 5 — scheduled runs (§4.5).** Home-scoped cron files + app-lifetime
  scanner that fires due ticks as §4.1/§4.2 runs; `lastRun/nextDue/missed`
  surfacing. Independent of 1–4 (rides whatever tracks exist).

Phases 1–2 are the high-value core (they retire most of the lifecycle complexity
that produced the bugs). 3, 4, 5 can follow independently.

## 10. Risks & open questions

1. **Sentinel reliability.** SIGKILL (or a power loss) before the child writes
   `exit_code` → finalize as `killed`. Acceptable and honest.
2. **Dropping the scheduler.** A genuinely heavy local job (ML training) could
   thrash if many run at once. Mitigation: a *soft, configurable* concurrency cap
   and/or a profile-based *advisory* (not a hard blanket gate). Flagged because it
   reverses an intentional "one-heavy-at-a-time" guard — we judge the guard
   mis-tuned (timeout proxy), not wrong in spirit.
3. **Quit policy** (detach+reconcile vs kill-on-quit) — §6. Default detach.
4. **Backward-compat.** Existing `compute-plans.json` / run-store entries: migrate
   in-flight `running` records to "reconcile on first load via sentinel/PID";
   old records without a sentinel → finalize as `unknown/killed`.
5. **Compute tab history** must keep showing finished runs — preserved via the
   immutable terminal-result record (§4.1), not the dropped live-state.

## 11. Out of scope

- The approval *gate policy* (`requiresApproval` / `forceApprovalForAll`) — unchanged.
- Profile-driven *cost* estimation — orthogonal.
- Reworking the `ComputeBackend` registry/abstraction itself (RFC-008) — this RFC
  changes lifecycle tracking, not the backend interface beyond one capability flag.
