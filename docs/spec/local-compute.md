# Local Compute: Intelligent Sandboxed Task Execution

> Spec version: 1.2 | Last updated: 2026-04-05

## 1. Overview

Local Compute provides sandboxed execution of agent-generated code (Python scripts, shell commands, data pipelines) with full lifecycle management: scheduling, preflight validation, progress monitoring, stall detection, failure analysis, experience learning, and crash recovery.

### Design Axiom

**The system core is fully self-contained. LLM is never on the critical path.**

```
v1.0: run, observe, persist, stop           -- ZERO LLM dependency
v1.1: preflight, smoke contract, env inject -- still no LLM calls
v1.2: LLM profiling, LLM risk advice        -- LLM enhances, never required
```

### Two-Layer Architecture

```
+---------------------------------------------------+
|                  DECISION LAYER                    |
|  (enhances execution; not required for it)         |
|                                                    |
|  task-profiler.ts    LLM multi-axis profiling      |
|  strategy.ts         LLM risk assessment           |
|  experience.ts       Structured outcome records    |
|  environment-model.ts  Static probe + MLX detect   |
+-------------------------+-------------------------+
                          | advice
+-------------------------v-------------------------+
|                  EXECUTION LAYER                   |
|  (works standalone, no LLM needed)                 |
|                                                    |
|  runner.ts       scheduler -> preflight ->         |
|                  smoke? -> full -> finalize         |
|  sandbox/        process (v1) or docker (v2)       |
|  run-store.ts    JSONL persistence (debounced)     |
|  progress.ts     output polling + extraction       |
|  failure-signals.ts   pure failure derivation      |
|  scheduler.ts    one-heavy-at-a-time guard         |
+---------------------------------------------------+
```

---

## 2. File Structure

```
lib/local-compute/
  types.ts                Core types: RunRecord, FailureSignal, SandboxProvider, etc.
  sandbox/
    provider.ts           SandboxProvider interface re-export
    process-sandbox.ts    Process sandbox (v1.0): detached process group, stderr tee
    docker-sandbox.ts     Docker sandbox (v2.0 placeholder)
    detect.ts             Auto-detect available providers, cached
  run-store.ts            JSONL persistence with debounced flush
  runner.ts               Main orchestrator: submit, poll, stall, timeout, finalize
  scheduler.ts            Admission control: one-heavy-at-a-time + resource checks
  progress.ts             3-layer progress extraction (protocol > regex > raw)
  failure-signals.ts      Pure deriveFailure() function
  preflight.ts            Pre-execution checks (syntax, imports, disk, paths)
  environment-model.ts    System profiling + MLX detection + agent guidance
  experience.ts           Structured experience JSONL store
  task-profiler.ts        LLM multi-axis task profiling (v1.2)
  strategy.ts             LLM risk assessment (v1.2)
  tools.ts                5 AgentTools: plan, execute, wait, status, stop

app/src/renderer/
  stores/compute-store.ts               Zustand store
  components/center/ComputeView.tsx     Compute tab main view
  components/center/ComputeRunCard.tsx  Individual run card
```

### Modified Files

```
lib/types.ts                    PATHS.computeRuns added
lib/tools/index.ts              Returns { tools, destroy }; registers compute tools
lib/agents/coordinator.ts       Async env probe via setSystemPrompt; destroyResearchTools in destroy()
app/src/main/ipc.ts             Compute IPC forwarding in onToolResult; destroyAllCoordinators()
app/src/main/index.ts           before-quit calls destroyAllCoordinators()
app/src/preload/index.ts        3 compute IPC channels
app/src/renderer/stores/ui-store.ts    'compute' added to CenterView
app/src/renderer/components/layout/CenterPanel.tsx   Compute tab + badge
app/src/renderer/App.tsx        Compute IPC listeners
```

---

## 3. State Machine

```
          +-------+
          | queued |  (future: scheduler queue)
          +---+---+
              |
   preflight  |   pass
+-------------v-----------+     +----------+
|         running          +--->| completed | (exit 0)
|  phase: preflight/smoke/ |    +----------+
|         full             |
+---+------+------+---+---+    +------+
    |      |      |   |   +--->| failed | (exit != 0)
    |      |      |   |        +------+
    |      |      |   |
    |      |      |   +------->+-----------+
    |      |      |            | timed_out | (exceeded timeoutMs)
    |      |      |            +-----------+
    |      |      |
    |      |      +----------->+-----------+
    |      |                   | cancelled | (user/agent stop)
    |      |                   +-----------+
    |      |
    |      +--no output for--->+---------+
    |         stallThreshold   | stalled | (still running, not terminal)
    |                          +----+----+
    |                               |
    |         output resumes        |
    +<------------------------------+
```

**Terminal states**: completed, failed, timed_out, cancelled

**Non-terminal**: running, stalled (process still alive; agent decides next action)

---

## 4. Core Types

### 4.1 RunRecord (JSONL-persisted)

```typescript
interface RunRecord {
  runId: string                    // "cr-" + 4 hex bytes
  status: RunState
  weight: RunWeight                // 'heavy' | 'light'
  currentPhase: 'preflight' | 'smoke' | 'full'
  command: string
  smokeCommand?: string
  workDir: string                  // Workspace-relative
  sandboxWorkDir: string           // Absolute
  sandbox: 'docker' | 'process'
  env?: Record<string, string>

  createdAt: string                // ISO 8601
  startedAt?: string
  completedAt?: string

  exitCode?: number
  exitSignal?: string
  error?: string
  stderrTail?: string              // Last 4KB

  outputPath: string               // Absolute: .research-pilot/compute-runs/{runId}/output.log
  outputBytes: number
  outputLines: number
  lastOutputAt?: string

  timeoutMs: number
  stallThresholdMs: number
  stalled: boolean

  pid?: number                     // For crash recovery
  pidStartTime?: number            // Process start epoch ms (PID+starttime prevents reuse confusion)

  retryCount: number
  parentRunId?: string
}
```

### 4.2 FailureSignal

```typescript
type FailureCode =
  | 'OOM_KILLED'          // exit 137 or MemoryError
  | 'TIMEOUT'             // exceeded timeoutMs
  | 'STALL'               // no output for stallThreshold
  | 'MODULE_NOT_FOUND'    // Python ModuleNotFoundError
  | 'PERMISSION_DENIED'   // EACCES / PermissionError
  | 'PYTHON_ERROR'        // Traceback / *Error: / *Exception:
  | 'SIGNAL_KILLED'       // killed by signal (non-OOM)
  | 'COMMAND_FAILED'      // generic non-zero exit

interface FailureSignal {
  code: FailureCode
  retryable: boolean
  message: string
  suggestions: string[]    // Actionable for agent
}
```

Failure derivation is a **pure function** (`deriveFailure(run)`) with priority-ordered pattern matching. No side effects, trivially testable.

### 4.3 StructuredProgress

```typescript
interface StructuredProgress {
  currentStep?: number
  totalSteps?: number
  percentage?: number              // 0-100
  metrics?: Record<string, number> // e.g., { loss: 0.85, accuracy: 0.92 }
  phase?: string                   // "training", "downloading", etc.
  etaSeconds?: number
}
```

### 4.4 TaskProfile (v1.2, LLM-based)

```typescript
interface TaskProfile {
  cpuDensity: 'low' | 'medium' | 'high'
  gpuDensity: 'none' | 'light' | 'heavy'
  memoryPattern: 'constant' | 'growing' | 'spike'
  ioPattern: 'read_heavy' | 'write_heavy' | 'balanced' | 'minimal'
  chunkable: boolean               // Can split data
  resumable: boolean               // Has checkpoints
  idempotent: boolean              // Safe to re-run
  hasExternalSideEffects: boolean   // API calls, DB writes
  networkRequired: boolean
  smokeSupported: boolean           // Has --smoke flag
  expectedDurationClass: 'seconds' | 'minutes' | 'hours'
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
}
```

### 4.5 ExperienceRecord

```typescript
interface ExperienceRecord {
  runId: string
  taskKind: string                 // "{framework}-{action}" e.g. "pytorch-training"
  sandbox: 'docker' | 'process'
  outcome: 'success' | 'failed' | 'timeout' | 'cancelled'
  failureCode?: FailureCode
  durationSeconds: number
  retryCount: number
  dataSizeMb?: number
  peakMemoryMb?: number
  summary?: string                 // LLM-generated (v1.2)
  effectiveFix?: string            // What fixed it (v1.2)
  timestamp: string
}
```

---

## 5. Execution Pipeline

### 5.1 Submit Flow

```
local_compute_execute(command, ...)
  |
  v
1. classifyWeight(timeout, command) -> 'heavy' | 'light'
  |
  v
2. canAdmit(snapshot, weight)
   - Max 1 heavy concurrent
   - Max 3 total concurrent
   - Min 500MB free memory
   - Min 500MB free disk
   |  rejected? -> throw "Scheduler: ..."
   v
3. runPreflight(command, workDir)
   - checkSyntax (python3 -m py_compile)
   - checkImports (batch test, single Python process)
   - checkDataPaths (fs.existsSync)
   - checkDiskSpace (df -m)
   - checkOutputDir (write test)
   |  failed? -> throw "Preflight failed: ..."
   v
4. provider.spawn(smokeCommand ?? command)
   - Process sandbox: bash wrapper with stderr tee
   - Record PID + pidStartTime for crash recovery
   |
   v
5. handle.wait().then(handleExit)
   - If smoke succeeded + full differs: transition to 'full', re-spawn
   - Otherwise: set terminal status, record experience, cleanup
```

### 5.2 Polling (5-second shared interval)

```
For each active run:
  1. stat(outputPath) -> currentBytes
  2. readFileTail(outputPath, 8KB) -> tail
  3. estimateLines(bytes, tail)
  4. Output grew?
     - Yes: update lastOutputAt; clear stalled flag if was stalled
     - No + past stallThreshold: set stalled=true, status='stalled'
  5. currentBytes > 1GB? -> kill process, status='failed'
  6. elapsed > timeoutMs? -> SIGTERM + 3s SIGKILL, status='timed_out'
  7. updateRun(patch) -- debounced flush (every 30s unless terminal)
```

### 5.3 Smoke Run (Optional)

Smoke is an **opt-in contract**. The agent provides `smoke_command` explicitly (e.g., `"python3 train.py --smoke"`). No auto-detection, no auto-generation.

- If provided: runner spawns smoke first (timeout = min(full_timeout * 0.1, 5min))
- Smoke exit 0: transition to `phase: 'full'`, re-spawn with full command
- Smoke exit != 0: stop pipeline, return failure to agent
- If not provided: straight to full run

---

## 6. Sandbox Provider

### 6.1 Interface

```typescript
interface SandboxProvider {
  name: 'docker' | 'process'
  available(): Promise<boolean>
  spawn(config: SpawnConfig): Promise<SandboxHandle>
}

interface SandboxHandle {
  pid: number | string
  kill(signal?: string): Promise<void>
  wait(): Promise<{ exitCode: number; exitSignal?: string }>
  cleanup(): Promise<void>
}
```

### 6.2 Process Sandbox (v1.0)

- Wraps command with bash for stderr duplication:
  ```bash
  ( ${command} ) 2> >(tee -a "${stderrPath}" >&2) >> "${outputPath}" 2>&1
  ```
- `detached: true` creates new process group for clean `kill(-pid)`
- `stdio: ['ignore', 'ignore', 'ignore']` -- zero parent-side file handles
- Combined output file (`output.log`) gets both stdout and stderr (for progress extraction)
- Separate stderr file (`output.log.stderr`) for failure analysis

### 6.3 Auto-Detection

`getProvider(preference?)` returns the best available provider. Currently only ProcessSandbox. Docker provider is a v2.0 target.

---

## 7. Persistence

### 7.1 RunStore

**Storage**: `.research-pilot/compute-runs/runs.jsonl`

**Debounced flush strategy**:
- In-memory Map is source of truth
- **Immediate flush**: `createRun()`, terminal state transitions (completed/failed/timed_out/cancelled), `flushNow()` on shutdown
- **Debounced flush**: progress updates via dirty flag + 30-second periodic timer
- Atomic writes: temp file + rename

**Eviction**: Records with terminal status + `completedAt` older than 7 days are removed (plus their output directories) on startup.

### 7.2 ExperienceStore

**Storage**: `.research-pilot/compute-runs/experience.jsonl`

- Capped at 200 records (most recent kept)
- Written once per run completion
- `taskKind` inferred from command + script content (framework detection + action detection)
- `findRelevant(taskKind)` returns exact matches, falling back to recent records
- `summarize(taskKind)` computes success/failure counts, avg duration, common failure codes

---

## 8. Progress Monitoring

Three layers, later layer takes precedence:

### Layer 1: Raw Output Stats

Every 5-second poll: `stat()` output file, count bytes/lines, detect growth.

### Layer 2: Regex Pattern Extraction

Applied to the last 8KB of normalized output (carriage returns replaced with newlines):

| Pattern | Example | Extracted |
|---------|---------|-----------|
| tqdm | `45%\|...\| 450/1000 [02:15<02:45]` | percentage, step, total, ETA |
| Epoch | `Epoch 3/10` | step, total, phase='training' |
| Step | `Step 150/1000` | step, total |
| Percentage | `Processing: 45%` | percentage (last occurrence) |
| Metrics | `loss=0.85 acc=0.92` | metrics map (all occurrences) |
| Phase | Keywords: download/train/evaluate/preprocess/save | phase string |

### Layer 3: Cooperative Protocol (Authoritative)

Scripts can emit structured progress:
```
##PROGRESS## {"step": 3, "total": 10, "loss": 0.85, "phase": "training", "eta": 120}
```

Last `##PROGRESS##` line takes precedence over regex. Any numeric fields beyond the known keys (`step`, `total`, `percentage`, `phase`, `eta`, `eta_seconds`) are captured as metrics.

---

## 9. Failure Classification

`deriveFailure(run: RunRecord): FailureSignal | undefined`

Priority-ordered rules (first match wins):

| Priority | Code | Detection | Retryable |
|----------|------|-----------|-----------|
| 1 | OOM_KILLED | exit 137 OR MemoryError/OOM in stderr | Yes |
| 2 | TIMEOUT | status === 'timed_out' | Yes |
| 3 | STALL | status === 'stalled' | Yes |
| 4 | MODULE_NOT_FOUND | ModuleNotFoundError in stderr | Yes |
| 5 | PERMISSION_DENIED | PermissionError/EACCES in stderr | No |
| 6 | PYTHON_ERROR | Traceback OR `^\w+Error:` OR `^\w+Exception:` in stderr | Yes |
| 7 | SIGNAL_KILLED | exitSignal present | SIGTERM=yes |
| 8 | COMMAND_FAILED | Fallback | No |

Each signal includes `suggestions[]` with actionable remediation steps for the agent.

---

## 10. Crash Recovery

### Problem

If the Electron app crashes (SIGKILL, force quit), child processes spawned with `detached: true` become orphans. The RunStore contains stale `status: 'running'` records.

### Solution: PID + Process Start Time

```typescript
// On spawn: record PID + start time
const pid = handle.pid
const pidStartTime = getPidStartTime(pid)  // macOS: ps -p; Linux: /proc/stat
store.updateRun(runId, { pid, pidStartTime })

// On startup: check each non-terminal record
function isStaleRun(record: RunRecord): boolean {
  if (!record.pid) return true                    // No PID -> stale
  if (!isPidAlive(record.pid)) return true         // PID dead -> stale
  // PID alive but might be reused by another process
  const currentStartTime = getPidStartTime(record.pid)
  if (Math.abs(currentStartTime - record.pidStartTime) > 2000) return true  // Different process
  return false  // Genuinely still running
}
```

On startup, `reconcileStaleRuns()` transitions all stale records to `status: 'failed'` with error message.

### Why PID + Start Time (not just PID)

PIDs are recycled by the OS. On macOS (PID range 0-99999), a PID can be reused within minutes. Checking only `isPidAlive(pid)` would incorrectly identify an unrelated process as the old compute run, keeping the scheduler permanently blocked.

The `(pid, starttime)` pair uniquely identifies a process instance across PID recycling.

---

## 11. Shutdown Cleanup

### Three-Phase Destroy

```
runner.destroy():
  1. SIGTERM all active processes
  2. Wait up to 5 seconds for graceful exit (poll isPidAlive every 500ms)
  3. SIGKILL any survivors
  4. Update all records to 'cancelled', flush store
```

### App Quit Handler

```typescript
// app/src/main/index.ts
app.on('before-quit', (event) => {
  event.preventDefault()
  destroyAllCoordinators()   // 8s timeout across all windows
    .finally(() => app.exit(0))
})
```

This ensures Cmd+Q does not leave orphan compute processes.

---

## 12. Scheduler

### Admission Rules

| Rule | Threshold | Effect |
|------|-----------|--------|
| Heavy concurrency | Max 1 heavy run | Block new heavy runs |
| Total concurrency | Max 3 runs (heavy + light) | Block all new runs |
| Free memory | Min 500MB | Block with message |
| Free disk | Min 500MB | Block with message |

### Weight Classification

```
timeoutMinutes <= 2                             -> 'light'
timeoutMinutes <= 10 AND command matches viz    -> 'light'
otherwise                                       -> 'heavy'
```

Viz patterns: `/\b(plot|viz|chart|figure|draw|render)\b/i`

---

## 13. Environment Model

### Static Profile (probed once, cached)

```typescript
interface StaticProfile {
  os: 'darwin' | 'linux' | 'other'
  arch: string
  cpuCores: number
  cpuModel: string
  totalMemoryMb: number
  gpu: {
    type: 'apple_silicon' | 'nvidia' | 'none'
    model: string
    memoryMb?: number
    mlxAvailable: boolean
    mlxPackages: string[]
    cudaAvailable: boolean
    metalAvailable: boolean
  }
  pythonVersion: string
  pipPackages: string[]
  dockerAvailable: boolean
}
```

### MLX Detection

On Apple Silicon (darwin + arm64):
1. Check if `mlx` is in pip packages
2. Verify import: `python3 -c "import mlx; print(mlx.__version__)"`
3. Scan for related packages: mlx, mlx-nn, mlx-data, mlx-lm, mlx-optimizers, mlx-audio, mlx-vlm

### Agent Guidance Injection

`generateAgentGuidance(profile)` produces a text block injected into the agent's system prompt **asynchronously** (fire-and-forget via `agent.setSystemPrompt()`). The agent starts immediately with the base prompt; guidance arrives within 1-3 seconds.

Example guidance on Mac with MLX:
```
## Local Compute Environment
Machine: darwin arm64, 10 CPU cores, 32768MB RAM
Python: 3.11.6
GPU: Apple M2 Max (32768MB unified memory, Metal available)

### MLX Acceleration Available
Installed MLX packages: mlx, mlx-nn, mlx-data, mlx-lm
When writing ML training code for local_compute_execute:
- Prefer mlx over PyTorch for training -- native Metal acceleration
- Use mlx.core.array for GPU-accelerated array operations
- mlx supports 4-bit quantization via mlx-lm for large models

### Sandbox Guidelines
- All required packages must be importable (preflight checks imports)
- For long-running tasks, consider adding a --smoke flag
- Print progress: ##PROGRESS## {"step": N, "total": M, "loss": 0.85}
```

---

## 14. AgentTools

### 14.1 local_compute_plan (v1.2, optional)

Analyze a script before execution. Agent can skip this for simple tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| command | string | Yes | Shell command |
| script_path | string | No | Relative path for deeper analysis |
| sandbox | string | No | "docker" / "process" / "auto" |
| timeout_minutes | number | No | Suggested timeout |
| smoke_command | string | No | Quick validation command |

Returns: task_profile, risk_assessment, recommendations, experience_summary.

### 14.2 local_compute_execute

Submit a command for sandboxed execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| command | string | Yes | Shell command |
| work_dir | string | No | Workspace-relative working directory |
| sandbox | string | No | "docker" / "process" / "auto" (default: auto) |
| timeout_minutes | number | No | Max runtime (default: 60, max: 1440) |
| stall_threshold_minutes | number | No | Minutes without output before stall (default: 5) |
| env | object | No | Extra environment variables |
| smoke_command | string | No | Quick validation command |
| parent_run_id | string | No | Previous failed run (retry lineage) |

Returns: run_id, sandbox, status, current_phase, output_path, weight.

### 14.3 local_compute_wait

Block until run completes, stalls, or timeout.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| run_id | string | Yes | Run ID from execute |
| timeout_seconds | number | No | Max wait (default: 120, max: 600) |

Returns: status, current_phase, exit_code, output_tail, progress, failure, elapsed_seconds.

### 14.4 local_compute_status

Non-blocking status check. Same return as wait.

### 14.5 local_compute_stop

Cancel a running task. Returns: run_id, status='cancelled'.

---

## 15. UI: Compute Tab

### CenterView

Added `'compute'` to `CenterView = 'chat' | 'literature' | 'compute'`. Tab shows active run count badge.

### ComputeView

- **Active section**: Running/stalled runs with ComputeRunCard
- **Recent section**: Last 20 completed/failed/cancelled runs, sorted by start time
- **Environment footer**: Sandbox type, OS, CPU, RAM, GPU, MLX badge, free resources
- **Empty state**: Shown when no runs exist

### ComputeRunCard

- Run ID + status badge (color-coded: blue=running, amber=stalled, green=completed, red=failed, orange=timeout, gray=cancelled)
- Command (truncated)
- Progress bar (if percentage available, clamped 0-100)
- Stats line: phase, percentage, step/total, elapsed, bytes, ETA
- Metrics: key=value badges (loss, accuracy, etc.)
- Failure panel: error code, message, suggestions list
- Retry lineage: "Retry of cr-xxxxx"
- Collapsible live output (last 2KB)
- Stop button (active runs only)

### IPC Events

| Channel | Direction | When |
|---------|-----------|------|
| `compute:run-update` | Main -> Renderer | Agent calls execute/status/wait (non-terminal) |
| `compute:run-complete` | Main -> Renderer | Run reaches terminal state |
| `compute:environment` | Main -> Renderer | Once on coordinator init |

Events are forwarded in `onToolResult` handler, not from background polling. UI updates only when agent explicitly queries status.

---

## 16. Constants Reference

| Constant | Value | Location |
|----------|-------|----------|
| POLL_INTERVAL_MS | 5,000 | runner.ts |
| OUTPUT_TAIL_BYTES | 8,192 | runner.ts |
| STDERR_TAIL_BYTES | 4,096 | runner.ts |
| DEFAULT_TIMEOUT_MS | 3,600,000 (60 min) | runner.ts |
| DEFAULT_STALL_THRESHOLD_MS | 300,000 (5 min) | runner.ts |
| MAX_TIMEOUT_MS | 86,400,000 (24 h) | runner.ts |
| MAX_OUTPUT_BYTES | 1,073,741,824 (1 GB) | runner.ts |
| DESTROY_KILL_TIMEOUT_MS | 5,000 | runner.ts |
| FLUSH_INTERVAL_MS | 30,000 | run-store.ts |
| EVICT_AGE_MS | 604,800,000 (7 days) | run-store.ts |
| MAX_RECORDS (experience) | 200 | experience.ts |
| MAX_HEAVY_CONCURRENT | 1 | scheduler.ts |
| MAX_TOTAL_CONCURRENT | 3 | scheduler.ts |
| MIN_FREE_MEMORY_MB | 500 | scheduler.ts |
| MIN_FREE_DISK_MB | 500 | scheduler.ts |

---

## 17. Known Limitations and Future Work

### Current Limitations

1. **Docker sandbox not implemented** -- Only process sandbox available. Docker is a v2.0 target.
2. **No output file rotation** -- Output capped at 1GB but no in-flight rotation. Process is killed when cap is hit.
3. **Compute tab gets updates only on agent tool calls** -- No independent background IPC stream. Progress updates appear when agent queries status.
4. **Keyboard shortcut Cmd+3 not wired** -- Tab displays the hint but handler is not registered.
5. **Zustand selectors re-render on every Map mutation** -- Acceptable for Electron, optimize with `useShallow` in v2.
6. **Rosetta 2 edge case** -- On Apple Silicon running under Rosetta, `os.arch()` returns 'x64', missing MLX detection.

### Planned Enhancements (v2.0+)

1. **Docker sandbox provider** -- Full filesystem/network isolation, resource limits via `--memory`/`--cpus`.
2. **Background IPC stream** -- Push progress updates to renderer independently of agent tool calls.
3. **Run detail view** -- Expandable run view with full output viewer, resource graphs.
4. **Cross-session experience reasoning** -- LLM-powered experience relevance assessment.
5. **Auto-suggest code rewrites** -- Suggest PyTorch -> MLX conversion on Apple Silicon.
6. **Dependency auto-resolution** -- Auto-create venv and `pip install` from requirements.txt before run.
7. **Multi-run orchestration** -- Hyperparameter sweeps, batch experiment submission.

---

## 18. Agent Workflow Example

```
User: "Train a random forest on patient_data.csv"

Agent turn 1:
  1. write_file("train_rf.py", generated_code)
  2. local_compute_execute(
       command: "python3 train_rf.py",
       timeout_minutes: 30
     )
     -> { run_id: "cr-a1b2c3d4", status: "running" }
  3. local_compute_wait("cr-a1b2c3d4", timeout_seconds: 120)
     -> { status: "running", progress: { percentage: 40, metrics: { accuracy: 0.87 } } }
  4. Reply: "Training underway. 40% complete, accuracy so far: 0.87."

User: "How's it going?"

Agent turn 2:
  1. local_compute_status("cr-a1b2c3d4")
     -> { status: "failed", failure: {
           code: "MODULE_NOT_FOUND", retryable: true,
           message: "No module named 'xgboost'",
           suggestions: ["Add xgboost to requirements.txt"] } }
  2. edit_file("requirements.txt", add "xgboost")
  3. local_compute_execute(
       command: "python3 train_rf.py",
       parent_run_id: "cr-a1b2c3d4"
     )
  4. Reply: "Fixed missing xgboost dependency. Restarted training."
```
