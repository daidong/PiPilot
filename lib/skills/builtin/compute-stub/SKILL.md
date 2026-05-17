---
name: compute-stub
description: Diagnostic in-memory compute backend. Use ONLY when the user explicitly asks to verify that the compute pipeline (Registry → IPC → renderer) is wired correctly without invoking real shells or remote services. Off by default — register via ENABLE_COMPUTE_STUB=1.
category: Compute
tags: [compute, diagnostic, stub, qa]
triggers: [diagnose compute, compute health check, verify pipeline, stub backend, test compute]
license: MIT
metadata:
  skill-author: Research Copilot
---

# Stub Compute (diagnostic)

Stub backend (`backend: 'stub'`, `toolPrefix: 'stub'`) is an in-memory no-op that simulates plan/run/stop without invoking any real subprocess or remote API. Available only when the developer sets `ENABLE_COMPUTE_STUB=1`.

## When to use

- The Compute tab seems broken — want to confirm whether the bug is in registry / IPC / renderer plumbing vs. a backend's internals.
- Validating that a new backend you're writing follows the same lifecycle the stub demonstrates.
- Smoke-testing event flow after refactors to lib/compute/.

Do NOT use for real work — there's no actual computation happening.

## Behavior

The stub parses keywords from the command string:

| Command contains | Behavior |
|---|---|
| (default) | Sleeps 100ms then completes with exit code 0 |
| `SLOW` | Sleeps 5000ms (use to exercise `stub_stop`) |
| `FAIL` | Sleeps 100ms then exits with code 1 + sets `failure.code = COMMAND_FAILED` |

Combine freely — e.g. `SLOW job that may FAIL` waits 5s then fails.

## Tool flow

1. `list_compute_backends()` — confirm `stub` is registered.
2. `compute_plan({ backend: 'stub', command: 'health check' })` — no approval gate.
3. `stub_execute({ plan_id })` — kicks off the timer.
4. `stub_wait({ run_id })` — blocks until terminal.
5. `stub_stop({ run_id })` — cancels (useful for SLOW runs).

If the stub flow succeeds end-to-end but `local_*` / `modal_*` flows don't, the bug is backend-internal (sandbox provider, Modal CLI, etc.), not registry/IPC/renderer plumbing.

## Reference for adding a new backend

`lib/compute/backends/stub/stub-backend.ts` is also the canonical
reference implementation for RFC §19 (Adding a new compute backend).
It demonstrates every `ComputeBackend` method against the simplest
possible state (a Map + setTimeout), so you can read the whole file
in under 5 minutes and see the contracts in action.
