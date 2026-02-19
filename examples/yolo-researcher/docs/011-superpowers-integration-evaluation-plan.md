# YOLO-Researcher v2: Superpowers Integration Evaluation Plan (RFC-011)

> Status: proposal only / not implemented.
> Decision goal: decide whether to integrate a constrained subset of superpowers skills into YOLO-Researcher v2.

---

## 0. Executive Summary

This document evaluates whether we should integrate four superpowers skills:

- `writing-plans`
- `executing-plans`
- `systematic-debugging`
- `verification-before-completion`

into current YOLO-Researcher v2 runtime.

Main conclusion (proposal):

1. Full import is high-risk and likely to conflict with our existing runtime gates.
2. A constrained, adapted, low-risk rollout can improve turn-level execution quality and reduce repeated `NO_DELTA` loops.
3. Runtime gate logic must remain source-of-truth; skills are guidance, not authority.

---

## 1. Context and What We Observed

Based on recent workspace run logs and runtime behavior, we repeatedly observed:

1. High frequency of `NO_DELTA: missing_plan_deliverable_touch`.
2. Periodic `done_definition_non_mechanical` or deliverable mismatch outcomes.
3. Turns with real activity and evidence files but weak plan-deliverable attribution.
4. Repeated planning/documentation actions with limited execution conversion.
5. Experimental work often stops at scaffold/protocol/objective-run level; cross-turn analysis quality and experiment-to-insight conversion are inconsistent.

These are not model-only failures. They are mostly execution-discipline and control-plane alignment failures.

---

## 2. Current Pain Points

### 2.1 Plan-to-Execution Alignment Gap

- Agent can produce useful artifacts, but artifacts do not always match active plan deliverable semantics.
- Runtime then downgrades to `no_delta`, even when non-trivial work happened.

### 2.2 Over-Planning / Under-Execution Drift

- In checkpoint-heavy periods, planning notes can dominate the turn budget.
- Execution depth per turn drops, leading to low completion velocity.

### 2.3 Weak Debugging Discipline in Failure Turns

- Some failure turns still exhibit patch-first behavior instead of root-cause-first behavior.
- This increases repeated retries with low learning gain.

### 2.4 Verification Claims Not Always Strong Enough

- Execution results exist, but final claims can be ahead of fresh verification evidence.
- This creates fragile progress and later reversals.

### 2.5 Experiment Capability Ceiling

- We can generate experiment scaffolds quickly.
- But consistency of: controlled design -> robust execution -> statistical analysis -> actionable conclusions is still limited.

---

## 3. Why "Experiment Capability" Still Feels Low

Even when execution appears active, quality bottlenecks remain:

1. Reproducibility contracts are not always enforced in each turn.
2. Cross-turn analysis deliverables are not consistently mandatory.
3. Verification and interpretation are sometimes mixed with optimistic summaries.
4. Root-cause debugging and experiment debugging are not treated as first-class stages.
5. Turn success is still easier to achieve via artifact production than via hypothesis validation quality.

So the real gap is not "can we run commands", but "can we reliably transform runs into credible experimental conclusions".

---

## 4. What the Four Skills Could Add

### 4.1 `writing-plans`

Potential value:

1. Forces concrete task decomposition with explicit file and verification steps.
2. Reduces vague plan items and generic done definitions.
3. Improves handoff quality from planning to execution.

Limitations:

1. If unadapted, it assumes external workflow conventions (`docs/plans`, commit cadence) that may conflict with YOLO runtime.
2. Overuse can consume turn budget and reduce execution throughput.

### 4.2 `executing-plans`

Potential value:

1. Enforces batch-based execution checkpoints.
2. Reduces turn-by-turn objective drift.
3. Improves incremental reviewability of progress.

Limitations:

1. If batches are too big, this still causes `missing_plan_deliverable_touch`.
2. Needs strict mapping from batch outputs to runtime deliverables.

### 4.3 `systematic-debugging`

Potential value:

1. Enforces root-cause-first, not guess-and-patch.
2. Should reduce repeated low-yield fix attempts.
3. Produces better failure evidence and better next-step decisions.

Limitations:

1. Adds upfront diagnostic cost.
2. Without explicit debugging deliverables, runtime may still classify these turns as weak progress.

### 4.4 `verification-before-completion`

Potential value:

1. Strongly improves claim integrity.
2. Reduces false-success and rollback turns.
3. Better trust boundary between execution and summary.

Limitations:

1. Can reduce speed if every turn performs broad verification.
2. Must be scoped to targeted verification to avoid throughput collapse.

---

## 5. Integration Principles (Non-Negotiable)

1. Runtime gates remain canonical.
2. Skills only shape behavior; they do not override status/delta attribution.
3. Keep integration minimal and reversible.
4. Use feature flags and phased rollout.
5. Preserve current path contracts (`runs/turn-xxxx/artifacts`).

---

## 6. Proposed Integration Design

### 6.1 Scope: Do Not Import Full Superpowers

Integrate only the four selected skills, and only as adapted variants.

### 6.2 Skill Adaptation Layer

For each imported skill:

1. Replace path assumptions (`docs/plans/...`) with turn artifacts path conventions.
2. Remove or neutralize mandatory commit/PR assumptions where not applicable.
3. Add explicit references to existing YOLO constraints:
   - active deliverable touch
   - planner checkpoint boundary
   - coding-large-repo requirement for git repo code edits

### 6.3 Load/Trigger Policy

Use conditional preload, not global always-on:

1. `writing-plans`: checkpoint-due and plan-quality-repair cases.
2. `executing-plans`: normal execution turns with valid concrete plan.
3. `systematic-debugging`: repeated failures, blocker loops, test regressions.
4. `verification-before-completion`: applied as finalization rule before success-like claims.

### 6.4 Output Contract Mapping

Each skill-guided turn must still satisfy runtime deliverable semantics:

1. Plan actions must map to mechanical done_definition rows.
2. Debug actions must write explicit evidence artifacts.
3. Verification actions must persist command output pointers.

### 6.5 Desktop Sync Safety

Current workspace default-skill sync should remain non-destructive to avoid wiping user-added skills during session/bootstrap.

---

## 7. Rollout Plan (Phased)

### Phase 0: Baseline Measurement (No Behavior Change)

Collect baseline over N runs:

1. `NO_DELTA` rate and top reasons.
2. Deliverable touch rate.
3. Turns-to-DONE per plan item.
4. Verification failure/retry pattern.
5. Experiment conclusion quality proxy (presence of analysis deliverables).

Exit criteria:

- Stable baseline metrics for comparison.

### Phase 1: Shadow Guidance Mode

Enable adapted skills in prompt context only; no new hard gate.

Goals:

1. Measure natural behavior shift.
2. Detect token/latency impact.
3. Identify conflict points with existing gate logic.

Exit criteria:

- No major regression in completion velocity.
- Observable reduction in repeated drift patterns.

### Phase 2: Soft Enforcement

Add soft policy nudges:

1. If success claim lacks verification, add warning and suggest retry.
2. If debugging turns skip root-cause evidence, warn and deprioritize success hints.

Exit criteria:

- Better claim integrity without severe throughput drop.

### Phase 3: Selective Hardening

Only harden high-value rules:

1. Completion claim without fresh verification evidence is downgraded.
2. Repeated fix attempts without root-cause evidence can trigger debug-mode checkpoint.

Exit criteria:

- Net gain in progress quality and final correctness.

---

## 8. Success Metrics

Primary metrics:

1. `missing_plan_deliverable_touch` ratio decreases.
2. `fallback_active` attribution ratio decreases.
3. Completed plan items per 12-turn loop increases.
4. Verification-backed success ratio increases.

Secondary metrics:

1. Average turn latency increase is controlled.
2. Prompt token usage increase is acceptable.
3. User escalation rate does not spike.

Suggested initial targets:

1. `missing_plan_deliverable_touch` down by 20-30%.
2. Deliverable touch rate up by 15%+.
3. Verification-backed success up by 25%+.

---

## 9. Risks and Pre-Plan Mitigations

### Risk A: Process Overhead Too High

Mitigation:

1. Conditional preload only.
2. Keep one-skill-per-problem trigger logic.

### Risk B: Skill/Runtime Contract Conflict

Mitigation:

1. Adapt skill text to YOLO contract.
2. Keep runtime as final arbiter.

### Risk C: Prompt Bloat

Mitigation:

1. Use summary by default, full load only on trigger.
2. Cap simultaneously fully-loaded workflow skills.

### Risk D: False Sense of Improvement

Mitigation:

1. Compare against baseline quantitatively.
2. Use experiment-quality deliverables as an explicit metric.

### Risk E: Workspace Skill Sync Wipe

Mitigation:

1. Ensure non-destructive sync strategy.
2. Add startup health check for required skills only.

---

## 10. Decision Checklist (Before Implementation)

1. Do we accept increased prompt/latency overhead for better execution quality?
2. Do we agree runtime remains final authority over status and delta?
3. Do we adopt phased rollout with rollback at every phase?
4. Do we agree to adapt superpowers text to YOLO path and policy contracts?
5. Do we commit to metric-driven go/no-go after Phase 1 and Phase 2?

If all five are yes, proceed with implementation RFC.

---

## 11. Proposed Next Step

If approved, create RFC-012 implementation spec with:

1. Exact file diffs for preload routing and desktop sync safety.
2. Adapted skill text templates for the four skills.
3. Test plan updates (`tests/yolo-researcher-v2/*`) and acceptance checks.
4. Feature flags and rollback switches.

---

## 12. Expected Code Touchpoints (for Scoping)

Likely files for implementation (if we proceed):

1. `examples/yolo-researcher/v2/llm-agent.ts`
   - add conditional skill preload/routing policy
   - add skill-usage hints into prompt where needed
2. `examples/yolo-researcher/v2/session.ts`
   - keep runtime gates authoritative
   - add optional soft/hard verification and debug evidence checks
3. `examples/yolo-researcher/v2/tool-wrappers.ts`
   - extend `skills-health-check` for superpowers presence/readiness
4. `examples/yolo-researcher/desktop/src/main/ipc.ts`
   - ensure workspace skill sync is non-destructive
5. `examples/yolo-researcher/skills/default-project-skills/*`
   - add adapted superpowers skill variants (not raw upstream copy)
6. `tests/yolo-researcher-v2/runtime-contract.test.ts`
   - add integration and guardrail tests for new behavior
7. `tests/yolo-researcher-v2/convergence-discipline.test.ts`
   - add regression tests for drift/no-delta improvements

Estimated complexity:

1. Prompt and routing changes: medium
2. Runtime gate interaction changes: medium-high
3. Desktop skill sync safety: low-medium
4. Test additions: medium
