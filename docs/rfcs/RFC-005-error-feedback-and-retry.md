# RFC-005: Error Feedback & Retry

**Status:** Implemented
**Author:** Captain + Claude
**Created:** 2026-01-29
**Updated:** 2026-01-30

## 1. Problem

Agents make mistakes. Tools fail. Environments return unexpected results. The connection between an agent and its environment is inherently unreliable. A robust agent framework must treat **error recovery as a first-class concern**, not an afterthought.

Today in AgentFoundry, error handling is scattered and inconsistent:

| Component | Has Retry? | Error Fed Back to Agent? | Notes |
|-----------|-----------|--------------------------|-------|
| Agent loop (context overflow) | Yes (2x) | No | Halves messages, but LLM doesn't know why |
| Agent loop (incomplete response) | Yes (2x) | No | Detects `finishReason=length`, retries silently |
| Structured output (`structured.ts`) | Yes (1x) | **Yes** — repair prompt | Best current pattern: Zod errors -> prompt injection |
| Tool definition (`define-tool.ts`) | Yes (3x) | No | Exponential backoff, silent |
| Context source (`define-context-source.ts`) | Yes (3x) | No | Exponential backoff, falls back to empty |
| Tool registry validation | No | No | Validation errors returned but never reach LLM |
| Policy engine denials | No | No | Denial reason exists but isn't injected into agent context |
| Team flow executor | No | No | First error is terminal |
| Python bridge | No | No | Timeout only, no retry |
| Data analysis loop (app-level) | Yes (3x) | **Yes** — error in prompt | Gold standard: stderr -> next prompt |

Two patterns already work well:

1. **Structured output repair** (`src/llm/structured.ts`): Zod validation error -> repair strategy -> modified prompt -> retry. Pluggable, traced.
2. **Data analysis retry** (`examples/research-pilot/agents/data-team.ts`): Python stderr -> injected into next LLM prompt -> LLM fixes its code. Simple, effective.

The problem: these patterns are **isolated implementations**. There is no unified way for any component to (a) classify an error, (b) decide whether to retry, (c) build informative feedback, and (d) inject that feedback back to the agent for the next attempt.

### Concrete failures today

**Tool validation errors are invisible to the agent.** When tool-registry validates parameters and finds `filePath` is missing, it returns `{ success: false, error: "Parameter validation failed" }`. The agent-loop adds this as a tool result message, but the error string is generic. The LLM doesn't learn "you forgot the required `filePath` parameter" — it just sees "failed".

**Policy denials are opaque.** When a policy denies an operation (e.g., "no writing to .env files"), the denial reason exists in the policy engine but the agent-loop returns a generic failure. The LLM can't learn to avoid the denied action.

**Team flow failures are terminal.** If step 3 of a 5-step flow fails, the entire flow stops. There's no way to express "retry step 3 up to 3 times" or "if step 3 fails, try step 3b instead".

**Context assembly failures are silent.** If a context phase drops content due to budget limits, the agent doesn't know what was dropped. It may produce answers based on incomplete context without realizing it.

## 2. Design Principles

1. **The environment must explain itself.** When something fails, the error feedback should contain enough information for an LLM to reason about what went wrong and try a different approach. A stack trace is better than "failed". A structured error with parameter names and expected types is better than a stack trace.

2. **Retry is a strategy, not a magic number.** Different errors need different retry approaches. A rate limit needs backoff. A validation error needs input repair. A timeout might need a simpler request. The framework should let each component declare *how* to recover, not just *how many times* to try.

3. **Feedback flows to where decisions are made.** If the LLM is the decision-maker (which agent to call, what parameters to use), then error feedback must reach the LLM in a form it can reason about. If a tool executor is the decision-maker (retry with backoff), it needs structured error classification. These are two fundamentally different retry paths (see Section 3.3).

4. **Feedback is sanitized, not raw.** Error messages originate from external environments — stderr, HTTP responses, file contents, API errors. These may contain adversarial content. The framework must sanitize external content before injecting it into agent context. Feedback is structured into **facts** (machine-readable, safe) and **guidance** (framework-generated, controlled). Raw external text never enters the prompt directly.

5. **Non-breaking and incremental.** Existing code continues to work. New capabilities are opt-in. Components that don't provide error feedback still work — they just produce less informative errors.

## 3. Design

### 3.1 Error Envelope

Every error in the system is wrapped in a standard envelope:

```typescript
// src/core/errors.ts

interface AgentError {
  /** What went wrong */
  category: ErrorCategory
  /** Where the error originated (discriminated union) */
  source: ErrorSource
  /** Human/LLM-readable explanation (sanitized — no raw external content) */
  message: string
  /** How likely is recovery? */
  recoverability: Recoverability
  /** Current attempt number (1-based) */
  attempt?: number
  /** Sanitized details safe to include in LLM prompts */
  details?: Record<string, unknown>
  /** Original raw error (not exposed to LLM) */
  rawError?: unknown
}

type ErrorCategory =
  | 'validation'        // Bad input (missing param, wrong type, out of range)
  | 'execution'         // Tool/script runtime failure (exception, non-zero exit)
  | 'timeout'           // Operation exceeded time limit
  | 'rate_limit'        // External API rate limit / 429
  | 'auth'              // API key invalid, token expired, 401/403
  | 'policy_denied'     // Policy engine blocked the operation
  | 'context_overflow'  // LLM context window exceeded
  | 'malformed_output'  // LLM produced unparseable output
  | 'resource'          // File not found, DNS failure, permanent 404
  | 'transient_network' // Temporary network error, connection reset, DNS timeout
  | 'unknown'           // Unclassified

type ErrorSource =
  | { kind: 'tool'; toolName: string }
  | { kind: 'policy'; policyId: string }
  | { kind: 'llm'; model?: string }
  | { kind: 'runtime' }
  | { kind: 'python'; scriptPath?: string }
  | { kind: 'network' }
  | { kind: 'flow'; stepId: string; agentId?: string }
  | { kind: 'context'; phase?: string }

type Recoverability = 'yes' | 'no' | 'maybe'
```

**Key property: `recoverability`.** This is a three-valued hint, not a hard rule:
- `'yes'` — The error is almost certainly fixable by retrying (rate_limit, transient_network, validation with clear fix).
- `'maybe'` — Recovery is possible but depends on context (execution failure, resource not found, policy denied — the LLM might fix its approach, or might not).
- `'no'` — Recovery is unlikely without external intervention (auth failure).

Default recoverability per category:

```typescript
const RECOVERABILITY_MAP: Record<ErrorCategory, Recoverability> = {
  validation: 'yes',
  execution: 'yes',
  timeout: 'maybe',
  rate_limit: 'yes',
  auth: 'no',
  policy_denied: 'maybe',   // LLM may try a different approach
  context_overflow: 'maybe',
  malformed_output: 'yes',
  resource: 'maybe',
  transient_network: 'yes',
  unknown: 'maybe'
}
```

**Error classification** uses heuristic keyword matching on error messages, with an optional `ClassifyErrorContext` to enrich source information:

```typescript
interface ClassifyErrorContext {
  toolName?: string
  policyId?: string
  stepId?: number
}

function classifyError(
  error: string | Error,
  sourceOrContext?: ErrorSourceKind | ClassifyErrorContext
): AgentError
```

The second parameter accepts either a legacy flat source kind string (backwards-compatible) or a context object. The `inferSource()` helper converts context to an `ErrorSource`:

```typescript
function inferSource(context?: ClassifyErrorContext): ErrorSource {
  if (context?.policyId) return { kind: 'policy', policyId: context.policyId }
  if (context?.toolName) return { kind: 'tool', toolName: context.toolName }
  return { kind: 'runtime' }
}
```

**Convenience constructors** for common error types:

```typescript
// Tool validation errors
function createValidationError(
  toolName: string,
  errors: Array<{ param: string; message: string }>
): AgentError

// Python execution errors (parses traceback automatically)
function createPythonError(stderr: string, exitCode?: number): AgentError
```

### 3.2 Feedback Channels: Facts & Guidance

When an error is fed back to the agent, the feedback is structured into two channels to prevent raw external content from entering the prompt:

```typescript
// src/core/feedback.ts

interface ErrorFeedback {
  /** Structured, machine-readable error facts (sanitized, safe for LLM) */
  facts: ErrorFacts
  /** Framework-generated guidance for the LLM (never from external sources) */
  guidance: string
  /** Optional: repaired input for automatic tool-level retry */
  repairedInput?: unknown
}

interface ErrorFacts {
  /** Error category */
  category: string
  /** Flattened source label (e.g., "tool:data-analyze", "policy:no-secrets") */
  source: string
  /** Attempt number */
  attempt?: number
  /** Category-specific structured data (sanitized) */
  data?: Record<string, unknown>
}
```

The `source` field is a flattened string label derived from `ErrorSource`:

```typescript
function sourceLabel(source: ErrorSource): string {
  switch (source.kind) {
    case 'tool': return `tool:${source.toolName}`
    case 'policy': return `policy:${source.policyId}`
    default: return source.kind
  }
}
```

**Feedback builders:**

```typescript
type FeedbackBuilder = (error: AgentError, context?: FeedbackContext) => ErrorFeedback

interface FeedbackContext {
  /** The original tool input that caused the error */
  originalInput?: unknown
  /** Previous attempts/errors for this tool call */
  history?: Array<{ attempt: number; error: string }>
  /** Schema summary of the tool */
  toolSchema?: ToolSchemaSummary
}

interface ToolSchemaSummary {
  name: string
  params: Array<{ name: string; type: string; required: boolean }>
}
```

**Built-in feedback builders:**

| Builder | Purpose |
|---------|---------|
| `buildFeedback(error, context?)` | Generic builder from AgentError |
| `toolValidationFeedback(toolName, paramErrors, context?)` | Structured parameter error list with schema hint |
| `executionFailureFeedback(error, context?)` | Python/code execution failure with exception details |
| `policyDenialFeedback(toolName, reason, policyId?)` | Policy denial with sanitized reason |
| `contextDropFeedback(droppedItems, reason)` | Context items dropped due to budget |

**Guidance templates** provide category-specific instructions. When tool schema info is available (validation errors), the guidance is enriched with parameter listings:

```typescript
// Example: toolValidationFeedback output
{
  facts: {
    category: 'validation',
    source: 'tool:data-analyze',
    data: {
      tool: 'data-analyze',
      paramErrors: [
        { param: 'instructions', message: 'Required parameter missing' }
      ]
    }
  },
  guidance: 'Fix these parameter errors and retry:\n  - instructions: Required parameter missing\n\nCheck the tool definition for correct parameter names, types, and required fields.\nTool "data-analyze" expects: instructions: string (required), taskType: string (required)'
}
```

**Rendering feedback as a tool result:**

All feedback is rendered as JSON via `formatFeedbackAsToolResult()`:

```typescript
function formatFeedbackAsToolResult(feedback: ErrorFeedback): string {
  return JSON.stringify({
    success: false,
    error: feedback.facts,
    guidance: feedback.guidance,
    ...(feedback.repairedInput !== undefined ? { repairedInput: feedback.repairedInput } : {})
  })
}
```

This is the single unified format for all tool error responses. The LLM sees:

```json
{
  "success": false,
  "error": {
    "category": "validation",
    "source": "tool:data-analyze",
    "data": { "tool": "data-analyze", "paramErrors": [...] }
  },
  "guidance": "Fix these parameter errors and retry:..."
}
```

**Sanitization rules:**

All string fields in feedback go through `sanitizeErrorContent()`:

```typescript
function sanitizeErrorContent(content: string, maxLength: number = 256): string
```

This strips prompt injection patterns (`ignore previous instructions`, `you are now`, `system:`, etc.) and truncates to the specified max length. Details objects are sanitized via `sanitizeDetails()` which enforces a 1024-byte total budget across all fields.

### 3.3 Two Retry Modes

A critical design distinction: not all retries need LLM involvement. Conflating them wastes tokens on transient errors and fails to provide feedback on errors only the LLM can fix.

```typescript
// src/core/retry.ts

type RetryMode = 'executor_retry' | 'agent_retry'

/**
 * executor_retry: Retry inside the executor without LLM involvement.
 *   Use for: rate_limit, transient_network, timeout.
 *   Cost: Only wall-clock time. Zero extra tokens.
 *
 * agent_retry: Feed error back to LLM and let it decide next action.
 *   Use for: validation, execution, malformed_output, resource.
 *   Cost: Full LLM round-trip (tokens + latency).
 */
```

**Key design decision:** `executor_retry` is implemented by `withRetry()`. `agent_retry` is implemented by the **agent loop naturally** — tool error becomes a structured feedback tool result, LLM sees it, LLM decides its next action. There is no special `withRetry` path for agent_retry; the loop's existing tool-result mechanism already implements it.

**Default strategy per error category:**

```typescript
const DEFAULT_STRATEGIES: Record<ErrorCategory, RetryStrategy> = {
  validation:        { mode: 'agent_retry',    maxAttempts: 3 },
  execution:         { mode: 'agent_retry',    maxAttempts: 3 },
  timeout:           { mode: 'executor_retry', maxAttempts: 2, backoff: { type: 'exponential', baseMs: 1000, multiplier: 2 } },
  rate_limit:        { mode: 'executor_retry', maxAttempts: 5, backoff: { type: 'exponential', baseMs: 2000, multiplier: 2 } },
  auth:              { mode: 'agent_retry',    maxAttempts: 1 },
  policy_denied:     { mode: 'agent_retry',    maxAttempts: 1 },
  context_overflow:  { mode: 'agent_retry',    maxAttempts: 2 },
  malformed_output:  { mode: 'agent_retry',    maxAttempts: 2 },
  resource:          { mode: 'agent_retry',    maxAttempts: 2 },
  transient_network: { mode: 'executor_retry', maxAttempts: 3, backoff: { type: 'exponential', baseMs: 1000, multiplier: 2 } },
  unknown:           { mode: 'agent_retry',    maxAttempts: 1 }
}
```

**Execution semantics:**

```
executor_retry (handled by withRetry):
  1. Error occurs
  2. classifyError() -> AgentError
  3. Check shouldRetry (budget + recoverability)
  4. Re-classify per iteration (error may change category)
  5. Compute backoff delay via BackoffStrategy
  6. Wait, then re-execute same operation with same input
  7. No LLM round-trip, no token cost
  8. If exhausted -> throw with agentError attached

agent_retry (handled by agent loop):
  1. Tool returns error (or executor_retry exhausted)
  2. If error is pre-structured JSON from ToolRegistry -> pass through with re-sanitization
  3. Otherwise: classifyError() -> AgentError -> buildFeedback() -> formatFeedbackAsToolResult()
  4. Record against shared RetryBudget
  5. Inject feedback as tool result message
  6. LLM sees facts + guidance, decides next action
  7. Full LLM round-trip (tokens tracked in retryTokenCost)
  8. If budget exhausted -> append "RETRY BUDGET EXHAUSTED" guidance
```

### 3.4 Retry Budget

To prevent death spirals, retry attempts are tracked per error category within a single agent run. The budget is **shared across both executor_retry and agent_retry**.

```typescript
interface RetryBudgetConfig {
  maxTotalRetries: number
  maxConsecutiveSameCategory: number
  perCategory?: Partial<Record<ErrorCategory, number>>
}

class RetryBudget {
  constructor(config: RetryBudgetConfig)
  canRetry(category: ErrorCategory, recoverability: Recoverability): boolean
  record(category: ErrorCategory): void
  stats(): { total: number; byCategory: Partial<Record<ErrorCategory, number>> }
}

const DEFAULT_BUDGET_CONFIG: RetryBudgetConfig = {
  maxTotalRetries: 10,
  maxConsecutiveSameCategory: 3,
  perCategory: {
    auth: 1,
    policy_denied: 1,
    rate_limit: 5
  }
}
```

Budget enforcement rules:
- Non-recoverable errors (`recoverability: 'no'`) are never retried
- Total retry count across all categories is capped
- Consecutive same-category retries are capped (resets when a different category occurs)
- Per-category limits provide fine-grained control (e.g., `auth: 1`)

In the agent loop, every tool error records against the shared budget. When budget is exhausted, guidance is appended:

```
"RETRY BUDGET EXHAUSTED — The system has reached the maximum number of retries.
Report the failure to the user and do not attempt further retries for this category."
```

### 3.5 Backoff Strategy

```typescript
type BackoffStrategy =
  | { type: 'none' }
  | { type: 'fixed'; delayMs: number }
  | { type: 'exponential'; baseMs: number; multiplier: number; maxMs?: number }
  | { type: 'custom'; compute: (attempt: number) => number }

function computeBackoff(strategy: BackoffStrategy | undefined, attempt: number): number
```

Backoff is computed as:
- `none` -> 0ms
- `fixed` -> `delayMs`
- `exponential` -> `baseMs * multiplier^attempt`, capped at `maxMs`
- `custom` -> `compute(attempt)`

### 3.6 `withRetry()` — Executor-Level Retry

The core retry executor handles **executor_retry** only. It replaces manual retry loops for transient errors:

```typescript
interface WithRetryOptions {
  /** Maximum number of attempts (including the first) */
  maxAttempts: number
  /** Backoff strategy between attempts */
  backoff?: BackoffStrategy
  /** Budget tracker (optional, creates default if not provided) */
  budget?: RetryBudget
  /** Custom shouldRetry predicate */
  shouldRetry?: (error: AgentError, attempt: number, budget: RetryBudget) => boolean
  /** Callback when a retry occurs */
  onRetry?: (error: AgentError, attempt: number) => void
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions
): Promise<T>
```

Key behaviors:
- Errors are classified via `classifyError()` on each iteration (re-classification, since the error may change)
- Budget is checked via `shouldRetry` before each retry
- Backoff is computed and applied between attempts
- On exhaustion, the last error is thrown with `.agentError` attached for callers that need classification info
- The function signature is `fn: () => Promise<T>` — no feedback parameter, since executor_retry doesn't involve the LLM

**Agent-retry is NOT implemented by `withRetry`.** It is the natural behavior of the agent loop: tool error -> structured feedback in tool result -> LLM sees it -> LLM decides next action. This is a deliberate design choice — the loop already provides the agent_retry mechanism.

### 3.7 Retry Presets

```typescript
const RetryPresets = {
  /** No retries at all */
  none(): WithRetryOptions {
    return { maxAttempts: 1 }
  },

  /** Retry transient errors with exponential backoff */
  transient(): WithRetryOptions {
    return {
      maxAttempts: 3,
      backoff: { type: 'exponential', baseMs: 1000, multiplier: 2, maxMs: 10000 }
    }
  },

  /** Budget-aware retry with exponential backoff */
  smart(budget?: RetryBudget): WithRetryOptions {
    return {
      maxAttempts: 5,
      backoff: { type: 'exponential', baseMs: 500, multiplier: 2, maxMs: 15000 },
      budget: budget ?? new RetryBudget(DEFAULT_BUDGET_CONFIG)
    }
  }
}
```

### 3.8 Structured Feedback Passthrough

The ToolRegistry produces structured JSON feedback (via `formatFeedbackAsToolResult`) for validation errors and policy denials. The agent loop detects this pre-structured feedback to avoid re-classifying it:

```typescript
// In agent-loop.ts
function isStructuredFeedback(error: string): boolean {
  if (!error.startsWith('{"success":false')) return false
  try {
    const parsed = JSON.parse(error)
    return parsed.success === false
      && parsed.error?.category !== undefined
      && parsed.guidance !== undefined
  } catch { return false }
}
```

When pre-structured feedback is detected, it passes through directly but is **re-sanitized** to enforce the "no raw external content" rule:

```typescript
function sanitizeStructuredFeedback(feedbackJson: string): string {
  try {
    const parsed = JSON.parse(feedbackJson)
    if (typeof parsed.guidance === 'string') {
      parsed.guidance = sanitizeErrorContent(parsed.guidance, 512)
    }
    if (parsed.error?.data && typeof parsed.error.data === 'object') {
      for (const [key, value] of Object.entries(parsed.error.data)) {
        if (typeof value === 'string') {
          parsed.error.data[key] = sanitizeErrorContent(value, 256)
        }
      }
    }
    return JSON.stringify(parsed)
  } catch { return sanitizeErrorContent(feedbackJson, 1024) }
}
```

### 3.9 Integration Points

#### 3.9.1 Agent Loop (`src/agent/agent-loop.ts`)

The agent loop is the central integration point. It:

1. **Creates a shared `RetryBudget`** per `agent.run()` invocation
2. **Handles executor_retry** for transient errors (rate_limit, transient_network, timeout) — re-executes the tool call with backoff, re-classifying per iteration
3. **Handles agent_retry** by producing structured feedback tool results
4. **Detects pre-structured feedback** from ToolRegistry (via `isStructuredFeedback()`) and passes through with re-sanitization
5. **Tracks token cost** of agent_retry rounds via `hadToolErrors` flag and `retryTokenCost` accumulator
6. **Enforces budget** — appends exhaustion guidance when budget runs out
7. **Emits trace events** for all retry activity

```typescript
// Simplified flow in agent loop tool error handling:

if (!toolResult.success && toolResult.error) {
  // 1. Check for pre-structured feedback from ToolRegistry
  if (isStructuredFeedback(toolResult.error)) {
    toolResultContent = sanitizeStructuredFeedback(toolResult.error)
    // Record against budget
    retryBudget.record(parsedCategory)
  } else {
    // 2. Classify the error
    const agentError = classifyError(toolResult.error, { toolName })
    const strategy = getStrategy(agentError.category)

    if (strategy.mode === 'executor_retry') {
      // 3. Transparent retry — no LLM involvement
      // Re-execute with backoff, re-classify each iteration
      // Track as retryByMode.executor_retry
    } else {
      // 4. Agent retry — build feedback for LLM
      const feedback = buildFeedback(agentError, feedbackContext)
      toolResultContent = formatFeedbackAsToolResult(feedback)
      retryBudget.record(agentError.category)
      hadToolErrors = true
      // Track as retryByMode.agent_retry
    }
  }

  // 5. Budget exhaustion check
  if (!retryBudget.canRetry(category, recoverability)) {
    // Append "RETRY BUDGET EXHAUSTED" guidance
  }
}
```

#### 3.9.2 Tool Registry (`src/core/tool-registry.ts`)

The tool registry produces structured feedback for:

- **Validation errors**: Uses `toolValidationFeedback()` with `FeedbackContext` including `toolSchema` (parameter names, types, required status)
- **Policy denials**: Uses `policyDenialFeedback()` with `policyId` from `BeforeResult`

Both render via `formatFeedbackAsToolResult()` and return as `{ success: false, error: jsonString }`.

```typescript
// Validation error path
if (!validation.valid) {
  const agentError = createValidationError(name, validation.errors)
  const toolSchema: ToolSchemaSummary = {
    name,
    params: Object.entries(tool.parameters).map(([pName, pDef]) => ({
      name: pName, type: pDef.type, required: pDef.required !== false
    }))
  }
  const feedback = toolValidationFeedback(name, validation.errors, { originalInput: input, toolSchema })
  return { success: false, error: formatFeedbackAsToolResult(feedback) }
}

// Policy denial path
if (!beforeResult.allowed) {
  const feedback = policyDenialFeedback(name, beforeResult.reason || 'Policy denied', beforeResult.policyId)
  return { success: false, error: formatFeedbackAsToolResult(feedback) }
}
```

#### 3.9.3 Policy Engine (`src/core/policy-engine.ts`)

When a guard policy denies an operation, the engine returns `policyId` alongside the denial:

```typescript
// In policy-engine.ts guard phase:
if (decision.action === 'deny') {
  return { allowed: false, reason: decision.reason, policyId: policy.id }
}
```

This `policyId` flows through to `policyDenialFeedback()`, producing `source: "policy:no-secret-files"` instead of `source: "policy:unknown"`.

#### 3.9.4 Context Drop Feedback

When the agent loop trims messages to stay within context limits, it injects a context-drop notification as an assistant/user message pair with structured JSON:

```typescript
const feedback = contextDropFeedback(droppedItems, reason)
// Injected as structured message pair, not a [System] prefix
```

#### 3.9.5 Python Bridge (`src/python/bridge.ts`)

Python execution failures are classified via `createPythonError()` which parses the traceback to extract:
- `exceptionType` (e.g., "ValueError")
- `exceptionMessage` (sanitized)
- `topFrame` (first `File "..."` line)
- `exitCode`

#### 3.9.6 Define Tool / Define Context Source

Both `defineTool()` and `defineContextSource()` factories accept `RetryStrategy` for executor-level retry with `computeBackoff()`.

### 3.10 Observability

Every retry attempt is recorded in the trace system:

```typescript
// Emitted trace events:
'error.classified'   // Error wrapped in AgentError envelope
'error.retrying'     // About to retry — includes mode, feedback, backoff
'error.recovered'    // Retry succeeded — includes attempt count
'error.exhausted'    // All retries failed — includes full history

// Budget summary (emitted at end of agent.run()):
{
  type: 'error.budget_summary',
  data: {
    totalRetries: 4,
    byCategory: { rate_limit: 2, execution: 2 },
    byMode: { executor_retry: 2, agent_retry: 2 },
    tokensConsumedByRetries: 3200  // Only agent_retry rounds count
  }
}
```

Token cost tracking: the agent loop sets `hadToolErrors = true` when any tool error occurs. On the next LLM round, if this flag is set, the tokens consumed are added to `retryTokenCost` and the flag is cleared. This gives accurate tracking of tokens spent on agent_retry recovery.

## 4. Example: How Data Analysis Uses This

Currently `data-team.ts` implements retry + feedback manually. With this RFC, the tool registry and agent loop handle feedback automatically:

```typescript
// The agent loop automatically:
// 1. Classifies Python execution errors via createPythonError()
// 2. Builds structured feedback with executionFailureFeedback()
// 3. Renders as JSON tool result via formatFeedbackAsToolResult()
// 4. LLM sees: { success: false, error: { category: "execution", source: "python", data: { exceptionType: "NameError", ... } }, guidance: "Python raised NameError: ... Fix the code and try again." }
// 5. LLM fixes its code and retries naturally

// For manual retry loops (outside the agent loop), use withRetry for transient errors:
import { withRetry, RetryPresets } from 'agent-foundry'

const result = await withRetry(
  async () => executeScript(scriptPath, cwd),
  RetryPresets.transient()
)
```

What changes vs. pre-RFC-005:
- Raw stderr is sanitized before reaching the LLM prompt
- Retry budget prevents infinite loops
- Trace records every attempt for debugging
- Structured JSON feedback replaces generic "failed" strings
- Token cost of recovery is tracked

## 5. Implementation Status

All core components are implemented:

| Component | Status | Files |
|-----------|--------|-------|
| Error classification | Done | `src/core/errors.ts` |
| Feedback builders | Done | `src/core/feedback.ts` |
| Retry system | Done | `src/core/retry.ts` |
| Agent loop integration | Done | `src/agent/agent-loop.ts` |
| Tool registry feedback | Done | `src/core/tool-registry.ts` |
| Policy engine policyId | Done | `src/core/policy-engine.ts` |
| Define tool/context source | Done | `src/factories/define-tool.ts`, `src/factories/define-context-source.ts` |
| Python bridge | Done | `src/python/bridge.ts` |
| Trace events | Done | `src/types/trace.ts` |
| Exports | Done | `src/index.ts` |
| Tests | Done | `tests/core/errors.test.ts`, `tests/core/feedback.test.ts`, `tests/core/retry.test.ts` |

**Not yet implemented:**
- Team flow `retry()` and `fallback()` combinators (Section 3.9.4 of original draft — deferred to a future RFC)
- Migration of `structured.ts` RepairStrategy to use RetryStrategy + FeedbackBuilder

## 6. Non-Goals

- **Automatic root-cause analysis.** The framework classifies errors and provides context, but does not attempt to automatically determine *why* a tool failed beyond what the error message says.
- **Self-healing agents.** The framework provides retry + feedback primitives. Whether the agent actually fixes the problem depends on the LLM's reasoning ability. The framework makes recovery *possible*, not *guaranteed*.
- **Circuit breakers / global rate limiting.** These are operational concerns that belong in infrastructure middleware. This RFC handles per-run retry budgets only.
- **Agent-retry via `withRetry()`.** Agent-retry is deliberately the loop's responsibility, not a library function. The loop naturally implements it: tool error -> structured feedback -> LLM decides. Putting agent-retry in `withRetry()` would create a dead API surface since the loop already does this.

## 7. Resolved Questions

1. **Should `withRetry()` handle agent-retry?** -> No. `withRetry()` is executor-level only (`fn: () => Promise<T>`). Agent-retry is the agent loop's natural behavior: tool error -> structured feedback in tool result -> LLM sees it -> LLM decides. A `withFeedback` preset was initially added but removed as dead API — the loop already handles this.

2. **Should feedback builders access full conversation history?** -> No. Builders get only: last error + compact attempt history + tool schema summary. If the LLM needs more context, it should call `ctx-expand` explicitly. This keeps feedback token-bounded.

3. **How does retry interact with budget management?** -> `RetryBudget` tracks attempts per category per `agent.run()`, shared across both executor_retry and agent_retry. Token cost of agent_retry rounds is tracked separately via `retryTokenCost`. When budget is exhausted, guidance is appended telling the LLM to stop retrying.

4. **How to prevent feedback injection attacks?** -> `sanitizeErrorContent()` strips known prompt injection patterns, truncates to max length per field, enforces 1024-byte total for details. Pre-structured feedback from ToolRegistry is re-sanitized via `sanitizeStructuredFeedback()` before passing through to the LLM.

5. **Should pre-structured feedback from ToolRegistry be re-classified?** -> No. The agent loop detects pre-structured JSON via `isStructuredFeedback()` and passes it through directly, avoiding double-classification that would lose the original category/guidance. It is re-sanitized but not re-classified.

6. **Single format or legacy + new?** -> Single unified format via `formatFeedbackAsToolResult()`. The legacy `formatFeedback()` function was removed entirely (pre-1.0, no deprecation cycle needed).
