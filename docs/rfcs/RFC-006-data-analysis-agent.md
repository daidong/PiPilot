# RFC-006: Data Analysis Agent — Design and Implementation

## Summary

This RFC documents the design, architecture, and implementation of the **Data Analysis Agent** — a Python code execution subsystem that enables AI agents to perform statistical analysis, data visualization, data transformation, and modeling on user-provided datasets. The agent follows a **LLM codegen → sandbox execute → collect outputs** pipeline, with automatic retry on failure, real-time UI progress tracking, and entity registration for generated artifacts.

## Motivation

Research workflows frequently require data analysis: computing statistics, generating plots, transforming datasets, and building models. An LLM alone cannot perform these operations accurately — it can hallucinate numbers, cannot execute code, and has no access to the actual data values.

The Data Analysis Agent solves this by:
1. **Reading the actual data file** to provide schema and preview context to the LLM
2. **Generating executable Python code** via LLM (not hallucinated results)
3. **Executing the code in a sandboxed Python process** to produce real outputs
4. **Registering generated artifacts** (plots, tables, transformed data) as first-class entities visible in the UI

### Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Code generation over direct analysis** | LLMs hallucinate statistics; executing real code guarantees correct results |
| **Absolute path injection** | LLM-generated code must not derive paths — the runtime provides them |
| **Retry with error feedback** | Python errors are passed back to the LLM for self-repair (classified per RFC-005) |
| **Schema-aware prompting** | The LLM sees column stats, types, and a data summary before generating code |
| **Entity lifecycle integration** | Outputs become first-class research entities with provenance tracking |
| **Explicit results protocol** | Scripts declare their outputs via `results.json`, not directory scanning |

## Architecture Overview

```
                 ┌──────────────────────────────────────────────────┐
                 │               Coordinator Agent                  │
                 │  (main chat agent with tool access)              │
                 └─────────────────┬────────────────────────────────┘
                                   │ calls data-analyze tool
                                   ▼
                 ┌──────────────────────────────────────────────────┐
                 │          Subagent Tool Wrapper                   │
                 │  (subagent-tools.ts)                             │
                 │  • Creates DataAnalyzer instance on first call   │
                 │  • Emits todo-update events for UI progress      │
                 │  • Maps tool parameters to analyzer input        │
                 └─────────────────┬────────────────────────────────┘
                                   │ calls analyze()
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Data Analysis Pipeline                               │
│  (data-team.ts)                                                             │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │ 1. Read File  │───▶│ 2. Infer     │───▶│ 3. LLM       │───▶│ 4. Inject │ │
│  │   + Summary  │    │    Schema    │    │    Codegen   │    │  Paths +  │ │
│  │ (adaptive)   │    │ (sampled,   │    │ (system +    │    │  Helpers  │ │
│  │              │    │  200 rows)  │    │  user prompt)│    │           │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └─────┬─────┘ │
│                                                                     │       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           │       │
│  │ 7. Register   │◀──│ 6. Read      │◀──│ 5. Execute   │◀──────────┘       │
│  │    Entities  │    │ results.json │    │    Python    │                   │
│  │ (saveData)   │    │ (manifest)   │    │ (PythonBridge│                   │
│  │              │    │              │    │  graceful    │                   │
│  └──────────────┘    └──────────────┘    │  shutdown)   │                   │
│                                          └──────┬───────┘                   │
│                                                  │                           │
│                                          ┌───────▼────────┐                  │
│                                          │ On failure:     │                  │
│                                          │ Classify error  │──▶ Back to      │
│                                          │ per RFC-005,    │   step 3        │
│                                          │ retry if        │   (if retryable)│
│                                          │ recoverable     │                  │
│                                          └────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Detailed Design

### 1. Tool Interface

The data analysis capability is exposed as a single AgentFoundry tool:

```typescript
defineTool({
  name: 'data-analyze',
  description: 'Analyze a dataset file using Python code execution. ' +
    'Supports statistics, visualization, data transformation, and modeling.',
  parameters: {
    filePath: {
      type: 'string',
      description: 'Relative path to the data file (CSV, JSON, TSV, log, txt)',
      required: true
    },
    taskType: {
      type: 'string',
      description: 'Type of analysis: analyze | visualize | transform | model',
      required: false  // defaults to 'analyze'
    },
    instructions: {
      type: 'string',
      description: 'What to do with the data',
      required: true
    }
  }
})
```

### 2. Task Types

Each task type provides specialized system prompt instructions to the code-generating LLM:

| Task Type | Purpose | Output Types | System Prompt Focus |
|-----------|---------|-------------|-------------------|
| `analyze` | Statistical analysis | CSV summary tables, stdout | Descriptive stats, correlations, outlier detection |
| `visualize` | Data visualization | PNG figures | matplotlib/seaborn plots, proper labels and legends |
| `transform` | Data cleaning/reshaping | CSV files | Handle missing values, type conversions, encoding |
| `model` | Statistical/ML modeling | CSV metrics, stdout | sklearn/statsmodels, performance metrics |

### 3. Schema Inference

Before calling the LLM, the system inspects the input file to provide data context:

```typescript
function inferDataSchema(filePath: string): {
  columns: ColumnSchemaDetailed[];
  rowCount: number;
}
```

**Sampled inference (updated):** Instead of inspecting only the first data row, the system samples up to **200 rows** (via `pandas.read_csv(nrows=200)` or a csv sniffer for non-pandas paths) to produce richer per-column statistics:

| Metric | Computed For | Description |
|--------|-------------|-------------|
| `dtype` | All columns | Inferred pandas dtype (int64, float64, object, datetime64, bool) |
| `missingRate` | All columns | Fraction of null/NaN values in the sample |
| `topKValues` | Categorical (object/bool) | Top 5 most frequent values with counts |
| `min` / `max` / `mean` | Numeric (int/float) | Basic descriptive stats from the sample |

**Strategy by file extension:**

| Extension | Strategy | Output |
|-----------|----------|--------|
| `.csv` | Parse header + sample 200 rows, compute per-column stats | Column names + dtypes + stats |
| `.tsv` | Same as CSV with tab delimiter | Column names + dtypes + stats |
| `.json` | Parse as array, sample up to 200 objects, extract keys and types | Key names + types + stats |
| `.log`, `.txt`, other | No schema inference — report as unstructured | Empty columns, line count only |

The distinction is important: for unstructured files, the user prompt tells the LLM "This is an unstructured text file (not CSV). Parse it line-by-line as needed." instead of providing a misleading schema.

### 4. Code Generation Prompts

The LLM receives a two-part prompt:

**System prompt** = Base analysis rules + Task-specific instructions

The base prompt includes **critical path rules** that enforce use of runtime-injected variables:

```
CRITICAL PATH RULES — you MUST follow these exactly:
- The runtime pre-defines these variables before your code runs:
    DATA_FILE  — absolute path to the input data file
    FIGURES_DIR — absolute path to save figures
    TABLES_DIR  — absolute path to save CSV tables
    DATA_DIR    — absolute path to save transformed data
- You MUST use DATA_FILE to read the input. Do NOT compute, derive, or hardcode any file path.
- Do NOT use os.path.dirname(__file__) or any path derivation logic.
- After generating all outputs, call write_results() with your output manifest (see template header).
```

**User prompt** contains:
- File name and row/line count
- Schema with per-column statistics (or "unstructured" notice)
- **Adaptive data summary** (see below)
- Explicit reminder of pre-defined variable names with usage examples
- User's analysis instructions
- Previous error context (on retry attempts)

#### Adaptive Data Summary (replaces raw preview)

Instead of injecting the first 50 raw lines of the data file, the system provides an **adaptive summary**:

**Structured files (CSV, TSV, JSON):**
- Column statistics (dtype, missing rate, top-k / min-max-mean)
- 5 randomly sampled rows (not the first 5, to avoid header-adjacent bias)
- Total row count

**Unstructured files (log, txt, other):**
- First 20 lines
- Extracted field patterns (e.g., detected delimiters, timestamp formats, key=value pairs)
- Line count and average line length

### 5. Code Assembly and Path Injection

The generated Python code is sandwiched between a **template header** and the LLM output:

```python
# Template header (always prepended)
import os
import json
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
import warnings
warnings.filterwarnings('ignore')

# ===== DO NOT MODIFY: Runtime-injected paths =====
DATA_FILE = r"/absolute/path/to/input.csv"
FIGURES_DIR = r"/absolute/path/to/outputs/figures"
TABLES_DIR = r"/absolute/path/to/outputs/tables"
DATA_DIR = r"/absolute/path/to/outputs/data"
RESULTS_FILE = r"/absolute/path/to/outputs/results_<runId>.json"
for _d in [FIGURES_DIR, TABLES_DIR, DATA_DIR]:
    os.makedirs(_d, exist_ok=True)
# ===== END runtime paths =====

# ===== Results protocol helper =====
def write_results(outputs, summary=None, warnings_list=None):
    """Write a structured results manifest. Call this at the end of your script.

    Args:
        outputs: list of dicts with keys: path, type, title, description, tags
        summary: optional dict with analysis summary
        warnings_list: optional list of warning strings
    """
    manifest = {
        "outputs": outputs,
        "summary": summary or {},
        "warnings": warnings_list or []
    }
    with open(RESULTS_FILE, 'w') as f:
        json.dump(manifest, f, indent=2, default=str)
# ===== END results protocol =====

# LLM-generated code follows...
```

**Design decision:** The header includes `os`, `json`, `pandas`, `numpy`, `matplotlib`, and `seaborn` imports so the LLM code can use them without re-importing. The `matplotlib.use('Agg')` ensures headless rendering (no display server needed). Output directories are created with `os.makedirs(exist_ok=True)` for robustness. The `write_results()` helper enables the explicit results protocol (see Section 8).

The `# ===== DO NOT MODIFY =====` marker serves as a visual boundary that helps prevent the LLM from overriding the injected paths (a failure mode observed in production — see Known Issues section).

#### Post-Execution Path Validation

After successful script execution, before collecting outputs, the system verifies that **all output files reside within the allowed directories** (`FIGURES_DIR`, `TABLES_DIR`, `DATA_DIR`). Any file written outside these directories is flagged as a security violation and excluded from entity registration.

```typescript
function validateOutputPath(filePath: string, allowedDirs: string[]): boolean {
  const resolved = path.resolve(filePath);
  return allowedDirs.some(dir => {
    const rel = path.relative(dir, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}
```

### 6. Python Execution via PythonBridge

Scripts are executed using the framework's `PythonBridge` in **script mode**:

```typescript
const bridge = new PythonBridge({
  script: scriptPath,     // Generated .py file
  mode: 'script',         // One-shot execution
  cwd: projectPath,       // Working directory = user's project folder
  env: { PYTHONDONTWRITEBYTECODE: '1' }
})
```

#### Graceful Timeout and Process Lifecycle

Instead of a raw `Promise.race` timeout, PythonBridge manages process lifecycle with a **graceful shutdown protocol**:

```
1. Start timer (default: 120 seconds)
2. On timeout:
   a. Send SIGTERM to the Python process
   b. Wait grace period (5 seconds) for cleanup
   c. If still alive: send SIGKILL
   d. Classify error as { category: 'timeout' } for the retry system
3. On normal exit:
   a. Exit code 0 → success
   b. Exit code != 0 → capture stderr, classify error
```

**Orphan process prevention is mandatory:** The bridge must register a handler on `process.on('exit')` and `process.on('SIGINT')` to kill any spawned child process. This prevents zombie Python processes accumulating during development or when the Node process crashes.

The `timeout` error category is fed into the retry system (see Section 7) as a potentially degradable error — the retry can attempt a simpler analysis strategy (e.g., sampling the data instead of processing all rows).

#### Dependency Pre-flight Check

Before the first analysis execution in a session, the system runs a **dependency pre-flight check**:

```bash
python3 -c "import pandas, numpy, matplotlib, seaborn"
```

If this fails, the system returns a structured error:

```typescript
{
  success: false,
  errorCategory: 'resource',  // Missing Python deps = unavailable resource
  details: {
    missing: ['pandas', 'seaborn'],  // parsed from ImportError
    installCommand: 'pip install pandas seaborn',
    hint: 'Run the install command above, or activate a virtual environment that has these packages.'
  }
}
```

This error is **not retried** — it requires user intervention.

**Future direction:** Per-project virtual environment management with a `python.lock.json` manifest for reproducible environments across machines.

### 7. Retry Logic (RFC-005 Integrated)

The pipeline supports up to 3 attempts with **error classification** based on RFC-005:

#### Error Classification

| Error Type | Category (RFC-005) | Retryable? | Strategy |
|------------|----------|------------|----------|
| `SyntaxError`, `NameError`, `TypeError` | `execution` | Yes | Pass error to LLM for self-repair |
| `KeyError`, `ValueError` on data columns | `execution` | Yes | Pass error + schema reminder to LLM |
| `ImportError` | `resource` | **No** | Return structured error to user (see Section 6) |
| `FileNotFoundError` on injected path vars | `unknown` | **No** | Log as internal error, do not retry |
| `FileNotFoundError` on LLM-derived path | `execution` | Yes | Pass error + path rule reminder to LLM |
| `MemoryError` | `resource` | **Degrade** | Retry with data sampling instruction |
| Timeout (120s) | `timeout` | **Degrade** | Retry with reduced scope (sample data, fewer plots) |

#### Retry Flow

```
Attempt 1: Generate code → Execute → Classify result
  If execution error       → Attempt 2 (with error context in prompt)
  If resource/timeout      → Attempt 2 (with degradation instructions)
  If resource (missing dep)→ Stop, return to user
  If unknown (internal)    → Stop, log error

Attempt 2: Same flow...
Attempt 3: Last attempt → on failure, return failure with full error history
```

On each retry for `execution` errors, the error from the previous attempt is appended to the user prompt:

```
PREVIOUS ATTEMPT FAILED with this error:
```
Traceback (most recent call last):
  File "...", line 42, in main
    df = pd.read_csv(DATA_FILE)
  ...
KeyError: 'duration_ms'
```
Fix the error and try a different approach if needed.
Available columns: timestamp, tool_name, duration, status
```

**Key change from original design:** Unrecoverable errors (`resource` for missing deps, `unknown` for internal bugs) are no longer retried, saving LLM calls and avoiding confusing retry loops for problems the LLM cannot fix. Error categories align with the RFC-005 `ErrorCategory` type.

### 8. Output Collection via Results Protocol

After successful execution, the system reads the **`results_<runId>.json` manifest** written by the script's `write_results()` call, rather than scanning output directories. Each run gets a unique manifest file (keyed by timestamp or UUID) to prevent race conditions when multiple analyses run concurrently.

#### Results Manifest Schema

```json
{
  "outputs": [
    {
      "path": "/abs/path/to/outputs/figures/correlation_matrix.png",
      "type": "figure",
      "title": "Correlation Matrix",
      "description": "Pearson correlation heatmap of all numeric columns",
      "tags": ["correlation", "heatmap"]
    },
    {
      "path": "/abs/path/to/outputs/tables/summary_stats.csv",
      "type": "table",
      "title": "Summary Statistics",
      "description": "Descriptive statistics for all numeric columns",
      "tags": ["statistics", "summary"]
    }
  ],
  "summary": {
    "rowsProcessed": 1500,
    "columnsAnalyzed": 12,
    "keyFindings": "Strong positive correlation (r=0.87) between duration and memory_usage"
  },
  "warnings": [
    "Column 'status' has 15% missing values — rows dropped for correlation analysis"
  ]
}
```

#### Entity Registration

Each entry in `outputs` is registered as a `DataAttachment` entity, using metadata from the manifest:

```typescript
for (const output of manifest.outputs) {
  if (!validateOutputPath(output.path, allowedDirs)) {
    console.warn(`Skipping out-of-bounds output: ${output.path}`);
    continue;
  }

  saveData(output.title || path.basename(output.path), {
    filePath: output.path,
    mimeType: mimeMap[path.extname(output.path)] || 'application/octet-stream',
    tags: [...(output.tags || []), taskType, 'auto-generated'],
    description: output.description
  }, cliContext);
}
```

**Fallback:** If `results.json` is missing (e.g., the LLM forgot to call `write_results()`), the system falls back to directory scanning but logs a warning. On retry, the error prompt reminds the LLM to call `write_results()`.

This replaces the previous directory-scan approach and resolves the output accumulation problem (formerly Known Issue 3).

### 9. UI Progress Tracking and Streaming Stdout

The tool wrapper emits synthetic `todo-update` events to show real-time progress:

```typescript
const DATA_STEPS = {
  preflight: 'Checking Python dependencies',
  codegen: 'Generating analysis code',
  execute: 'Running Python script',
  collect: 'Collecting results'
}
```

The IPC layer in the Electron desktop app intercepts these events and displays them as a checklist in the right panel:

```
☐ Checking Python dependencies      → ⏳ → ✓
☐ Generating analysis code           → ⏳ → ✓
☐ Running Python script              → ⏳ → ✓ (or ✗ on failure)
☐ Collecting results                 → ⏳ → ✓ (or ✗ on failure)
```

#### Streaming Stdout

During script execution, PythonBridge streams stdout and stderr line-by-line to the UI in real time via IPC events. This provides immediate visibility into long-running analyses instead of waiting for the full 120-second timeout before showing any output.

```typescript
// PythonBridge emits 'stdout' and 'stderr' events as lines arrive
bridge.on('stdout', (line: string) => {
  emit('data-stdout', { line, stream: 'stdout' });
});
bridge.on('stderr', (line: string) => {
  emit('data-stdout', { line, stream: 'stderr' });
});
```

The Electron UI renders these lines in a collapsible console panel below the progress checklist, auto-scrolling to the latest output. This is especially useful for scripts that log progress (e.g., `print(f"Processing row {i}/{total}")`).

### 10. Coordinator Integration

The coordinator agent's system prompt includes **hard rules** that gate data analysis requests:

```
Data Analysis Rules (HARD):
- ALWAYS use data-analyze for ANY data analysis, visualization, statistics
- NEVER read raw data files (CSV, JSON, TSV, log) directly with read/glob/grep
- data-analyze executes Python code → plots, stats, transforms, models
```

The intent classification table maps user requests to the correct tool:

| User Intent | Required Tool |
|-------------|--------------|
| "Analyze this data" | `data-analyze` |
| "Visualize" / "plot" | `data-analyze` (taskType: visualize) |
| Statistics / data exploration | `data-analyze` |

## File System Layout

### Project Directory Structure

```
<project-root>/
├── .research-pilot/
│   ├── data/                     # Entity metadata (JSON files)
│   │   ├── <uuid>.json           # User-uploaded data entity
│   │   ├── <uuid>.json           # Auto-generated output entity
│   │   └── plots/                # Optional user-created plot directory
│   ├── outputs/                  # Generated analysis outputs
│   │   ├── figures/              # PNG plots
│   │   ├── tables/               # CSV summary tables
│   │   ├── data/                 # Transformed datasets
│   │   └── results_<runId>.json   # Output manifest (one per run, no overwrites)
│   ├── analysis/
│   │   └── scripts/              # Generated Python scripts (for debugging)
│   │       ├── analysis_<timestamp>.py
│   │       └── ...
│   ├── notes/                    # Research notes
│   ├── literature/               # Paper references
│   ├── sessions/                 # Chat history
│   └── project.json              # Project configuration
└── <user data files>             # CSV, JSON, log files, etc.
```

### Source Code Structure

```
examples/research-pilot/
├── agents/
│   ├── data-team.ts              # Core: LLM codegen + Python execution pipeline
│   ├── subagent-tools.ts         # Tool wrapper with progress tracking
│   └── coordinator.ts            # Main chat agent integration
├── commands/
│   ├── save-data.ts              # Entity registration for data files
│   └── list.ts                   # Entity listing
├── tools/
│   └── entity-tools.ts           # Save/update tools for notes and papers
└── types.ts                      # DataAttachment, DataSchema, Provenance types

src/python/
├── bridge.ts                     # PythonBridge (script + service modes)
└── define-python-tool.ts         # Helper factory for Python tools
```

## Type Definitions

### Core Types

```typescript
// Analysis input from the coordinator agent
interface AnalyzeInput {
  filePath: string
  taskType?: 'analyze' | 'visualize' | 'transform' | 'model'
  instructions: string
}

// Analysis result returned to the coordinator
interface AnalyzeResult {
  success: boolean
  stdout?: string                   // Python script stdout
  stderr?: string                   // Python script stderr (on failure)
  outputs: OutputFile[]             // Collected output files
  manifest?: ResultsManifest        // Parsed results.json
  code?: string                     // Generated Python code (for debugging)
  attempts: number                  // Number of attempts used
  error?: string                    // Error message (on failure)
  errorCategory?: ErrorCategory     // Classified error type
}

// Results manifest written by the script
interface ResultsManifest {
  outputs: Array<{
    path: string
    type: 'figure' | 'table' | 'data'
    title: string
    description?: string
    tags?: string[]
  }>
  summary: Record<string, unknown>
  warnings: string[]
}

// Error categories — reuses RFC-005 ErrorCategory (src/core/errors.ts)
// Relevant categories for data analysis:
//   'execution'   — Retryable: Python syntax, name, type, key errors
//   'resource'    — Not retryable (missing deps) or degradable (MemoryError)
//   'timeout'     — Degradable: execution exceeded time limit
//   'unknown'     — Not retryable: internal/framework errors
type ErrorCategory = import('../../../src/core/errors.js').ErrorCategory

// A single output file produced by the analysis
interface OutputFile {
  path: string                      // Absolute path on disk
  name: string                      // Filename (e.g., "correlation_matrix.png")
  category: 'figures' | 'tables' | 'data'
  title?: string                    // From results manifest
  description?: string              // From results manifest
}

// Column metadata inferred from the data file (updated)
interface ColumnSchemaDetailed {
  name: string
  dtype: string                     // pandas dtype: 'int64' | 'float64' | 'object' | 'datetime64' | 'bool'
  missingRate: number               // 0.0 - 1.0
  topKValues?: Array<{ value: string; count: number }>  // For categorical columns
  min?: number                      // For numeric columns
  max?: number                      // For numeric columns
  mean?: number                     // For numeric columns
}

// Data context passed to the LLM for code generation (updated)
interface DataContext {
  summary: string                   // Adaptive summary (not raw preview)
  schema: ColumnSchemaDetailed[]    // Rich per-column stats (empty for unstructured)
  fileName: string                  // Base filename
  rowCount: number                  // Number of rows/lines
  isStructured: boolean             // true for csv/tsv/json
}
```

### Entity Types

```typescript
// Persisted data entity (stored as JSON in .research-pilot/data/)
interface DataAttachment extends ResearchEntity {
  type: 'data'
  name: string                      // Display name
  filePath: string                  // Absolute path to the actual data file
  mimeType?: string                 // MIME type (image/png, text/csv, etc.)
  schema?: DataSchema               // Optional column metadata
}

interface DataSchema {
  columns?: Array<{
    name: string
    type: string
    description?: string
  }>
  rowCount?: number
  description?: string
}

// Provenance tracking
interface Provenance {
  source: 'user' | 'agent' | 'import'
  sessionId: string
  agentId?: string
  extractedFrom?: 'agent-response' | 'user-input' | 'file-import'
  messageId?: string
}
```

### PythonBridge Types

```typescript
interface PythonBridgeConfig {
  script: string                    // Python script path
  mode?: 'script' | 'service'      // Execution mode
  port?: number                     // Service port (service mode only)
  python?: string                   // Python interpreter (default: 'python3')
  cwd?: string                      // Working directory
  env?: Record<string, string>      // Extra environment variables
  startupTimeout?: number           // Startup timeout in ms (default: 30000)
  executionTimeout?: number         // Script execution timeout in ms (default: 120000)
  gracePeriod?: number              // SIGTERM → SIGKILL grace period in ms (default: 5000)
}

interface CallResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorCategory?: ErrorCategory     // Classified error type
}
```

## Data Flow Walkthrough

**User says:** "Plot the distribution of tool call durations from tool_calls.log"

### Step 1: Coordinator Intent Classification
The coordinator agent matches "plot" + "distribution" to Tier 1 (direct operation) with the data-analyze intent gate. It calls:

```
data-analyze({
  filePath: ".research-pilot/data/tool_calls.log",
  taskType: "visualize",
  instructions: "Plot the distribution of tool call durations as a histogram"
})
```

### Step 2: Tool Wrapper (subagent-tools.ts)
- Creates `DataAnalyzer` instance if not already created
- Runs dependency pre-flight check (first call only)
- Emits todo events: `data-preflight: done`, `data-codegen: pending`, `data-execute: pending`, `data-collect: pending`
- Emits `data-codegen: in_progress`
- Calls `dataAnalyzer.analyze(input)`

### Step 3: File Path Resolution (data-team.ts)
```typescript
const absPath = resolve(projectPath, ".research-pilot/data/tool_calls.log")
// → "/Users/user/project/.research-pilot/data/tool_calls.log"
```

### Step 4: Data Inspection
- `inferDataSchema(absPath)` → Extension is `.log`, so returns `{ columns: [], rowCount: 342, isStructured: false }`
- `buildAdaptiveSummary(absPath, schema)` → First 20 lines + detected patterns (e.g., "timestamp tool_name duration_ms status" fields) + line stats

### Step 5: LLM Code Generation
The LLM receives:
- **System prompt:** Base rules (CRITICAL PATH RULES + `write_results()` requirement) + Visualization task instructions
- **User prompt:** "Data file: tool_calls.log (342 lines)\nThis is an unstructured text file...\n[adaptive summary]\n...\nInstructions: Plot the distribution of tool call durations as a histogram"

The LLM generates Python code that:
1. Reads `DATA_FILE` line-by-line
2. Parses duration values from each line using regex
3. Creates a matplotlib histogram
4. Saves to `os.path.join(FIGURES_DIR, "duration_distribution.png")`
5. Calls `write_results([{...}], summary={...})`

### Step 6: Code Assembly
The template header + `write_results()` helper + runtime path injection + LLM code are concatenated and written to:
```
.research-pilot/analysis/scripts/analysis_1769747098513.py
```

### Step 7: Python Execution
PythonBridge spawns `python3 analysis_1769747098513.py run {}` with:
- cwd = project path
- 120-second timeout with SIGTERM → 5s grace → SIGKILL
- stdout/stderr captured
- Orphan process cleanup registered

### Step 8: Output Collection
On success, the system reads `results.json`:
```json
{
  "outputs": [{
    "path": "/abs/path/to/outputs/figures/duration_distribution.png",
    "type": "figure",
    "title": "Duration Distribution",
    "description": "Histogram of tool call durations (ms)",
    "tags": ["histogram", "duration"]
  }],
  "summary": { "mean": "245ms", "median": "180ms", "max": "3200ms" },
  "warnings": []
}
```

Each output path is validated against allowed directories before registration.

### Step 9: Entity Registration
```typescript
saveData("Duration Distribution", {
  filePath: "/abs/path/to/outputs/figures/duration_distribution.png",
  mimeType: "image/png",
  tags: ["histogram", "duration", "visualize", "auto-generated"],
  description: "Histogram of tool call durations (ms)"
}, { sessionId, projectPath })
```

Creates `.research-pilot/data/<uuid>.json` → visible in the UI's Data tab.

### Step 10: Result Return
The tool returns:
```json
{
  "success": true,
  "data": {
    "stdout": "Duration distribution: mean=245ms, median=180ms, max=3200ms",
    "outputs": [{ "name": "duration_distribution.png", "category": "figures", "path": "...", "title": "Duration Distribution" }],
    "manifest": { "summary": { "mean": "245ms", "median": "180ms", "max": "3200ms" }, "warnings": [] },
    "attempts": 1
  }
}
```

The coordinator synthesizes this into a user-facing response.

## Known Issues and Mitigations

### Issue 1: LLM Ignores Injected Path Variables

**Problem:** The LLM-generated code sometimes derives its own paths using `os.path.dirname(__file__)` or hardcodes paths, ignoring the pre-defined `DATA_FILE` variable. This causes `FileNotFoundError` because the derived path is wrong.

**Root cause:** The LLM was not strongly prompted to use the runtime-injected variables. The original prompt said "Read the data file using its full path" without specifying which variable contained that path.

**Mitigation (implemented):**
1. Added `CRITICAL PATH RULES` to the system prompt that explicitly name each variable and forbid path derivation
2. Added usage examples in the user prompt: `pd.read_csv(DATA_FILE)`
3. Added `# ===== DO NOT MODIFY: Runtime-injected paths =====` comment block in the generated script
4. The template header now includes `import os` and `import json` so the LLM doesn't need to re-import (which often led to re-defining path variables)

### Issue 2: Schema Inference Fails on Non-Tabular Files

**Problem:** `.log` and `.txt` files were treated as CSV, producing garbage column names that misled the LLM about the data format.

**Mitigation (implemented):** Schema inference now only attempts CSV/TSV parsing for `.csv`/`.tsv` extensions. All other extensions return empty schema with an "unstructured text file" notice in the prompt.

### ~~Issue 3: Output Directory Accumulation~~ (Resolved)

**Problem:** `collectOutputs()` returned ALL files in the output directories, including outputs from previous analysis runs.

**Resolution:** Replaced directory scanning with the explicit `results.json` manifest protocol. Scripts now declare their outputs via `write_results()`, and only declared outputs are registered as entities. See Section 8.

### Issue 4: Python Dependency Management (Improved)

**Problem:** The system assumes `python3`, `pandas`, `numpy`, `matplotlib`, and `seaborn` are available in the user's environment.

**Mitigation (implemented):** Pre-flight dependency check runs `python3 -c "import pandas, numpy, matplotlib, seaborn"` before first execution. On failure, returns a structured error with `errorCategory: 'resource'` and install instructions. This error is classified as non-retryable. See Section 6.

### Issue 5: Large File Handling

**Problem:** `readDataPreview()` reads the entire file into memory to extract preview lines. For very large files (GB+), this is wasteful.

**Status:** Partially mitigated. The adaptive summary approach uses `pandas.read_csv(nrows=200)` for structured files (which streams and doesn't load the full file). For unstructured files, a streaming readline approach for the first 20 lines is planned.

## Security Considerations

### 1. Arbitrary Code Execution

The LLM-generated Python code runs with the user's full permissions. This is acceptable for an internal research desktop application where users trust the system. Proper sandboxing would be needed for multi-tenant deployments.

### 2. Path Containment

**Mitigations:**
- The `filePath` parameter is resolved relative to `projectPath`
- Post-execution validation uses `path.relative()` to verify all output files reside within allowed directories
- Paths containing `..` traversal are rejected:

```typescript
function assertContained(filePath: string, baseDir: string): void {
  const resolved = path.resolve(baseDir, filePath);
  const rel = path.relative(baseDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path traversal rejected: ${filePath}`);
  }
}
```

### 3. Network Control

Generated Python code has **unrestricted network access by default**. For sensitive datasets:

- **Default-off toggle:** Add an `allowNetwork` flag to the tool parameters (default: `false`). When disabled, the script is executed with network restrictions.
- **Enforcement options** (environment-dependent):
  - macOS: `sandbox-exec` with a deny-network profile
  - Linux: `firejail --net=none` or `unshare --net`
  - Cross-platform: Docker container with `--network=none`
- **Current status:** Not yet implemented. Listed as a future improvement with high priority for deployments handling sensitive data.

### 4. Write Restriction

- Outputs are only permitted in `FIGURES_DIR`, `TABLES_DIR`, and `DATA_DIR`
- Post-execution audit checks for any files written outside allowed directories

## Future Improvements

### High Priority

1. **Interactive refinement** — Allow the user to say "make the bars blue" and have the agent modify the existing script rather than regenerating from scratch
2. **Streaming preview for large files** — Use readline-based preview for unstructured files instead of reading the entire file

### Medium Priority

3. **Network sandboxing** — Implement default-off network access with `sandbox-exec` / `firejail` / Docker (for sensitive data deployments)
4. **Execution environment management** — Auto-create a virtual environment with pinned package versions per project (`python.lock.json`)
5. **Multi-file analysis** — Support joining/correlating multiple data files in a single analysis

### Long-Term

7. **Incremental analysis** — Cache intermediate results (DataFrames) so follow-up analyses don't re-parse the data
8. **Service mode** — Use PythonBridge's service mode to keep a warm Python process for faster turnaround on repeated analyses
9. **Notebook export** — Generate Jupyter notebooks alongside scripts so users can continue analysis interactively

## References

- Implementation: `examples/research-pilot/agents/data-team.ts`
- Tool wrapper: `examples/research-pilot/agents/subagent-tools.ts`
- Coordinator integration: `examples/research-pilot/agents/coordinator.ts`
- PythonBridge: `src/python/bridge.ts`
- Entity types: `examples/research-pilot/types.ts`
- Entity registration: `examples/research-pilot/commands/save-data.ts`
- RFC-001: Contract-First Team System (related: structured I/O patterns)
- RFC-005: Error Feedback and Retry (related: retry strategy, error classification)

---

## Changelog

### Rev 3 — Simplification and Streaming

Decisions from internal review:

1. **Removed AST safety check** — Unnecessary for an internal project; the overhead and incomplete coverage do not justify the complexity (Sections 5, 7, walkthrough)
2. **Removed PII scrubbing** — Not needed for internal use; raw data summaries are passed directly to the LLM (Section 4)
3. **Added streaming stdout** — PythonBridge streams stdout/stderr line-by-line to the UI in real time, giving immediate visibility into long-running scripts (Section 9)
4. **Run-specific results manifest** — Changed `results.json` to `results_<runId>.json` to prevent race conditions when multiple analyses run concurrently (Sections 5, File System Layout)
5. **Reprioritized future improvements** — Streaming stdout moved to implemented; network sandboxing demoted to medium priority

### Rev 2 — Reviewer Feedback Integration

Incorporated feedback covering 8 categories. Changes are listed in the reviewer's recommended priority order:

1. **Output collection protocol** — Replaced directory scanning with explicit `results.json` manifest written by `write_results()` helper (Section 5, 8)
2. **Path injection hardening** — Added post-execution path validation (Section 5)
3. **Retry strategy refinement** — Integrated RFC-005 error classification; stop retrying unrecoverable errors (`resource` for missing deps, `unknown` for internal bugs); degrade on resource/timeout errors (Section 7)
4. **Timeout & process lifecycle** — Replaced `Promise.race` with SIGTERM → grace → SIGKILL protocol; mandatory orphan process prevention (Section 6)
5. **Schema inference improvement** — Sampled 200-row inference with per-column dtype, missing rate, top-k, and numeric stats (Section 3)
6. **Preview efficiency** — Adaptive summary replaces raw 50-line preview (Section 4)
7. **Dependency management** — Pre-flight check with structured `resource` error and install instructions (Section 6)
8. **Security boundaries** — Path containment with `path.relative()`, network control design (default-off toggle), write restriction with post-run audit (Security Considerations)
