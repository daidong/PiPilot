# YOLO-Researcher v2: Minimal & Reliable (Thin Native Protocol)

> **Design Axiom**: The system does not pursue quality through architectural complexity.
> It pursues **minimal discipline to avoid death + evidence-driven progressive strengthening**.

---

## 0. Goals

Build a highly autonomous researcher that can run long tasks with:

- **Cross-session continuity** (no amnesia)
- **Failure memory** (no blind retries forever)
- **Evidence discipline** (facts must be backed by artifacts)
- **Low fixed overhead** (budget goes to real work, not protocol ceremony)

---

## 1. Non-Negotiable Principles

### 1.1 Single-Agent Native Runtime

No mandatory multi-agent orchestration. No heavy intermediate protocol.
A single agent executes tools/skills/subagents directly and returns one turn report.

### 1.2 Evidence First

Allowed truth sources:

- raw tool output
- code patch files
- generated experiment artifacts

LLM text without evidence is hypothesis only.

### 1.3 Append-Only Recovery

Every turn writes to a new directory `runs/turn-xxxx/`.
History is not rewritten.

### 1.4 Failure = Learned Constraint

Deterministic repeated failures are promoted to `WARN`/`BLOCKED` and prevent dead loops.

---

## 2. Minimal Persistence Contracts

```
PROJECT.md
FAILURES.md
user-input-queue.json
runs/
├── turn-0001/
│   ├── action.md
│   ├── result.json
│   ├── cmd.txt
│   ├── stdout.txt
│   ├── stderr.txt
│   ├── exit_code.txt
│   └── artifacts/
│       ├── tool-events.jsonl
│       └── ...
└── turn-0002/...
```

### 2.1 PROJECT.md (Control Panel)

`PROJECT.md` is navigation, not a narrative dump.

Required sections:

- Goal & Success Criteria
- Current Plan (3–5 concrete next actions)
- Facts (must include `runs/turn-xxxx/...` evidence pointers)
- Constraints / Environment (with evidence pointers)
- Hypotheses `[HYP]`
- Key Artifacts

Size discipline:

- total lines <= 150
- facts <= 20
- key artifacts <= 20
- old facts are demoted to `Facts (Archived)` as pointer entries (append-only)

### 2.2 FAILURES.md (Do-Not-Retry Memory)

`FAILURES.md` is only for deterministic failure memory.
Not a full error journal.

Statuses:

- `[WARN]`
- `[BLOCKED]`
- `[UNBLOCKED]`

Entry must include at least:

- runtime
- command
- error line
- evidence path
- fingerprint
- timestamp

### 2.3 result.json (Mandatory for Every Turn)

Every turn writes `result.json`.

Current v2 contract:

```json
{
  "status": "success|failure|blocked|ask_user|stopped",
  "intent": "...",
  "summary": "...",
  "primary_action": "...",
  "exit_code": 0,
  "runtime": "host|docker|venv",
  "cmd": "...",
  "cwd": "...",
  "duration_sec": 1.234,
  "timestamp": "2026-02-17T02:17:23.000Z",
  "tool_events_path": "runs/turn-0001/artifacts/tool-events.jsonl",
  "tool_events_count": 2,
  "failure_fingerprint": "... (optional)",
  "unblock_verified": true
}
```

Notes:

- `cmd/stdout/stderr/exit_code` are synthesized from the latest `bash` tool event when available.
- Non-bash turns still write `result.json`; `cmd` falls back to `primary_action`.

### 2.4 User Input Bridge

If agent asks user (`status=ask_user`):

- write `runs/turn-xxxx/artifacts/ask-user.md`
- wait for UI submission
- queue stored in `user-input-queue.json`
- next turn materializes queue into `runs/turn-yyyy/artifacts/user-input-*.md`
- successful native run consumes queue

### 2.5 BLOCKED Unblock Protocol

`BLOCKED` is not permanent.

Allowed unblock evidence:

- environment changed (deps fixed / runtime changed)
- explicit user confirmation of remediation
- minimal verification command succeeds

When verification succeeds, append `[UNBLOCKED]` with:

- `was:` previous blocked reason
- `resolved:` remediation
- `evidence:` verification result path

---

## 3. Execution Model (Thin Native)

### 3.1 Turn Flow

Each turn stays minimal:

```
Load  -> Read PROJECT.md + FAILURES.md + last N action.md (+ pending user inputs)
Run   -> agent.runTurn(context) with native tools/skills/subagents
Flush -> write turn artifacts + update PROJECT.md/FAILURES.md pointers
```

Defaults:

- recent context window: last **3** turns
- failure fingerprint window: last **10** turns

### 3.2 Native Turn Contract

Agent returns one JSON outcome:

```json
{
  "intent": "why this turn",
  "status": "success|failure|ask_user|stopped",
  "summary": "one concise observation",
  "primaryAction": "short label of what was done",
  "askQuestion": "required when ask_user",
  "stopReason": "required when stopped",
  "projectUpdate": {
    "currentPlan": ["3-5 concrete items"],
    "facts": [{"text":"...", "evidencePath":"runs/turn-xxxx/..."}],
    "constraints": [{"text":"...", "evidencePath":"runs/turn-xxxx/..."}],
    "hypotheses": ["[HYP] ..."],
    "keyArtifacts": ["runs/turn-xxxx/..."],
    "defaultRuntime": "host|docker|venv"
  },
  "updateSummary": ["<=5 pointer lines"],
  "toolEvents": ["optional captured tool call/result records"],
  "rawOutput": "optional raw model output"
}
```

Rules:

- one turn returns one report
- multi-step internal tool usage is allowed, but report must stay concise
- ask user only when truly blocked by external info/permission

---

## 4. Tool / Skill / Subagent Execution

v2 runtime allows native use of all registered capabilities:

- built-in tools
- project/community skills
- subagent execution tools

No extra action protocol layer is required between agent and runtime.

Raw execution evidence is preserved through tool events and turn artifacts.

---

## 5. Failure Learning Circuit Breaker (Minimal)

### 5.1 Fingerprint

Deterministic failure fingerprint:

```
fingerprint = normalize(cmd) + normalize(error_line_1) + normalize(runtime)
```

### 5.2 Trigger Thresholds (Last 10 Turns)

- same fingerprint >= 2 -> append `[WARN]`
- same fingerprint >= 3 (historical count) -> append `[BLOCKED]` (triggers on 4th failure turn)
- when blocked fingerprint later verifies successfully -> append `[UNBLOCKED]`

### 5.3 After BLOCKED, Next Move Must Change Something

Allowed next direction:

- switch runtime
- do minimal verification
- remediate dependency/permission/path
- ask user for missing external input

Forbidden:

- blind immediate retry of same failing route

---

## 6. Research Progression (Artifact-Driven)

No heavyweight stage machine is required.
Progress is driven by missing/weak artifacts and evidence gaps.

Typical artifacts:

- `problem_statement.md`
- `literature_map.md`
- `idea_candidates.md`
- `exp-xxxx/`
- `paper_draft.md`

### 6.1 Deliverable Checklist & Stagnation Guard

The system infers research stage by scanning `runs/turn-xxxx/artifacts/` for deliverable filenames.
When 4 of the last 5 turns repeat the same action type (`action_type`), stagnation mode activates.
During stagnation, repeating the dominant action type counts as progress only when:
- stage advances via new deliverables, or
- blocker transitions occur (`failure_recorded` / `blocked_cleared`).
Otherwise the turn is downgraded to `no_delta` and fed into the redundancy breaker.

Canonical deliverable filenames (from §6 above):
- S1: `problem_statement.md`
- S2: `literature_map.md`
- S3: `idea_candidates.md`
- S4: `experiment_plan.md` or `exp-xxxx/`
- S5: `paper_draft.md` or `outline.md`

---

## 7. Anti-Hallucination Hard Rules

1. Facts and constraints require evidence paths under `runs/turn-xxxx/`.
2. No evidence -> write as `[HYP]`.
3. PROJECT.md remains short pointer-based control panel.
4. Raw output files are never replaced by summaries.

---

## 8. Templates

### 8.1 PROJECT.md

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

## Constraints / Environment (must include evidence pointers)
- ... (evidence: runs/turn-0012/stderr.txt)

## Hypotheses [HYP] (unverified)
- [HYP] ...

## Key Artifacts
- runs/turn-0015/artifacts/exp-0001/
```

### 8.2 FAILURES.md

```markdown
# Failures / Blockers (Do not retry blindly)

- [WARN][host] <cmd>
  error: <one-line error>
  evidence: runs/turn-xxxx/stderr.txt
  fingerprint: <...>
  attempts: 2
  updated_at: <iso>
  alternatives:
    - ...

- [BLOCKED][host] <cmd>
  error: <one-line error>
  evidence: runs/turn-yyyy/stderr.txt
  fingerprint: <...>
  attempts: 3
  updated_at: <iso>
  alternatives:
    - ...

- [UNBLOCKED][host] <cmd>
  was: BLOCKED (...)
  resolved: <what changed>
  evidence: runs/turn-zzzz/result.json
  fingerprint: <...>
  updated_at: <iso>
```

### 8.3 runs/turn-xxxx/action.md

```markdown
# Turn turn-xxxx

## Intent
- Why this turn: ...
- Expected outcome: Produce fresh evidence and update pointers only.

## Action
- Tool: Agent
- Command or target: <primaryAction>

## Result
- Status: success/failure/blocked/ask_user/stopped
- Key observation: ...
- Evidence: runs/turn-xxxx/...

## Update (<=5 lines, pointers only)
- PROJECT.md: applied structured update from native turn.
- PROJECT.md: applied runtime-generated evidence pointers.
- FAILURES.md: WARN recorded for fingerprint ...
```

---

## 9. Optional Accelerators (Never Correctness Dependencies)

- Mechanical event log views
- Retrieval index for artifacts
- Lightweight stuck checker
- On-demand review reports (`[HYP]` only, cannot write Facts, cannot gate execution)

Deleting any accelerator must not break base correctness.

---

## 10. Why This Fixes v1 Pain Points

- No cross-session amnesia -> persistent control files + append-only runs
- No silent loss -> raw outputs + result contract per turn
- No infinite retry loops -> deterministic circuit breaker
- No protocol bloat -> thin native turn contract
- No summary drift -> evidence pointer discipline

---

## Appendix: Immovable Skeleton

Future extensions must keep these four invariants:

1. **Evidence pointer discipline** (`runs/turn-xxxx` for Facts/Constraints)
2. **Append-only runs + short PROJECT navigation**
3. **One turn = one native outcome report**
4. **Accelerators are optional, never correctness-critical**
