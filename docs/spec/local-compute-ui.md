# Local Compute UI Design

> Design spec for the Compute tab — execution workspace, environment display, run management, and guidance system.

## 1. Design Philosophy

### The Compute Tab is an Execution Workspace

The three tabs represent three distinct working modes:
- **Chat** = conversation workspace (thinking)
- **Literature** = reading/search workspace (finding)
- **Compute** = execution workspace (doing)

The Compute tab is where users **understand their machine, see what's running, review what happened, and learn how to use compute effectively**. It is not a task list — it's an execution theater with a control panel.

### Information Hierarchy (what users need, in order)

1. **Is anything running right now?** (most urgent — live status)
2. **Did something fail or finish?** (actionable — needs response)
3. **What can my machine do?** (context — informs decisions)
4. **What happened before?** (history — pattern recognition)
5. **What should I try next?** (guidance — reduces friction)

### Future-Proofing: Compute Targets

The UI should treat "where code runs" as a first-class concept from day one. Currently there's one target: **Local Machine**. The information architecture must accommodate future targets (Lab GPU server, cloud instance) without restructuring. This means:

- Environment display is **target-scoped**
- Run cards carry a **target badge**
- The sidebar has a **target selector** (shows only "Local" for now, but the slot exists)
- History can be **filtered by target**

This costs almost nothing now but prevents a painful refactor later.

---

## 2. Layout Overview

Following the Literature tab pattern: **dedicated left sidebar + center panel**.

```
┌────���────────────────────┬────────────��───────────────────────────────────┐
│    COMPUTE SIDEBAR      │    COMPUTE CENTER PANEL                        │
│    (w-80, left)         │    (flex-1)                                    │
│                         │                                                │
│  ┌───────────────────┐  │  ViewSwitcher: [Chat] [Literature] [Compute]   │
│  │ Target Card       │  │                                                │
│  │ ● Local Machine   │  │  ┌── Active Runs ──────────────────────────┐   │
│  │   M2 Pro · 16GB   │  │  │  RunCard (live progress, output, stop) │   │
│  │   MLX · Py 3.11   │  │  │  RunCard (live progress, output, stop) │   │
│  │   ░░░░ 6GB free   │  │  └───────────────────��────────────────────┘   │
│  └───────────────────┘  │                                                │
│                         │  ┌── Recovery Banner (if applicable) ───────┐   │
│  ── Quick Actions ──    │  │  "1 run recovered from previous session" │   │
│  [ Run a script     ]   │  └─────────────────────────────────────────┘   │
│  [ Analyze data     ]   │                                                │
│  [ Fix failed run   ]   │  ┌── Run History ──────────────────────────┐   │
│                         │  │  FilterBar (search, status filter)       │   │
│  ── Run Stats ──        │  │  HistoryRow (compact, expandable)       │   │
│  15 runs · 87% pass     │  │  HistoryRow                             │   │
��  Avg: 8min · 3 retries  │  │  HistoryRow                             │   │
│                         │  └─────���──────────────────────────────────┘   │
│  ── Experience ─���       │                                                │
│  pytorch: 85%, ~42m     │  ┌── Environment Detail (collapsible) ─────┐   │
│  pandas: 100%, ~2m      │  │  Full hardware/software breakdown       │   ��
│                         │  └─────���──────────────────────────────────┘   │
└──────���──────────────────┴──────────────��────────────────────────────���────┘
```

When `centerView === 'compute'`, the LeftSidebar renders `<ComputeSidebar />` instead of `<EntityTabs />` (same pattern as Literature).

---

## 3. Left Sidebar: ComputeSidebar

### 3.1 Target Card (always at top, never scrolls)

The most persistent element. Tells the user "this is the machine your code runs on."

```
┌─────────────────────────┐
���  ● Local Machine         │  ← green dot = healthy, amber = degraded, red = unavailable
│                          │
│  Apple M2 Pro · 16 GB    │  ← hardware summary
│  Python 3.11 · MLX ✓     │  ← software summary
│  Docker ✓                │  ← optional, only if detected
│                          │
│  Memory  ░░░░░░░░░░ 62%  │  ← live resource bar (freeMemoryMb)
│  Disk    ░░░░░░░░   45%  │  ← live resource bar (freeDiskMb)
│                          │
│  Ready · 0 running       │  ← status summary
└────��────────────────────┘
```

**Status dot colors**:
- Green: Ready, no issues
- Amber: Resource pressure (memory < 2GB or disk < 2GB), or a run is stalled
- Red: Cannot accept runs (memory < 500MB, disk < 500MB)

**Why this matters**: The user glances at the sidebar and instantly knows: "My machine is healthy, has MLX, has Docker, and has enough memory." This informs what they ask the agent to do. On a 8GB MacBook Air with no MLX, they see different guidance than on a 64GB workstation with CUDA.

**Future target extension**: This card becomes a list of targets. The active target has a checkbox or radio indicator. Clicking a different target updates the center panel to show that target's runs and environment.

```
┌─────────────────────────┐
│  ✓ Local Machine         │  ← selected
│    M2 Pro · 16GB · MLX   │
├─────────────────────────┤
│  ��� Lab A100 Server       │  ← future
│    A100 · 80GB · CUDA    │
├─────────────────────────┤
│  + Add compute target    │  ← future
└───────────────��─────────┘
```

### 3.2 Quick Actions

Same pattern as LiteratureSidebar: icon + title + description. Click → switch to Chat tab + prefill input.

```
── Quick Actions ─────────

[▶] Run a Script
    Execute Python or shell in sandbox

[📊] Analyze Dataset
    Data analysis with progress tracking

[🔧] Fix & Retry Last Failure
    Review error, fix code, re-run

[📋] Check Run Status
    Get progress on active runs
```

**"Fix & Retry Last Failure"** is context-sensitive:
- If there's a recent failed run: enabled, prefills chat with "The last compute run (cr-xxx) failed with [error]. Please review the stderr output and fix the code."
- If no recent failure: disabled/hidden.

**Action → Chat bridge**: Exact same mechanism as Literature's QuickAction:
```typescript
setCenterView('chat')
setTimeout(() => {
  const input = document.querySelector('[data-chat-input]')
  input.value = prefillText
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
}, 100)
```

### 3.3 Run Statistics

Compact stats derived from ExperienceStore:

```
── Statistics ────────────

Total runs      15
Success rate    87%  ████████░░
Avg duration    8m 32s
Total retries   3
Last run        2 hours ago
```

When no runs: show "No runs yet. Use Quick Actions to start."

### 3.4 Experience Insights (v1.2+)

Per-taskKind summaries from `ExperienceStore.summarize()`:

```
���─ Experience ────────────

pytorch-training
  5 runs · 80% success · avg 42 min
  Common issue: OOM (reduce batch)

pandas-etl
  8 runs · 100% success · avg 2 min

matplotlib-viz
  2 runs · 100% success · avg 15 sec
```

This section helps users develop intuition: "training takes ~40 minutes on my machine" or "ETL scripts always work, but training sometimes OOMs."

When no experience: hidden entirely (not empty state — just omit the section).

---

## 4. Center Panel: ComputeView

### 4.1 State Hierarchy

The center panel has **four distinct states**, displayed in priority order:

```
State 1: Active Runs Exist → Show live run cards prominently
State 2: Recovery Happened → Show recovery banner
State 3: History Exists    → Show run history table
State 4: No History        → Show welcome/empty state
```

Multiple states can coexist (active runs + history below).

### 4.2 Active Runs Section

Only shown when there are running or stalled runs. This is the **primary visual** when active.

```
─�� Active Runs (2) ───────────────────────────────────────────

┌───────────────────────────────────���──────────────────────┐
│  cr-a1b2c3d4                              ● Running      │
│  python3 train_rf.py                      Phase: full    │
│                                                          │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  42%  Epoch 3/10          │
│                                                          │
│  loss 0.8534    accuracy 0.9215    lr 0.001              ���
│                                                          │
│  Elapsed: 5m 42s · ETA: ~8 min · 2.3 MB output          │
│                                                          │
│  ▸ Live Output                                  [Stop]   │
│    Epoch 3/10 - loss: 0.8534 - accuracy: 0.9215         │
│    Validating fold 3/5...                                │
└──────���───────────────────────────��───────────────────────┘

┌──────────────────────────────���───────────────────────────┐
│  cr-e5f6g7h8                   ⚠ Stalled (3 min idle)   │
│  python3 preprocess.py                    Phase: full    │
│                                                          │
│  No progress detected · 15.4 MB output                   │
│                                                          │
│  Elapsed: 12m 15s · Timeout: 60 min                      │
│                                                          │
│  ▸ Last Output                       [Stop] [Ask Agent]  │
│    Processing chunk 847/2000...                           │
│    (no output for 3 minutes)                              │
└──────────��────────────────────────────────��──────────────┘
```

**Design details for active run cards**:

- **Status indicator**: Animated pulse for running (CSS `animate-pulse`), amber static for stalled
- **Progress bar**: Only if percentage available. Smooth CSS transition. Blue fill.
- **Metrics row**: Pill-shaped badges for each metric (loss, accuracy, etc.). Monospace values.
- **Live output**: Collapsed by default. Click to expand. Shows last 20 lines. Auto-scrolls to bottom. Monospace font. Dark background (terminal-like).
- **Stop button**: Always visible for active runs. Red on hover. Confirms before killing.
- **"Ask Agent" button**: Only on stalled runs. Switches to chat with prefilled: "Compute run cr-xxx appears stalled. Please check the output and decide whether to wait or stop it."
- **Elapsed + ETA**: Elapsed ticks every second (client-side timer, not dependent on IPC). ETA from StructuredProgress.

**Stalled run special treatment**:
- Amber border instead of default
- "Stalled (N min idle)" badge
- Additional "Ask Agent" action button
- Stall explanation: "(no output for N minutes)"

### 4.3 Recovery Banner

Shown after app restart when `reconcileStaleRuns()` transitioned stale records:

```
┌──────────────────────────────────────────────────────────┐
│  ℹ 1 compute run from a previous session was recovered   │
│    as failed. The process is no longer running.           │
│                                                  [Dismiss]│
└───��──────────────────────────────────────────────────────┘
```

- Blue info background (not red — it's informational, not an error)
- Dismissable (click X, disappears for this session)
- If a run was genuinely still alive (PID confirmed), show differently:
  ```
  ℹ 1 compute run from a previous session is still active. Monitoring resumed.
  ```

### 4.4 Run History Section

Shows completed/failed/cancelled/timed_out runs. Filterable.

```
── Run History ──────────────────────────────────────────────

┌─ Filter ─────────────────────────────────────────────────┐
│  [🔍 Search runs...]          [All ▾] [Any status ▾]    │
└─────────────────────────────────────��────────────────────┘

┌──────────────────────────────────────���───────────────────┐
│  ✓  cr-i9j0k1l2  python3 plot.py           45s    2m ago│
│                                                          │
│  ✗  cr-m3n4o5p6  python3 preprocess.py    12m   15m ago │
│     OOM_KILLED · Retried → cr-a1b2c3d4                  ���
│                                                          │
│  ✓  cr-q7r8s9t0  python3 analyze.py       3m    1h ago  │
│                                                          │
│  ⏱  cr-u1v2w3x4  python3 train_big.py    60m    3h ago │
│     TIMEOUT · Suggested: increase timeout                │
│                                                          │
│  ◼  cr-y5z6a7b8  python3 download.py      --    5h ago  │
│     Cancelled by user                                    │
└───────────────────────────────��──────────────────────────┘
```

**Row structure** (compact, expandable on click):

- **Status icon**: ✓ green (completed), ✗ red (failed), ⏱ orange (timed_out), ◼ gray (cancelled)
- **Run ID**: Monospace, muted color
- **Command**: Truncated, primary text
- **Duration**: Right-aligned
- **Time ago**: Right-aligned, muted
- **Failure line** (only for failed/timed_out): Error code + retry lineage link
- **Click to expand**: Shows full stderr tail, failure suggestions, output preview, retry button

**Filters**:
- Text search (command, run ID)
- Status dropdown (All, Completed, Failed, Timed Out, Cancelled)
- Target dropdown (Local — future: other targets)

**Expanded history row**:

```
┌──────────────────────────────────────────────────────────┐
│  ✗  cr-m3n4o5p6  python3 preprocess.py    12m   15m ago │
│                                                          │
│  Error: OOM_KILLED                                       │
│  Process was killed due to insufficient memory.          │
│                                                          │
│  Suggestions:                                            │
│  • Reduce the dataset size or batch size                 │
│  • Close other memory-intensive applications             │
│  • Process large data in chunks if possible              │
│                                                          │
│  ▸ Stderr Output (last 4KB)                              │
│                                                          │
│  Retried as: cr-a1b2c3d4 (success)                       │
│                                                          │
│  [Fix & Retry in Chat]                                   │
└─────────────��────────────────────────────────────────────┘
```

### 4.5 Empty State (No Runs Ever)

This is the user's first encounter. It must be **welcoming, informative, and action-oriented**.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                    [CPU icon, 48px]                       │
│                                                          │
│            Your compute environment is ready              │
│                                                          │
│     ┌──────────────────────────────────────────┐         │
│     │  Apple M2 Pro · 16 GB unified memory     │         │
│     │  Python 3.11 · MLX ✓ · Docker ✓          │         │
│     │  6.2 GB free memory · 45 GB free disk    │         │
��     └─────────────────────────────────────���────┘         │
│                                                          │
│     Ask the agent to run code, and it will execute       │
│     in a sandboxed environment with progress tracking,   │
│     stall detection, and automatic failure analysis.     │
│                                                          │
│     Try asking:                                          │
│     ┌──────────────────────────────────────────┐         │
│     │ "Train a random forest on patient_data"  │  [→]    │
│     │ "Run my analysis.py script"              │  [→]    │
│     │ "Process and clean the survey dataset"   │  [→]    │
│     └──���───────────────────────────���───────────┘         │
│                                                          │
│     Tip: Add ##PROGRESS## lines in your scripts          │
│     for structured progress tracking.                    │
│                                                          │
└──────────��─────────────────────────────────��─────────────┘
```

**Design details**:
- Centered vertically in the available space
- Environment card uses `t-bg-elevated` background, rounded corners
- Example prompts are clickable → switch to chat + prefill
- Tip text in `t-text-muted` with small font
- Icon uses muted opacity (like Literature's empty BookOpen icon)

### 4.6 Environment Detail Panel (Collapsible)

Below history (or in empty state), a collapsible panel showing full system profile:

```
▸ Environment Details

▾ Environment Details
  ┌──────────────────────────────────────────────────────┐
  │  Hardware                                             │
  │  CPU      Apple M2 Pro · 10 cores · arm64            │
  │  Memory   16,384 MB total · 6,200 MB free (38%)     │
  │  Disk     245 GB total · 45 GB free (18%)            │
  │  GPU      Apple M2 Pro (16,384 MB unified)           │
  │           Metal: ✓  MLX: ✓ (v0.21)                  │
  │           Packages: mlx, mlx-nn, mlx-data, mlx-lm   │
  │                                                      │
  │  Software                                             │
  │  Python   3.11.6                                     │
  │  pip      23.3.1 (247 packages installed)            │
  │  Docker   ✓ Available (Docker Desktop 4.28)          │
  │                                                      │
  │  Sandbox                                              │
  │  Active   Process (Docker also available)            │
  │  Limits   Max 1 heavy run · 3 total concurrent       │
  │  Output   1 GB cap per run                           │
  │  Timeout  Default 60 min · Max 24 hours              │
  └──────────────────────────────────────────────────────┘
```

---

## 5. State Transitions and Navigation

### 5.1 Chat → Compute (Automatic)

When the agent calls `local_compute_execute` during a chat, the Compute tab badge updates with the active run count. The user can:
- Stay in chat and ask for status updates (agent calls `local_compute_status`)
- Click the Compute tab to see live progress visually
- Continue chatting about other things while compute runs in background

**Key UX principle**: Never force-switch the user to Compute. Let them choose. The badge is the notification.

### 5.2 Compute → Chat (User-initiated)

Triggered by:
- **Quick Action buttons** in sidebar → prefill chat input
- **"Ask Agent" button** on stalled runs → prefill with context
- **"Fix & Retry" button** on failed runs → prefill with error context
- **Example prompts** in empty state → prefill
- **Keyboard shortcut** Cmd+1 → switch to Chat

The prefill pattern always follows:
```typescript
const prefill = `The compute run ${runId} ${context}. Please ${action}.`
setCenterView('chat')
// ... set input value after 100ms
```

### 5.3 Failure → Fix → Retry Flow

This is the critical path for the self-correcting loop:

```
1. User sees failed run in Compute tab
2. Clicks "Fix & Retry in Chat"
3. Switches to Chat with prefilled:
   "Compute run cr-xxx failed with OOM_KILLED.
    Stderr: [last 200 chars of stderr]
    Please fix the code and retry."
4. Agent reads error, fixes code, calls local_compute_execute(parent_run_id: ...)
5. New run appears in Compute tab with retry lineage
6. User can watch progress in Compute tab
```

The retry lineage is shown visually:
```
cr-m3n4o5p6 (failed, OOM) → cr-a1b2c3d4 (running, 42%)
```

---

## 6. IPC and Data Flow

### 6.1 Current Limitation (v1.1)

Compute events are forwarded only when the agent calls status/wait tools. The UI updates only on agent tool calls, not continuously.

### 6.2 Enhanced Model (v1.1+)

Add a lightweight **periodic IPC push** from the runner's poll loop:

```
Runner.pollOnce (every 5s, per active run)
  -> if run state changed or progress updated:
     -> emit 'compute:run-update' to main process event bus
     -> main process forwards to renderer via safeSend
```

This requires:
- ComputeRunner accepts an `onRunUpdate` callback
- Coordinator passes the callback, bound to `safeSend(win, 'compute:run-update', ...)`
- Renderer receives continuous updates regardless of agent tool calls

**Why this matters**: Without this, a user watching the Compute tab during a 30-minute training run sees NO updates between agent turns. With it, progress updates arrive every 5 seconds.

### 6.3 Data Flow Diagram

```
                     Execution Layer
                     ┌──────────────────┐
                     │  ComputeRunner    │
                     │  pollOnce() (5s)  │
                     └────────┬─────────┘
                              │ onRunUpdate callback
                     ┌────────▼─────────┐
                     │  ipc.ts (main)    │
                     │  safeSend(win,    │
                     │  'compute:...')   │
                     └────────┬─────────┘
                              │ IPC channel
                     ┌─��──────▼─────��───┐
                     │  preload bridge   │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  App.tsx listener │
                     └────────┬───────���─┘
                              │
                     ┌────────▼─────────��
                     │ useComputeStore   │
                     │ updateRun()       │
                     └────────┬─────────┘
                              │ Zustand re-render
                  ┌─────���─────┼───────��───┐
                  │           │           │
           ┌──────▼───┐ ┌────▼────┐ ┌────▼──────┐
           │ComputeSB  │ │RunCard  │ │HistoryRow │
           │(sidebar)  │ │(active) │ │(history)  │
           └───────────┘ └─────────┘ └───────────┘
```

---

## 7. Component Inventory

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ComputeSidebar` | `components/left/` | Left panel: target card, quick actions, stats, experience |
| `TargetCard` | `components/left/` | Environment summary with resource bars |
| `ComputeQuickActions` | `components/left/` | Action buttons that prefill chat |
| `RunStats` | `components/left/` | Aggregate statistics from experience |
| `ComputeView` | `components/center/` | Center panel orchestrator (existing, to be enhanced) |
| `ActiveRunCard` | `components/center/` | Detailed live run card (replaces ComputeRunCard) |
| `RunHistoryTable` | `components/center/` | Filterable history list |
| `RunHistoryRow` | `components/center/` | Compact expandable history entry |
| `ComputeEmptyState` | `components/center/` | Welcome screen with env info and examples |
| `RecoveryBanner` | `components/center/` | Post-restart notification |
| `EnvironmentDetail` | `components/center/` | Full collapsible system profile |
| `OutputViewer` | `components/center/` | Terminal-style output display (shared by active + history) |

### Modified Components

| Component | Change |
|-----------|--------|
| `LeftSidebar` | Add `centerView === 'compute' ? <ComputeSidebar /> : ...` |
| `CenterPanel` | Already wired (v1.1) |
| `App.tsx` | Add Cmd+3 shortcut; already has IPC listeners |

### Store Enhancements

| Store | Change |
|-------|--------|
| `compute-store.ts` | Add: environment live resource updates, recovery banner state, history filter state, selected run for detail view |
| `ui-store.ts` | Add: `computeFilter` state (like `literatureFilter`) |

---

## 8. Interaction Patterns

### 8.1 Click Patterns

| Element | Click Action |
|---------|-------------|
| Active run card | Expand/collapse live output |
| History row | Expand/collapse details |
| "Stop" button | Confirm dialog → stop run |
| "Ask Agent" (stalled) | Switch to chat + prefill |
| "Fix & Retry" (failed) | Switch to chat + prefill |
| Quick action (sidebar) | Switch to chat + prefill |
| Example prompt (empty) | Switch to chat + prefill |
| Target card (sidebar) | Toggle environment detail in center |
| History filter | Filter history list |
| Run ID (anywhere) | Copy to clipboard |
| Retry lineage link | Scroll to / highlight linked run |

### 8.2 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+3 | Switch to Compute tab |
| Cmd+1 | Switch back to Chat |
| Escape | Collapse expanded run / close detail |

### 8.3 Real-Time Updates

| Element | Update Source | Frequency |
|---------|-------------|-----------|
| Progress bar | IPC compute:run-update | Every 5s (poll) |
| Metrics badges | IPC compute:run-update | Every 5s |
| Elapsed time | Client-side setInterval | Every 1s |
| Resource bars (sidebar) | IPC compute:environment-snapshot | Every 30s (new) |
| Active run count badge | Derived from store | On store change |

---

## 9. Visual Design Tokens

Following existing Tailwind patterns from Literature:

### Status Colors

| Status | Dot/Badge | Border | Background |
|--------|-----------|--------|------------|
| Running | `bg-blue-500` pulse | `border-blue-500/20` | `bg-blue-500/5` |
| Stalled | `bg-amber-500` static | `border-amber-500/20` | `bg-amber-500/5` |
| Completed | `bg-emerald-500` | default | default |
| Failed | `bg-red-500` | `border-red-500/20` | `bg-red-500/5` |
| Timed Out | `bg-orange-500` | default | default |
| Cancelled | `bg-neutral-400` | default | default |

### Resource Bars

```
Memory  ░░░░░░░░░░░░ 62%     <- green < 70%, amber 70-85%, red > 85%
Disk    ░░░░░░░░░    45%     <- same thresholds
```

Colors: `bg-emerald-500` / `bg-amber-500` / `bg-red-500` on `t-bg-elevated` track.

### Typography

| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Section headers | `text-[10px]` | `font-semibold uppercase tracking-wide` | `t-text-muted` |
| Run ID | `text-[10px]` | `font-mono` | `t-text-muted` |
| Command | `text-xs` | `font-mono` | `t-text-secondary` |
| Status badge | `text-[10px]` | `font-medium` | status-specific |
| Metric value | `text-[10px]` | `font-mono` | `t-text-secondary` |
| Elapsed/ETA | `text-[10px]` | normal | `t-text-muted` |
| Output text | `text-[10px]` | `font-mono` | `t-text-secondary` on `t-bg-elevated` |
| Quick action title | `text-xs` | `font-medium` | `t-text` |
| Quick action desc | `text-[10px]` | normal | `t-text-muted` |

---

## 10. Edge Cases

### 10.1 Many Concurrent Runs (3 max)

Show all active run cards vertically. If screen is small, active section scrolls independently from history.

### 10.2 Very Long Commands

Truncate with `truncate` class. Full command shown in tooltip and on expand.

### 10.3 No Python Installed

Environment card shows: "Python: Not detected" with amber warning. Quick actions still work (preflight will catch and report the error clearly).

### 10.4 Rapid Failures

If the agent enters a retry loop (fail → fix → fail → fix), the history section may show many entries quickly. Group retry chains:
```
cr-001 (failed) → cr-002 (failed) → cr-003 (running)
  "python3 train.py" · 3 attempts · OOM_KILLED → OOM_KILLED → ...
```

### 10.5 Output File Capped

When a run hits the 1GB output cap, the active card shows:
```
⚠ Output reached 1GB limit. Process stopped.
```
The failure signal is `COMMAND_FAILED` with the cap explanation.

### 10.6 App Backgrounded / Screen Asleep

Progress keeps updating via IPC (Electron stays active). When user returns:
- Active runs show updated progress
- If a run completed while away, it's in history
- No "catch up" animation needed — just show current state

---

## 11. Implementation Phases

### Phase A (foundation — update existing v1.1 components)

- Enhance `ComputeView.tsx` with proper state hierarchy (active/recovery/history/empty)
- Enhance `ComputeRunCard.tsx` → `ActiveRunCard.tsx` with live output, metrics, stall handling
- Add `ComputeEmptyState.tsx` with environment display and example prompts
- Add `RunHistoryTable.tsx` + `RunHistoryRow.tsx` (expandable)
- Add `RecoveryBanner.tsx`
- Wire Cmd+3 keyboard shortcut

### Phase B (left sidebar)

- Create `ComputeSidebar.tsx` with target card, quick actions, stats
- Create `TargetCard.tsx` with resource bars
- Update `LeftSidebar.tsx` to switch on `centerView === 'compute'`
- Add chat prefill mechanism (reuse Literature's QuickAction pattern)

### Phase C (real-time + polish)

- Add `onRunUpdate` callback to ComputeRunner for continuous IPC push
- Add periodic resource snapshot IPC for sidebar resource bars
- Add `OutputViewer.tsx` component (terminal-style, shared between active and history)
- Add `EnvironmentDetail.tsx` collapsible panel
- Add retry chain grouping in history
- Add client-side elapsed time ticker (1s interval)
- Add Cmd+3 to actual keyboard handler in App.tsx

### Phase D (future — remote targets)

- Generalize TargetCard to target list
- Add target selector / switcher
- Filter runs by target
- Remote-specific status indicators (queued, provisioning, etc.)
