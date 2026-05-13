---
name: compute-environment
description: Route long-running research compute between the local sandbox and Modal remote compute. Use for training, fine-tuning, GPU jobs, large data processing, or scripts that may run for many minutes.
category: Compute
tags: [compute, gpu, modal, training]
triggers: [train model, gpu, remote compute, modal, run script, long-running, fine-tune]
license: MIT
metadata:
  skill-author: Research Copilot
---

# Compute Environment

Use compute tools for scripts that are long-running, resource-heavy, or need progress monitoring.

## Routing

Prefer local compute when:
- The job is quick, exploratory, or mostly file/data wrangling.
- The script uses MLX/Metal on Apple Silicon.
- The task can finish in under roughly 30 minutes.

Prefer Modal when:
- The script needs NVIDIA CUDA GPUs.
- Training or fine-tuning would take more than roughly 30 minutes locally.
- The dataset/model is large enough that local memory or GPU support is a poor fit.

## Tool Flow

Local:
1. Write or inspect the script.
2. Call `compute_plan` with `env: "local"` and `task_description`.
3. Call `local_compute_execute`, then monitor with `local_compute_status` or `local_compute_wait`.

Modal:
1. Write a Modal-compatible script.
2. Call `compute_plan` with `env: "modal"`, `script_path`, and `task_description`.
3. Tell the user a Modal plan is awaiting approval in the Compute tab.
4. Call `modal_execute`. If it returns `waiting_for_approval: true`, wait for user approval before trying again.
5. Monitor with `modal_status` or `modal_wait`. Stop with `modal_stop` if needed.

`task_description` should briefly name the computational objective, important inputs or dataset paths, expected outputs, and success criteria.

## Modal Script Template

```python
import modal

image = modal.Image.debian_slim(python_version="3.11").pip_install("torch", "numpy", "pandas")
app = modal.App("research-copilot-job")

@app.function(gpu="A10G", image=image, timeout=60 * 60)
def run_job():
    import torch
    # Put heavyweight imports and training code inside the function body.
    print('##PROGRESS## {"step": 1, "total": 3, "phase": "setup"}')
    # train/evaluate/process here

@app.local_entrypoint()
def main():
    run_job.remote()
```

## GPU Selection

- T4: cheapest small inference and light evaluation.
- A10G: default for ordinary PyTorch/TensorFlow training.
- A100 or A100-80GB: larger models or memory-heavy training.
- H100: very large or performance-critical jobs only.

## Progress And Cost

Progress lines beginning with `##PROGRESS##` followed by JSON work for both local and Modal runs.

Modal cost is estimated from elapsed time and configured GPU rate. The user can set an auto-kill threshold in Settings > Compute.
