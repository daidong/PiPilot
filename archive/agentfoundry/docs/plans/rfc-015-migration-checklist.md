# RFC-015 Migration Checklist
## Framework Memory Minimal Core + Research Pilot Alignment

Status: Draft  
Owner: AgentFoundry Team  
Related RFCs: RFC-015, RFC-012 (Deprecated)

---

## 1. Goal

Align runtime behavior with the new default:

1. Framework default profile is minimal (no task/facts/evidence scaffolding).
2. Research Pilot uses `Artifacts + Session Summaries` as the only memory semantics.
3. Legacy behavior remains available behind explicit `legacy` profile.

---

## 2. Phase A — Profile Infrastructure (Compatibility First)

### A1. Add profile config

1. Update `src/kernel-v2/types.ts`:
   - add `kernelV2.profile?: 'minimal' | 'legacy'`
   - add resolved config field with same union.
2. Update `src/kernel-v2/defaults.ts`:
   - resolve default profile (`legacy` for backward compatibility in this phase).

### A2. Branch assembly by profile

1. Update `src/kernel-v2/context-assembler-v2.ts`:
   - `legacy`: keep current behavior.
   - `minimal`: do not build or inject:
     - task anchor block
     - memory cards section
     - evidence cards section
   - keep:
     - continuity block
     - non-protected history
     - protected recent turns
     - optional selected context.

### A3. Branch kernel writes by profile

1. Update `src/kernel-v2/kernel.ts`:
   - `minimal`: skip task-state create/update and task memory write-candidate calls.
   - keep artifact registration APIs unchanged.

### A4. Telemetry clarity

1. Update kernel telemetry/log lines to include profile.
2. In `minimal`, ensure logs do not emit legacy terms (`task-anchor injected`, `memory=... evidence=...`).

---

## 3. Phase B — Research Pilot Switch

### B1. Enable minimal profile in Research Pilot

1. Update `examples/research-pilot/agents/coordinator.ts`:
   - set `kernelV2: { enabled: true, profile: 'minimal' }`.

### B2. Keep selected context path explicit

1. Verify and preserve:
   - mentions + latest session summary in `selectedContext`.
2. File: `examples/research-pilot/agents/coordinator.ts`.

### B3. Documentation updates

1. `examples/research-pilot/README.md`:
   - explicitly state no task/facts/evidence injection in runtime.
2. `README.md`:
   - note profile semantics at framework level.

---

## 4. Phase C — Legacy Isolation

### C1. Optionalize legacy semantics

1. Move legacy-heavy logic behind profile guards.
2. Keep code path stable for existing apps using `legacy`.

### C2. Naming cleanup

1. Avoid legacy wording in user-facing logs when `minimal`.

---

## 5. Tests

### Required tests to add/update

1. `tests/kernel-v2/context-assembler-v2.test.ts`
   - assert no task/memory/evidence sections under `minimal`.
2. `tests/kernel-v2/kernel-api-and-telemetry.test.ts`
   - assert legacy telemetry events absent under `minimal`.
3. `tests/examples/research-pilot/*`
   - add integration assertion that Research Pilot runs with profile `minimal`.

### Regression suite

1. `npm run test:run`
2. `npm run build`
3. `cd examples/research-pilot-desktop && npm run build`

---

## 6. Acceptance Criteria

1. Research Pilot debug logs no longer show:
   - `task-anchor injected`
   - `retrieval ... memory=... evidence=...`
2. System/context token usage in RP decreases measurably (target >= 20% on baseline tasks).
3. Legacy profile apps remain functional without behavior regression.

---

## 7. Rollback

If quality drops:

1. Switch app config back to `kernelV2.profile = 'legacy'`.
2. Keep profile-gated code; do not remove legacy path until after two stable releases.
