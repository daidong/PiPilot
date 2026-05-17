# Design Note 008: Compute Backend Abstraction

**Status:** Draft (v1) — pending review before any code lands
**Author:** Captain + Claude
**Date:** 2026-05-17
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

The `PendingPlanStore` becomes a single Registry-owned component keyed by `(backend, planId)`.

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
 */
export interface BackendIdentity {
  readonly id: string                  // 'local' | 'modal' | 'aws-batch' | ...
  readonly displayName: string         // UI label
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
  /** Backend-specific extras. Backend defines the type; callers see unknown. */
  backendData: unknown
}

export interface CostEstimate {
  estimatedTotalUsd: number
  /** Per-hour burn rate; used by Registry for elapsed-cost killing. */
  hourlyRateUsd: number
  expectedDurationMinutes: number
  /** Free-form notes from the cost estimator. */
  notes: string
  /**
   * Calibration of how complete this estimate is.
   *   'lower_bound' — only one cost dimension modeled (e.g. Modal GPU only,
   *                   misses CPU + RAM + idle container)
   *   'full'        — all material cost dimensions modeled
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
  /** Backend-specific snapshot for UI rendering. Backend defines the type. */
  backendData: unknown
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
  /** Backend-specific extras (e.g. Modal cost threshold, GPU stats). */
  backendData: unknown
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
   * list of runs the backend now knows about. Called once on app boot.
   */
  hydrate(): Promise<ComputeRun[]>
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
import type { ComputePlan, ComputeRun, RunStatus, PlanInput, SubmitOpts } from './types.js'
import { PendingPlanStore } from './pending-plan-store.js'

export class ComputeRegistry {
  private readonly backends = new Map<string, ComputeBackend>()
  private readonly pendingPlans: PendingPlanStore
  private readonly subscribers = new Set<(event: ComputeEvent) => void>()
  private forceApproval: boolean

  constructor(opts: { projectPath: string; forceApproval: boolean }) {
    this.pendingPlans = new PendingPlanStore(opts.projectPath)
    this.forceApproval = opts.forceApproval
  }

  setForceApproval(value: boolean): void { this.forceApproval = value }

  register(backend: ComputeBackend): void {
    this.backends.set(backend.identity.id, backend)
  }

  list(): ComputeBackend[] {
    return [...this.backends.values()]
  }

  get(backendId: string): ComputeBackend | undefined {
    return this.backends.get(backendId)
  }

  /**
   * Resolve which backend owns a runId via the backend prefix
   * (`lr-...` → local, `mr-...` → modal, etc.). Backends register their
   * prefix as part of identity; Registry maintains the routing table.
   */
  resolveBackendByRunId(runId: string): ComputeBackend | undefined {
    for (const backend of this.backends.values()) {
      if (backend.getStatus(runId)) return backend
    }
    return undefined
  }

  // ── Plan + approval ──────────────────────────────────────────────────
  async plan(backendId: string, input: PlanInput): Promise<ComputePlan> {
    const backend = this.requireBackend(backendId)
    const plan = await backend.plan(input)
    const needsApproval = this.forceApproval || backend.capabilities.requiresApproval
    if (needsApproval) {
      this.pendingPlans.write(plan)
    }
    this.emit({
      kind: 'plan-ready',
      backend: backendId,
      planId: plan.planId,
      plan,
      requiresApproval: needsApproval,
    })
    return plan
  }

  approvePlan(backendId: string, planId: string): boolean {
    const ok = this.pendingPlans.approve(backendId, planId)
    if (ok) this.emit({ kind: 'plan-approved', backend: backendId, planId, approvedAt: new Date().toISOString() })
    return ok
  }

  rejectPlan(backendId: string, planId: string, comments: string): boolean {
    const ok = this.pendingPlans.reject(backendId, planId, comments)
    if (ok) this.emit({ kind: 'plan-rejected', backend: backendId, planId, rejectedAt: new Date().toISOString(), comments })
    return ok
  }

  // ── Submit ──────────────────────────────────────────────────────────
  async submit(backendId: string, planId: string, opts: SubmitOpts): Promise<ComputeRun> {
    const backend = this.requireBackend(backendId)
    const needsApproval = this.forceApproval || backend.capabilities.requiresApproval
    let plan: ComputePlan
    if (needsApproval) {
      const stored = this.pendingPlans.read(backendId, planId)
      if (!stored) throw new Error(`No pending plan ${planId} for backend ${backendId}`)
      if (!stored.approved) throw new Error(`Plan ${planId} not approved yet`)
      plan = stored.plan
      this.pendingPlans.clear(backendId, planId)
    } else {
      // No approval gate: the plan is expected to be passed back from the
      // most recent plan() call via an in-memory cache (or re-planned).
      // Implementation detail — see §6.
      throw new Error('TODO: implement no-approval-path plan retrieval')
    }
    return backend.submit(plan, opts)
  }

  // ── Run inspection ──────────────────────────────────────────────────
  getStatus(runId: string): RunStatus | undefined {
    const backend = this.resolveBackendByRunId(runId)
    return backend?.getStatus(runId)
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    const backend = this.resolveBackendByRunId(runId)
    return backend?.waitForCompletion(runId, timeoutMs)
  }

  async stop(runId: string): Promise<void> {
    const backend = this.resolveBackendByRunId(runId)
    if (!backend) throw new Error(`Unknown run: ${runId}`)
    if (!backend.capabilities.supportsStop) throw new Error(`Backend ${backend.identity.id} does not support stop`)
    return backend.stop(runId)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  async destroy(): Promise<void> {
    await Promise.allSettled([...this.backends.values()].map(b => b.destroy()))
  }

  async hydrate(): Promise<ComputeRun[]> {
    const all: ComputeRun[] = []
    for (const backend of this.backends.values()) {
      try { all.push(...await backend.hydrate()) } catch { /* non-fatal */ }
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
    return toAgentResult('compute_plan', {
      success: true,
      data: {
        backend: plan.backend,
        plan_id: plan.planId,
        task_profile: plan.taskProfile,
        cost_estimate: plan.costEstimate,  // undefined for free backends
        backend_data: plan.backendData,    // image inspection, queue info, etc.
        requires_approval: registry.get(plan.backend)!.capabilities.requiresApproval,
        message: needsApproval(plan) ? 'Plan ready. Ask the user to approve in the Compute tab before calling <backend>_execute.' : 'Plan ready. Call <backend>_execute to run.',
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
  const prefix = backend.identity.id
  return [
    {
      name: `${prefix}_execute`,
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
        const run = await registry.submit(prefix, params.plan_id, {
          timeoutMinutes: params.timeout_minutes,
          stallThresholdMinutes: params.stall_threshold_minutes,
          parentRunId: params.parent_run_id,
        })
        return toAgentResult(`${prefix}_execute`, { success: true, data: serializeRun(run) })
      },
    },
    // ... _wait, _status, _stop — same pattern
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
'compute:hydrate'        → ComputeRun[]
'compute:approve-plan'   (backend: string, planId: string) → { success, error? }
'compute:reject-plan'    (backend: string, planId: string, comments: string) → { success, error? }
```

That's it. No backend-specific channels.

### 5.2 Preload

```typescript
interface ElectronAPI {
  // ... existing non-compute methods ...

  isComputeEnabled: () => boolean
  hydrateComputeRuns: () => Promise<ComputeRun[]>
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

## 6. Open Questions (deferred to implementation)

These don't need to be settled before code starts but flag them so implementer doesn't waste time relitigating.

### 6.1 No-approval plan retrieval

`registry.submit(backendId, planId, opts)` needs the plan, but when `requiresApproval=false` we don't write to `PendingPlanStore`. Options:
- (a) Write to `PendingPlanStore` unconditionally with `approved: true` for no-approval backends. Cost: file write on every plan().
- (b) In-memory plan cache per backend, keyed by planId, evicted on submit() or after TTL.
- (c) Have `compute_plan` return the full plan object and require the agent to round-trip it through `*_execute(plan: ...)`. Cost: large args.

Lean (b). File-write tax on local-compute is overkill; round-tripping plans through LLM context is wasteful.

### 6.2 Backend prefix collisions

If two backends declare overlapping runId prefixes (unlikely but possible — `lr-` for local, `lr-` for "Lambda Run"), Registry's `resolveBackendByRunId` could mis-route. Options:
- (a) Backend declares its prefix at construction; Registry rejects duplicate prefix registration.
- (b) Backends own runId minting via `nextRunId()` method; Registry doesn't parse prefixes, instead maintains an `runId → backend` map populated at submit() time.

Lean (b). Less coupling between Registry and backend naming conventions; survives if a backend changes its scheme.

### 6.3 Cost-killing for backends without `gpuRateUsdPerHour`

The `CostEstimate.hourlyRateUsd` field is sufficient for Modal-style billing. For AWS with line-item billing, the *displayed* estimate might come from a more sophisticated source while cost-killing remains hourly-rate-based. Document `hourlyRateUsd` as "rate used for the kill-threshold timer only; total estimate may use a more complete model".

### 6.4 Streaming vs. polling

PR #62's Modal runner polls the output file every 5 seconds and re-reads the last 8 KB. AWS CloudWatch can stream via subscription, GCP Cloud Logging similar. The interface today implies polling (no streaming method on `ComputeBackend`). Future amendment:

```typescript
// Future: backends with supportsStreaming=true can register a streaming source
onOutput?(runId: string, cb: (chunk: string) => void): () => void
```

Defer to backend #3 actually needing this.

### 6.5 Per-backend skill files

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
- [ ] `lib/compute/pending-plan-store.ts` — Registry-owned, keyed by (backend, planId)
- [ ] `lib/compute/shared-types.ts` — move `FailureSignal` + `StructuredProgress` here (currently in `lib/local-compute/types.ts`)
- [ ] Unit tests: `lib/compute/__tests__/registry.test.ts`, `pending-plan-store.test.ts`, `events.test.ts`

### 7.2 Port local-compute

- [ ] Create `lib/compute/backends/local/` (move existing local-compute internals here)
- [ ] Implement `LocalBackend implements ComputeBackend`:
  - `capabilities: { requiresApproval: false, hasCost: false, supportsGpu: <detected>, supportsStop: true, supportsStreaming: false }`
  - `plan()` returns plan with `costEstimate: undefined` and `backendData: { sandbox: 'docker' | 'process', resourceSnapshot: {...} }`
  - `submit()` uses existing `ComputeRunner`
  - `hydrate()` reads existing `.research-pilot/compute-runs/` for local runs
- [ ] Delete `lib/local-compute/tools.ts` (no longer needed)
- [ ] Migrate experience store: `compute-runs/experience.jsonl` → namespaced per backend? Or keep shared (probably keep shared — task-kind taxonomy is cross-backend useful)
- [ ] Unit tests: `lib/compute/backends/local/__tests__/local-backend.test.ts`

### 7.3 Port modal-compute

- [ ] Create `lib/compute/backends/modal/` (move `lib/modal-compute/` internals here)
- [ ] Implement `ModalBackend implements ComputeBackend`:
  - `capabilities: { requiresApproval: true, hasCost: true, supportsGpu: true, supportsStop: true, supportsStreaming: false }`
  - `plan()` runs the plan-agent (now constructed via `ctx.AgentClass` + `ctx.resolveApiKey` + `ctx.defaultModelId`, NOT via `createSubAgent`)
  - `submit()` uses existing `ModalRunner`
  - Cost-killing in runner emits `{ kind: 'cost-killed', ... }` via `ctx.emit`
  - `hydrate()` reads `modal-runs.json` for in-flight runs
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

- [ ] `Registry` — register / lookup / dispatch / event fan-out
- [ ] `Registry.plan()` — approval-gate honored when capability set; honored when force-flag set; bypassed otherwise
- [ ] `Registry.submit()` — rejects unapproved plan; clears pending after submit
- [ ] `PendingPlanStore` — write / read / approve / reject / clear lifecycle; concurrent (backend, planId) keys don't collide
- [ ] `LocalBackend` — plan returns `costEstimate: undefined`; submit returns running run; status reflects child process state; stop sends SIGTERM
- [ ] `ModalBackend` — plan calls plan-agent; cost-killer fires when threshold exceeded (mocked clock); stop sends SIGTERM
- [ ] `Cost-estimator` — `coverage: 'lower_bound'` flag set when only GPU dimension modeled; threshold-killing uses `hourlyRateUsd` regardless

### 8.2 Integration

- [ ] End-to-end with mocked Modal CLI: plan → approve → submit → wait → complete; events arrive in expected order
- [ ] End-to-end local: plan → submit (no approval) → wait → complete
- [ ] Crash recovery: write run files → restart → `registry.hydrate()` returns them with correct backend attribution
- [ ] Settings change: flip `requireApprovalForAllBackends` true → local plan now goes through approval gate

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
- Streaming output (§6.4)
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
