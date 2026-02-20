# YOLO-Researcher v3-paper: North-Star Paper Loop (RFC-016)

Status: Proposed  
Owner: yolo-researcher/v2 runtime  
Target: Replace doc-churn-prone v3 compatibility flow with paper-first artifact loop

## 0.1 Current Implementation Delta (Strict Branch)

The runtime implementation now enforces a stricter `v3-paper` gate than the initial proposal:

1. `RealityCheck` is split into:
   - `RealityCheck (Internal)` (consistency/structure checks)
   - `RealityCheck (External)` (non-self-referential evidence generation)
2. `Scoreboard` is required (`artifacts/*.json` metrics files), and success requires measurable improvement.
3. `External Friction Policy` is required with `require_external_every: N` (default `3`).

This prevents the "claims-only churn" failure mode where internal checks pass forever without external evidence.

## 1. Problem Statement

Legacy north-star compatibility behavior can converge to a false-progress loop for research-paper goals:

1. Repeated edits to `artifacts/northstar.md` are accepted as success.
2. Verify command is optional, so no external friction is required.
3. Plan board is background-only, so execution pressure is weak.
4. Literature runs can be repeated without enforced convergence into citable structures.

Result: high turn throughput, low real progress.

## 2. Design Principle

For paper-oriented tasks, keep the system minimal:

- Minimal discipline to avoid dead loops.
- Evidence-driven strengthening over time.
- Every turn must satisfy at least one mechanical reality check.

We explicitly avoid heavy workflow machinery.

## 3. Core Model

`v3-paper` introduces two anchors:

1. `NorthStarArtifact`: the deliverable files that represent real paper progress.
2. `RealityCheck`: deterministic checks executable by runtime/scripts.

Progress is valid only when at least one of these anchors moves in a mechanically verifiable way.

## 4. Contract Changes

## 4.1 Orchestration Mode

Add new mode:

- `artifact_gravity_v3_paper`

Mode selection:

- `auto`: can choose `artifact_gravity_v3_paper` only when:
  - `NORTHSTAR.md` has valid `NorthStarArtifact` paths (project-relative, non-`runs/turn-*`, under `artifacts/` and existing or creatable), and
  - `RealityCheck` section is present and each command passes runtime allowlist validation.
- explicit env override:
  - `YOLO_ORCHESTRATION_MODE=artifact_gravity_v3_paper`

## 4.2 NORTHSTAR.md Schema (v3-paper)

Required sections (strict branch):

- `## Goal`
- `## Current Objective (this sprint)`
- `## NorthStarArtifact`
  - one or more `- path: ...` (project-relative; non-`runs/turn-*`)
- `## RealityCheck (Internal)`
  - one or more `- cmd: ...`
- `## RealityCheck (External)`
  - one or more `- cmd: ...`
- `## Gate Policy`
  - `- gate: any|all` (default `any`)
- `## External Friction Policy`
  - `- require_external_every: <int>`
- `## Scoreboard`
  - one or more `- path: artifacts/*.json`

Optional sections:

- `## Pivot Rule`
- `## Next Action (one line)`

## 4.3 Default Bootstrap Template

`bootstrapNorthStar()` now generates paper-safe defaults:

- artifact paths:
  - `artifacts/paper_draft.md`
  - `artifacts/claims.csv`
- internal checks:
  - `python scripts/check_claims.py artifacts/claims.csv --emit-metrics artifacts/metrics_claims.json`
  - `python scripts/check_paper.py artifacts/paper_draft.md artifacts/claims.csv --emit-metrics artifacts/metrics_paper.json`
- external checks:
  - `python experiments/run_smoke.py --out artifacts/results/smoke.json`
- scoreboard:
  - `artifacts/metrics_claims.json`
  - `artifacts/metrics_paper.json`

Critically: `NORTHSTAR.md` itself is never a valid NorthStarArtifact.

## 5. Runtime Gate Semantics

## 5.1 Success Rule (strict branch)

Turn is `success` iff all conditions hold:

1. Internal RealityCheck passes according to its gate policy.
2. External friction quota is satisfied:
   - if quota is due this turn (`require_external_every` window), external check must pass.
3. Scoreboard is ready and improved versus previous turn metrics.

Artifact delta alone is not sufficient.

## 5.2 No-Delta Rule

Turn is `no_delta` if any strict condition fails:

- internal checks not executed/passed,
- external quota due but external check not passed,
- scoreboard missing, or
- scoreboard not improved.

Hard rule:

- changes to `NORTHSTAR.md` alone can never satisfy progress in `v3-paper`.

## 5.3 Anti-Churn Rule

If consecutive turns without executing any `RealityCheck` >= `K` (default `2`):

- force `no_delta`,
- set `pivot_allowed=true`,
- require pivot rationale/evidence in `NORTHSTAR.md`.

Important:

- `RealityCheck` failure does not trigger anti-churn by itself.
- failure streak is advisory (used to prioritize next action), not an automatic no-delta trigger.

## 5.4 Non-trivial Delta

Use deterministic, mechanical rules only:

1. Ignore pure whitespace-only changes using normalized text hash (`collapse_whitespace`).
2. For `claims.csv`, treat row-count changes or any cell-value changes as non-trivial.
3. For `paper_draft.md`, any normalized-text hash change is non-trivial (no byte-floor gate).

Do not rely on semantic/NLP similarity for this decision.

## 5.5 RealityCheck Command Allowlist

`RealityCheck (Internal|External).cmd` must pass runtime allowlist validation before execution.

Minimum recommended policy:

- allow `python scripts/check_*.py ...`
- allow project-local deterministic external runners (e.g., `python experiments/*.py`, `python scripts/run_*.py`, `pytest`)
- deny networked/side-effect-heavy commands by default

Invalid commands make the NorthStar contract incomplete for `auto` mode selection.

## 6. Evidence and Control-Plane Policy

1. Runtime owns evidence path materialization (`runs/turn-xxxx/...`).
2. LLM may describe facts, but should not be source-of-truth for path integrity.
3. `result.json` must include reality-check execution summary:
   - checks configured
   - checks executed
   - pass/fail per check
   - gate policy and gate result

## 7. Paper-Focused Artifacts

Recommended minimal output set:

- `artifacts/paper_draft.md`
- `artifacts/claims.csv`

Optional later-stage artifacts:

- `artifacts/reading_list.csv`
- `artifacts/related_work_matrix.csv`

## 7.1 claims.csv Schema (minimum)

Columns:

- `id` (`C1`, `C2`, ...)
- `type` (`fact|method|result|limitation|related_work`)
- `claim`
- `evidence`
- `status` (`draft|verified|needs_cite`)

Evidence value may be:

- `runs/turn-xxxx/...` path
- DOI/citation key (e.g. `doi:...`, `cite:...`)

## 8. RealityCheck Script Expectations

Scripts must be deterministic and machine-verifiable.

## 8.1 check_claims.py

Suggested checks:

- minimum row count,
- unique `id`,
- non-empty `claim`,
- evidence coverage ratio threshold,
- evidence format validity (`runs/turn-*` or `doi:/cite:`).

## 8.2 check_paper.py

Suggested checks:

- required section headers present,
- placeholder tokens (`TODO`, `CITE_NEEDED`) under threshold,
- claim references `[Cxx]` resolve in `claims.csv`,
- verified-claim utilization threshold in draft.

## 8.3 check_reading_list.py (optional)

Suggested checks:

- dedup by DOI/title,
- required fields completeness,
- relevance notes existence.

## 9. LLM Prompt Policy (v3-paper)

Prompt should enforce:

1. One primary action per turn.
2. Primary action must touch NorthStarArtifact or execute RealityCheck.
3. If recent check failures exist, next action should address the failing rule directly.
4. Literature collection is valid only when it converges into structured artifacts (`reading_list.csv` / matrix), not freeform notes.

Plan board remains informational only in `v3-paper`.

## 10. Migration Plan

Phase 1 (additive):

1. Add mode + parser support for `RealityCheck`.
2. Keep existing v3 mode unchanged.
3. Enable `v3-paper` only via explicit mode/env.

Phase 2 (default switch for paper tasks):

1. In `auto`, choose `v3-paper` when:
   - NorthStar has valid artifact paths under `artifacts/` (existing or creatable), and
   - `RealityCheck` section is present, and
   - all `RealityCheck.cmd` entries pass allowlist validation.
2. Keep `artifact_gravity_v3_paper` latched and surface explicit contract warnings when incomplete.

Phase 3 (hardening):

1. Promote anti-churn rule.
2. Add richer per-check telemetry and UI surfacing.

## 11. Backward Compatibility

The runtime is now paper-loop only (`artifact_gravity_v3_paper`), including `auto`.
Existing run artifact format remains compatible.

## 12. Risks and Mitigations

Risk: checks become too strict and block iteration.  
Mitigation: start with `gate:any` + cheap checks first, tighten in later sprint.

Risk: users skip script maintenance.  
Mitigation: bootstrap scripts with minimal deterministic templates.

Risk: paper edits game superficial checks.  
Mitigation: couple paper checks with claims linkage and evidence coverage.

## 13. Acceptance Criteria

RFC-016 is considered implemented when:

1. `artifact_gravity_v3_paper` mode is available.
2. `NORTHSTAR.md` parser supports `RealityCheck` and `Gate Policy`.
3. Runtime success/no_delta in this mode follows Section 5 exactly.
4. `NORTHSTAR.md`-only edits no longer pass as success in this mode.
5. `result.json` includes per-check execution outcomes.
6. Bootstrap emits paper-safe artifact/check defaults.
7. `auto` enters `v3-paper` only when artifact path + reality-check allowlist validation both pass.
8. Anti-churn is triggered by missing check execution streak (not by check failure streak).
9. Repeated check-only pass with no artifact delta and no gate-state transition is treated as `no_delta`.

## 14. Reference NORTHSTAR Template (v3-paper)

```md
# NORTHSTAR

## Goal
把本项目研究产出写成可投稿论文，并做到关键 claim 可追溯证据/引用。

## Current Objective (this sprint)
把 claims.csv 做到 coverage >= 80%，并让 paper_draft 的 Method/Experiment 章节引用这些 claims。

## NorthStarArtifact
- path: artifacts/paper_draft.md
- path: artifacts/claims.csv

## RealityCheck
- cmd: python scripts/check_claims.py artifacts/claims.csv
- cmd: python scripts/check_paper.py artifacts/paper_draft.md artifacts/claims.csv

## Gate Policy
- gate: any

## Pivot Rule (minimal)
- pivot_allowed_when:
  - no_delta_streak >= 2
- pivot_action:
  - only edit Current Objective and/or artifact paths/check commands
  - include one-line rationale + runs/turn-xxxx failure evidence

## Next Action (one line)
补齐 Method 相关 5 条 claim，并在 paper_draft 对应段落插入 claim keys。
```
