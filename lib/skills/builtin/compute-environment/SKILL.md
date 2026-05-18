---
name: compute-environment
description: Route long-running research compute across available backends — currently local sandbox and Modal remote, generic enough that AWS/GCP/CloudLab can be added without changing this skill. Use for training, fine-tuning, GPU jobs, large data processing, or scripts that may run for many minutes.
category: Compute
tags: [compute, gpu, modal, training]
triggers: [train model, gpu, remote compute, modal, run script, long-running, fine-tune]
license: MIT
metadata:
  skill-author: Research Copilot
---

# Compute Environment

Use compute tools for scripts that are long-running, resource-heavy, or need progress monitoring. Each backend (local, modal, …) is registered with capabilities and a current availability status; the agent picks the right one by calling `list_compute_backends` and `compute_plan` with the chosen `backend`.

## Backend routing

Default heuristic:

| Use local when | Use Modal when |
|---|---|
| Quick / exploratory / file wrangling | Needs NVIDIA CUDA GPUs |
| MLX/Metal on Apple Silicon | Long training / fine-tuning (>30 min locally) |
| Likely finishes in <30 minutes | Datasets / models too large for the local machine |

For backend-specific patterns (script template, GPU choice, cost
awareness, sandbox vs container), consult the per-backend skill:

- `compute-local` — local sandbox tips, smoke-test patterns, sandbox choice
- `compute-modal` — Modal script template, GPU rate awareness, image declaration

## Tool surface

Generic:
- `list_compute_backends()` — see what's registered and which are available right now
- `compute_plan({ backend, command, task_description?, script_path?, timeout_minutes? })` — analyze + queue (or auto-approve when backend doesn't require approval)

Per-backend (replaces `<backend>` with the toolPrefix returned by `list_compute_backends`):
- `<backend>_execute({ plan_id, … })` — kick off the plan
- `<backend>_wait({ run_id, timeout_seconds? })` — block until terminal or timeout
- `<backend>_status({ run_id })` — non-blocking snapshot
- `<backend>_stop({ run_id })` — cancel (some backends don't support stop)

## Approval gate

For backends with `capabilities.requiresApproval: true` (Modal today, AWS/cloud likely), `compute_plan` queues the plan and the response carries `requires_approval: true` plus a message telling the user to approve in the Compute tab. Don't loop on `<backend>_execute` — call it once; if it returns `waiting_for_approval: true`, surface the message to the user and stop.

The user can also globally force approval on every backend via Settings → Compute → "Require approval for every compute backend".

## Cost awareness

For backends with `capabilities.hasCost: true`, `compute_plan` returns a `cost_estimate` with `estimatedTotalUsd`, `hourlyRateUsd`, and `coverage`. A `coverage: 'lower_bound'` flag means only one cost dimension is modeled (today Modal models GPU-time only) — actual bills can be higher. Each backend's auto-kill threshold lives in Settings → Compute.

## Progress lines

For any backend, scripts emit progress lines on stdout in the form:
```
##PROGRESS## {"step": 1, "total": 3, "phase": "setup", "percentage": 33}
```
The runner parses these and surfaces them through `<backend>_status` / `<backend>_wait` output so the agent can report fine-grained progress.
