/**
 * Compute Store — Zustand store for compute backend state.
 *
 * Subscribes to the unified `compute:event` IPC channel and dispatches
 * via a single applyEvent reducer (RFC-008 §7.6). Backend-specific
 * payloads are kept in `backendData` so per-backend UI components can
 * render their own details.
 *
 * Legacy selectors usePendingModalPlan / modalAvailable are preserved
 * (derived from the new backends/pendingPlans maps) so existing
 * consumers do not break.
 */

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Shared (cross-backend) types
// ---------------------------------------------------------------------------

export interface ComputeProgress {
  percentage?: number
  currentStep?: number
  totalSteps?: number
  metrics?: Record<string, number>
  phase?: string
  etaSeconds?: number
}

export interface ComputeFailure {
  code: string
  retryable: boolean
  message: string
  suggestions: string[]
}

// ---------------------------------------------------------------------------
// Backend-specific payload shapes (subset — UI components type-narrow
// via backendData + backendDataVersion per amendment A5).
// ---------------------------------------------------------------------------

export interface ModalImageView {
  source: 'script' | 'modal_default' | 'unknown'
  gpuType: string | null
  runtimeGpuType: string | null
  buildGpuType: string | null
  baseImage: string
  pythonVersion: string | null
  pythonPackages: string[]
  pythonPackageInstallers: Array<'uv_pip_install' | 'pip_install' | 'micromamba_install'>
  systemPackages: string[]
  envVars: string[]
  localDirs: string[]
  localFiles: string[]
  localPythonSources: string[]
  buildCommands: string[]
  buildFunctions: string[]
  forceBuild: boolean
  warnings: string[]
  reasoning: string
}

export interface ModalCostEstimateView {
  estimatedTotalUsd: number
  gpuRateUsdPerHour: number
  expectedDurationMinutes: number
  notes: string
}

// ---------------------------------------------------------------------------
// Run + plan + backend views
// ---------------------------------------------------------------------------

export interface ComputeRunView {
  runId: string
  backend: string                    // 'local' | 'modal' | ...
  planId?: string
  taskDescription?: string
  status: string
  /** Local-only — survives for legacy ComputeView code paths. */
  currentPhase: string
  command: string
  scriptPath?: string
  sandbox: string
  weight: string
  /**
   * When the system accepted responsibility for this work — for a real
   * ComputeRun, this is run.createdAt (when the agent called execute);
   * for a synthetic row representing an approved-but-not-yet-executed
   * plan, this is plan.approvedAt. Used by the "Submitted" column and
   * the default sort.
   */
  createdAt?: string
  startedAt?: string
  lastOutputAt?: string
  elapsedSeconds: number
  outputBytes: number
  outputLines: number
  timeoutMs?: number
  stallThresholdMs?: number
  stalled: boolean
  progress?: ComputeProgress
  outputTail: string
  failure?: ComputeFailure
  exitCode?: number
  parentRunId?: string
  /** RFC-017 §6 — campaign/sweep grouping key (Finished zone). */
  campaignId?: string
  estimatedCostUsd?: number
  costThresholdUsd?: number
  costEstimate?: ModalCostEstimateView
  image?: ModalImageView
  /** Generic escape hatch for per-backend UI extras (amendment A5). */
  backendData?: unknown
  backendDataVersion?: number
  /**
   * True iff this is a synthetic row constructed from an approved-but-
   * not-yet-executed plan (not a real ComputeRun). RunRow uses this to
   * disable stop/expand and render the "waiting for agent" label.
   */
  isPlanPlaceholder?: boolean
}

export interface ComputePlanView {
  backend: string
  planId: string
  taskDescription?: string
  command: string
  scriptPath?: string
  taskProfile?: {
    expectedDurationClass?: 'seconds' | 'minutes' | 'hours'
    durationReasoning?: string
    reasoning?: string
  }
  /** Modal-specific — present when backend = 'modal'. */
  image?: ModalImageView
  costEstimate?: ModalCostEstimateView
  createdAt: string
  approved: boolean
  approvedAt?: string
  rejectedAt?: string
  rejectionComments?: string
  /** True iff this plan must be approved/confirmed before execute. */
  requiresApproval: boolean
  /**
   * RFC-016 §4.4 — rule-based danger findings for a non-gated local command.
   * Non-empty ⇒ this is a *danger confirm* (Zone ① "Run anyway"), not a cost
   * or approval gate.
   */
  dangerFlags?: string[]
  /** True iff the backend bills the user (drives the cost-confirm framing). */
  hasCost?: boolean
  backendData?: unknown
  backendDataVersion?: number
}

export interface BackendCapabilities {
  requiresApproval: boolean
  hasCost: boolean
  supportsGpu: boolean
  supportsStop: boolean
  supportsStreaming: boolean
}

export interface BackendAvailability {
  available: boolean
  missingRequirements: string[]
  hints?: string[]
}

export interface BackendView {
  id: string
  displayName: string
  toolPrefix: string
  capabilities?: BackendCapabilities
  availability?: BackendAvailability
}

/** RFC-016 §4.5 — a scheduled task plus its computed scheduling facts. */
export interface CronTaskView {
  id: string
  name?: string
  schedule: string
  command: string
  workDir?: string
  backend: string
  scriptPath?: string
  backendData?: string
  enabled: boolean
  createdAt: string
  lastRun?: string
  lastRunId?: string
  catchUpOnReopen?: boolean
  campaignId: string
  nextDue?: string
  missedSinceLastOpen: number
  scheduleValid: boolean
}

// ---------------------------------------------------------------------------
// Legacy compat types (preserved for existing ComputeView consumers)
// ---------------------------------------------------------------------------

export interface ModalAvailability {
  available: boolean
  cliInstalled: boolean
  hasCredentials: boolean
}

export type ModalPlanView = ComputePlanView   // legacy alias

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ComputeState {
  runs: Map<string, ComputeRunView>
  backends: Map<string, BackendView>
  /** Keyed by `${backend}::${planId}`. Only the most recent plan-ready per backend is shown to the user. */
  pendingPlans: Map<string, ComputePlanView>
  /** RFC-016 §4.5 — scheduled tasks (home-scoped), keyed by task id. */
  cronTasks: Map<string, CronTaskView>

  // Single reducer for all ComputeEvent variants (RFC-008 §7.6).
  applyEvent: (event: any) => void

  // Cron events (compute:cron-event) — separate channel from run events.
  applyCronEvent: (event: any) => void
  hydrateCronTasks: (tasks: CronTaskView[]) => void

  // Bulk hydration after app boot (compute:hydrate).
  hydrateRuns: (runs: Array<{ run: any; status: any }>) => void
  hydratePendingPlans: (entries: Array<{ backend: string; planId: string; record: any }>) => void
  hydrateBackends: (backends: Array<{ id: string; displayName: string; toolPrefix: string; capabilities?: BackendCapabilities; availability?: BackendAvailability }>) => void

  // Direct setters (used by tests / niche flows; renderer normally uses applyEvent)
  updateRun: (runId: string, data: Partial<ComputeRunView>) => void
  removeRun: (runId: string) => void
  /** Legacy shim — drops any modal pending plan. New code should rely on applyEvent('plan-approved'/'plan-rejected'). */
  clearModalPendingPlan: () => void
  reset: () => void
}

function planKey(backend: string, planId: string): string {
  return `${backend}::${planId}`
}

function runViewFrom(backendId: string, runId: string, run: any, status: any): ComputeRunView {
  return {
    runId,
    backend: backendId,
    planId: run?.planId,
    taskDescription: run?.taskDescription,
    status: status?.status ?? run?.status ?? 'running',
    currentPhase: status?.backendData?.currentPhase ?? 'full',
    command: run?.command ?? '',
    scriptPath: run?.scriptPath,
    campaignId: run?.campaignId,
    sandbox: run?.backendData?.sandbox ?? backendId,
    weight: run?.backendData?.weight ?? 'heavy',
    createdAt: run?.createdAt,
    startedAt: run?.startedAt,
    lastOutputAt: status?.lastOutputAt,
    elapsedSeconds: status?.elapsedSeconds ?? 0,
    outputBytes: status?.outputBytes ?? 0,
    outputLines: status?.outputLines ?? 0,
    timeoutMs: undefined,
    stallThresholdMs: undefined,
    stalled: status?.stalled ?? false,
    progress: status?.progress,
    outputTail: status?.outputTail ?? '',
    failure: status?.failure,
    exitCode: status?.exitCode,
    parentRunId: run?.parentRunId,
    estimatedCostUsd: status?.estimatedCostUsd ?? run?.estimatedCostUsd,
    costThresholdUsd: status?.backendData?.costThresholdUsd ?? run?.backendData?.costThresholdUsd,
    costEstimate: status?.backendData?.costEstimate,
    image: status?.backendData?.image ?? run?.backendData?.image,
    backendData: status?.backendData ?? run?.backendData,
    backendDataVersion: status?.backendDataVersion ?? run?.backendDataVersion,
  }
}

function runViewFromStatusOnly(backendId: string, runId: string, status: any, prev?: ComputeRunView, planId?: string, campaignId?: string): ComputeRunView {
  const base = prev ?? {
    runId,
    backend: backendId,
    status: 'running',
    currentPhase: 'full',
    command: '',
    sandbox: backendId,
    weight: 'heavy',
    // No `prev` means this is the FIRST event we've seen for this run
    // (the run was created during this session — hydrate would have
    // populated prev otherwise). The status payload does not carry
    // createdAt, so we approximate it with "now". Precision is good
    // enough for the Submitted column + default sort because the
    // run's true createdAt is at most a few hundred ms earlier.
    createdAt: new Date().toISOString(),
    elapsedSeconds: 0,
    outputBytes: 0,
    outputLines: 0,
    stalled: false,
    outputTail: '',
  } as ComputeRunView
  return {
    ...base,
    // Carry planId forward — events deliver it explicitly so the
    // approval-card-removal logic in applyEvent can find the matching
    // pending plan, but a later event without planId (defensive) won't
    // erase what we already learned.
    planId: planId ?? base.planId,
    campaignId: campaignId ?? base.campaignId,
    status: status?.status ?? base.status,
    elapsedSeconds: status?.elapsedSeconds ?? base.elapsedSeconds,
    outputBytes: status?.outputBytes ?? base.outputBytes,
    outputLines: status?.outputLines ?? base.outputLines,
    outputTail: status?.outputTail ?? base.outputTail,
    lastOutputAt: status?.lastOutputAt ?? base.lastOutputAt,
    stalled: status?.stalled ?? base.stalled,
    progress: status?.progress ?? base.progress,
    failure: status?.failure ?? base.failure,
    exitCode: status?.exitCode ?? base.exitCode,
    estimatedCostUsd: status?.estimatedCostUsd ?? base.estimatedCostUsd,
    costThresholdUsd: status?.backendData?.costThresholdUsd ?? base.costThresholdUsd,
    costEstimate: status?.backendData?.costEstimate ?? base.costEstimate,
    image: status?.backendData?.image ?? base.image,
    currentPhase: status?.backendData?.currentPhase ?? base.currentPhase,
    backendData: status?.backendData ?? base.backendData,
    backendDataVersion: status?.backendDataVersion ?? base.backendDataVersion,
  }
}

function planViewFrom(event: any): ComputePlanView {
  const plan = event.plan ?? event.record?.plan ?? {}
  return {
    backend: event.backend ?? plan.backend,
    planId: event.planId ?? plan.planId,
    taskDescription: plan.taskDescription,
    command: plan.command,
    scriptPath: plan.scriptPath,
    taskProfile: plan.taskProfile,
    image: plan.backendData?.image,
    costEstimate: plan.costEstimate
      ? {
          estimatedTotalUsd: plan.costEstimate.estimatedTotalUsd,
          gpuRateUsdPerHour: plan.costEstimate.hourlyRateUsd ?? plan.costEstimate.gpuRateUsdPerHour,
          expectedDurationMinutes: plan.costEstimate.expectedDurationMinutes,
          notes: plan.costEstimate.notes,
        }
      : undefined,
    createdAt: plan.createdAt ?? new Date().toISOString(),
    approved: event.record?.approved ?? false,
    approvedAt: event.record?.approvedAt,
    rejectedAt: event.record?.rejectedAt,
    rejectionComments: event.record?.rejectionComments,
    requiresApproval: event.requiresApproval ?? event.record?.effectiveRequiresApproval ?? false,
    dangerFlags: event.dangerFlags ?? event.record?.dangerFlags,
    hasCost: !!plan.costEstimate,
    backendData: plan.backendData,
    backendDataVersion: plan.backendDataVersion,
  }
}

export const useComputeStore = create<ComputeState>((set, get) => ({
  runs: new Map(),
  backends: new Map(),
  pendingPlans: new Map(),
  cronTasks: new Map(),

  applyCronEvent: (event) => {
    if (!event || typeof event !== 'object') return
    if (event.kind === 'cron-tasks' && Array.isArray(event.tasks)) {
      get().hydrateCronTasks(event.tasks)
    }
    // 'cron-fired' is informational; the follow-up 'cron-tasks' event carries
    // the refreshed list, and the fired run shows up via the normal run events.
  },

  hydrateCronTasks: (tasks) => {
    const map = new Map<string, CronTaskView>()
    for (const t of tasks) map.set(t.id, t)
    set({ cronTasks: map })
  },

  applyEvent: (event) => {
    if (!event || typeof event !== 'object') return
    const state = get()
    switch (event.kind) {
      case 'availability-changed': {
        const backends = new Map(state.backends)
        const existing = backends.get(event.backend) ?? {
          id: event.backend,
          displayName: event.backend,
          toolPrefix: event.backend,
        }
        backends.set(event.backend, { ...existing, availability: event.availability })
        set({ backends })
        return
      }
      case 'plan-ready': {
        const plans = new Map(state.pendingPlans)
        plans.set(planKey(event.backend, event.planId), planViewFrom(event))
        set({ pendingPlans: plans })
        return
      }
      case 'plan-approved': {
        const plans = new Map(state.pendingPlans)
        const existing = plans.get(planKey(event.backend, event.planId))
        if (existing) {
          plans.set(planKey(event.backend, event.planId), {
            ...existing,
            approved: true,
            approvedAt: event.approvedAt,
          })
          set({ pendingPlans: plans })
        }
        return
      }
      case 'plan-rejected': {
        const plans = new Map(state.pendingPlans)
        const existing = plans.get(planKey(event.backend, event.planId))
        if (existing) {
          plans.set(planKey(event.backend, event.planId), {
            ...existing,
            approved: false,
            rejectedAt: event.rejectedAt,
            rejectionComments: event.comments,
          })
          set({ pendingPlans: plans })
        }
        return
      }
      case 'plan-discarded': {
        // User deleted the plan from the Compute tab — drop its row
        // outright (no rejectedAt bookkeeping, unlike plan-rejected).
        const plans = new Map(state.pendingPlans)
        if (plans.delete(planKey(event.backend, event.planId))) {
          set({ pendingPlans: plans })
        }
        return
      }
      case 'run-update':
      case 'run-complete': {
        const runs = new Map(state.runs)
        const prev = runs.get(event.runId)
        // Prefer the event's planId (carried explicitly by the backend
        // emitters); fall back to whatever the previous run view had.
        // This fixes the bug where a newly-spawned run's FIRST event
        // had `prev === undefined`, so `prev?.planId` was always
        // undefined, leaving the "approved, waiting for agent" card
        // stuck at the top of the Compute tab forever.
        const planId = event.planId ?? prev?.planId
        const campaignId = event.campaignId ?? prev?.campaignId
        runs.set(event.runId, runViewFromStatusOnly(event.backend, event.runId, event.status, prev, planId, campaignId))
        if (planId) {
          const plans = new Map(state.pendingPlans)
          const key = planKey(event.backend, planId)
          if (plans.has(key)) {
            plans.delete(key)
            set({ runs, pendingPlans: plans })
            return
          }
        }
        set({ runs })
        return
      }
      case 'cost-killed': {
        const runs = new Map(state.runs)
        const prev = runs.get(event.runId)
        if (prev) {
          runs.set(event.runId, {
            ...prev,
            status: 'cost_killed',
            estimatedCostUsd: event.estimatedCostUsd,
            costThresholdUsd: event.thresholdUsd,
          })
          set({ runs })
        }
        return
      }
      default:
        return
    }
  },

  hydrateRuns: (entries) => {
    const runs = new Map(get().runs)
    for (const entry of entries) {
      const backendId = entry.run?.backend ?? 'local'
      runs.set(entry.run.runId, runViewFrom(backendId, entry.run.runId, entry.run, entry.status))
    }
    set({ runs })
  },

  hydrateBackends: (entries) => {
    const backends = new Map(get().backends)
    for (const entry of entries) {
      backends.set(entry.id, {
        id: entry.id,
        displayName: entry.displayName,
        toolPrefix: entry.toolPrefix,
        capabilities: entry.capabilities,
        availability: entry.availability,
      })
    }
    set({ backends })
  },

  hydratePendingPlans: (entries) => {
    const plans = new Map(get().pendingPlans)
    for (const entry of entries) {
      const event = {
        backend: entry.backend,
        planId: entry.planId,
        plan: entry.record?.plan,
        record: entry.record,
        requiresApproval: entry.record?.effectiveRequiresApproval ?? false,
      }
      plans.set(planKey(entry.backend, entry.planId), planViewFrom(event))
    }
    set({ pendingPlans: plans })
  },

  updateRun: (runId, data) =>
    set((state) => {
      const next = new Map(state.runs)
      const existing = next.get(runId)
      if (existing) {
        next.set(runId, { ...existing, ...data })
      } else {
        next.set(runId, {
          runId,
          backend: 'local',
          status: 'running',
          currentPhase: 'full',
          command: '',
          sandbox: 'process',
          weight: 'heavy',
          elapsedSeconds: 0,
          outputBytes: 0,
          outputLines: 0,
          stalled: false,
          outputTail: '',
          ...data,
        } as ComputeRunView)
      }
      return { runs: next }
    }),

  removeRun: (runId) =>
    set((state) => {
      const next = new Map(state.runs)
      next.delete(runId)
      return { runs: next }
    }),

  clearModalPendingPlan: () => set((state) => {
    const next = new Map(state.pendingPlans)
    for (const [k, v] of next) {
      if (v.backend === 'modal') next.delete(k)
    }
    return { pendingPlans: next }
  }),

  reset: () => set({ runs: new Map(), backends: new Map(), pendingPlans: new Map(), cronTasks: new Map() }),
}))

// ---------------------------------------------------------------------------
// Derived selectors — preserve legacy API for ComputeView / LiteratureSidebar
// ---------------------------------------------------------------------------

export function useActiveRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values()).filter(
    (r) => r.status === 'running' || r.status === 'stalled' || r.status === 'queued' || r.status === 'pending_approval'
  )
}

export function useRecentRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values())
    .filter((r) => !['running', 'stalled', 'queued', 'pending_approval'].includes(r.status))
    .sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0
      return bTime - aTime
    })
    .slice(0, 20)
}

export function useActiveRunCount(): number {
  const runs = useComputeStore((s) => s.runs)
  let count = 0
  for (const r of runs.values()) {
    if (['running', 'stalled', 'queued', 'pending_approval'].includes(r.status)) count++
  }
  return count
}

/**
 * Count of plans that emitted `plan-ready` and are still sitting
 * unhandled (no approval, no rejection). Drives the warning-toned
 * badge on the Compute tab so a plan submitted from chat isn't
 * silently lost when the user is in a different view.
 */
export function usePendingPlanCount(): number {
  return useComputeStore((s) => s.pendingPlans.size)
}

/**
 * Returns all pending plans (any backend) that are either awaiting
 * approval OR approved-but-not-yet-running. Rejected plans are
 * excluded — once the user rejects, the card disappears and the
 * chat flow takes over.
 *
 * Sorted oldest-first so the user sees the earliest pending plan
 * at the top of the Compute tab.
 */
export function usePendingPlans(): ComputePlanView[] {
  const plans = useComputeStore((s) => s.pendingPlans)
  return Array.from(plans.values())
    .filter((p) => !p.rejectedAt)
    .sort((a, b) => {
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return aT - bT
    })
}

/**
 * Plans the user already approved but the agent hasn't started yet.
 * These render as synthetic "queued" rows inside the run table so the
 * Compute tab tells a complete story: approved work is visible in the
 * same place as live and finished work, sortable next to it, and gets
 * replaced by the real run row the moment the agent calls execute.
 */
export function useApprovedPendingPlans(): ComputePlanView[] {
  const plans = useComputeStore((s) => s.pendingPlans)
  return Array.from(plans.values()).filter((p) => p.approved && !p.rejectedAt)
}

/** Plans still waiting on user Approve/Reject — only these get the top banner. */
export function useUnapprovedPendingPlans(): ComputePlanView[] {
  const plans = useComputeStore((s) => s.pendingPlans)
  return Array.from(plans.values())
    .filter((p) => !p.approved && !p.rejectedAt)
    .sort((a, b) => {
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return aT - bT
    })
}

/**
 * Build a ComputeRunView from an approved-pending plan so the table
 * can render it next to real runs without a separate code path. The
 * runId is namespaced with `pending::` so it's guaranteed not to
 * collide with a real ComputeRunner-assigned runId; the
 * `isPlanPlaceholder` flag lets RunRow disable stop/expand.
 */
export function planToPlaceholderRun(plan: ComputePlanView): ComputeRunView {
  return {
    runId: `pending::${plan.backend}::${plan.planId}`,
    backend: plan.backend,
    planId: plan.planId,
    taskDescription: plan.taskDescription,
    status: 'queued',
    currentPhase: 'full',
    command: plan.command,
    scriptPath: plan.scriptPath,
    sandbox: plan.backend,
    weight: 'heavy',
    // "Submitted" displays this — the moment the user clicked Approve
    // is when the system accepted responsibility. Falls back to plan
    // creation time for backends that don't gate (the approval and
    // creation are effectively the same instant there).
    createdAt: plan.approvedAt ?? plan.createdAt,
    elapsedSeconds: 0,
    outputBytes: 0,
    outputLines: 0,
    stalled: false,
    outputTail: '',
    image: plan.image,
    costEstimate: plan.costEstimate,
    backendData: plan.backendData,
    backendDataVersion: plan.backendDataVersion,
    isPlanPlaceholder: true,
  }
}

// ---------------------------------------------------------------------------
// RFC-017 — three-zone selectors (Needs you / Running / Finished + campaigns)
// ---------------------------------------------------------------------------

const RUNNING_STATUSES = new Set(['running', 'stalled', 'queued', 'pending_approval'])

function submittedMs(run: ComputeRunView): number {
  const src = run.createdAt ?? run.startedAt
  return src ? new Date(src).getTime() : 0
}

/** Zone ② — live runs (running / stalled). The heart of the tab. */
export function useRunningRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values())
    .filter((r) => RUNNING_STATUSES.has(r.status))
    .sort((a, b) => submittedMs(b) - submittedMs(a))
}

/** Zone ③ — finished (terminal) runs, newest first. */
export function useFinishedRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values())
    .filter((r) => !RUNNING_STATUSES.has(r.status))
    .sort((a, b) => submittedMs(b) - submittedMs(a))
}

export interface Campaign {
  /** campaignId, or a synthetic id for a one-off finished run. */
  id: string
  /** True when this is a multi-run group rendered with a header. */
  grouped: boolean
  /** Human label for the group header (shared command family). */
  label: string
  runs: ComputeRunView[]
  completed: number
  failed: number
  total: number
  latestMs: number
}

/**
 * A short, shared label for a campaign group — the command family its runs
 * have in common (RFC-017 §4.4). E.g. `python probe.py --label a/b/c` →
 * "probe.py". Falls back to the raw command, truncated.
 */
function campaignLabel(runs: ComputeRunView[]): string {
  const first = runs[0]
  const raw = (first?.taskDescription?.trim() || first?.command || 'runs').trim()
  // Prefer a script-ish token (foo.py / foo.sh / foo.js); else the first
  // non-interpreter word; else the first word.
  const tokens = raw.split(/\s+/)
  const script = tokens.find((t) => /\.(py|sh|js|ts|rb|jl|R)$/i.test(t))
  if (script) return script.split('/').pop() || script
  const interp = new Set(['python', 'python3', 'node', 'bash', 'sh', 'Rscript', 'julia', 'ruby'])
  const word = tokens.find((t) => !interp.has(t)) ?? tokens[0] ?? raw
  return word.length > 40 ? word.slice(0, 39) + '…' : word
}

/**
 * Zone ③ grouping (RFC-017 §4.4/§6, distilled). ONE place per run: only
 * FINISHED runs appear here — a still-running member lives in the Running
 * zone, never duplicated here. A campaignId with ≥2 finished members renders
 * as a collapsible group; a single finished run (grouped or not) renders as a
 * bare row.
 */
export function groupRunsIntoCampaigns(runs: Iterable<ComputeRunView>): Campaign[] {
  const groups = new Map<string, ComputeRunView[]>()
  const singles: ComputeRunView[] = []
  for (const r of runs) {
    if (RUNNING_STATUSES.has(r.status)) continue   // live runs belong to the Running zone
    if (r.campaignId) {
      const arr = groups.get(r.campaignId) ?? []
      arr.push(r)
      groups.set(r.campaignId, arr)
    } else {
      singles.push(r)
    }
  }
  const out: Campaign[] = []
  for (const [id, members] of groups) {
    if (members.length >= 2) out.push(buildCampaign(id, true, members))
    else singles.push(members[0])   // a lone campaign member reads better as a bare row
  }
  for (const r of singles) out.push(buildCampaign(`run::${r.runId}`, false, [r]))
  return out.sort((a, b) => b.latestMs - a.latestMs)
}

export function useCampaigns(): Campaign[] {
  const runs = useComputeStore((s) => s.runs)
  return groupRunsIntoCampaigns(runs.values())
}

function buildCampaign(id: string, grouped: boolean, members: ComputeRunView[]): Campaign {
  let completed = 0, failed = 0, latestMs = 0
  for (const r of members) {
    if (r.status === 'completed') completed++
    else if (['failed', 'timed_out', 'cost_killed', 'cancelled'].includes(r.status)) failed++
    latestMs = Math.max(latestMs, submittedMs(r))
  }
  const runs = members.slice().sort((a, b) => submittedMs(b) - submittedMs(a))
  return { id, grouped, label: campaignLabel(runs), runs, completed, failed, total: members.length, latestMs }
}

/**
 * Zone ① — decisions that genuinely need the user (RFC-017 §4.2): a gated
 * plan awaiting confirm. Under RFC-016 §4.4 this is a remote *cost* confirm,
 * a flagged *danger* confirm, or a forced approval — never routine local
 * approval (local auto-runs).
 */
export function useDecisions(): ComputePlanView[] {
  const plans = useComputeStore((s) => s.pendingPlans)
  return Array.from(plans.values())
    .filter((p) => p.requiresApproval && !p.approved && !p.rejectedAt)
    .sort((a, b) => {
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return aT - bT
    })
}

/** RFC-016 §4.5 — scheduled tasks, oldest first. */
export function useCronTasks(): CronTaskView[] {
  const tasks = useComputeStore((s) => s.cronTasks)
  return Array.from(tasks.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * Legacy selector: returns the most recent pending Modal plan if any,
 * else null. Mirrors the PR #62 API so old call sites still work.
 * Includes approved-not-yet-running plans (the renderer can decide
 * whether to render the full approval card or a slim waiting state).
 */
export function usePendingModalPlan(): ComputePlanView | null {
  const plans = useComputeStore((s) => s.pendingPlans)
  for (const plan of plans.values()) {
    if (plan.backend === 'modal' && !plan.rejectedAt) return plan
  }
  return null
}

/**
 * Legacy selector: returns Modal availability derived from the
 * backends map. cliInstalled is inferred (an availability with no
 * "CLI not installed" requirement implies it's installed).
 */
export function useModalAvailability(): ModalAvailability | null {
  const backends = useComputeStore((s) => s.backends)
  const modal = backends.get('modal')
  if (!modal?.availability) return null
  const missing = modal.availability.missingRequirements ?? []
  const cliMissing = missing.some(m => m.toLowerCase().includes('cli'))
  const credsMissing = missing.some(m => m.toLowerCase().includes('credentials'))
  return {
    available: modal.availability.available,
    cliInstalled: !cliMissing,
    hasCredentials: !credsMissing,
  }
}
