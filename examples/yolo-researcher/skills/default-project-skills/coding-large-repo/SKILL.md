---
name: coding-large-repo
description: Structured workflow for large-repo code changes with scoped planning, incremental edits, and verification loops.
allowed-tools:
  - skill-script-run
id: coding-large-repo
shortDescription: Plan and execute non-trivial codebase edits with scoped verification and fallback evidence
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - coding
  - repository
  - refactor
  - testing
meta:
  approvedByUser: true
---

# Summary
Use this skill for medium/large codebase modifications where blind edits are risky. It provides a repeatable loop:
`repo-intake -> change-plan -> delegate-coding-agent -> verify-targets -> summarize evidence`.

# Procedures
1. Run `repo-intake` to capture branch state, dirty status, coding-agent availability (`codex`/`claude`), and suggested verification commands.
2. Run `change-plan "<task>"` to create a scoped plan file under `.yolo-researcher/tmp/coding-large-repo/`.
3. Delegate implementation to an external coding agent:
   - Bounded task: `delegate-coding-agent --task "<task>" --provider auto --cwd <path>`
   - Long task: `delegate-coding-agent` now auto-routes to `agent-start` in `--async auto` mode (or force with `--async always`), then use `agent-poll` / `agent-log` until completed.
4. Run `verify-targets --cmd "<targeted test command>" [--cwd <path>]` after coding-agent edits. By default it uses Docker-preferred runtime (`--runtime auto`), then falls back to host when Docker is unavailable or fails with infrastructure-level errors.
5. Record command outcomes, session ids, and log paths in turn assets (for example Note/RunRecord/ExperimentRequest payloads).
6. Only escalate to `ask_user` after at least one local coding-agent attempt and one local verification attempt fail to unblock the task.
7. For all scripts in this skill, consume the final `AF_RESULT_JSON: {...}` line (schema `coding-large-repo.result.v1`) as the canonical machine-readable result; failure paths also emit this JSON.
8. `delegate-coding-agent` runs Codex/Claude in dangerous no-approval mode by default (`codex --dangerously-bypass-approvals-and-sandbox`, `claude --dangerously-skip-permissions`) to avoid user-confirmation stalls.

Recommended script usage:
- `skill-script-run` with `skillId="coding-large-repo"` and `script="repo-intake"`
- `skill-script-run` with `skillId="coding-large-repo"` and `script="change-plan"` + args: task statement
- `skill-script-run` with `skillId="coding-large-repo"` and `script="delegate-coding-agent"` + args: `--task`, optional `--provider`, optional `--cwd`, optional `--async`, optional `--session-id`
- `skill-script-run` with `skillId="coding-large-repo"` and `script="agent-start"` + args: `--task`, optional `--provider`, optional `--cwd`
- `skill-script-run` with `skillId="coding-large-repo"` and `script="agent-poll"` + args: `--session-id`
- `skill-script-run` with `skillId="coding-large-repo"` and `script="agent-log"` + args: `--session-id`, optional `--tail-lines`
- `skill-script-run` with `skillId="coding-large-repo"` and `script="agent-kill"` + args: `--session-id`
- `skill-script-run` with `skillId="coding-large-repo"` and `script="verify-targets"` + args: `--cmd`, optional `--cwd`, optional `--timeout-sec`, optional `--runtime`, optional `--docker-image`

# Examples
1. Intake:
`skill-script-run({"skillId":"coding-large-repo","script":"repo-intake","args":["."]})`

2. Plan:
`skill-script-run({"skillId":"coding-large-repo","script":"change-plan","args":["Implement offline trace validator retry logic"]})`

3. Delegate one-shot coding:
`skill-script-run({"skillId":"coding-large-repo","script":"delegate-coding-agent","args":["--task","Implement retry logic in runtime/session.ts and update related tests","--provider","auto","--cwd","."]})`

3b. Delegate and force background session:
`skill-script-run({"skillId":"coding-large-repo","script":"delegate-coding-agent","args":["--task","Refactor evaluator + add integration tests + run focused verification","--provider","auto","--cwd",".","--async","always","--session-id","coding-agent-<id>"]})`

4. Start background coding session:
`skill-script-run({"skillId":"coding-large-repo","script":"agent-start","args":["--task","Refactor planner/coordinator prompt contracts and update tests","--provider","auto","--cwd","."]})`

5. Poll session:
`skill-script-run({"skillId":"coding-large-repo","script":"agent-poll","args":["--session-id","coding-agent-<id>"]})`

6. Read session log:
`skill-script-run({"skillId":"coding-large-repo","script":"agent-log","args":["--session-id","coding-agent-<id>","--tail-lines","120"]})`

7. Verify:
`skill-script-run({"skillId":"coding-large-repo","script":"verify-targets","args":["--cmd","npx vitest run tests/yolo-researcher-v2/runtime-contract.test.ts","--cwd","."]})`

`skill-script-run({"skillId":"coding-large-repo","script":"verify-targets","args":["--cmd","pytest -q tests/test_runtime.py::test_resume","--runtime","docker","--docker-image","my-repo-dev:latest","--cwd","."]})`

# Troubleshooting
- If `provider=auto` picks the wrong backend, force `--provider codex` or `--provider claude`.
- If Codex is installed via macOS app bundle, this skill auto-checks `/Applications/Codex.app/Contents/Resources/codex`.
- This skill intentionally uses dangerous no-approval flags for coding-agent delegation; only run in trusted local repositories.
- For long-running jobs, prefer `delegate-coding-agent --async auto|always` so it immediately returns a session handle from `agent-start` (then use `agent-poll` + `agent-log`).
- `verify-targets` now defaults to Docker-preferred execution (`--runtime auto`) and reports whether host fallback was used in `AF_RESULT_JSON`.
- If Docker should be deterministic for a repo, pass `--docker-image <image>` (or set `CODING_LARGE_REPO_DOCKER_IMAGE`).
- If `verify-targets` fails, inspect the printed `log_path` and rerun with a narrower command.
- If suggested verification commands from `repo-intake` do not fit the repo, replace them with project-specific commands and continue the same loop.
- If there is no reliable automated test path, use the smallest reproducible local check and clearly report the residual risk.
