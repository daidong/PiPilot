# RFC-016: Compute Lifecycle — Ephemeral-Local + Poll-Remote (lessons from Claude Code)

> Spec version: 0.2 (DRAFT — not implemented) | Last updated: 2026-06-06
>
> Status: **PROPOSED**. Replaces the earlier patch-oriented "durable run
> reconciliation" sketch floated in discussion. This RFC reframes three
> separately-reported bugs as symptoms of one architectural mistake and
> converges them onto a single, simpler lifecycle model.
>
> v0.2: **local runs auto-execute — no per-task approval** (§4.4). Approval
> becomes a remote/cost concern only. This dissolves the orphan-plan bug for
> local entirely and narrows RFC-015's bridge to remote backends.
>
> Relationship to **RFC-015** (auto-execute on approval): with v0.2, RFC-015's
> approval→execution *bridge* applies to **remote** backends only (where real
> spend warrants a confirm). Local needs no bridge — it auto-runs (§4.4) and the
> run enters the local track directly. RFC-016 supplies the *lifecycle the
> submitted/auto-run task then lives in* (§8).

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

### 4.4 Approval is a remote/cost concern — local auto-runs

The per-task "plan → approve → execute" gate is **redundant friction for local
tasks** and should be dropped. The agent already has unrestricted local
code-execution via its built-in `bash`/code tools — gating `local_execute`
behind a second, heavier plan-approval is inconsistent: either you trust the
agent to run local code (then per-task approval is noise) or you don't (then it
belongs to the up-front bash-permission/trust layer, not a compute workflow).
This mirrors Claude Code: permission is an up-front *trust gate*, not a per-task
approval; once running, you can stop/kill.

The model therefore splits the gate by track:

- **Local → auto-run.** Default `requiresApproval = false`. The controls that
  matter are (1) up-front trust (a settings/permission decision, not per-task)
  and (2) strong *post-start* management — observe live output, stop/kill early,
  plus the OOM/stall safety signals. No "approved — waiting for agent to execute"
  placeholder; no orphan-plan state.
- **Local danger check (rule-based, not LLM).** A cheap pattern check (reuse
  `strategy.ts`'s risk pass) flags *genuinely* dangerous commands (recursive
  delete, network exfil, etc.) for a one-tap confirm — **warn only when risky**,
  not approve-everything. Mirrors Claude Code's destructive-command warnings.
- **Remote → confirm (cost gate).** Modal/AWS spend real money and provision
  external resources; a confirm (or a cost ceiling) is warranted. This is where
  RFC-015's approval bridge lives.
- **`forceApprovalForAll` stays** as the escape hatch: a paranoid / shared-lab
  user can re-impose the gate on local too.

Consequence: the orphan-plan bug (bug 2) **evaporates for local** rather than
needing the RFC-015 machinery; RFC-015 narrows to remote.

## 5. How each bug dissolves

| Bug | Why it happens today | Dissolved by |
|---|---|---|
| Zombie runs | persisted `running` + in-memory-only exit detection + one-shot reconcile + no exit-code on disk | §4.1: continuous liveness in monitor + child-written exit sentinel; state is no longer a trusted persisted flag |
| Sequential | timeout-based heavy/light + single heavy slot + zombie occupying it | §4.1: drop the local scheduler (OS-managed concurrency); zombies gone so no slot is held |
| Orphan plans | approval flips a flag but nothing submits | **Local**: §4.4 drops per-task approval entirely — auto-runs, no orphan state. **Remote**: RFC-015 deterministic submit-on-confirm; the run then enters the remote track (§8) |

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

## 8. Relationship to RFC-015

With v0.2, RFC-015 applies to **remote** backends only (§4.4 makes local
auto-run, so local has no approval to bridge). On a user *confirm* of a remote
plan, the main process **deterministically** `submit()`s (the "spine"), then an
optional lightweight agent turn narrates + monitors. The submitted remote run
enters the **remote track (§4.2)**, whose status is re-derived by polling — so
RFC-015's spine never has to trust durable run-state. The two RFCs compose:
RFC-015 = *get a remote run started on confirm*, RFC-016 = *track any run
(local or remote) to completion*.

(RFC-015's header carries a cross-reference back here.)

## 9. Migration / rollout

- **Phase 1 — stop the bleeding (covers bug 1, unblocks bug 3).** Child exit
  sentinel + `pollOnce` liveness finalization + sentinel-aware `reconcileStaleRuns`.
  Smallest change; kills zombies and frees the heavy slot.
- **Phase 2 — simplify local concurrency (bug 3 + memory-gate bug).** Drop
  heavy/light + blanket memory gate; OS-managed concurrency with an optional soft
  cap. Split live-state from terminal-result history.
- **Phase 3 — approval bridge (bug 2).** Land RFC-015's deterministic
  submit-on-approval; run enters the local track.
- **Phase 4 — remote track.** Make Modal/AWS `hydrate()` poll the remote source
  of truth; formalize the `livenessModel` capability.

Phases 1–2 are the high-value core (they retire most of the lifecycle complexity
that produced the bugs). 3 and 4 can follow independently.

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
