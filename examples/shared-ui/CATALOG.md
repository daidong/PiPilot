# Shared UI Component Catalog

> AgentFoundry's shared-ui library provides reusable React components, Zustand stores,
> types, constants, and utilities for Electron desktop apps.
>
> **Consumed by:** `personal-assistant`, `research-pilot-desktop` (aliased as `@shared`)

---

## Components

### Right Panel

#### ProgressSteps

**File:** `components/right/ProgressSteps.tsx`

Displays a list of todo/task items with a progress bar showing completion ratio. Each item renders a status icon (done, in-progress, blocked, pending) and title. Automatically computes done/total counts.

**Props:** None (reads directly from `useProgressStore`)

**Dependencies:** `useProgressStore`, lucide-react (`CheckCircle2`, `Circle`, `Loader2`, `Ban`)

**Visual description:** A "Progress (N/M)" heading, a thin horizontal progress bar (green fill), and a vertical list of task rows. Each row has a status icon on the left (green check, spinning loader, red ban, or gray circle) and the task title.

**Usage:**

```tsx
import { ProgressSteps } from '@shared/components/right/ProgressSteps'

function RightSidebar() {
  return <ProgressSteps />
}
```

---

#### TokenUsage

**File:** `components/right/TokenUsage.tsx`

Compact, single-line display of all-time token usage totals: token count, billable cost, cache hit rate, billing source, and LLM call count. Includes a reset button with confirmation (click once to arm, click again within 3s to confirm).

**Props:** None (reads directly from `useUsageStore`)

**Dependencies:** `useUsageStore`, `formatTokens`, `formatCost` (from `../../utils`), lucide-react (`RotateCcw`)

**Visual description:** A single row labeled "TOTAL" on the left, with monospaced stats on the right separated by dots: e.g. `12.4K . $0.032 . 74% . api-key . 8x`. A small rotate icon to the left of the label serves as the reset button (turns red when armed).

**Usage:**

```tsx
import { TokenUsage } from '@shared/components/right/TokenUsage'

function RightSidebar() {
  return <TokenUsage />
}
```

---

#### ActivityLog

**File:** `components/right/ActivityLog.tsx`

A scrollable, auto-scrolling activity feed that shows agent events (tool calls, tool results, errors, system messages). Tool-result events merge into their matching tool-call row in-place (spinning icon becomes a checkmark). Capped at 50 events.

**Props:** None (reads directly from `useActivityStore`)

**Dependencies:** `useActivityStore`, `ActivityEvent` type, lucide-react (`Activity`, `AlertCircle`, `CheckCircle2`, `Loader2`, `Wrench`, `Info`)

**Visual description:** An "Activity" heading with an activity icon, followed by a list of event rows. Each row has a colored status icon (spinning blue for in-progress, green check for success, red alert for error, blue info for system), a summary text, and a timestamp on the right. Failed events show a red error message below the summary.

**Usage:**

```tsx
import { ActivityLog } from '@shared/components/right/ActivityLog'

function RightSidebar() {
  return <ActivityLog />
}
```

---

### Center Panel

#### CommandPopover

**File:** `components/center/CommandPopover.tsx`

A floating popover for slash-command autocomplete. Filters commands by name or description as the user types. Supports keyboard navigation (ArrowUp/ArrowDown, Enter/Tab to select, Escape to close) and mouse selection.

**Props:**

```typescript
interface Props {
  query: string                        // Current search text (after the "/")
  commands: SlashCommand[]             // Available slash commands
  onSelect: (command: string) => void  // Called with the command name when selected
  onClose: () => void                  // Called when popover should close (Escape)
}
```

**Dependencies:** `SlashCommand` type, lucide-react (`Terminal`)

**Visual description:** An absolutely-positioned dropdown (anchored above the input bar, 320px wide, max 256px tall). Shows a "Commands" header with a terminal icon, then a list of command rows. Each row displays the command name as inline code on the left, a description, and optional args below it. The selected row has an elevated background. If no commands match, shows "No matching commands for /query".

**Usage:**

```tsx
import { CommandPopover } from '@shared/components/center/CommandPopover'

function ChatInput() {
  const [slashQuery, setSlashQuery] = useState('')
  const commands: SlashCommand[] = [
    { name: '/help', description: 'Show available commands' },
    { name: '/clear', description: 'Clear chat history' },
  ]

  return (
    <div className="relative">
      {slashQuery && (
        <CommandPopover
          query={slashQuery}
          commands={commands}
          onSelect={(cmd) => console.log('Selected:', cmd)}
          onClose={() => setSlashQuery('')}
        />
      )}
      <input onChange={(e) => { /* detect slash */ }} />
    </div>
  )
}
```

---

### Left Panel

#### ModelSelector

**File:** `components/left/ModelSelector.tsx`

A dropdown selector for choosing the active LLM model. Models are grouped by provider (OpenAI, Anthropic). Checks API key availability before allowing selection -- if a key is missing, shows a modal dialog with setup instructions and a copy button.

**Props:**

```typescript
interface Props {
  selectedModel: string                      // Currently selected model ID
  onSelectModel: (modelId: string) => void   // Called when user picks a new model
}
```

**Dependencies:** `SUPPORTED_MODELS` constant, `ModelOption` type, `window.api` (Electron preload bridge for `getAnthropicAuthStatus`, `getOpenAIAuthStatus`, `onAnthropicAuthStatus`), lucide-react (`ChevronDown`, `Check`, `Cpu`)

**Visual description:** A compact button showing a CPU icon, the current model label (truncated to 100px), an optional auth badge ("api" or "auth"), and a chevron. Clicking opens a dropdown (256px wide, max 320px tall) with models grouped under provider headings. Each model row shows a checkmark if selected. If API key is missing, a centered modal dialog appears with step-by-step instructions and a "Copy" button for the env variable template.

**Usage:**

```tsx
import { ModelSelector } from '@shared/components/left/ModelSelector'

function TitleBar() {
  const [model, setModel] = useState('claude-opus-4-6')

  return (
    <ModelSelector
      selectedModel={model}
      onSelectModel={setModel}
    />
  )
}
```

---

#### ReasoningToggle

**File:** `components/left/ReasoningToggle.tsx`

A single-button toggle that cycles through reasoning effort levels: low -> medium -> high -> max -> low. Only renders when the selected model supports reasoning (is in `REASONING_MODELS`). The lightbulb icon color changes by level.

**Props:**

```typescript
interface Props {
  selectedModel: string                              // Current model ID
  reasoningEffort: ReasoningEffort                   // Current effort level
  onChangeEffort: (effort: ReasoningEffort) => void  // Called with the next effort level
}
```

**Dependencies:** `REASONING_MODELS` constant, `ReasoningEffort` type, lucide-react (`Lightbulb`)

**Color mapping:**

| Effort   | CSS class         |
|----------|-------------------|
| `max`    | `t-text-accent`   |
| `high`   | `t-text-error`    |
| `medium` | `t-text-info`     |
| `low`    | `t-text-muted`    |

**Visual description:** A small rounded button with a lightbulb icon. The icon color indicates the current reasoning effort. Tooltip shows "Reasoning: {level}". Returns `null` (renders nothing) if the model does not support reasoning.

**Usage:**

```tsx
import { ReasoningToggle } from '@shared/components/left/ReasoningToggle'

function TitleBar() {
  const [effort, setEffort] = useState<ReasoningEffort>('medium')

  return (
    <ReasoningToggle
      selectedModel="claude-opus-4-6"
      reasoningEffort={effort}
      onChangeEffort={setEffort}
    />
  )
}
```

---

## Stores

### useActivityStore

**File:** `stores/activity-store.ts`

Tracks agent activity events (tool calls, results, errors, system messages). Tool-result events merge in-place into their matching tool-call row. Filters out internal `todo-*` tool events. Capped at 50 events.

**Exported types:**

```typescript
export interface ActivityEvent {
  id: string
  timestamp: string
  type: 'tool-call' | 'tool-result' | 'error' | 'system'
  tool?: string
  summary: string
  success?: boolean   // only for tool-result
  error?: string      // error message if failed
}
```

**State shape & actions:**

```typescript
interface ActivityState {
  events: ActivityEvent[]
  push: (event: ActivityEvent) => void
  clear: () => void
}
```

**Usage:**

```tsx
import { useActivityStore } from '@shared/stores/activity-store'

// Read events
const events = useActivityStore((s) => s.events)

// Push a new event
useActivityStore.getState().push({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  type: 'tool-call',
  tool: 'read',
  summary: 'Reading file...',
})

// Clear all events
useActivityStore.getState().clear()
```

---

### useProgressStore

**File:** `stores/progress-store.ts`

Manages a list of todo/task items. Supports upsert semantics (insert or update by `id`).

**Exported types:**

```typescript
export interface TodoItem {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  priority: string
  tags?: string[]
  createdAt: string
  updatedAt: string
  completedAt?: string
}
```

**State shape & actions:**

```typescript
interface ProgressState {
  items: TodoItem[]
  upsertItem: (item: TodoItem) => void   // Insert or update by id
  clear: () => void
}
```

**Usage:**

```tsx
import { useProgressStore } from '@shared/stores/progress-store'

// Read items
const items = useProgressStore((s) => s.items)

// Upsert a task
useProgressStore.getState().upsertItem({
  id: '1',
  title: 'Implement feature X',
  status: 'in_progress',
  priority: 'high',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

// Clear all items
useProgressStore.getState().clear()
```

---

### useUsageStore

**File:** `stores/usage-store.ts`

Tracks token usage and costs at three granularities: current run, session, and all-time (persisted via framework). Supports loading persisted totals on app start and resetting at any level.

**Exported types:**

```typescript
export interface UsageEvent {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cost: number
  rawCost?: number
  billableCost?: number
  authMode?: 'api-key' | 'none'
  billingSource?: 'api-key' | 'none'
  cacheHitRate: number
}

export interface RunSummary {
  totalTokens: number
  totalCost: number
  cacheHitRate: number
  callCount: number
}
```

**State shape & actions:**

```typescript
interface UsageState {
  // Current run (resets when new run starts)
  runTokens: number
  runCost: number
  runCacheHitRate: number
  runCallCount: number

  // Session totals (accumulates within app session)
  sessionTokens: number
  sessionCost: number
  sessionCalls: number

  // All-time totals (persisted by framework)
  allTimeTokens: number
  allTimePromptTokens: number
  allTimeCachedTokens: number
  allTimeCost: number
  allTimeBillableCost: number
  allTimeCalls: number
  billingSource: 'api-key' | 'none'

  // Actions
  recordCall: (event: UsageEvent) => void      // Record a single LLM call
  completeRun: (summary: RunSummary) => void   // Mark run as done (no-op, keeps stats visible)
  resetRun: () => void                          // Reset run stats (called when NEW run starts)
  resetSession: () => void                      // Reset session + run (keep all-time)
  loadPersisted: () => Promise<void>            // Hydrate from framework on app start
  resetAllTime: () => void                      // Reset everything (user-initiated)
}
```

**Usage:**

```tsx
import { useUsageStore } from '@shared/stores/usage-store'

// Display all-time stats
const { allTimeTokens, allTimeBillableCost } = useUsageStore()

// Record an LLM call
useUsageStore.getState().recordCall({
  promptTokens: 1200,
  completionTokens: 350,
  cachedTokens: 800,
  cost: 0.004,
  billableCost: 0.002,
  cacheHitRate: 0.67,
  billingSource: 'api-key',
})

// Load persisted totals on startup
await useUsageStore.getState().loadPersisted()
```

---

## Types

**File:** `types.ts`

```typescript
// Color scheme for the app
export type Theme = 'light' | 'dark'

// Reasoning effort level for models that support extended thinking
export type ReasoningEffort = 'high' | 'medium' | 'low' | 'max'

// Model identifier string (e.g. 'claude-opus-4-6', 'gpt-5.4')
export type ModelId = string

// Describes a selectable LLM model
export interface ModelOption {
  id: ModelId
  label: string       // Display name (e.g. "Claude Opus 4.6")
  provider: string    // Provider name (e.g. "Anthropic", "OpenAI")
}

// A file the agent is currently working with
export interface WorkingFile {
  path: string
  name: string
  accessedAt: number  // Epoch timestamp
}

// A slash command available in the chat input
export interface SlashCommand {
  name: string        // e.g. "/help"
  description: string // Short description shown in autocomplete
  args?: string       // Optional argument hint
}
```

---

## Constants

**File:** `constants.ts`

### REASONING_MODELS

```typescript
export const REASONING_MODELS: string[] = [
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'claude-opus-4-6'
]
```

List of model IDs that support reasoning effort toggling. Used by `ReasoningToggle` to decide whether to render.

### GPT5_REASONING_MODELS (deprecated)

```typescript
/** @deprecated Use REASONING_MODELS instead */
export const GPT5_REASONING_MODELS = REASONING_MODELS
```

### SUPPORTED_MODELS

```typescript
export const SUPPORTED_MODELS: ModelOption[] = [
  // OpenAI
  { id: 'gpt-5.4',      label: 'GPT-5.4',        provider: 'OpenAI' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini',   provider: 'OpenAI' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano',   provider: 'OpenAI' },
  { id: 'gpt-4o',       label: 'GPT-4o',          provider: 'OpenAI' },
  // Anthropic
  { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',   provider: 'Anthropic' },
  { id: 'claude-opus-4-5-20251101',  label: 'Claude Opus 4.5',   provider: 'Anthropic' },
  { id: 'claude-sonnet-4-5-20250929',label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  provider: 'Anthropic' },
]
```

The full list of models shown in `ModelSelector`, grouped by provider.

---

## Utilities

**File:** `utils.ts`

### formatTokens

```typescript
export function formatTokens(n: number): string
```

Formats a token count for compact display.

| Input        | Output   |
|-------------|----------|
| `1500000`   | `"1.5M"` |
| `12400`     | `"12.4K"` |
| `350`       | `"350"`  |

### formatCost

```typescript
export function formatCost(n: number): string
```

Formats a USD cost value with appropriate precision.

| Input     | Output      |
|-----------|-------------|
| `0.0042`  | `"$0.0042"` |
| `0.123`   | `"$0.123"`  |
| `4.56`    | `"$4.56"`   |

---

## Styles

**File:** `styles/global-base.css`

Shared CSS foundation for all AgentFoundry desktop apps. Defines:

- **Theme tokens** for `html.dark` and `html.light` (background, surface, text, border, status colors)
- **Themed utility classes** prefixed with `t-` (e.g. `.t-bg-surface`, `.t-text-accent`, `.t-text-error`)
- **Input focus glow** (`.t-input-container:focus-within`, `.t-focus-ring:focus`)
- **Draggable regions** (`.drag-region`, `.no-drag`)
- **Markdown prose** (`.md-prose` with styles for headings, lists, code, tables, blockquotes, links)
- **Scrollbar styling** and reduced-motion media query

Each consuming app must define these accent tokens in its own CSS:
`--color-accent`, `--color-accent-soft`, `--color-code-text`, `--color-code-bg`, `--color-code-border`, `--color-input-focus`, `--color-bubble-user`.

**Usage in consuming apps:**

```css
@import "tailwindcss";
@import "@shared/styles/global-base.css";

html.dark {
  --color-accent: #your-accent-color;
  /* ...other app-specific tokens */
}
```
