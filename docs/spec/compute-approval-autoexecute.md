# RFC-015: Auto-Execute Compute Plans on Approval

> Spec version: 0.1 (DRAFT — not implemented) | Last updated: 2026-06-05
>
> Status: **PROPOSED**. No code written. This RFC captures the design agreed in
> discussion so implementation can proceed against a fixed target. Supersedes the
> implicit "the agent must re-call execute after approval" contract documented
> nowhere and surprising in practice.
>
> v0.1: initial draft. Core decision: a **deterministic submit is the spine**
> (keeps the Local Compute axiom "LLM is never on the critical path" intact); the
> injected agent turn is an **enhancement layer** for narration + monitoring, not
> the thing that makes execution happen.

## 1. Problem

A local-compute plan that requires approval never runs after the user clicks
**Approve**. Approval and execution are decoupled, and nothing bridges them.

Evidence (call chain as-built):

1. Agent calls `compute_plan` → a gated `PlanRecord` (`approved: false`) is
   persisted to `.research-pilot/compute-plans.json` and shown in the Compute tab
   (`registry.ts:152` `plan()`, `plan-store.ts:66` `write()`).
2. Agent calls `{backend}_execute` → `registry.submit()` → `doSubmit()` throws
   `"Plan … requires approval and has not been approved yet"` when gated and not
   approved (`registry.ts:264`).
3. The execute tool catches that, returns `{ waiting_for_approval: true }`, and
   **the agent turn ends** — the tool does not block (`tools.ts:226-234`).
4. User clicks **Approve** → `approvePlan()` flips `approved: true` and emits
   `plan-approved` (`registry.ts:177-192`).
5. The **only** consumer of `plan-approved` is `safeSend(win, 'compute:event')`
   (`ipc.ts:715`) → the renderer store moves the card to an "approved — waiting for
   agent to execute" placeholder (`compute-store.ts:349`, `ComputeView.tsx:560`).
   Nothing calls `submit()`; nothing wakes the agent.

`registry.submit()` has exactly one caller — the agent's execute tool
(`tools.ts:216`). So after approval the plan is stuck unless a **fresh agent turn**
re-calls execute, which only happens if the user types into chat again. The
observable symptom is "Approve does nothing / the task seems cancelled." It is
neither a cancellation nor a resource problem (resources only matter once
`backend.submit()` actually starts a process).

## 2. Considered alternatives (summary)

| Option | What | Verdict |
|---|---|---|
| **A. UX hint** | Tell the user to go nudge the agent in chat | Minimal; doesn't fix the gap, just documents it |
| **B. Event → deterministic submit** | On `plan-approved`, main process calls `submit()` directly | Robust, durable, but agent never receives the `runId`, so it won't auto-monitor / incorporate results |
| **C. Execute tool blocks on approval** | `{backend}_execute` awaits approval, then submits | Feels intuitive but is the **least robust**: the wait is an in-memory suspended async fn that dies on app restart / turn abort (exactly the state stuck plans are in), freezes the agent for the whole wait, serializes multi-plan approval, and needs an awkward approval-timeout |
| **B′ (this RFC)** | Deterministic submit (spine) **+** injected lightweight agent turn (enhancement) for narration + monitoring | Durable, async, multi-plan-safe, keeps the agent in the loop, and keeps the LLM off the critical path |

Full analysis lives in the discussion thread; §3 below is the chosen design.

## 3. Design axiom alignment (the key decision)

Local Compute's stated axiom (`compute.md` §Design Axiom):

> **The system core is fully self-contained. LLM is never on the critical path.**

A naïve B′ ("inject a turn and hope the LLM calls execute") **violates** this — it
puts the LLM on the execution critical path. We therefore split B′ into two layers:

- **Spine (deterministic, axiom-compliant):** on a user `plan-approved`, the main
  process **directly** calls `registry.submit(backend, planId, opts)` using the
  plan's own captured `recommendations` for `timeoutMinutes` / `stallThresholdMinutes`.
  Execution is guaranteed regardless of any LLM behaviour.
- **Enhancement (LLM, optional):** a lightweight agent turn is injected **after**
  the submit, telling the agent "plan X was approved and is now running as
  `runId=…`" so it can `{backend}_wait` / `{backend}_status`, incorporate results,
  and narrate to the user. If this turn no-ops or errors, the run still completes.

This is the same shape as the existing v1.2 layering (LLM *enhances* profiling/risk
but is never *required*). The injected turn is sugar; the submit is load-bearing.

## 4. Flow

```
User clicks Approve (Compute tab)
  → IPC compute:approve-plan
  → registry.approvePlan()            [flips approved:true, emits plan-approved]
  → ipc subscriber sees plan-approved (user-origin, gated by setting)
  → SPINE:   registry.submit(backend, planId, {from plan.recommendations})  [guaranteed]
             → run starts, runId known, plan cleared from store
  → ENHANCE: enqueueAgentTurn(state, win, syntheticMessage(runId, planId))   [serialized]
             → agent observes runId, may wait/status, narrates
```

If the spine `submit()` fails (e.g. genuinely insufficient resources, rejected,
already-cleared), the failure is surfaced to the user through the same Compute-tab
run row + an error note; the enhancement turn is skipped or told about the failure.

## 5. Detailed design

### 5.1 Trigger & hook point
`plan-approved` is **always** user-initiated — `approvePlan()` is only reachable via
the `compute:approve-plan` IPC handler; the agent never calls it (and auto-approved
plans never emit it — `plan()` sets `approved` without emitting `plan-approved`).
So **every** `plan-approved` is a safe auto-execute signal.

Hook in the main process where compute events are already observed
(`ipc.ts:715`, the `compute.onEvent` forwarder) — branch on
`event.kind === 'plan-approved' && resolvedSettings.compute.autoExecuteOnApproval`.
Orchestration lives in ipc.ts (not the coordinator) because the turn boilerplate —
`onCoordinatorActive()`, `realtimeBuffer`, `safeSend('agent:done')`, `turnId`,
mention parsing — all lives in the `agent:send` handler (`ipc.ts:1414-1507`).

### 5.2 Deterministic submit (spine)
```
const rec = registry.getPlanRecord(backend, planId)   // already exists, registry.ts:173
const run = await registry.submit(backend, planId, {
  timeoutMinutes: rec.plan.recommendations.timeoutMinutes,
  stallThresholdMinutes: rec.plan.recommendations.stallThresholdMinutes,
})
```
`submit()` is already idempotent (`submitInFlight` memo + `plans.clear()` on success,
`registry.ts:243-269`), so a double event cannot double-run.

### 5.3 Turn serialization (concurrency)
pi-mono's `agent.state` is single-threaded; two concurrent `coord.chat()` calls
corrupt it. The user may approve while a turn is running. Therefore:

- Add per-window `state.generating: boolean` and `state.turnQueue: QueuedTurn[]`.
- Factor the `agent:send` body (`ipc.ts:1466-1506`) into `runAgentTurn(state, win,
  message, { origin })` and route **both** `agent:send` (origin `'user'`) and the
  approval enhancement (origin `'plan-approval'`) through one `runTurnSerialized()`:
  busy → enqueue; drain on the `agent:done` path.
- The renderer already disables input while generating, so user-sends and
  auto-turns won't collide; auto-turns are FIFO among themselves.

### 5.4 Idempotency
`autoExecInFlight = new Set<"backend::planId">`. Skip enqueue if present; clear when
the run is confirmed started (or on failure). Layered on top of `submit()`'s own
idempotency — belt and suspenders so we never run two turns for one plan.

### 5.5 Restart-gap recovery (mandatory — this is B′'s edge over C)
`plan-approved` only fires at click time. A plan approved in a **previous session**
that never ran reopens as an "approved — waiting for agent to execute" placeholder
and emits no event. So on coordinator init / after `hydrate()`, **drain
approved-but-unsubmitted plans** once:

- A plan still in the PlanStore with `approved && !rejectedAt` = approved but not yet
  run (successful `submit()` calls `plans.clear()`). Expose
  `registry.listApprovedUnsubmitted()` (thin wrapper over the store).
- Run each through the same spine+enhancement path, deduped via `autoExecInFlight`.
- Align with the existing orphan-recovery hook (`coordinator.ts:745`, "recover orphan
  … on the first chat() call after creation") — co-locate or chain, don't fork a
  second recovery mechanism.

### 5.6 Injected message (enhancement turn)
Deterministic context, directive, monitoring-oriented (execution already happened):

> `[Automated] Compute plan {planId} on backend {backendId} was approved and has
> started running as runId={runId}. Monitor it with {backendId}_wait /
> {backendId}_status, incorporate the results, and report back. Do NOT re-plan or
> re-execute it.`

The agent does **not** need to call execute (the spine already submitted). This
removes the "did the LLM actually call execute?" failure mode entirely.

### 5.7 Loop safety
- An enhancement turn may call `compute_plan` (a *new* gated plan) → emits
  `plan-ready`, **not** `plan-approved` → no auto-trigger. No cycle.
- The spine emits no `plan-approved`. No self-trigger.
- `autoExecInFlight` is the final backstop.

### 5.8 Setting / gating
`shared-ui/settings-types.ts`: add `compute.autoExecuteOnApproval: boolean`
(default **true**) to `ComputeSettings` + `DEFAULT_SETTINGS.compute` + the resolved
shape. Off = today's manual flow (approve, then nudge the agent yourself). Read live
via `getResolvedSettings()` so the toggle applies without a coordinator rebuild
(same pattern as `forceApprovalForAll`).

## 6. UX

- The enhancement turn must **not** masquerade as a user chat bubble. Render it as a
  system/automation note (small, "auto-executed on approval" marker), followed by the
  normal assistant monitoring output. Requires a message `origin` marker in the chat
  message shape + renderer styling. **Open UI decision** — see §10.
- `ComputeView.tsx:560` placeholder copy: when `autoExecuteOnApproval` is on, "approved
  — waiting for agent to execute" → "approved — starting…", flipping to a real run row
  once the run registers.

## 7. Files to touch

| File | Change |
|---|---|
| `app/src/main/ipc.ts` | factor `runAgentTurn` + `runTurnSerialized` (generating flag + queue); branch on `plan-approved` → spine submit + enhancement enqueue; drain approved-unsubmitted after init/hydrate |
| `lib/compute/registry.ts` (+ `plan-store.ts`) | `listApprovedUnsubmitted()` |
| `shared-ui/settings-types.ts` | `compute.autoExecuteOnApproval` + default + resolve |
| `app/src/renderer/components/settings/ComputeSettings.tsx` | toggle |
| chat message shape + `ChatView` | `origin: 'automation'` marker + styling |
| `app/src/renderer/components/center/ComputeView.tsx` | placeholder copy when auto-exec on |

## 8. Edge cases

| Scenario | Behaviour |
|---|---|
| Approve while a turn is running | enhancement turn queued, runs after; spine submit happens immediately (not queued) |
| Approve several plans at once | each spine-submits immediately; enhancement turns FIFO (optimization: batch into one "monitor X, Y, Z" turn) |
| Plan approved in a previous session, never ran | §5.5 init drain submits it |
| Plan rejected | no trigger (only `plan-approved` fires) |
| `submit()` fails (resources/cleared) | surfaced on the run row + error note; enhancement turn skipped or told of failure |
| User hits Stop during the enhancement turn | aborts like any turn; the run itself keeps going (stop the run via the Stop affordance) |
| App fully closed | no coordinator to receive the event; §5.5 init drain covers it on reopen |
| `autoExecuteOnApproval = false` | spine + enhancement both skipped; manual flow preserved |

## 9. Test plan

- **Spine**: `plan-approved` → `registry.submit` called once with the plan's
  recommendation opts; double event → single submit (idempotency).
- **Gating**: `autoExecuteOnApproval = false` → no submit, no turn.
- **Serializer**: approval during an active turn → enhancement enqueued, runs after;
  two approvals → no concurrent `coord.chat()`.
- **Restart drain**: approved-but-unsubmitted plan present at init → submitted once.
- **Loop safety**: an enhancement turn that emits `plan-ready` does not re-trigger.
- **Message**: synthetic message carries correct `{backendId, planId, runId}`.
- **Regression**: `agent:send` routed through `runTurnSerialized` behaves identically.

## 10. Risks & open questions

1. **Axiom compliance is load-bearing, not optional.** The spine must be the thing
   that runs the plan; if a future refactor moves execution into the LLM turn, it
   re-introduces the C-class fragility and violates the compute axiom. Guard this in
   review.
2. **UI origin marker (open decision).** How to render an automation-origin turn so
   it's clearly not user-typed and not confused with the agent's spontaneous output.
   Options: a dedicated system-note row; a muted prefix chip; a collapsible "auto"
   group. Needs a UX call before the renderer change.
3. **Token cost of enhancement turns.** One LLM turn per approval. For users approving
   many plans, batch approvals into a single monitoring turn (§8) — deferrable.
4. **Enhancement turn fidelity.** The agent might narrate inaccurately or wander. Since
   it's not on the critical path, worst case is a cosmetically odd message; the run is
   unaffected. Keep the injected prompt tight and directive.
5. **`recommendations` completeness.** Spine relies on `plan.recommendations.timeoutMinutes`
   / `stallThresholdMinutes` being present on every backend's plan. Verify all backends
   (local/modal/aws-ec2) populate them; fall back to backend defaults if absent.

## 11. Rollout

- **Phase 1 (covers the reported bug):** spine submit on live `plan-approved` +
  `runTurnSerialized` + setting. Enhancement turn optional in this phase (can ship
  spine-only first — approve genuinely runs the task — then add narration).
- **Phase 2:** restart-gap drain (§5.5) + enhancement turn + automation-origin UI +
  placeholder copy.
- **Phase 3 (optional):** batch multiple approvals into one monitoring turn.

Rough size: Phase 1 ~150–200 LOC + ~100 LOC tests; Phase 2 ~150 LOC; Phase 3 ~60 LOC.

## 12. Out of scope

- Modal / AWS-EC2 backend-specific approval nuances beyond reusing the shared
  registry path (the design is backend-agnostic by construction).
- Changing the approval *gate* policy (`requiresApproval` / `forceApprovalForAll`) —
  unchanged; this RFC only bridges approval → execution.
- The agent's own in-turn execute flow for non-gated plans — unchanged.
