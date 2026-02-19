# YOLO-Researcher v2: Runtime Selection Execution Gap (RFC-010)

> Status: open design debt / not implemented yet.
> Purpose: prevent false assumptions that `host|docker|venv` already changes execution backend.

---

## 0. Problem Statement

Desktop UI exposes runtime options:

- `host`
- `docker`
- `venv`

But current implementation does **not** switch execution backend based on this selection.
The selected runtime is currently used as:

- project/session metadata (`defaultRuntime`)
- prompt hint to the model
- runtime label in turn result / failure fingerprint dimensions

It is **not** used to route `bash` execution into docker or a specific venv.

---

## 1. Current Behavior (As-Is)

### 1.1 Wired (real effect today)

- UI selection persists and triggers session rebuild.
- turn context includes `defaultRuntime`.
- result/failure records include runtime label.
- agent prompt includes `Default runtime` and optional system notes.

### 1.2 Missing (not implemented)

- no docker executor routing
- no venv executor routing
- no runtime-specific preflight checks and fallback
- no runtime-specific environment injection strategy

### 1.3 Ground Truth in Code

- UI selector: `desktop/src/renderer/components/ControlPanel.tsx`
- payload/session wiring: `desktop/src/main/ipc.ts`
- runtime label usage in session: `v2/session.ts`
- actual command execution path (always shell spawn): `src/core/runtime-io.ts`

---

## 2. Why This Matters

If users choose `docker` or `venv`, they may expect isolation/reproducibility guarantees.
Current behavior provides labeling/hints, but not actual execution isolation.
This can create misleading experiment assumptions.

---

## 3. Target Behavior (Future)

When `defaultRuntime` is selected:

1. `host`: execute directly on host shell (current behavior).
2. `venv`: execute via configured venv activation/interpreter wrapper.
3. `docker`: execute inside configured container/image wrapper.

Execution backend choice must be deterministic at runtime IO layer (not only prompt guidance).

---

## 4. Minimum Acceptance Criteria

1. `bash` command path uses runtime-aware executor routing.
2. turn artifacts include effective executor details (`runtime`, image/env identity, cwd mapping).
3. deterministic preflight failure classification exists:
   - docker unavailable / image missing / daemon down
   - venv missing / python missing / activation failure
4. fallback policy is explicit and configurable (strict vs allow-host-fallback).
5. unit/integration tests cover host/docker/venv routing branches.
6. UI copy reflects real capability (no implied support before criteria are met).

---

## 5. Suggested Implementation Order

1. Introduce runtime executor abstraction in `RuntimeIO.exec`.
2. Implement `host` executor as baseline adapter.
3. Implement `docker` executor with explicit image/cwd/env mapping.
4. Implement `venv` executor with explicit interpreter/activation strategy.
5. Add preflight diagnostics and structured failure codes.
6. Connect UI/runtime settings to executor config and add tests.

---

## 6. Temporary Product Note (Until Implemented)

Current `Runtime` selector should be interpreted as:

- planning/prompt hint
- logging label

not execution isolation.

Keep this note until Section 4 acceptance criteria are all satisfied.

