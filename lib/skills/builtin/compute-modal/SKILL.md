---
name: compute-modal
description: Modal remote GPU compute. Use for CUDA workloads, fine-tuning, large training, or anything the local machine can't fit. Requires explicit user approval per plan (cost > 0).
category: Compute
tags: [compute, modal, gpu, training, remote]
triggers: [modal, train large model, fine-tune, gpu cloud, cuda]
license: MIT
metadata:
  skill-author: Research Copilot
---

# Modal Compute

Modal backend (`backend: 'modal'`, `toolPrefix: 'modal'`) shells out to the `modal` CLI to run scripts on Modal's remote GPU infrastructure. Bills the user's Modal account. Every plan requires explicit user approval in the Compute tab before execution — no auto-approval.

## Prerequisites

The user must have:
- `pip install modal` (or `uv pip install modal`) somewhere on PATH
- A Modal token: `modal token new` once, OR `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` in Settings → API Keys

If either is missing, `list_compute_backends` will show `available: false` with `missingRequirements`. Surface the message to the user — they need to install Modal CLI / configure credentials before Modal plans can execute.

## Tool flow

1. Confirm availability: `list_compute_backends()`.
2. `compute_plan({ backend: 'modal', command, script_path, task_description })` — runs a planning sub-agent that reads the script and extracts the declared Modal image + GPU configuration, then estimates cost.
3. Response includes `requires_approval: true` and `message` — tell the user a Modal plan is awaiting approval in the Compute tab. Do NOT call `modal_execute` until they approve.
4. `modal_execute({ plan_id })` — submits the run. If approval is still pending, returns `waiting_for_approval: true`; if user rejected, returns `rejected: true` with the rejection comments.
5. Monitor with `modal_status` / `modal_wait`. Stop with `modal_stop`.

## Modal script template

```python
import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("torch==2.8.0", "numpy", "pandas")
)
app = modal.App("research-copilot-job")

@app.function(gpu="A10G", image=image, timeout=60 * 60)
def run_job():
    import torch
    # Heavy imports + work inside the function body
    print('##PROGRESS## {"step": 1, "total": 3, "phase": "setup"}')
    # train / evaluate / process here

@app.local_entrypoint()
def main():
    run_job.remote()
```

## GPU selection

The planner extracts the GPU declared by `@app.function(gpu=…)` and feeds it to the cost estimator.

| GPU | Use case | ~Rate ($/hr) |
|---|---|---|
| T4 | Small inference / light eval | 0.59 |
| A10G | Default for ordinary PyTorch/TensorFlow training | 1.10 |
| A100 | Larger models / memory-heavy training | 3.72 |
| A100-80GB | Larger context / longer sequences | 4.28 |
| H100 | Very large or perf-critical jobs only | 8.10 |
| L4 | Cheap inference, video / image workloads | 0.80 |

When multiple GPUs are declared, the cost estimator picks the highest and adds a warning.

## Cost awareness

`compute_plan` returns a `cost_estimate` with `estimatedTotalUsd`, `hourlyRateUsd`, and `coverage: 'lower_bound'` (only GPU time is modeled; CPU/RAM/idle-container are not). The user's configured Modal cost threshold (Settings → Compute) auto-kills runs whose elapsed cost exceeds the threshold.

Mention the estimated cost when surfacing the plan to the user so they know what they're approving.

## Progress lines

Same convention as local: print `##PROGRESS## {...}` on stdout; the runner extracts them via `modal_status`/`modal_wait`.

## Image declaration tips

- Use `uv_pip_install` over `pip_install` when available — it's faster.
- Pin versions for reproducibility: `torch==2.8.0`, not just `torch`.
- Declare runtime GPU on `@app.function(gpu=…)`, not just on the image build, so cost estimation finds it.
- Avoid `.add_local_dir` of the whole workspace — only the directories the script reads at runtime.
