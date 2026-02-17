---
name: cloudlab-distributed-experiments
description: CloudLab/Powder distributed experiment orchestration via Portal API for reproducible multi-node runs, including experiment lifecycle, host inventory, remote execution, artifact collection, and teardown. Use when tasks mention CloudLab, Powder, Portal API, reservations, or running repeatable distributed experiments across cluster nodes.
allowed-tools:
  - skill-script-run
id: cloudlab-distributed-experiments
shortDescription: Reproducible CloudLab experiment lifecycle + distributed execution workflow
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - cloudlab
  - powder
  - distributed-systems
  - infrastructure
  - reproducibility
meta:
  approvedByUser: true
---

# Summary
Use this skill when research work needs reproducible distributed experiments on CloudLab/Powder (create -> wait-ready -> run across nodes -> collect outputs -> terminate) without manual portal clicking.

All scripts emit a machine-readable final line:
`AF_RESULT_JSON: {...}` using schema `cloudlab-distributed-experiments.result.v1`.

# Prerequisites
1. Export CloudLab portal variables before calls:
   - `PORTAL_HTTP` (for example `https://boss.emulab.net:43794`)
   - `PORTAL_TOKEN` or `PORTAL_TOKEN_FILE`
2. Ensure local tools are available: `curl`, `jq`, `ssh`, `scp`.
3. Ensure your SSH public key is configured in CloudLab so experiment nodes accept `ssh`.

# Workflow
1. `portal-intake`:
   - Validate API reachability and token correctness via `/version` and `/tokens/this`.
2. `resgroup-search` / `resgroup-create` (optional but recommended under contention):
   - Search feasible reservation windows and create reservation groups for guaranteed capacity.
3. `profile-create` / `profile-update` (optional):
   - Create or evolve the experiment profile (script-backed or repo-backed) before instantiation.
   - Use `profile-get` / `profile-delete` for inspection and cleanup.
4. `experiment-create`:
   - Create experiment with required fields (`name`, `project`, `profile_name`, `profile_project`) and optional `bindings`/`duration`.
5. `experiment-wait-ready`:
   - Poll status until `ready` (or fail fast on terminal non-ready states).
6. `experiment-hosts`:
   - Extract host inventory from experiment aggregates into a hosts JSON file.
   - Optionally generate SSH config aliases.
7. `distributed-ssh`:
   - Execute one command across all hosts with bounded concurrency and per-host logs.
8. `collect-artifacts`:
   - Pull result files/directories from each host into local folders.
9. `experiment-extend` (optional):
   - Extend running experiment duration via `extend_by` or absolute `expires_at`.
10. `experiment-terminate`:
   - Release resources and optionally wait until experiment is deleted.
11. `resgroup-get` / `resgroup-modify` / `resgroup-delete` (optional):
   - Inspect, adjust, and clean reservation groups as the schedule changes.

# Script Catalog
- `portal-intake`: check portal/token/env readiness.
- `resgroup-search`: search available reservation time window for requested resources.
- `resgroup-create`: create reservation group for capacity guarantees.
- `resgroup-get`: inspect reservation group details.
- `resgroup-modify`: update reservation group timing/resources/reason.
- `resgroup-delete`: delete reservation group.
- `profile-create`: create profile (script-backed or repo-backed).
- `profile-update`: patch profile fields or trigger repo-backed refresh.
- `profile-get`: inspect profile metadata/version/repository state.
- `profile-delete`: delete profile.
- `experiment-create`: create CloudLab experiment.
- `experiment-wait-ready`: block until experiment status becomes `ready`.
- `experiment-hosts`: materialize node host list to JSON (+ optional SSH config file).
- `distributed-ssh`: run remote command on all hosts with concurrency control.
- `collect-artifacts`: copy outputs from all hosts to local path.
- `experiment-extend`: request more runtime for an active experiment.
- `experiment-terminate`: terminate experiment and optionally confirm deletion.

# Recommended Calls
1. Validate portal/token:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"portal-intake","args":[]})`

2. Create experiment:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"experiment-create","args":["--name","rq1-baseline","--project","myproject","--profile-name","small-lan","--profile-project","PortalProfiles","--duration","2","--bindings-file","./bindings.json"]})`

3. (Optional) Search & reserve capacity:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"resgroup-search","args":["--project","myproject","--duration","2","--nodetypes-file","./resgroup-nodetypes.json"]})`

`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"resgroup-create","args":["--project","myproject","--reason","RQ1 baseline reservation","--duration","2","--start-at","<start_at>","--nodetypes-file","./resgroup-nodetypes.json"]})`

4. (Optional) Create or update profile:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"profile-create","args":["--name","rq1-profile","--project","myproject","--script-file","./profile.py","--public","false"]})`

`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"profile-update","args":["--profile-id","<profile_id>","--script-file","./profile.py"]})`

`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"profile-get","args":["--profile-id","<profile_id>","--elaborate"]})`

5. Wait until ready:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"experiment-wait-ready","args":["--experiment-id","<exp_id>","--timeout-sec","3600","--poll-sec","20"]})`

6. Build hosts inventory:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"experiment-hosts","args":["--experiment-id","<exp_id>","--hosts-out",".yolo-researcher/tmp/cloudlab/hosts.json","--ssh-config-out",".yolo-researcher/tmp/cloudlab/ssh_config"]})`

7. Run distributed command:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"distributed-ssh","args":["--hosts-file",".yolo-researcher/tmp/cloudlab/hosts.json","--cmd","python3 run_benchmark.py --iters 5","--parallel","4","--continue-on-error"]})`

8. Collect outputs:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"collect-artifacts","args":["--hosts-file",".yolo-researcher/tmp/cloudlab/hosts.json","--remote-path","~/exp-results","--local-dir",".yolo-researcher/artifacts/cloudlab-rq1","--allow-missing"]})`

9. (Optional) Extend runtime:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"experiment-extend","args":["--experiment-id","<exp_id>","--extend-by","2","--reason","Need rerun for variance reduction"]})`

10. Cleanup:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"experiment-terminate","args":["--experiment-id","<exp_id>","--wait-gone"]})`

11. (Optional) Reservation cleanup:
`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"resgroup-get","args":["--resgroup-id","<resgroup_id>","--elaborate"]})`

`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"resgroup-modify","args":["--resgroup-id","<resgroup_id>","--project","myproject","--reason","shift schedule","--start-at","<new_start>","--expires-at","<new_end>"]})`

`skill-script-run({"skillId":"cloudlab-distributed-experiments","script":"resgroup-delete","args":["--resgroup-id","<resgroup_id>","--allow-missing"]})`

# Coordination Rules
1. Keep one active experiment id per branch in coordinator context and reuse host inventory files to avoid repeated discovery calls.
2. Treat `AF_RESULT_JSON` as canonical status; use script `status/exit_code` for retry/escalate decisions.
3. Do not ask user to run commands until at least one local orchestration attempt has failed with concrete evidence.
4. Always terminate experiments when done or when blocked for long periods to avoid quota/resource waste.

# References
Use `references/cloudlab-api-notes.md` for validated endpoint details and design assumptions.
