# Design Note 008: Compute Backend Abstraction

**Status:** Implemented (v2) — branch `feat/compute-backend-abstraction`, PR #63. All 10 §7 sub-sections landed as 8 commits; build green on all 3 platforms; 460/460 tests including 64 new compute tests pinning amendments A1–A5.
**Author:** Captain + Claude
**Reviewer:** Codex review pass 2026-05-17
**Date:** 2026-05-17 (v1), 2026-05-17 (v2), 2026-05-17 (v2 implemented)
**Scope:** Refactor `lib/local-compute/` + `lib/modal-compute/` (PR #62) into a single `lib/compute/` subsystem behind a `ComputeBackend` interface, so that adding AWS Batch / GCP Run / CloudLab / Lambda / etc. is "implement an interface + register" rather than "fork the IPC + the store + the UI". Settles three locked decisions before implementation begins.

## 0. TL;DR

PR #62 (Modal integration) introduced Modal as the second compute target alongside the existing `local-compute` subsystem, but it modeled Modal as a **sibling special-case** rather than as **an instance of a backend kind**. The result:

- 5 architecture smells captured in the PR review (double `PendingPlanStore` instantiation, `agent.state.messages` strong-typing leaks, `createSubAgent` reverse-reach into the coordinator, `gpuRateUsdPerHour`-only cost model, Modal-specific callbacks on `CoordinatorConfig`)
- 8 IPC channels (was 3 for local)
- 8 preload methods (was 3)
- A `compute_plan` whose response schema bifurcates on `target`
- Per-backend tool families (`local_compute_*`, `modal_*`) with no shared contract

The cost of fixing this is roughly the cost of adding one more backend (≈ 2k lines). The cost of NOT fixing it is paid every time we add AWS / GCP / CloudLab / whatever's next, forever.

**Modal has zero users today** (the PR is unmerged). This is the last cheap window.

This note locks the abstraction's shape, decides three sharp questions, and sets a one-shot migration plan.

## 0.1 Amendments (v1 → v2)

Five corrections from the v1 review pass. Each is reflected inline in the relevant section; this list exists so readers of the v2 don't have to diff against v1.

| # | Severity | Section | What changed |
|---|---|---|---|
| A1 | High | §2.2, §3.5, §4.1 | **`effectiveRequiresApproval` is captured at `plan()` time.** v1's `Registry.submit()` re-derived the approval requirement from current settings (race condition: a settings flip between plan and submit sent submit to look in the wrong store) and threw a TODO for the no-approval path. v2 introduces `PlanRecord { plan, effectiveRequiresApproval, approved, ... }` written by `Registry.plan()` for **every** plan (gated or not). `Registry.submit()` reads the captured record. Settings changes only affect future plans. Resolves v1's §6.1 open question. |
| A2 | High | §3.1 (CostEstimate), §3.5, §7.3 | **Cost-killing is backend-owned.** v1 said `CostEstimate.hourlyRateUsd` was used by Registry for the kill timer, then said Modal runner emits `cost-killed` events itself — two owners, risk of double-kill or missed-kill. v2 puts cost-killing entirely inside the backend: the backend reads `ctx.getCostThresholdUsd()`, polls its own runs (it already does for output/stall detection), kills via its own process handle, and emits `cost-killed`. Registry only fans the event out. |
| A3 | Medium | §3.2, §3.5, §5.1, §5.2, §7.5 | **`hydrate()` returns `Array<{ run, status }>`** instead of `Array<ComputeRun>`. `ComputeRun` lacks the live status fields (outputTail, progress, stalled, failure) that the UI needs to restore the Compute tab after a crash. Returning a tuple lets the renderer rehydrate both the durable record and the latest snapshot in one round trip. |
| A4 | Medium | §3.1 (BackendIdentity), §4.3 | **`BackendIdentity.toolPrefix: string` is separate from `id`.** v1 generated tool names from `id`, so `id: 'aws-batch'` would produce the invalid tool name `aws-batch_execute`. v2 requires backends to declare a `toolPrefix` matching `/^[a-z][a-z0-9_]*$/`; `Registry.register()` enforces uniqueness across all registered backends. `id` stays display-friendly. |
| A5 | Medium | §3.1 (ComputePlan/ComputeRun/RunStatus), §5.3 | **`backendData` is JSON-serializable, carries `backendDataVersion: number`.** v1's `backendData: unknown` crosses IPC and is rendered by per-backend components without any contract; Dates / Maps / Sets / functions break `structuredClone`, and a backend changing its data shape silently breaks the renderer. v2 adds (a) an explicit contract that `backendData` must be JSON values only, and (b) a sibling `backendDataVersion` field that per-backend renderer components check before rendering. |

The v1 file's content is otherwise preserved; v2 amendments are inline at each location and cross-referenced here.

## 1. Motivation — why we end up here without an abstraction

### 1.1 The PR #62 architecture smells, traced to a root cause

All five smells in the PR #62 review are downstream of a single missing concept: **"a compute backend"**.

| Smell from review | Root cause |
|---|---|
| `PendingPlanStore` instantiated twice (`lib/tools/index.ts` and `modal-compute/tools.ts`) | No registry owns backend state, so each tool file builds its own |
| `plan-agent.ts` reads `agent.state.messages` post-hoc + `(coord as any).agent` cast | Plan is implemented as an ad-hoc sub-agent leak rather than a backend method |
| `createSubAgent` factory on `CoordinatorConfig` | `lib/modal-compute/` reverse-depends on coordinator internals |
| Cost estimate is `gpuRateUsdPerHour * elapsed` only | No "cost model" interface — Modal's cost shape is hardcoded in the runner |
| `onModalCostKilled` / `onModalRunUpdate` on `CoordinatorConfig` | No unified `ComputeEvent` channel — each new event leaks into coordinator config |

### 1.2 What "the next backend" looks like and why it hurts now

Sketch of what implementing AWS Batch in the current architecture would require:

| Area | Cost |
|---|---|
| `lib/aws-compute/` mirror of `modal-compute/` | ~1.5k lines |
| `aws_execute`, `aws_wait`, `aws_status`, `aws_stop` tools | ~400 lines |
| `compute_plan` adds a third `target` branch with AWS-specific schema | ~200 lines |
| `CoordinatorConfig` grows `awsCredentials`, `onAwsCostKilled`, `onAwsRunUpdate` | API churn |
| IPC adds `compute:aws-*` channels (probably 5+) | ~150 lines |
| Preload adds `onAwsPlanReady`, `approveAwsPlan`, `rejectAwsPlan`, `onAwsAvailable`, `onAwsCostKilled` | ~80 lines |
| `compute-store.ts` adds `awsPendingPlan`, `awsAvailable` state | ~60 lines |
| `App.tsx` subscribes to 5 new IPC channels | ~40 lines |
| `ComputeView.tsx` adds AWS-specific approval UI | ~300 lines |

≈ 2,800 lines per backend, most of which is structurally identical to what Modal already wrote. The abstraction reduces that to "implement `ComputeBackend` + write a SKILL.md".

### 1.3 What stays domain-specific

The abstraction does not try to flatten the things that legitimately differ:

- **Resource shape** — local has CPU + RAM + disk; Modal has GPU type + image; AWS Batch has queue + vCPU; CloudLab has bare-metal reservation. Stored in `ComputePlan.resourceSpec` as an opaque-to-callers backend-typed blob (with backend-known schema).
- **Cost model** — local is free; Modal is GPU-hour; AWS has hundreds of line items; CloudLab is research credit. Each backend's `costEstimator` is internal; the interface only promises `estimatedCostUsd` + threshold-killing.
- **Submission mechanism** — local spawns a subprocess; Modal shells out to `modal run`; AWS uses the SDK; CloudLab uses reservation API + ssh. Hidden inside `backend.submit()`.

These live behind `backendData` escape hatches on plans and runs. The interface promises *common operations*, not *uniform internals*.

## 2. Locked Decisions

These three were debated in conversation 2026-05-17. They are locked here so the implementation PR doesn't reopen them.

### 2.1 Tool naming — hybrid C

| Layer | Tool surface | Why |
|---|---|---|
| **Planning** | One generic tool: `compute_plan(backend: string, ...)` | Lets the LLM compare backends in a single decision (e.g. "this fits local; this needs GPU → go modal"). Plan output is uniform shape, so prompt engineering is simpler. |
| **Execution** | Per-backend tools: `local_execute`, `modal_execute`, `aws_execute`, … (and `_wait` / `_status` / `_stop` per backend) | Once the LLM has chosen, it commits via a tool whose **name** reflects the choice. Tool descriptions can carry backend-specific guidance (Modal: "approval required"; AWS: "queue may take 60s+"). The agent doesn't accidentally execute on the wrong backend. |

Total tool count: `1 + 4N` for N backends. Acceptable up to 5–6 backends; if we ever cross that, revisit.

Rejected:
- **All-generic (`compute_execute(backend=...)`)** — saves tool count but the agent's reasoning step ("which backend?") becomes a parameter choice it can flub silently. Per-backend `_execute` makes the commitment visible in the tool call name.
- **All per-backend (no generic `compute_plan`)** — would force `local_compute_plan`, `modal_compute_plan`, `aws_compute_plan`, each with near-identical surface. Loses the "agent can compare backends" property at plan time.

### 2.2 Approval gate — by backend capability, settings can override

Default: `Backend.capabilities.requiresApproval` decides per backend.
- `local`: `false` (current behavior preserved — execute immediately)
- `modal`: `true` (cost is real; approval is the existing PR #62 UX)
- Future backends pick what fits.

Override: `appSettings.compute.requireApprovalForAllBackends: boolean` (default `false`). When true, the registry forces every `submit()` through the approval gate regardless of the backend's capability. Use cases: shared lab machines, audit/compliance environments, paranoid solo users.

Approval state machine (in `Registry`, not per-backend):

```
plan() → ComputePlan
       ↓
   (capability OR override?)
       ↙ no                    ↘ yes
   submit() immediately       persist PendingPlan
                                ↓
                              user approves / rejects in UI
                                ↓
                              submit() OR plan discarded
```

`PendingPlanStore` is renamed to `PlanStore` in v2 (see amendment A1) and now stores **every** plan, not just the gated ones — keyed by `(backend, planId)`, carrying a captured `effectiveRequiresApproval` flag. `Registry.plan()` writes the record; `Registry.submit()` reads it and decides based on the captured flag, not on current settings. Consequence: flipping `requireApprovalForAllBackends` between plan and submit does NOT redirect the submit — it only affects future plans. This rules out a race where the user toggles the override mid-flight and the plan ends up un-submittable.

### 2.3 Migration — one-shot

| Approach | Verdict |
|---|---|
| **One-shot** — port local + modal in the same PR; drop old tool names; one IPC channel | ✅ Chosen |
| **Two-step** — abstraction lands first with local as adapter; modal in PR-2 | ❌ Rejected |

Why one-shot:
- Modal has zero users today; local-compute has only internal users (gated behind `ENABLE_LOCAL_COMPUTE=1`). The blast radius for a breaking change is the smallest it will ever be.
- A half-done abstraction calcifies — if no one ports the second backend for 6 months, the interface fossilizes around the first.
- The new tool names (`local_execute` etc.) and the new IPC channel name (`compute:event`) want to be public from day one. Shipping them gradually means deprecation periods and shim layers, which are exactly the kind of complexity this RFC is trying to prevent.

What "one-shot" includes in the migration PR:
- Old tool names (`local_compute_execute`, etc.) → removed (not aliased)
- Old IPC channels (`compute:run-update`, `compute:run-complete`, `compute:environment`, all `compute:modal-*`) → removed
- Old preload methods (`onComputeRunUpdate`, `onComputeRunComplete`, `onModalPlanReady`, …) → removed
- Renderer store API renamed
- Settings keys re-shaped (`modalCompute.costThresholdUsd` → `compute.backends.modal.costThresholdUsd`)
- Spec doc `docs/spec/local-compute.md` renamed to `docs/spec/compute.md` with backend-onboarding chapter

Skills that hardcode tool names get updated in the same PR (`lib/skills/builtin/compute-environment/SKILL.md` — currently introduced by PR #62 — becomes the canonical "how to use compute" skill referring to the new tool names).

## 3. Interface Definitions

All under `lib/compute/`. Single source of truth.

### 3.1 `lib/compute/types.ts`

```typescript
import type { FailureSignal, StructuredProgress } from './shared-types.js'

/**
 * Identity + advertised capabilities of a backend.
 *
 * `id` is the public, display-friendly slug used in events, settings keys,
 * URLs, etc. It can contain hyphens ('aws-batch', 'gcp-run').
 *
 * `toolPrefix` is the prefix the registry uses to generate per-backend tool
 * names — '${toolPrefix}_execute', '${toolPrefix}_wait', etc. MUST match
 * /^[a-z][a-z0-9_]*$/ (no hyphens — they aren't valid in tool names).
 * MUST be unique across all registered backends; `Registry.register()`
 * rejects duplicates. Often equals `id` (when `id` is already tool-safe).
 * Example: `id: 'aws-batch', toolPrefix: 'aws'` → tools named
 * `aws_execute`, `aws_wait`, etc.
 *
 * v2 amendment A4: split from `id` to allow hyphenated ids while
 * keeping tool names tool-safe and stable across id rewordings.
 */
export interface BackendIdentity {
  readonly id: string                  // 'local' | 'modal' | 'aws-batch' | ...
  readonly displayName: string         // UI label
  readonly toolPrefix: string          // 'local' | 'modal' | 'aws' (see above)
}

export interface BackendCapabilities {
  /** Plan must be approved by the user before submit() runs. */
  requiresApproval: boolean
  /** Backend bills the user; cost-killing and threshold settings apply. */
  hasCost: boolean
  /** Backend can run GPU workloads. Used by planner to filter candidate backends. */
  supportsGpu: boolean
  /** Backend supports stop() once a run is in flight. */
  supportsStop: boolean
  /** Backend can stream output incrementally (vs. only on completion). */
  supportsStreaming: boolean
}

export interface BackendAvailability {
  /** Ready to accept submissions right now. */
  available: boolean
  /**
   * Human-readable list of what's missing.
   * Example: ['Modal CLI not installed', 'MODAL_TOKEN_ID env var unset']
   */
  missingRequirements: string[]
  /** Optional actionable next-steps for the UI. */
  hints?: string[]
}

/**
 * Common slice of a task profile that every backend's planner produces.
 * Backend-specific fields go into ComputePlan.backendData.
 */
export interface TaskProfile {
  cpuDensity: 'low' | 'medium' | 'high'
  gpuDensity: 'none' | 'light' | 'heavy'
  memoryPattern: 'constant' | 'growing' | 'spike'
  ioPattern: 'read_heavy' | 'write_heavy' | 'balanced' | 'minimal'
  chunkable: boolean
  resumable: boolean
  idempotent: boolean
  hasExternalSideEffects: boolean
  networkRequired: boolean
  expectedDurationClass: 'seconds' | 'minutes' | 'hours'
  reasoning: string
}

/**
 * What planner returns. Generic shape; everything backend-specific
 * (Modal image inspection, AWS queue choice, CloudLab reservation
 * request) goes under backendData with a backend-defined type.
 *
 * v2 amendment A5: `backendData` MUST be JSON-serializable (no Date /
 * Map / Set / BigInt / function / undefined values). It crosses IPC
 * via structuredClone and reaches the renderer's per-backend component
 * untouched. `backendDataVersion` is a backend-owned integer; the
 * backend bumps it on any breaking change to its `backendData` schema.
 * Renderer-side per-backend components SHOULD declare the minimum
 * version they understand and render a fallback when the field is
 * higher (indicating a newer backend wrote the record).
 */
export interface ComputePlan {
  planId: string
  backend: string                      // BackendIdentity.id
  createdAt: string                    // ISO timestamp
  taskDescription?: string
  command: string
  scriptPath?: string
  taskProfile: TaskProfile
  /** Present iff backend.capabilities.hasCost. */
  costEstimate?: CostEstimate
  /** Backend-specific extras. Backend defines the type; callers see unknown. JSON-serializable only. */
  backendData: unknown
  /** Backend-owned schema version for `backendData`. Bumped on breaking changes. */
  backendDataVersion: number
}

export interface CostEstimate {
  estimatedTotalUsd: number
  /**
   * Per-hour burn rate. Used **by the backend itself** for elapsed-cost
   * kill decisions (the backend already polls its own runs for stall
   * detection; it computes elapsed-cost in the same loop and emits
   * `cost-killed` when over threshold). Also surfaced in the UI as the
   * "burn rate".
   *
   * v2 amendment A2: previously documented as "used by Registry" — that
   * was wrong. Registry has no timing or killing logic; it only fans
   * out the `cost-killed` event a backend emits.
   */
  hourlyRateUsd: number
  expectedDurationMinutes: number
  /** Free-form notes from the cost estimator. */
  notes: string
  /**
   * Calibration of how complete this estimate is.
   *   'lower_bound' — only one cost dimension modeled (e.g. Modal GPU only,
   *                   misses CPU + RAM + idle container)
   *   'full'        — all material cost dimensions modeled
   *
   * Informational only — does NOT change kill behavior. The backend's
   * kill timer always uses `hourlyRateUsd * elapsed > threshold`,
   * even when coverage is `lower_bound`. Backends with richer cost
   * models can implement their own internal kill criterion in
   * addition; what surfaces here is the lower-bound rate-based one.
   */
  coverage: 'lower_bound' | 'full'
}

export type RunState =
  | 'pending_approval'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'cost_killed'

export function isTerminal(state: RunState): boolean {
  return state === 'completed' || state === 'failed' ||
         state === 'timed_out' || state === 'cancelled' ||
         state === 'cost_killed'
}

export interface ComputeRun {
  runId: string                        // backend-prefixed, e.g. 'lr-abc', 'mr-xyz'
  backend: string
  planId: string
  status: RunState
  command: string
  scriptPath?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  outputPath: string
  parentRunId?: string                 // retry lineage
  retryCount: number
  estimatedCostUsd?: number            // populated for hasCost backends
  /** Backend-specific snapshot for UI rendering. JSON-serializable only. */
  backendData: unknown
  /** Backend-owned schema version for `backendData`. See ComputePlan. */
  backendDataVersion: number
}

export interface RunStatus {
  status: RunState
  exitCode?: number
  elapsedSeconds: number
  outputBytes: number
  outputLines: number
  outputTail: string
  lastOutputAt?: string
  stalled: boolean
  progress?: StructuredProgress
  failure?: FailureSignal
  estimatedCostUsd?: number
  /** Backend-specific extras (e.g. Modal cost threshold, GPU stats). JSON-serializable only. */
  backendData: unknown
  /** Backend-owned schema version for `backendData`. See ComputePlan. */
  backendDataVersion: number
}

/**
 * Captured plan state — owned by Registry's PlanStore.
 *
 * v2 amendment A1: every plan is written here, regardless of whether
 * approval is required, because `Registry.submit()` needs the plan
 * by id later. `effectiveRequiresApproval` is captured at
 * `Registry.plan()` time and is IMMUTABLE for this record's lifetime.
 * `approved` starts true when no approval gate applies, false otherwise.
 */
export interface PlanRecord {
  plan: ComputePlan
  effectiveRequiresApproval: boolean
  approved: boolean
  approvedAt?: string
  rejectedAt?: string
  rejectionComments?: string
}

/**
 * Inputs to backend.plan().
 */
export interface PlanInput {
  command: string
  taskDescription?: string
  scriptPath?: string                  // resolved absolute path
  scriptContent?: string               // pre-read if available
  /** Hint from caller; backend may refine. */
  suggestedTimeoutMinutes?: number
}

/**
 * Options to backend.submit().
 */
export interface SubmitOpts {
  timeoutMinutes?: number
  stallThresholdMinutes?: number
  parentRunId?: string
}
```

### 3.2 `lib/compute/backend.ts`

```typescript
import type {
  BackendIdentity, BackendCapabilities, BackendAvailability,
  ComputePlan, ComputeRun, RunStatus, PlanInput, SubmitOpts,
} from './types.js'

/**
 * One compute backend = one implementation of this interface.
 *
 * Implementations are stateless w.r.t. each other (different backends
 * share nothing). Backend-internal state (runner pools, polling
 * timers, child processes) is encapsulated.
 */
export interface ComputeBackend {
  readonly identity: BackendIdentity
  readonly capabilities: BackendCapabilities

  /**
   * Live-probe whether this backend can accept work right now.
   * Cheap to call (sub-second). Cached by Registry for UI; backends
   * MAY return immediately if they have nothing to check.
   */
  probeAvailability(): Promise<BackendAvailability>

  /**
   * Analyze a task and produce a plan. May call out to LLM, read script,
   * inspect image declarations, etc. Backend decides how much work to do.
   *
   * MUST NOT submit. MUST be safe to call repeatedly (no side effects
   * beyond logging / cache warming).
   */
  plan(input: PlanInput): Promise<ComputePlan>

  /**
   * Kick off the plan. Returns immediately with a ComputeRun whose
   * runId can be polled. Polling + event emission is the backend's
   * responsibility; backend reports via the EventEmitter handed in at
   * construction (see ComputeContext in §3.3).
   */
  submit(plan: ComputePlan, opts: SubmitOpts): Promise<ComputeRun>

  /**
   * Synchronous snapshot of a run's current state. Returns undefined
   * if runId is unknown to this backend.
   */
  getStatus(runId: string): RunStatus | undefined

  /**
   * Block until the run reaches a terminal state OR the timeout
   * expires. Returns undefined if runId is unknown.
   */
  waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined>

  /**
   * Cancel a running task. No-op if already terminal or unknown.
   * Capability `supportsStop: false` → this method throws.
   */
  stop(runId: string): Promise<void>

  /**
   * Release resources (timers, child processes, file handles).
   * Called on coordinator teardown.
   */
  destroy(): Promise<void>

  /**
   * Hydrate persisted runs from disk for crash recovery. Returns the
   * list of runs the backend now knows about, each paired with its
   * latest status snapshot. Called once on app boot.
   *
   * v2 amendment A3: returns `{ run, status }` tuples rather than
   * `ComputeRun[]` alone. ComputeRun captures the durable record;
   * RunStatus carries live UI state (outputTail, progress, stalled,
   * failure) that the renderer needs to restore the Compute tab.
   * Avoids a follow-up getStatus() round trip per hydrated run.
   */
  hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>>
}
```

### 3.3 `lib/compute/context.ts`

What backends receive at construction time. Replaces today's `ResearchToolContext` reach-through.

```typescript
import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import type { ComputeEvent } from './events.js'

export interface ComputeContext {
  readonly projectPath: string
  readonly workspacePath: string

  /**
   * Per-backend resolved credentials. Loaded from settings.json
   * at registration time; refreshed by Registry on settings change.
   *
   * Keys are backend-defined. Local has none; Modal has
   * { tokenId, tokenSecret }; AWS would have { accessKeyId, secretAccessKey, region }.
   */
  getCredentials(): Record<string, string | undefined>

  /**
   * Per-backend cost threshold in USD. Backends with hasCost=false ignore this.
   */
  getCostThresholdUsd(): number

  /**
   * Emit an event to the Registry, which fans it out to subscribers
   * (IPC, telemetry, etc.). Replaces the modal-specific onModalCostKilled /
   * onModalRunUpdate callbacks that polluted CoordinatorConfig in PR #62.
   */
  emit(event: ComputeEvent): void

  /**
   * Pi-mono Agent class for backends that need a sub-agent (e.g. Modal's
   * plan agent which sandboxes script analysis). Provided as a class
   * reference rather than a factory closing over coordinator internals,
   * so backends are responsible for constructing with the right config.
   *
   * Backends that don't need this can ignore it.
   */
  readonly AgentClass: typeof Agent

  /**
   * Resolve the API key for a given provider — backends may need to
   * pass this to AgentClass. Same source as coordinator uses.
   */
  resolveApiKey(provider: string): string | undefined

  /**
   * Default model id (for sub-agents).
   */
  readonly defaultModelId: string
}
```

### 3.4 `lib/compute/events.ts`

```typescript
import type { ComputePlan, RunStatus, BackendAvailability } from './types.js'

export type ComputeEvent =
  | {
      kind: 'availability-changed'
      backend: string
      availability: BackendAvailability
    }
  | {
      kind: 'plan-ready'
      backend: string
      planId: string
      plan: ComputePlan
      /** True iff this plan must be approved before submit() runs. */
      requiresApproval: boolean
    }
  | {
      kind: 'plan-approved'
      backend: string
      planId: string
      approvedAt: string
    }
  | {
      kind: 'plan-rejected'
      backend: string
      planId: string
      rejectedAt: string
      comments: string
    }
  | {
      kind: 'run-update'
      backend: string
      runId: string
      status: RunStatus
    }
  | {
      kind: 'run-complete'
      backend: string
      runId: string
      status: RunStatus
    }
  | {
      kind: 'cost-killed'
      backend: string
      runId: string
      estimatedCostUsd: number
      thresholdUsd: number
    }
```

One discriminated union. One IPC channel (`compute:event`). One preload subscription (`onComputeEvent`). One renderer reducer.

### 3.5 `lib/compute/registry.ts`

```typescript
import type { ComputeBackend } from './backend.js'
import type { ComputeContext } from './context.js'
import type { ComputeEvent } from './events.js'
import type { ComputePlan, ComputeRun, RunStatus, PlanInput, SubmitOpts, PlanRecord } from './types.js'
import { PlanStore } from './plan-store.js'

export class ComputeRegistry {
  private readonly backends = new Map<string, ComputeBackend>()
  /** runId → backend, populated in submit(). Avoids guessing by prefix (amendment A1 sibling cleanup). */
  private readonly runIdRouting = new Map<string, ComputeBackend>()
  private readonly plans: PlanStore
  private readonly subscribers = new Set<(event: ComputeEvent) => void>()
  private forceApproval: boolean

  constructor(opts: { projectPath: string; forceApproval: boolean }) {
    this.plans = new PlanStore(opts.projectPath)
    this.forceApproval = opts.forceApproval
  }

  /**
   * Update the global approval-override flag. v2 amendment A1: this
   * affects only *future* plans. Plans already written to PlanStore
   * keep their captured `effectiveRequiresApproval`. The whole point
   * of capturing is to eliminate the settings-flip-between-plan-
   * and-submit race.
   */
  setForceApproval(value: boolean): void { this.forceApproval = value }

  register(backend: ComputeBackend): void {
    if (this.backends.has(backend.identity.id)) {
      throw new Error(`Backend id collision: ${backend.identity.id}`)
    }
    for (const existing of this.backends.values()) {
      if (existing.identity.toolPrefix === backend.identity.toolPrefix) {
        throw new Error(`Backend toolPrefix collision: '${backend.identity.toolPrefix}' already used by '${existing.identity.id}'`)
      }
    }
    if (!/^[a-z][a-z0-9_]*$/.test(backend.identity.toolPrefix)) {
      throw new Error(`Backend toolPrefix '${backend.identity.toolPrefix}' is not tool-safe (must match /^[a-z][a-z0-9_]*$/)`)
    }
    this.backends.set(backend.identity.id, backend)
  }

  list(): ComputeBackend[] {
    return [...this.backends.values()]
  }

  get(backendId: string): ComputeBackend | undefined {
    return this.backends.get(backendId)
  }

  // ── Plan + approval ──────────────────────────────────────────────────
  /**
   * v2 amendment A1: every plan gets a PlanRecord, regardless of
   * whether approval is required. The captured
   * `effectiveRequiresApproval` is final for this record's lifetime;
   * later settings flips do not affect it.
   */
  async plan(backendId: string, input: PlanInput): Promise<ComputePlan> {
    const backend = this.requireBackend(backendId)
    const plan = await backend.plan(input)
    const effectiveRequiresApproval = this.forceApproval || backend.capabilities.requiresApproval
    const record: PlanRecord = {
      plan,
      effectiveRequiresApproval,
      approved: !effectiveRequiresApproval,   // auto-approved when no gate
    }
    this.plans.write(backendId, plan.planId, record)
    this.emit({
      kind: 'plan-ready',
      backend: backendId,
      planId: plan.planId,
      plan,
      requiresApproval: effectiveRequiresApproval,
    })
    return plan
  }

  approvePlan(backendId: string, planId: string): boolean {
    const record = this.plans.read(backendId, planId)
    if (!record) return false
    if (!record.effectiveRequiresApproval) return false   // no gate to approve
    const approvedAt = new Date().toISOString()
    this.plans.write(backendId, planId, { ...record, approved: true, approvedAt, rejectedAt: undefined, rejectionComments: undefined })
    this.emit({ kind: 'plan-approved', backend: backendId, planId, approvedAt })
    return true
  }

  rejectPlan(backendId: string, planId: string, comments: string): boolean {
    const record = this.plans.read(backendId, planId)
    if (!record) return false
    if (!record.effectiveRequiresApproval) return false
    const rejectedAt = new Date().toISOString()
    this.plans.write(backendId, planId, { ...record, approved: false, rejectedAt, rejectionComments: comments, approvedAt: undefined })
    this.emit({ kind: 'plan-rejected', backend: backendId, planId, rejectedAt, comments })
    return true
  }

  // ── Submit ──────────────────────────────────────────────────────────
  /**
   * v2 amendment A1: relies entirely on the captured PlanRecord. No
   * re-derivation from current settings — that was the bug.
   */
  async submit(backendId: string, planId: string, opts: SubmitOpts): Promise<ComputeRun> {
    const backend = this.requireBackend(backendId)
    const record = this.plans.read(backendId, planId)
    if (!record) throw new Error(`No plan ${planId} for backend ${backendId}`)
    if (record.effectiveRequiresApproval && !record.approved) {
      throw new Error(`Plan ${planId} requires approval and has not been approved yet`)
    }
    if (record.rejectedAt) {
      throw new Error(`Plan ${planId} was rejected; produce a new plan before submitting`)
    }
    const run = await backend.submit(record.plan, opts)
    this.runIdRouting.set(run.runId, backend)
    this.plans.clear(backendId, planId)
    return run
  }

  // ── Run inspection ──────────────────────────────────────────────────
  getStatus(runId: string): RunStatus | undefined {
    return this.runIdRouting.get(runId)?.getStatus(runId)
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    return this.runIdRouting.get(runId)?.waitForCompletion(runId, timeoutMs)
  }

  async stop(runId: string): Promise<void> {
    const backend = this.runIdRouting.get(runId)
    if (!backend) throw new Error(`Unknown run: ${runId}`)
    if (!backend.capabilities.supportsStop) throw new Error(`Backend ${backend.identity.id} does not support stop`)
    return backend.stop(runId)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  async destroy(): Promise<void> {
    await Promise.allSettled([...this.backends.values()].map(b => b.destroy()))
  }

  /**
   * v2 amendment A3: returns runs paired with their latest status,
   * so the renderer can restore the Compute tab in one round trip.
   */
  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> {
    const all: Array<{ run: ComputeRun; status: RunStatus }> = []
    for (const backend of this.backends.values()) {
      try {
        const entries = await backend.hydrate()
        for (const entry of entries) {
          this.runIdRouting.set(entry.run.runId, backend)
          all.push(entry)
        }
      } catch { /* non-fatal */ }
    }
    return all
  }

  // ── Events ──────────────────────────────────────────────────────────
  subscribe(cb: (event: ComputeEvent) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  emit(event: ComputeEvent): void {
    for (const sub of this.subscribers) sub(event)
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  private requireBackend(backendId: string): ComputeBackend {
    const backend = this.backends.get(backendId)
    if (!backend) throw new Error(`Unknown compute backend: ${backendId}`)
    return backend
  }
}
```

### 3.5.1 `lib/compute/plan-store.ts`

Persistent home of `PlanRecord`. Backed by a single JSON file at `.research-pilot/compute-plans.json` (the volume is small — handful of plans at most, all of them either pending approval or briefly in-flight between plan() and submit()).

```typescript
import fs from 'node:fs'
import path from 'node:path'
import type { PlanRecord } from './types.js'

export class PlanStore {
  private readonly filePath: string
  // Layout: { [`${backend}::${planId}`]: PlanRecord }
  // In-memory cache so reads are O(1); writes flush to disk.
  private cache: Record<string, PlanRecord> | null = null

  constructor(projectPath: string) {
    this.filePath = path.join(projectPath, '.research-pilot', 'compute-plans.json')
  }

  private load(): Record<string, PlanRecord> {
    if (this.cache) return this.cache
    try {
      if (!fs.existsSync(this.filePath)) { this.cache = {}; return this.cache }
      this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      return this.cache!
    } catch {
      this.cache = {}
      return this.cache
    }
  }

  private flush(): void {
    if (!this.cache) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp.' + process.pid + '.' + Date.now()
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  private key(backendId: string, planId: string): string { return `${backendId}::${planId}` }

  read(backendId: string, planId: string): PlanRecord | undefined {
    return this.load()[this.key(backendId, planId)]
  }

  write(backendId: string, planId: string, record: PlanRecord): void {
    const cache = this.load()
    cache[this.key(backendId, planId)] = record
    this.flush()
  }

  clear(backendId: string, planId: string): void {
    const cache = this.load()
    delete cache[this.key(backendId, planId)]
    this.flush()
  }

  /** Used by Registry.hydrate() to surface plans still awaiting approval after a crash. */
  listPending(): Array<{ backend: string; planId: string; record: PlanRecord }> {
    const result: Array<{ backend: string; planId: string; record: PlanRecord }> = []
    for (const [k, record] of Object.entries(this.load())) {
      if (record.effectiveRequiresApproval && !record.approved && !record.rejectedAt) {
        const [backend, planId] = k.split('::')
        result.push({ backend, planId, record })
      }
    }
    return result
  }
}
```

## 4. Tool Surface (per locked decision 2.1)

### 4.1 `compute_plan` — single generic tool

```typescript
{
  name: 'compute_plan',
  label: 'Compute: Plan',
  description:
    'Analyze a compute task and produce an execution plan. ' +
    'Choose a backend by id (call list_compute_backends first if unsure). ' +
    'Plans for backends with requiresApproval=true wait for user approval before execute.',
  parameters: Type.Object({
    backend: Type.String({ description: 'Backend id: "local" | "modal" | ...' }),
    command: Type.String(),
    task_description: Type.Optional(Type.String()),
    script_path: Type.Optional(Type.String()),
    timeout_minutes: Type.Optional(Type.Number()),
  }),
  execute: async (_id, raw) => {
    const params = raw as any
    const plan = await registry.plan(params.backend, {
      command: params.command,
      taskDescription: params.task_description,
      scriptPath: params.script_path && resolvePath(workspace, params.script_path),
      suggestedTimeoutMinutes: params.timeout_minutes,
    })
    // v2 amendment A1: report the EFFECTIVE approval requirement
    // (captured at plan() time, may differ from backend.capabilities
    // when forceApproval is enabled). PlanRecord is the source of truth.
    const record = registry.getPlanRecord(plan.backend, plan.planId)!
    const toolPrefix = registry.get(plan.backend)!.identity.toolPrefix
    return toAgentResult('compute_plan', {
      success: true,
      data: {
        backend: plan.backend,
        plan_id: plan.planId,
        task_profile: plan.taskProfile,
        cost_estimate: plan.costEstimate,           // undefined for free backends
        backend_data: plan.backendData,             // image inspection, queue info, etc.
        backend_data_version: plan.backendDataVersion,
        requires_approval: record.effectiveRequiresApproval,
        message: record.effectiveRequiresApproval
          ? `Plan ready. Ask the user to approve in the Compute tab before calling ${toolPrefix}_execute.`
          : `Plan ready. Call ${toolPrefix}_execute to run.`,
      },
    })
  },
}
```

### 4.2 `list_compute_backends` — single generic introspection tool

```typescript
{
  name: 'list_compute_backends',
  description: 'List available compute backends and their capabilities. Call this to decide which backend to use for a task.',
  parameters: Type.Object({}),
  execute: async () => {
    const backends = registry.list()
    const results = await Promise.all(backends.map(async b => ({
      id: b.identity.id,
      display_name: b.identity.displayName,
      capabilities: b.capabilities,
      availability: await b.probeAvailability(),
    })))
    return toAgentResult('list_compute_backends', { success: true, data: { backends: results } })
  },
}
```

### 4.3 Per-backend execute / wait / status / stop

Generated by registry at startup for each registered backend. Tool description is templated with backend-specific guidance:

```typescript
function createBackendTools(backend: ComputeBackend, registry: ComputeRegistry): AgentTool[] {
  // v2 amendment A4: use toolPrefix (tool-safe), not id (which may
  // contain hyphens like 'aws-batch'). Registry.register() guarantees
  // toolPrefix matches /^[a-z][a-z0-9_]*$/ and is unique.
  const toolPrefix = backend.identity.toolPrefix
  const backendId = backend.identity.id
  return [
    {
      name: `${toolPrefix}_execute`,
      label: `${backend.identity.displayName}: Execute`,
      description: buildExecuteDescription(backend),  // e.g. Modal: "Call compute_plan first and wait for user approval."
      parameters: Type.Object({
        plan_id: Type.String(),
        timeout_minutes: Type.Optional(Type.Number()),
        stall_threshold_minutes: Type.Optional(Type.Number()),
        parent_run_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, raw) => {
        const params = raw as any
        const run = await registry.submit(backendId, params.plan_id, {
          timeoutMinutes: params.timeout_minutes,
          stallThresholdMinutes: params.stall_threshold_minutes,
          parentRunId: params.parent_run_id,
        })
        return toAgentResult(`${toolPrefix}_execute`, { success: true, data: serializeRun(run) })
      },
    },
    // ... _wait, _status, _stop — same pattern; all use toolPrefix for
    // tool naming but pass backendId to registry.* calls.
  ]
}
```

### 4.4 Total tool count

For N=2 (local + modal):
- 2 generic tools (`compute_plan`, `list_compute_backends`)
- 4 × 2 = 8 backend tools
- **Total: 10**

PR #62 today has 9 (compute_plan + 4 local + 4 modal). The new surface is one tool larger (the introspection helper) but the per-backend extension cost is now fixed at 4 — same as adding any other backend.

## 5. IPC + Renderer Surface

### 5.1 Main process

Replaces 8 current channels with 1 + 3 handlers:

```typescript
// One outbound channel
'compute:event'  // payload: ComputeEvent (discriminated union)

// Three invoke handlers
'compute:hydrate'        → { runs: Array<{ run: ComputeRun; status: RunStatus }>; pendingPlans: Array<{ backend, planId, record: PlanRecord }> }
'compute:approve-plan'   (backend: string, planId: string) → { success, error? }
'compute:reject-plan'    (backend: string, planId: string, comments: string) → { success, error? }
```

That's it. No backend-specific channels.

`compute:hydrate` (v2 amendment A3) returns both:
- **runs** — each run paired with its latest RunStatus so the renderer can restore live UI state (outputTail, progress, stalled) without a follow-up round trip
- **pendingPlans** — plans still awaiting approval, sourced from `PlanStore.listPending()`, so a crashed approval gate isn't silently lost

### 5.2 Preload

```typescript
interface ElectronAPI {
  // ... existing non-compute methods ...

  isComputeEnabled: () => boolean
  hydrateCompute: () => Promise<{
    runs: Array<{ run: ComputeRun; status: RunStatus }>
    pendingPlans: Array<{ backend: string; planId: string; record: PlanRecord }>
  }>
  approveComputePlan: (backend: string, planId: string) => Promise<{ success: boolean; error?: string }>
  rejectComputePlan: (backend: string, planId: string, comments: string) => Promise<{ success: boolean; error?: string }>
  onComputeEvent: (cb: (event: ComputeEvent) => void) => () => void
}
```

5 methods total (was 8 in PR #62). Adding a backend = 0 new preload methods.

### 5.3 Renderer store

```typescript
interface ComputeState {
  backends: Map<string, BackendView>           // { capabilities, availability }
  runs: Map<string, ComputeRunView>            // each run carries backend field
  pendingPlans: Map<string, ComputePlanView>   // key: `${backend}::${planId}`
  costThresholds: Record<string, number>       // per-backend, from settings

  applyEvent: (event: ComputeEvent) => void    // single reducer for all events
  // ...
}
```

Single `applyEvent` reducer dispatches on `event.kind`. UI components subscribe to slices.

### 5.4 UI

`ComputeView.tsx`:
- Backend picker at top (lists registered backends with availability badges)
- Pending plans panel (shows plans for whichever backend has one; same UI shape, plan-specific details rendered from `plan.backendData` via per-backend renderer components like `<ModalPlanDetails plan={plan.backendData}/>`)
- Run list (shows all runs across backends; backend badge per row)

Per-backend UI extras (Modal image inspection details, AWS queue stats, CloudLab reservation info) live in `app/src/renderer/components/center/compute/<backend>/` and are imported by `ComputeView` via a registry-style lookup.

v2 amendment A5: per-backend renderer components MUST check `backendDataVersion` on the plan/run before unpacking `backendData`. Convention:

```typescript
const MIN_SUPPORTED_VERSION = 1
export function ModalPlanDetails({ plan }: { plan: ComputePlanView }) {
  if (plan.backendDataVersion < MIN_SUPPORTED_VERSION) {
    return <BackendDataUnsupported reason="older than this build expects" />
  }
  if (plan.backendDataVersion > KNOWN_MAX_VERSION) {
    return <BackendDataUnsupported reason="newer than this build understands; try updating the app" />
  }
  // ... safe to unpack ...
}
```

The version is owned by the backend; bump it only on breaking shape changes (additive optional fields don't require a bump).

## 6. Open Questions (deferred to implementation)

These don't need to be settled before code starts but flag them so implementer doesn't waste time relitigating.

> **Resolved by v2 review (see §0.1 Amendments):**
> - ~~6.1 No-approval plan retrieval~~ — settled by amendment A1 (every plan is written to `PlanStore` with captured `effectiveRequiresApproval`; submit() reads from there regardless of whether a gate applies).
> - ~~6.2 Backend prefix collisions~~ — settled by amendment A4 (`Registry.register()` enforces `toolPrefix` uniqueness; runId routing is the `runId → backend` map populated at submit() time, not prefix-string guessing).
> - ~~6.3 Cost-killing for backends without `gpuRateUsdPerHour`~~ — settled by amendment A2 (cost-killing is backend-owned; each backend defines its own kill criterion using whatever signal makes sense for its billing model, and emits `cost-killed` for Registry fan-out).

### 6.1 Streaming vs. polling

PR #62's Modal runner polls the output file every 5 seconds and re-reads the last 8 KB. AWS CloudWatch can stream via subscription, GCP Cloud Logging similar. The interface today implies polling (no streaming method on `ComputeBackend`). Future amendment:

```typescript
// Future: backends with supportsStreaming=true can register a streaming source
onOutput?(runId: string, cb: (chunk: string) => void): () => void
```

Defer to backend #3 actually needing this.

### 6.2 Per-backend skill files

Today PR #62 ships `lib/skills/builtin/compute-environment/SKILL.md`. New convention: each backend gets its own skill file (`compute-local`, `compute-modal`, `compute-aws`), loaded on demand. The generic `compute_plan` description mentions "consult `compute-<backend>` skill for the chosen backend".

## 7. Migration Checklist

Single PR, ordered work. Each box should be a clean intermediate commit.

### 7.1 Foundation (new code, no deletions yet)

- [ ] Create `lib/compute/` directory
- [ ] `lib/compute/types.ts` — all types from §3.1
- [ ] `lib/compute/backend.ts` — `ComputeBackend` interface
- [ ] `lib/compute/context.ts` — `ComputeContext` interface
- [ ] `lib/compute/events.ts` — `ComputeEvent` discriminated union
- [ ] `lib/compute/registry.ts` — `ComputeRegistry` class
- [ ] `lib/compute/plan-store.ts` — Registry-owned, keyed by (backend, planId); stores every plan with captured `effectiveRequiresApproval` (v2 amendment A1)
- [ ] `lib/compute/shared-types.ts` — move `FailureSignal` + `StructuredProgress` here (currently in `lib/local-compute/types.ts`)
- [ ] Unit tests: `lib/compute/__tests__/registry.test.ts`, `plan-store.test.ts`, `events.test.ts`

### 7.2 Port local-compute

- [ ] Create `lib/compute/backends/local/` (move existing local-compute internals here)
- [ ] Implement `LocalBackend implements ComputeBackend`:
  - `identity: { id: 'local', displayName: 'Local', toolPrefix: 'local' }`
  - `capabilities: { requiresApproval: false, hasCost: false, supportsGpu: <detected>, supportsStop: true, supportsStreaming: false }`
  - `plan()` returns plan with `costEstimate: undefined`, `backendData: { sandbox: 'docker' | 'process', resourceSnapshot: {...} }`, `backendDataVersion: 1`
  - `submit()` uses existing `ComputeRunner`
  - `hydrate()` returns `Array<{ run, status }>`: reads existing `.research-pilot/compute-runs/` and pairs each record with `getStatus()` (v2 amendment A3)
- [ ] Delete `lib/local-compute/tools.ts` (no longer needed)
- [ ] Migrate experience store: `compute-runs/experience.jsonl` → namespaced per backend? Or keep shared (probably keep shared — task-kind taxonomy is cross-backend useful)
- [ ] Unit tests: `lib/compute/backends/local/__tests__/local-backend.test.ts`

### 7.3 Port modal-compute

- [ ] Create `lib/compute/backends/modal/` (move `lib/modal-compute/` internals here)
- [ ] Implement `ModalBackend implements ComputeBackend`:
  - `identity: { id: 'modal', displayName: 'Modal', toolPrefix: 'modal' }` (v2 amendment A4)
  - `capabilities: { requiresApproval: true, hasCost: true, supportsGpu: true, supportsStop: true, supportsStreaming: false }`
  - `plan()` runs the plan-agent (now constructed via `ctx.AgentClass` + `ctx.resolveApiKey` + `ctx.defaultModelId`, NOT via `createSubAgent`)
  - `submit()` uses existing `ModalRunner`
  - **Backend owns cost-killing** (v2 amendment A2): runner polls each active run; when `hourlyRateUsd * elapsed > ctx.getCostThresholdUsd()` it kills its child process and emits `{ kind: 'cost-killed', ... }` via `ctx.emit`. Registry has no kill timer of its own.
  - `hydrate()` returns `Array<{ run, status }>` (v2 amendment A3): reads `modal-runs.json` for in-flight runs, calls own `getStatus()` for the live snapshot, pairs them up
- [ ] Delete `lib/modal-compute/` (now lives in `lib/compute/backends/modal/`)
- [ ] Unit tests: `lib/compute/backends/modal/__tests__/modal-backend.test.ts`, `cost-estimator.test.ts`, `plan-agent.test.ts`

### 7.4 Coordinator integration

- [ ] Remove from `CoordinatorConfig`: `modalCredentials`, `onModalCostKilled`, `onModalRunUpdate`, `createSubAgent`
- [ ] Add to `CoordinatorConfig`:
  ```typescript
  computeRegistry?: ComputeRegistry              // pre-built by main process
  // OR
  computeBackends?: ComputeBackend[]             // coordinator builds registry
  ```
- [ ] Update `createResearchTools()` to consume the registry and emit:
  - `compute_plan`, `list_compute_backends`
  - For each registered backend: `<id>_execute`, `<id>_wait`, `<id>_status`, `<id>_stop`

### 7.5 IPC consolidation

- [ ] Delete IPC channels: `compute:run-update`, `compute:run-complete`, `compute:environment`, `compute:modal-plan-ready`, `compute:modal-plan-approved`, `compute:modal-plan-rejected`, `compute:modal-available`, `compute:modal-cost-killed`
- [ ] Add IPC channels: `compute:event` (outbound), `compute:hydrate`, `compute:approve-plan`, `compute:reject-plan` (handlers)
- [ ] In `ensureCoordinator`, subscribe Registry events → `safeSend(win, 'compute:event', event)`
- [ ] Remove `unwrapToolResult` + per-tool result forwarding from `agent:done` handler (events come from Registry now, not from inspecting tool results)

### 7.6 Preload + renderer

- [ ] Delete preload methods: `onComputeRunUpdate`, `onComputeRunComplete`, `onComputeEnvironment`, `onModalPlanReady`, `onModalPlanApproved`, `onModalPlanRejected`, `onModalAvailable`, `onModalCostKilled`, `probeComputeEnvironment`, `approveModalPlan`, `rejectModalPlan`
- [ ] Add preload methods: `onComputeEvent`, `hydrateComputeRuns`, `approveComputePlan`, `rejectComputePlan`
- [ ] Renderer store `compute-store.ts`:
  - Add `backends: Map<string, BackendView>`, `pendingPlans: Map<string, ComputePlanView>`
  - Replace ad-hoc setters with single `applyEvent(event)` reducer
  - Migrate selectors (`useComputeRuns`, etc.) to new shape
- [ ] `App.tsx`: replace 7 individual `onModal*` subscriptions with one `onComputeEvent` → `compute.applyEvent(event)`
- [ ] `ComputeView.tsx`: add backend picker; refactor pending-plan panel to dispatch to per-backend renderer

### 7.7 Settings

- [ ] In `shared-electron/ipc-base.ts` and `shared-ui/settings-types.ts`:
  ```typescript
  interface ComputeSettings {
    enabledBackends: string[]                          // ['local', 'modal']
    defaultBackend: string                             // 'local'
    requireApprovalForAllBackends: boolean             // false
    backends: Record<string, BackendSettings>          // per-backend bag
  }
  interface BackendSettings {
    costThresholdUsd?: number                          // for hasCost backends
    [extra: string]: unknown                           // backend-specific
  }
  ```
- [ ] Migrate `modalCompute.costThresholdUsd` → `compute.backends.modal.costThresholdUsd`
- [ ] Add settings migration in `loadSettingsFromConfig`

### 7.8 Spec doc

- [ ] Rename `docs/spec/local-compute.md` → `docs/spec/compute.md`
- [ ] New §15: "Adding a new backend" — checklist + code template
- [ ] Update §14 (AgentTools) for the new generic + per-backend tool surface
- [ ] Remove old §14.1 (`local_compute_plan`), §14.2 (`local_compute_execute`), etc.

### 7.9 Skills

- [ ] Split `lib/skills/builtin/compute-environment/SKILL.md` into:
  - `compute-environment/` (umbrella; how to choose a backend; lists tools)
  - `compute-local/SKILL.md` (local-specific patterns: sandboxes, file I/O conventions)
  - `compute-modal/SKILL.md` (Modal-specific: image declaration tips, GPU type choice, cost awareness)
- [ ] Update existing skill prompts to use new tool names

### 7.10 Cleanup

- [ ] Delete `lib/local-compute/` (now `lib/compute/backends/local/`)
- [ ] Delete `lib/modal-compute/` (now `lib/compute/backends/modal/`)
- [ ] Delete `lib/compute/plan-tool.ts` from PR #62 (replaced by `lib/compute/tools.ts` generic + per-backend)
- [ ] Delete `app/src/main/compute-run-events.ts` from PR #62 (no longer needed; backends emit structured events directly)
- [ ] Final build + full test pass on all 3 platforms

## 8. Test Plan

Tests this PR MUST add (PR #62 has zero):

### 8.1 Unit

- [ ] `Registry.register()` — rejects duplicate `id`; rejects duplicate `toolPrefix`; rejects `toolPrefix` failing the regex (amendment A4)
- [ ] `Registry.plan()` — writes PlanRecord with captured `effectiveRequiresApproval` (amendment A1); auto-approved when no gate; pending when gate; emits `plan-ready` with effective flag
- [ ] `Registry.submit()` — uses captured PlanRecord, not current settings (amendment A1); rejects unapproved plan; rejects already-rejected plan; clears PlanStore after submit; populates `runIdRouting` map
- [ ] `Registry.submit()` — settings flip between plan and submit does NOT change submit behavior (pins amendment A1)
- [ ] `Registry.hydrate()` — returns `{ run, status }` tuples (amendment A3); populates `runIdRouting` so subsequent stop/status route correctly
- [ ] `PlanStore` — write / read / approve / reject / clear lifecycle; concurrent (backend, planId) keys don't collide; `listPending()` returns only ungated unapproved entries
- [ ] `LocalBackend` — plan returns `costEstimate: undefined`, `backendDataVersion >= 1`; submit returns running run; status reflects child process state; stop sends SIGTERM; hydrate pairs records with live status
- [ ] `ModalBackend` — plan calls plan-agent; **backend-owned cost-killer fires when `hourlyRateUsd * elapsed > threshold`** (mocked clock); cost-kill emits `cost-killed` event with `backend: 'modal'` (amendment A2); stop sends SIGTERM
- [ ] `Cost-estimator` — `coverage: 'lower_bound'` flag set when only GPU dimension modeled; flag is informational only (does NOT change kill behavior, per amendment A2)
- [ ] **Renderer schema-version guard** — per-backend component renders fallback when `backendDataVersion` exceeds the renderer's `KNOWN_MAX_VERSION` (amendment A5)
- [ ] **`backendData` JSON-serializability** — test that each backend's plan/run survives `JSON.parse(JSON.stringify(x))` round trip without loss (amendment A5)

### 8.2 Integration

- [ ] End-to-end with mocked Modal CLI: plan → approve → submit → wait → complete; events arrive in expected order
- [ ] End-to-end local: plan → submit (no approval) → wait → complete (proves amendment A1 no-approval path)
- [ ] Crash recovery: write run + plan files → restart → `registry.hydrate()` + `PlanStore.listPending()` repopulates both the Compute tab AND the pending-approval panel
- [ ] Settings flip across submit: plan a local task → flip `requireApprovalForAllBackends` true → submit succeeds anyway because the original plan captured `effectiveRequiresApproval: false` (pins amendment A1)
- [ ] Settings flip before plan: flip `requireApprovalForAllBackends` true → new local plan now requires approval (pins amendment A1's "affects future plans only")

### 8.3 Manual / smoke

- [ ] All five test-plan items from PR #62 (Modal not installed → guidance, etc.) still pass under new architecture

## 9. PR Roadmap

One PR. The 10 sub-sections of §7 should be 10 logical commits in that order. Total estimated diff: +5,500 / -3,200 (the new abstraction + backends; minus what gets deleted from PR #62's modal-compute + local-compute).

Branch: `feat/compute-backend-abstraction`

Sequencing relative to PR #62:
- PR #62 stays open (review feedback continues), but **does not merge**
- This RFC's PR is **based on PR #62's branch** (`codex/modal_integration`) — the work is "take what's there and refactor it", not "throw away and restart"
- When the abstraction PR is ready, PR #62 is closed in favor of this one (or this one supersedes it via base-branch swap)

## 10. Out of Scope for This Note

- Specific AWS Batch / GCP Run / CloudLab backend implementations — those come after the abstraction lands and become reference exercises for "did we get the interface right?"
- Streaming output (§6.1)
- Multi-region / multi-account credentials for cloud backends (when needed: add `getCredentials(region?, account?)` overload)
- UI redesign of `ComputeView` beyond what's needed to show multiple backends (the layout cleanup is a follow-up design pass)
- Telemetry events for compute (today emitted via `beforeToolCall`/`afterToolCall` hooks; consider whether `ComputeEvent` should also be telemetry-emitted in a follow-up)

## 11. Why This RFC Now (and not later)

| Window | Cost to refactor |
|---|---|
| **Now, before PR #62 merges** (zero Modal users) | One refactor PR; everything is private API |
| After PR #62 merges, before any other backend | One refactor PR + one deprecation cycle for `modal_*` tool names + IPC channels |
| After 2nd backend lands | Two backends to migrate; tool-name aliases for backwards compat; renderer store has multiple shapes to support; minimum 2x the work |
| After 3rd backend lands | Probably skip the abstraction entirely — too costly, settle for codified boilerplate per backend |

The shape of the abstraction will not improve by waiting. Real-world usage data won't change the answer because no one is using Modal yet. The cheapest day to do this is the day before PR #62 merges.
