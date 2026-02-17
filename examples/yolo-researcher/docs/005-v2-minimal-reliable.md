# YOLO-Researcher v2: Minimal & Reliable

> **Design Axiom**: The system does not pursue quality through architectural complexity.
> Instead, it pursues **minimal discipline to prevent death + evidence-driven progressive strengthening**.

---

## 0. Goals

Build a highly autonomous YOLO researcher: given a research topic prompt, it continuously drives the full research process (clarify → analyze → innovate → experiment → summarize → write), with:

- **Cross-session continuity**: No "amnesia", no repeated mistakes.
- **Resistance to repeated failures**: The same error does not appear over and over.
- **Resistance to hallucination spread**: One inaccurate LLM output does not corrupt everything.
- **Low fixed overhead**: Token/context budget goes to reading code, running experiments, and writing papers — not to protocols and orchestration.

---

## 1. Design Philosophy & Key Principles

### 1.1 Simplicity First

No multi-agent pipeline. No heavy protocols. No multi-layer Gate/Reviewer.
A single agent autonomous loop can run the entire process; everything else is an **optional accelerator**, not a correctness dependency.

### 1.2 Evidence First

The most dangerous thing in research is not "being not smart enough" — it is **"looks reasonable but has no evidence"**. Therefore:

- **Sources of truth** are restricted to: raw tool output, code patches, experiment artifacts.
- LLM-written content may only be:
  - **Decisions**
  - **Hypotheses**
  - **Next actions**
  - **Pointers** to evidence paths
- Any "factual claim" must point to a file under `runs/turn-xxxx/`. Otherwise it must be tagged `[HYP]`.

This principle directly prevents "inaccurate summary / memory drift causing disaster".

### 1.3 Append-Only, Never Rewrite History

LLM errors are inevitable, but we guarantee errors never overwrite evidence and history:

- Every turn writes actions and evidence into a new directory `runs/turn-xxxx/` (append-only).
- The main files receive only small incremental updates: update current plan and pointers, never bulk-rewrite the past.
- This way, **"errors are confined to the latest turn"** and are easy to roll back or correct.

### 1.4 Failure = Learning (Failure Memory + Circuit Breaker)

Repeated occurrences of the same operation/error are a systemic problem:

- **Deterministic failures** (e.g., `ModuleNotFoundError`, permission errors, path not found) — once repeated 2–3 times, automatically marked as `BLOCKED`.
- `BLOCKED` entries must be written into `FAILURES.md` and forcefully avoided in subsequent turns. The agent must switch to an alternative route or ask the user for information.

---

## 2. Minimal Persistence: Directory Structure & File Contracts

v2 persistence is deliberately compressed to the minimum: **2 main files + evidence directories**.

```
yolo/<project_id>/
├── PROJECT.md          # Single control panel: goal/plan/state/key pointers (short)
├── FAILURES.md         # Failure & blocker list: paths not to retry (short)
└── runs/
    ├── turn-0001/
    │   ├── action.md   # This turn's "what/why" (short)
    │   ├── result.json # Execution metadata (see §2.3)
    │   ├── cmd.txt     # Command run (if any)
    │   ├── stdout.txt  # Raw output (if any)
    │   ├── stderr.txt  # Raw error (if any)
    │   ├── patch.diff  # Code changes (if any)
    │   └── artifacts/  # Result files/figures/tables/intermediates
    └── turn-0002/...
```

### 2.1 PROJECT.md: Single Control Panel (Must Be Short)

PROJECT.md is **navigation**, not a **fact warehouse**. Its job: let the agent quickly find the main thread on every startup.

Fixed structure (do not expand arbitrarily):

| Section | Purpose | Rules |
|---------|---------|-------|
| **Goal & Success Criteria** | Target + verifiable success criteria | As specific as possible |
| **Current Plan (Next 3–5 actions)** | Next steps, max 3–5 items | Short and actionable |
| **Facts (with evidence pointers)** | Reproducible facts only | Every item must have an evidence path (`runs/turn-xxxx/...`) |
| **Constraints / Environment** | Environment constraints (docker/host, deps, permissions, network) | Must have evidence pointers |
| **Hypotheses [HYP]** | Unverified conjectures | Must be tagged `[HYP]`, forbidden from mixing into Facts |
| **Key Artifacts** | Key output pointers | Experiment result dirs, draft paths, key patches |

**Core discipline: Every sentence in Facts and Constraints must link to an evidence file.**

**Size limits** (any one exceeded triggers compression):

- Total lines: ≤ 150
- Facts entries: ≤ 20
- Key Artifacts entries: ≤ 20

**Compression strategy** (monotonic and safe — demote, never rewrite):

- Old Facts → `Facts (Archived)` section: **demote to index entry** — keep only the original conclusion sentence + its evidence path. This is not summarization (no new text is generated); it is demotion to a pointer.
- Always preserve in the active section: Constraints, Current Plan, most recent 5–10 Facts relevant to current stage.
- **Forbidden compression actions**: rewriting a Fact in different words, merging multiple Facts into one, generating a narrative summary of archived Facts. The only allowed operation is moving a Fact verbatim (or truncated to one line) into the Archived section with its evidence pointer intact.

### 2.2 FAILURES.md: Only Deterministic Failures/Blockers, Not a Journal

FAILURES.md is not for reviewing all errors. Its purpose is to form a **"do not retry" list** that breaks deadlocks.

Entry format — minimal but must include evidence:

```markdown
- [BLOCKED][docker] python -m openevolve.llm
  error: ModuleNotFoundError: No module named 'openevolve.llm'
  evidence: runs/turn-0012/stderr.txt
  attempts: 3
  alternatives:
    - run on host environment
    - install missing package in docker
    - fix import/module path

- [WARN][host] pip install openevolve
  error: Permission denied: /usr/local/lib/python3.11
  evidence: runs/turn-0015/stderr.txt
  attempts: 2
  alternatives:
    - use --user flag
    - use venv
```

**`BLOCKED` semantics**: Under current constraints unchanged, retrying will only waste turn budget.

### 2.3 result.json: Execution Metadata (Mandatory for Exec Actions)

Every `Exec` turn must write a `result.json` alongside the raw output files. This is the structured contract for execution results:

```json
{
  "exit_code": 1,
  "runtime": "docker",
  "cmd": "python -m openevolve.llm",
  "cwd": "/workspace/openevolve",
  "duration_sec": 12.3,
  "timestamp": "2026-02-16T20:47:43Z"
}
```

| Field | Required | Purpose |
|-------|----------|---------|
| `exit_code` | Yes | Machine-readable success/failure signal |
| `runtime` | Yes | Which environment was used (docker/host/venv) |
| `cmd` | Yes | Exact command executed |
| `cwd` | Yes | Working directory at execution time |
| `duration_sec` | No | Wall-clock time (useful for timeout tuning) |
| `timestamp` | No | When execution occurred |

For non-Exec actions (Read/Edit/Write/Ask/Stop), `result.json` is optional.

### 2.4 BLOCKED Unblock Protocol

`BLOCKED` is not permanent. It means "under current constraints, retrying is wasteful." When constraints change, entries can be unblocked:

**Unblock triggers** (any one is sufficient):

| Trigger | Example | Action |
|---------|---------|--------|
| **Environment change** | Package installed, Dockerfile rebuilt, venv recreated | Agent writes `[UNBLOCKED]` with evidence of the change |
| **User explicit unblock** | User says "I fixed the docker image, try again" | Agent writes `[UNBLOCKED]` citing user instruction |
| **Minimal verification passes** | `python -c "import openevolve.llm"` exits 0 | Agent writes `[UNBLOCKED]` with evidence from the verification run |

**Unblock format** in FAILURES.md:

```markdown
- [UNBLOCKED][docker] python -m openevolve.llm
  was: BLOCKED (ModuleNotFoundError)
  resolved: package installed via pip install -e .
  evidence: runs/turn-0025/result.json (exit_code: 0)
```

**Rules**:

- `[UNBLOCKED]` entries stay in FAILURES.md as history (append-only principle).
- ToolRunner only checks the **latest status** for a given fingerprint: if the most recent entry is `[UNBLOCKED]`, execution is allowed.
- If the same fingerprint gets re-blocked after unblocking, the count resets from 0 (it's a new situation).

---

## 3. Execution Model: Single Agent Atomic Loop (One Turn = One Atomic Action)

### 3.1 Turn Structure

Every turn has exactly four steps, each lightweight:

```
Load  → Read PROJECT.md + FAILURES.md + last 3 runs/turn-xxxx/action.md
Decide → Choose one "atomic action" (do exactly one thing)
Act    → Call tools to execute (bash/read/edit/literature…), preserve raw output
Flush  → Write runs/turn-xxxx/*, small updates to PROJECT.md & FAILURES.md
```

**Default window size**: The "last N turns" lookback window defaults to **N = 3**. This value is used consistently across:

- Load phase: read last 3 `action.md` files for recent context.
- Failure fingerprint matching: scan last 10 turns for repeated failures (§5.2).

These defaults may be overridden via project config, but must always have explicit values.

**Atomic action is key**: prevents "step 3 fails but agent hallucinates continuing steps 4 and 5".

### 3.2 Atomic Action Set (Minimal)

No complex protocol needed. The agent simply writes its intent clearly:

| Action | Description | Boundary |
|--------|-------------|----------|
| **Read** | Read code / literature / data | One file or one search query |
| **Exec** | Run one command | **Exactly one shell command or one script invocation**. Multi-step experiments must be wrapped in a single script; the agent must not chain sequential commands within one turn |
| **Edit** | Make one small patch | One logical change (may touch multiple lines in one file, but one file per turn) |
| **Write** | Write a note / draft / experiment record | One artifact file |
| **Ask** | Ask the user a blocking question | One question |
| **Stop** | Complete / output milestone deliverable | Declare completion of a milestone |

**Why strict Exec boundary**: "Run one experiment" can hide multi-step complexity (setup env → install deps → run → collect). Each step should be its own turn so that failures are isolated and evidence is granular. If a multi-step workflow is needed, write a wrapper script in one turn (Write action), then execute it in the next turn (Exec action).

### 3.3 Cross-Session Recovery Protocol

```
First startup:
  1. Create PROJECT.md (initialize from user's goal)
  2. Create empty FAILURES.md
  3. Begin turn-0001

Recovery startup:
  1. Read PROJECT.md → restore goal and plan
  2. Read FAILURES.md → know what not to do
  3. Read last 3 runs/turn-xxxx/action.md → know where we left off
  4. If PROJECT.md "Current Plan" conflicts with recent runs
     → trust runs evidence
     → correct PROJECT.md in the new turn (not during startup)
  5. Continue next turn
```

---

## 4. Tool Execution: Raw Output Pass-Through (No Translation, No Loss)

The tool system must guarantee:

- **stdout/stderr/exit_code/traceback saved in full**
- **Failures are reproducible** (cmd + cwd + key environment info optionally saved)
- **Never wrap errors** into "tool execution failure" while losing raw information

### 4.1 ToolRunner Behavior

ToolRunner does exactly three things:

1. **BLOCKED interception**: Check FAILURES.md — if same cmd + same runtime has `BLOCKED` → reject immediately, return evidence pointer. Let Agent change runtime or strategy.
2. **Execute**: Run in the specified runtime environment.
3. **Dump raw results**: Write stdout/stderr/exit_code verbatim to `runs/turn-xxxx/`.

ToolRunner does NOT:

- Interpret errors
- Decide retry strategy
- Translate or summarize output

### 4.2 Explicit Runtime Selection

The agent must **explicitly specify runtime** (docker/host/venv) for every `Exec` action. No magic auto-selection.

- If omitted, use `default_runtime` from PROJECT.md.
- If that runtime is `BLOCKED` in FAILURES.md for the same class of operation, ToolRunner rejects deterministically.

This keeps ToolRunner as a **dumb pipe**: no reasoning, no retrying, no summarizing — but it can perform deterministic BLOCKED interception to prevent death loops.

---

## 5. Failure Learning: Minimal Circuit Breaker

### 5.1 Failure Fingerprint (Simple Version)

No complex embedding/indexing. Simplest fingerprint:

```
fingerprint = normalize(cmd) + normalize(error_line_1) + env(docker/host/venv)
```

### 5.2 Trigger Rules

| Condition | Action |
|-----------|--------|
| Same fingerprint appears ≥ 2 times in last 10 turns | Write to FAILURES.md as `[WARN]` |
| Same fingerprint appears ≥ 3 times in last 10 turns | Upgrade to `[BLOCKED]`; subsequent turns forbidden from retrying same path; must switch strategy or ask user |

### 5.3 "Alternatives First" Discipline

Once `BLOCKED` is hit, the next turn's action may only be:

- **Switch environment** (docker → host or vice versa)
- **Minimal verification** (smaller check, not re-running the big command)
- **Resolve dependency/permission** (install, change path, add config)
- **Ask user** (request missing information/permissions/resources)

---

## 6. Research Progression: Driven by Artifacts, Not State Machines

No complex S1–S5 state machine needed. Research progresses through a **minimal artifact contract**.

Key research artifacts live in `runs/.../artifacts/` and are pointer-referenced in PROJECT.md's Key Artifacts. Common artifacts:

| Artifact | Purpose |
|----------|---------|
| `problem_statement.md` | Problem definition, success criteria, hypotheses |
| `literature_map.md` | Literature landscape / key takeaways |
| `idea_candidates.md` | Candidate innovations with risks |
| `exp-xxxx/` | Experiment directory (commands, logs, results, figures) |
| `paper_draft.md` | Writing draft (grows incrementally) |

**Progression logic is simple**: whichever artifact is missing, work on it; when working on it, must include evidence / reproducible steps.

---

## 7. Anti-Hallucination: Two Hard Rules

### 7.1 Facts Must Have Evidence Paths

- No evidence → write to `Hypotheses [HYP]`
- Has evidence → write to `Facts`, with `runs/turn-xxxx/...` path attached

### 7.2 Control Files Are Navigation, Not Truth

PROJECT.md should NOT contain lengthy derivations or arguments (those get contaminated by errors). Long content goes into `runs/` artifacts. PROJECT.md holds only pointers and conclusions — and conclusions must have evidence.

---

## 8. Templates

### 8.1 PROJECT.md Template

```markdown
# Project: <title>

## Goal & Success Criteria
- Goal: ...
- Success criteria (measurable): ...

## Current Plan (Next 3-5 actions)
1. ...
2. ...
3. ...

## Facts (must include evidence pointers)
- ... (evidence: runs/turn-0007/stdout.txt)
- ... (evidence: runs/turn-0012/artifacts/result.csv)

## Constraints / Environment (must include evidence pointers)
- Docker python=3.11 lacks package X (evidence: runs/turn-0012/stderr.txt)
- ...

## Hypotheses [HYP] (unverified)
- [HYP] ...
- [HYP] ...

## Key Artifacts
- Experiments: runs/turn-0015/artifacts/exp-0001/
- Draft: runs/turn-0020/artifacts/paper_draft.md
- Patch: runs/turn-0018/patch.diff
```

### 8.2 FAILURES.md Template

```markdown
# Failures / Blockers (Do not retry blindly)

- [WARN][docker] <cmd>
  error: <one-line error>
  evidence: runs/turn-xxxx/stderr.txt
  attempts: 2
  alternatives:
    - ...
    - ...

- [BLOCKED][host] <cmd>
  error: <one-line error>
  evidence: runs/turn-yyyy/stderr.txt
  attempts: 3
  alternatives:
    - ...
    - ...
```

### 8.3 runs/turn-xxxx/action.md Template

```markdown
# Turn xxxx

## Intent
- Why this action: ...
- Expected outcome: ...

## Action
- Tool: bash/read/edit/...
- Command or target: ...

## Result
- Status: success/failure
- Key observation: ...
- Evidence: stdout/stderr/patch/artifacts paths

## Update (<=5 lines, pointers only)
- PROJECT.md: updated Facts #4 (evidence: stdout.txt)
- FAILURES.md: added [WARN] docker python -m ...
- Next: switch to host env, verify openevolve package exists
```

**Update section rules**:

- ≤ 5 lines, write change pointers only (which item updated, which blocker added, what minimal verification is next).
- No speculative long-form planning.
- All conjectures must go to `PROJECT.md > Hypotheses [HYP]`, ideally with evidence pointers or "command to verify".

---

## 9. Progressive Extension Roadmap (Stay Simple, Don't Break Correctness)

After v2 minimal is stable, add **only accelerators, never correctness dependencies**:

### Accelerator A: Mechanical Event Log

Record only tool call metadata (cmd/exit_code/paths) for debugging. Never injected into agent context.

### Accelerator B: Retrieval Index

Index only `runs/*/action.md` and artifacts for fast evidence lookup. If the index breaks, correctness is unaffected.

### Accelerator C: Lightweight Self-Check

Every N turns, check if stuck on BLOCKED, or if the plan hasn't progressed. Only provides hints, never gates.

### Accelerator D: On-Demand Lightweight Review

**Trigger conditions** (all mechanical, LLM does not judge "what is high risk"):

- Consecutive ≥ 2 failures (deterministic)
- Patch touches build/environment files (mechanical: `Dockerfile`, `requirements*.txt`, `pyproject.toml`, `Makefile`, `*.yml` CI files, etc.)
- Single patch exceeds threshold (mechanical: diff lines > N)

**Review output constraints**:

- May only write **suggestions and risk points** (tagged `[HYP]`, must reference evidence paths).
- May NOT write Facts.
- May NOT trigger any mandatory process: no "must pass to continue" conclusions. Only "suggest verifying X next" checklists.

**Review is written to**: `runs/turn-xxxx/review.md`

**Principle**: Deleting this accelerator does not affect system correctness (FAILURES.md provides the safety net).

---

## 10. How This Design Solves v1's Core Problems

| v1 Problem | v2 Solution |
|------------|-------------|
| Memory disabled/skipped | PROJECT.md + FAILURES.md + runs/ are permanent, always read |
| Sessions isolated | `project_id` is fixed; cross-session reads from the same directory |
| Information lost through layers | Raw stdout/stderr/patch always saved; ToolRunner is a dumb pipe |
| Repeated failures not broken | FAILURES.md + BLOCKED mechanically prevents retry |
| Architecture bloated | Core = one loop + simple file I/O + tool wrappers |
| Token budget wasted on orchestration | ~700 tokens fixed overhead (vs. ~6000+ in v1) |
| Errors propagate through summaries | Facts must have evidence pointers; no evidence = [HYP] |
| Reviewer becomes hidden gate | Reviewer is optional accelerator; cannot write Facts, cannot block |

---

## Appendix: Immovable Skeleton

These four properties form the **immovable skeleton** of v2. Any future extension must not violate them:

1. **Evidence pointer discipline** — Facts must point to `runs/`; no evidence = `[HYP]`.
2. **Append-only `runs/` + PROJECT.md as navigation only** — errors contaminate at most the latest turn.
3. **Atomic actions** — one turn does one thing.
4. **Accelerators are not correctness dependencies** — delete any accelerator, system still works correctly.
