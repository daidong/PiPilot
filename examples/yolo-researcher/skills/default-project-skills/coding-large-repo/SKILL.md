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
`agent-run-to-completion -> summarize evidence`.

# Procedures
1. Call `agent-run-to-completion` with:
   - `--task` (required)
   - `--verify-cmd` (recommended)
   - `--deliverable` (recommended when a concrete output path is expected)
2. The script internally performs:
   - repo intake
   - scoped plan write
   - coding-agent execution
   - bounded polling with stale-session restart handling
   - optional verification
   - optional deliverable-touch gate
3. For all scripts in this skill, consume the final `AF_RESULT_JSON: {...}` line (schema `coding-large-repo.result.v1`) as the canonical machine-readable result; failure paths also emit this JSON.
4. Only escalate to `ask_user` after at least one local run-to-completion attempt fails with concrete blocker evidence.
5. Legacy scripts are internal-only and require `CODING_LARGE_REPO_ALLOW_LEGACY_ENTRY=1`.

Recommended script usage:
- `skill-script-run` with `skillId="coding-large-repo"` and `script="agent-run-to-completion"` + args: `--task`, optional `--provider`, optional `--cwd`, optional `--verify-cmd`, optional `--deliverable`, optional `--timeout-sec`

# Examples
1. Single-run code edit + verify:
`skill-script-run({"skillId":"coding-large-repo","script":"agent-run-to-completion","args":["--task","Implement retry logic in runtime/session.ts and update related tests","--provider","auto","--cwd",".","--verify-cmd","npx vitest run tests/yolo-researcher-v2/runtime-contract.test.ts"]})`

2. Require deliverable touch in same run:
`skill-script-run({"skillId":"coding-large-repo","script":"agent-run-to-completion","args":["--task","Implement OpenAI client compatibility fix","--provider","auto","--cwd",".","--verify-cmd","pytest -q tests/test_runtime.py::test_resume","--deliverable","runs/turn-0021/artifacts/openai_compat_report.md"]})`

# Troubleshooting
- If `provider=auto` picks the wrong backend, force `--provider codex` or `--provider claude`.
- If Codex is installed via macOS app bundle, this skill auto-checks `/Applications/Codex.app/Contents/Resources/codex`.
- This skill intentionally uses dangerous no-approval flags for coding-agent delegation; only run in trusted local repositories.
- If run-to-completion fails, inspect `agent_log_path` / `verify_log_path` from `AF_RESULT_JSON` before retrying.
- If the task is long and logs stop growing, tune `--stale-sec` and `--max-restarts`.
- If deliverable gate fails, pass a path that is expected to be written in this run and ensure it is under the selected `--cwd`.
- If there is no reliable automated test path, use the smallest reproducible local check and clearly report the residual risk.
