# YOLO-Researcher v3: NorthStar Semantic Gate (RFC-017)

Status: Proposed  
Owner: yolo-researcher/v2 runtime  
Target: `artifact_gravity_v3_paper` full semantic progress governance  
Depends on: RFC-016 (`v3-paper`), RFC-012 (`semantic gate touch-only`)

## 0. Problem and Context

RFC-016 solved one class of false progress by enforcing deterministic checks (`RealityCheck + External Friction + Scoreboard`).

Remaining issue:

1. Deterministic metrics can still be "gamed" by low-value movement:
   - `claims_total` grows while claim quality does not improve.
   - `evidence_coverage=1.0` can still be true when evidence is low-trust string literals.
2. Runtime can prove execution correctness, but cannot reliably prove research-level progress quality.
3. A pure deterministic gate is necessary but not sufficient for research convergence.

This RFC introduces a semantic progress layer that judges "are we actually moving toward North Star research outcomes?" while preserving deterministic safety ownership in runtime.

## 1. Design Goals

1. Keep runtime authoritative for foundational correctness:
   - path safety
   - command execution and exit behavior
   - artifact existence and contract schema
2. Add LLM-based semantic judgement for research progress quality.
3. Avoid reviewer overreach:
   - reviewer can veto low-quality "success"
   - reviewer does not fully control research direction
4. Maintain replayability and auditability with structured IO and hashes.

## 2. Non-Goals

1. Replacing all runtime gates with LLM judgement.
2. Letting semantic gate override hard runtime violations.
3. Allowing unconstrained free-text reviewer directives.
4. Turning every reviewer recommendation into mandatory next-step policy.

## 3. Core Principle

Two-plane governance:

1. Deterministic Plane (hard authority):
   - "Can this be executed and verified mechanically?"
2. Semantic Plane (research authority):
   - "Does this represent meaningful progress toward the North Star objective?"

Enforce semantics are mode-specific:

1. `enforce_downgrade_only` (veto mode, production default):
   - semantic plane can veto deterministic `success`
   - semantic `abstain` is non-veto (keep deterministic status, mark uncertainty)
2. `enforce_balanced` (future):
   - two-plane agreement is required for `success`
   - constrained upgrades may be evaluated under strict policy

## 4. Scope and Mode

## 4.1 Initial Scope

Apply to `artifact_gravity_v3_paper` only.

## 4.2 Semantic Gate Modes

1. `off`
2. `shadow`
3. `enforce_downgrade_only` (default enforce mode)
4. `enforce_balanced` (future; can upgrade in tightly constrained conditions)

`enforce_downgrade_only` is the production default for v3 full rollout.

## 5. What NorthStar Semantic Gate Judges

The evaluator must return explicit judgement over five dimensions:

1. `goal_alignment`
   - Turn output directly supports current NorthStar objective.
2. `evidence_strength`
   - Claims marked as strong/verified have verifiable evidence references.
3. `novelty_delta`
   - Progress is substantive, not count-only or formatting churn.
4. `falsifiability`
   - The turn introduces or executes checks that can disconfirm claims.
5. `trajectory_health`
   - Recent turn window indicates convergence, not oscillation/churn.
   - Formal objective pivot must be evaluated in pivot context, not treated as churn by direction change alone.
   - When objective changed, score should focus on verifiable progress toward the new objective.

Each dimension is scored `0|1|2`:

1. `0`: fails
2. `1`: partial/weak
3. `2`: strong

## 6. NorthStar Contract Extensions

Add optional section in `NORTHSTAR.md`:

```md
## Semantic Review Policy
- mode: shadow|enforce_downgrade_only|enforce_balanced
- confidence_threshold: 0.80
- allow_upgrade: false
- required_action_budget_per_turn: 1
- must_action_max_open: 1
- recent_window_turns: 4
```

Runtime defaults when section missing:

1. mode = `enforce_downgrade_only`
2. confidence_threshold = `0.80`
3. allow_upgrade = `false`
4. required_action_budget_per_turn = `1`
5. must_action_max_open = `1`
6. recent_window_turns = `4`

`confidence_threshold` semantics in `enforce_downgrade_only`:

1. threshold gates semantic downgrades, not only `advance_confirmed` acceptance
2. if evaluator verdict is non-`abstain` and `confidence < confidence_threshold`, runtime must coerce effective verdict to `abstain`
3. coerced low-confidence turns must not trigger semantic downgrade
4. runtime must append reason code `low_confidence` for auditability

## 7. Input Contract (`yolo.northstar_semantic_gate.input.v1`)

Evaluator input must be structured JSON only.

```json
{
  "schema": "yolo.northstar_semantic_gate.input.v1",
  "turn": {"id": "turn-0021", "number": 21},
  "mode": "enforce_downgrade_only",
  "deterministic": {
    "status": "success",
    "blocked_reason": null,
    "hard_violations": [],
    "northstar_gate_satisfied": true
  },
  "northstar": {
    "goal": "...",
    "current_objective": "...",
    "objective_id": "obj-2026-02-20-baseline-v2",
    "objective_version": 7,
    "artifacts": ["artifacts/paper_draft.md", "artifacts/claims.csv"],
    "scoreboard_paths": ["artifacts/metrics_claims.json", "artifacts/metrics_paper.json"]
  },
  "delta": {
    "artifact_changes": ["artifacts/claims.csv", "artifacts/paper_draft.md"],
    "scoreboard_before": {
      "artifacts/metrics_claims.json:claims_verified": 4,
      "artifacts/metrics_claims.json:claims_verified_raw": 30,
      "artifacts/metrics_claims.json:evidence_valid_coverage": 0.40
    },
    "scoreboard_after": {
      "artifacts/metrics_claims.json:claims_verified": 5,
      "artifacts/metrics_claims.json:claims_verified_raw": 31,
      "artifacts/metrics_claims.json:claims_verified_invalid_evidence": 26,
      "artifacts/metrics_claims.json:evidence_valid_coverage": 0.52
    },
    "change_proof": {
      "patch_path": "runs/turn-0021/patch.diff",
      "patch_hunks_count": 3,
      "placeholder_patch_detected": false,
      "touched_files": ["artifacts/claims.csv", "artifacts/paper_draft.md"],
      "file_deltas": [
        {
          "path": "artifacts/claims.csv",
          "before_hash": "sha256:...",
          "after_hash": "sha256:...",
          "content_changed": true,
          "nontrivial_change_detected": true,
          "nontrivial_change_rules": ["added_lines>0"],
          "added_lines": 2,
          "removed_lines": 0
        }
      ]
    }
  },
  "content_snapshots": [
    {
      "path": "artifacts/claims.csv",
      "kind": "text",
      "source": "runtime_snapshot",
      "before_hash": "sha256:...",
      "after_hash": "sha256:...",
      "before_excerpt": "id,type,claim,evidence,status\\nC1,...",
      "after_excerpt": "id,type,claim,evidence,status\\nC1,...\\nC2,...",
      "structured_summary": {
        "rows_before": 30,
        "rows_after": 31,
        "verified_before": 5,
        "verified_after": 6,
        "verified_invalid_after": 0
      }
    },
    {
      "path": "artifacts/paper_draft.md",
      "kind": "text",
      "source": "runtime_snapshot",
      "before_hash": "sha256:...",
      "after_hash": "sha256:...",
      "before_excerpt": "## Method\\n...",
      "after_excerpt": "## Method\\n... [C31] ..."
    }
  ],
  "claim_quality": {
    "claims_total": 31,
    "claims_marked_verified": 31,
    "claims_verified_with_valid_evidence": 5,
    "claims_marked_verified_with_invalid_evidence": 26,
    "evidence_valid_coverage": 0.16129,
    "source_metric_path": "artifacts/metrics_claims.json"
  },
  "checks": {
    "internal_executed": ["..."],
    "internal_succeeded": ["..."],
    "external_executed": ["..."],
    "external_succeeded": ["..."]
  },
  "recent_turns": [
    {
      "turn": 20,
      "status": "success",
      "semantic_verdict": "no_progress",
      "summary": "..."
    }
  ],
  "recent_objectives": [
    {
      "turn": 19,
      "objective_id": "obj-2026-02-18-baseline-v1",
      "objective_version": 6,
      "change_reason": "pivot_due_to_regress"
    },
    {
      "turn": 21,
      "objective_id": "obj-2026-02-20-baseline-v2",
      "objective_version": 7,
      "change_reason": "scope_narrowing"
    }
  ],
  "pivot_context": {
    "is_explicit_pivot_turn": true,
    "pivot_reason": "pivot_due_to_regress",
    "pivot_evidence_paths": ["runs/turn-0021/result.json"],
    "pivot_approved_by_policy": true
  },
  "evidence_refs": {
    "trusted_paths": ["runs/turn-0021/..."],
    "business_artifacts": ["runs/turn-0021/artifacts/..."]
  }
}
```

`recent_objectives[*].change_reason` allowlist:

1. `pivot_due_to_regress`
2. `scope_narrowing`
3. `new_constraint`
4. `external_feedback`
5. `objective_stable` (no material objective change)

### 7.1 Metric Naming and Invariants (Normative)

Semantic input uses normalized `claim_quality` names:

1. `claims_total`
2. `claims_marked_verified`
3. `claims_verified_with_valid_evidence`
4. `claims_marked_verified_with_invalid_evidence`
5. `evidence_valid_coverage`
6. `source_metric_path` (the scoreboard metric file used for normalization)

Required invariants:

1. `claims_total >= claims_marked_verified >= claims_verified_with_valid_evidence`
2. `claims_marked_verified = claims_verified_with_valid_evidence + claims_marked_verified_with_invalid_evidence`
3. `evidence_valid_coverage = claims_verified_with_valid_evidence / claims_total` (within epsilon tolerance)

Legacy compatibility mapping (runtime normalization):

1. `claims_marked_verified <- claims_verified_raw` (legacy key)
2. `claims_verified_with_valid_evidence <- claims_verified` (legacy key)
3. `claims_marked_verified_with_invalid_evidence <- claims_verified_invalid_evidence` (legacy key)

Metric scope clarification:

1. `delta.scoreboard_before/after` are raw, path-scoped metric snapshots (keyed by `path:metric`), may include mixed metric families.
2. `claim_quality` is a normalized claims-quality view for semantic evaluation, derived from one primary claims metric source (`source_metric_path`).
3. if both are present and overlap on claims-quality metrics, runtime must validate consistency.
4. on inconsistency, runtime appends reason code `inconsistent_metrics`; in enforce mode, treat semantic result as conservative (`abstain` or `no_progress` per policy).

### 7.2 Change-Proof Naming and Invariants (Normative)

`delta.change_proof.file_deltas` must use deterministic names only:

1. `content_changed`:
   - strict fact flag derived by runtime
   - `content_changed = (before_hash != after_hash)`
2. `nontrivial_change_detected`:
   - deterministic heuristic flag from runtime rules/thresholds
   - examples: `added_lines > 0`, CSV row/column delta, key-field delta
3. `nontrivial_change_rules`:
   - optional list of rule identifiers that triggered `nontrivial_change_detected`

Required invariants:

1. if `content_changed=false`, then `nontrivial_change_detected` must be `false`
2. runtime must not use `semantic_*` field names in `file_deltas`
3. these fields must never be interpreted as research-semantic judgement; semantic judgement belongs to evaluator output only

### 7.3 Objective Continuity and Pivot Context (Normative)

To avoid false churn penalties during legitimate pivots, runtime should provide objective continuity context:

1. required in `northstar`:
   - `objective_id`
   - `objective_version`
2. required top-level context:
   - `recent_objectives` (windowed objective history with structured `change_reason`)
   - `pivot_context` (whether this turn is explicit pivot and why)

Trajectory scoring constraints:

1. if `pivot_context.is_explicit_pivot_turn=true` and pivot policy/evidence are valid, direction change alone must not force `trajectory_health=0`.
2. after formal objective change (`objective_id` or `objective_version` changes), evaluator should judge trajectory by progress against new objective, not previous objective continuity.
3. if pivot context is missing while objective changed, append reason code `objective_context_missing` and score trajectory conservatively.

Input safety rules:

1. No raw prompt injection text from arbitrary artifacts.
2. No full stdout/stderr dumps beyond bounded snippets.
3. Deterministic canonicalization + hash before evaluator call.
4. Maximum char budget enforced.
5. For key files (`claims.csv`, `paper_draft.md`, scoreboard JSON), include content-level snapshots (bounded excerpts + before/after hash), not path-only references.
6. `patch.diff` is advisory only; semantic judge must use `change_proof + content_snapshots` as primary truth.
7. Runtime must mark `placeholder_patch_detected=true` when patch is synthetic/empty (for example: touched list only, no hunks).
8. If `patch_hunks_count==0` and all `file_deltas.content_changed==false`, semantic judgement must treat novelty as zero unless other independent evidence proves progress.
9. Runtime must validate `claim_quality` invariants before evaluator call; if invalid, append `inconsistent_metrics` and downgrade trust level of semantic input.
10. Runtime should validate objective continuity fields; when objective changed without `recent_objectives/pivot_context`, append `objective_context_missing`.

## 8. Prompt Design

## 8.1 System Prompt (Normative)

```
You are a strict North Star research progress auditor.
Judge whether the current turn made meaningful progress toward the stated research objective.
Do not reward count inflation, wording churn, or unverifiable claims.
Runtime hard checks are authoritative and cannot be overridden.
Do not decide final verdict; runtime derives verdict deterministically from dimension scores.
If uncertain, keep confidence low and reflect uncertainty in scores/reason_codes.
Return JSON only following the schema.
```

## 8.2 User Prompt Template (Normative)

```
Evaluate the following JSON input.
Focus on:
1) objective alignment
2) evidence validity and traceability
3) substantive novelty (not count-only deltas)
4) falsifiability
5) trajectory over recent turns

Output schema: yolo.northstar_semantic_gate.output.v1
Important: runtime will derive verdict from dimension_scores; do not rely on free-text verdict choice.

<INPUT_JSON>
...
</INPUT_JSON>
```

## 8.3 Anti-Bias Clauses

Prompt must explicitly state:

1. `claims_total` increase alone is not progress.
2. `paper_claim_refs_total` increase alone is not progress.
3. Any verified claim without strong evidence is a negative signal.
4. Repeating unchanged weak patterns across turns should yield scores that runtime derives as `no_progress` or `regress`.
5. Do not infer progress from touched-file lists or empty/placeholder patch files.
6. Require content-level delta (`before_hash != after_hash` and meaningful excerpt/summary changes) for key artifact credit.
7. Do not treat formal objective pivot as churn by default; use `objective_id/objective_version/recent_objectives/pivot_context`.

## 9. Output Contract (`yolo.northstar_semantic_gate.output.v1`)

```json
{
  "schema": "yolo.northstar_semantic_gate.output.v1",
  "confidence": 0.86,
  "dimension_scores": {
    "goal_alignment": 2,
    "evidence_strength": 1,
    "novelty_delta": 2,
    "falsifiability": 1,
    "trajectory_health": 2
  },
  "reason_codes": ["evidence_quality_improved", "objective_aligned_delta"],
  "claim_audit": {
    "supported_ids": ["C14", "C15"],
    "unsupported_ids": ["C1", "C2"],
    "contradicted_ids": []
  },
  "required_actions": [
    {
      "tier": "should",
      "code": "repair_claim_evidence",
      "description": "Downgrade or repair verified claims lacking strong evidence",
      "due_turn": 24
    }
  ],
  "summary": "Progress is real but evidence quality debt remains."
}
```

Required field semantics:

1. `confidence`: `0..1`
2. `dimension_scores`: all five dimensions required, each `0|1|2`
3. `reason_codes`: stable machine-readable tags
4. `required_actions`: optional, bounded list
   - evaluator tier set is `must_candidate|should|suggest`
   - evaluator-emitted `must_candidate` is advisory until runtime deterministic promotion
5. optional compatibility field `verdict` may appear from legacy evaluators, but runtime must ignore it for status mapping
6. evaluator should emit `reason_codes` like:
   - `placeholder_patch_no_hunks`
   - `path_only_without_content_delta`
   - `count_only_delta`
   - `claim_evidence_unverifiable`
   - `evidence_ref_unresolvable`
   - `evidence_snapshot_hash_mismatch`
   - `inconsistent_metrics`
   - `invalid_change_proof_flags`
   - `objective_context_missing`
   - `pivot_context_applied`
   - `low_confidence`

### 9.1 Runtime Verdict Derivation (Normative)

Runtime must derive semantic verdict deterministically from `dimension_scores`:

1. read scores:
   - `ga = goal_alignment`
   - `es = evidence_strength`
   - `nd = novelty_delta`
   - `fa = falsifiability`
   - `th = trajectory_health`
2. validate score schema:
   - if any required dimension missing or outside `0|1|2`, set `derived_verdict=abstain`
   - append reason code `invalid_dimension_scores`
3. otherwise compute:
   - `sum = ga + es + nd + fa + th`
   - `zero_count = count(score == 0)`
   - `two_count = count(score == 2)`
4. derive `derived_verdict` in priority order:
   - if `zero_count >= 3`, then `regress`
   - else if `ga == 0 && (nd == 0 || th == 0)`, then `regress`
   - else if `nd == 0 || ga == 0`, then `no_progress`
   - else if `sum >= 8 && es >= 1 && two_count >= 2`, then `advance_confirmed`
   - else if `sum >= 5 && ga >= 1 && nd >= 1`, then `advance_weak`
   - else `no_progress`
5. if evaluator also emitted legacy `verdict` and it differs from `derived_verdict`:
   - keep `derived_verdict` as authoritative
   - append reason code `verdict_mismatch`

## 10. `required_actions` Governance (Anti-Overreach)

To avoid "reviewer hijacking" and prevent LLM single-point blocking, integrity authority is split:

1. Deterministic integrity (runtime hard authority):
   - evidence ref format/path allowlist validity
   - evidence target resolvable (file/optional line anchor exists)
   - evidence snapshot hash consistency
   - evidence value not empty / not placeholder-only (`TODO`, `TBD`, `N/A`)
   - violations here trigger hard violation or deterministic downgrade directly
2. Semantic quality (evaluator authority):
   - weak evidence strength, weak novelty, weak trajectory
   - evaluator cannot directly create blocking conditions

Evaluator action tiers:

1. `must_candidate`:
   - integrity-risk candidate proposed by evaluator
   - cannot block by itself
2. `should`:
   - prioritized guidance with due turn
   - non-blocking
3. `suggest`:
   - advisory only

Runtime promotion rule (required):

1. runtime may promote `must_candidate -> must` only when deterministic trigger(s) are present, for example:
   - `claims_marked_verified_with_invalid_evidence > 0` (normalized; legacy alias: `claims_verified_invalid_evidence > 0`)
   - `invalid_evidence_ref_count > 0`
   - `unresolvable_evidence_ref_count > 0`
   - `evidence_snapshot_hash_mismatch_count > 0`
   - `inconsistent_metrics_count > 0`
2. if no deterministic trigger exists, runtime must demote `must_candidate -> should`
3. only runtime-promoted `must` can block `success` when overdue

Hard limits:

1. `required_action_budget_per_turn <= 1`
2. `must_action_max_open <= 1` (counts promoted `must` only)
3. same action code repeated twice without new deterministic trigger auto-downgrades `must -> should`
4. agent may defer a `should` with `defer_reason`; defer itself is auditable

## 11. Runtime Decision Mapping

Precondition:

1. deterministic hard gate runs first
2. if hard violations exist, semantic outcome cannot upgrade status
3. evaluator `required_actions` are post-processed by runtime promotion (`must_candidate -> must|should`)
4. runtime computes `derived_semantic_verdict` from `dimension_scores` using Section 9.1 rules
5. runtime computes `effective_semantic_verdict` before status mapping:
   - start from `derived_semantic_verdict`
   - if `derived_semantic_verdict` is non-`abstain` and `confidence < confidence_threshold`, set `effective_semantic_verdict=abstain`
   - add reason code `low_confidence`

Mapping in `enforce_downgrade_only` (veto mode):

1. deterministic status `success`:
   - effective semantic `advance_confirmed`: keep `success`
   - effective semantic `abstain`: keep deterministic status but mark semantic uncertainty (non-veto)
   - effective semantic `advance_weak`: downgrade to `no_delta`
   - effective semantic `no_progress`: downgrade to `no_delta`
   - effective semantic `regress`: downgrade to `blocked` or `no_delta` with regress reason
2. deterministic status `no_delta|blocked|ask_user|failure`:
   - semantic cannot upgrade

Action-blocking rule in `enforce_downgrade_only`:

1. evaluator output alone cannot block turn success
2. only runtime-promoted `must` (with active deterministic integrity trigger) can block when overdue
3. if deterministic trigger clears, corresponding `must` auto-downgrades to `should`

Mapping in `shadow`:

1. no status mutation
2. full audit written to `result.json`

Mapping in `enforce_balanced` (future):

1. upgrades allowed only when:
   - confidence high
   - strict evidence constraints met
   - no hard/runtime policy risks

## 12. Feedback to Main Agent

Semantic output is returned to next-turn context as structured policy payload:

1. `last_semantic_verdict` (effective verdict used for mapping)
2. `last_reason_codes`
3. `open_required_actions`
4. `claim_audit_debt`
5. `last_semantic_derived_verdict` (pre-confidence-coercion deterministic verdict)

Agent prompt integration:

1. must mention open runtime-promoted `must` actions in "Current Objective" context
2. may reorder plan to satisfy `should`, but not forced every turn
3. maintain research initiative beyond reviewer guidance

## 13. Triggered Actions and Side Effects

On effective semantic outcome (`effective_semantic_verdict`):

1. `advance_confirmed`:
   - close matching prior semantic action debts if satisfied
2. `advance_weak`:
   - open one `should` action (max budget)
3. `no_progress`:
   - open one `should` action
   - increment semantic stagnation counter
4. `regress`:
   - open one `must_candidate` action if integrity-related
   - runtime may promote it to `must` only via deterministic trigger rules
   - may set `pivot_allowed=true`
5. `abstain`:
   - no mandatory action
   - attach uncertainty note for operator visibility

Escalation policy:

1. two consecutive `no_progress` -> require one external validation turn
2. two consecutive `regress` -> force `ask_user` for strategy correction

## 14. Persistence and Telemetry

Persist in `runs/turn-xxxx/result.json`:

```json
{
  "northstar_semantic_gate": {
    "enabled": true,
    "mode": "enforce_downgrade_only",
    "invoked": true,
    "eligible": true,
    "prompt_version": "nsg.v1",
    "model_id": "gpt-5.2",
    "temperature": 0,
    "input_hash": "...",
    "output": {...},
    "derived_verdict": "no_progress",
    "legacy_verdict_ignored": true,
    "effective_output": {
      "verdict": "abstain",
      "reason_codes_appended": ["low_confidence"]
    },
    "accepted": true,
    "status_mutation": {
      "from": "success",
      "to": "success",
      "reason": "semantic_low_confidence_abstain"
    }
  }
}
```

Runtime should also persist action-promotion audit:

1. `required_action_promotions`:
   - source tier (`must_candidate|should|suggest`)
   - final tier (`must|should|suggest`)
   - deterministic trigger codes used for promotion/demotion
2. `blocking_action_source` must indicate `runtime_promoted_must` when action debt blocks success
3. `verdict_derivation_audit`:
   - input `dimension_scores`
   - `derived_verdict`
   - optional legacy `verdict`
   - `legacy_verdict_ignored` boolean

Track aggregate metrics:

1. `semantic_invocation_rate`
2. `semantic_downgrade_rate`
3. `semantic_abstain_rate`
4. `semantic_vs_human_agreement` (operator sampled audits)
5. `time_to_recover_from_no_progress`
6. `must_candidate_promotion_rate`
7. `low_confidence_coercion_rate`
8. `verdict_mismatch_rate` (legacy model verdict vs runtime-derived verdict)
9. `pivot_turn_false_churn_rate` (explicit pivot turns scored as churn without supporting rationale)

## 15. Failure Handling

If semantic evaluator fails (timeout/provider/model issue):

1. return synthetic `abstain` with `confidence=0`
2. do not block runtime finalization
3. persist failure reason in telemetry

If input integrity is weak:

1. when key artifact content snapshots are missing, force `abstain` with reason `missing_content_snapshot`
2. when patch is placeholder-only and no content delta is shown, enforce score patterns that runtime derives as `no_progress` or `abstain` (never `advance_confirmed`)

## 16. Security and Robustness

1. strict structured output schema validation
2. reject unknown fields in enforce mode
3. sanitize model-provided evidence references
4. never execute model-suggested commands directly
5. keep deterministic path constraints and allowlist unchanged
6. evaluator cannot directly emit blocking `must`; blocking actions must come from runtime deterministic promotion

## 17. Rollout Plan

Phase 0:

1. implement IO contracts + result persistence
2. run `shadow` only

Phase 1:

1. enable `enforce_downgrade_only` for pilot workspaces
2. monitor false downgrade and abstain rates

Phase 2:

1. tune thresholds and action budgets
2. optionally evaluate `enforce_balanced` behind explicit flag

## 18. Test Plan

Required tests:

1. schema validation and deterministic normalization
2. verdict-to-status mapping in each mode
3. runtime verdict derivation consistency:
   - same `dimension_scores` must always yield same `derived_verdict`
   - legacy evaluator `verdict` mismatch must not change mapping outcome
4. `required_actions` budget and anti-loop constraints
5. hard violation precedence over semantic decisions
6. abstain fallback behavior
7. replay determinism from persisted input hash
8. placeholder patch defense:
   - input has `patch_hunks_count=0`, touched list present, no key file semantic delta
   - expected verdict: not `advance_confirmed`
9. `must_candidate` promotion guard:
   - evaluator emits `must_candidate` without deterministic trigger
   - expected: demoted to `should`, no blocking effect
10. runtime-only blocking source:
   - overdue action blocks only when source is `runtime_promoted_must` and trigger remains active
11. low-confidence downgrade guard:
   - evaluator emits `no_progress|regress` with `confidence < confidence_threshold`
   - expected: coerced to effective `abstain`, no semantic downgrade, `low_confidence` recorded
12. claim-quality invariant guard:
   - `claim_quality` violates normalization invariants or conflicts with overlapping scoreboard metrics
   - expected: `inconsistent_metrics` recorded and semantic mapping forced to conservative path
13. pivot-aware trajectory guard:
   - objective changed (`objective_id/objective_version` diff) with valid `pivot_context`
   - expected: trajectory is not auto-scored as churn solely due to direction change
14. missing objective-context guard:
   - objective changed but `recent_objectives` or `pivot_context` missing
   - expected: `objective_context_missing` recorded and conservative trajectory handling

Dataset regression tests:

1. replay known "count inflation" traces and require downgrade or no credit
2. replay known real-progress traces and avoid false downgrade

## 19. Backward Compatibility

1. Existing RFC-016 deterministic gate remains valid when semantic mode is `off`.
2. Legacy `semantic_gate` (RFC-012 touch-only path) has been removed from runtime/UI.
3. `northstar_semantic_gate` is the single semantic review channel.

## 20. Open Questions

1. Which model is default in production (`gpt-5.2` vs configurable per workspace)?
2. In future `enforce_balanced`, should `abstain` remain neutral or become mildly conservative?
3. Do we need human override API for urgent release deadlines?
4. Should semantic claims audit auto-write PR comments for operators?

## 21. Decision Summary

Adopt a v3 full semantic governance layer with strict boundaries:

1. runtime keeps foundational correctness authority
2. semantic gate judges research progress quality
3. enforce mode initially supports downgrade-only to minimize risk
   - interpreted as veto-only (`abstain` is non-veto)
4. reviewer directives are tiered and budgeted to prevent strategy hijacking
   - LLM emits `must_candidate`; only runtime deterministic promotion can create blocking `must`
5. runtime derives semantic verdict deterministically from `dimension_scores`
   - legacy evaluator `verdict` is compatibility-only and non-authoritative
