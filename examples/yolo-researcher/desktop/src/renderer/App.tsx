import React, { useEffect, useMemo, useState } from 'react'
import {
  FolderOpen,
  Pause,
  Play,
  Square,
  Send,
  Bot,
  Timer,
  FlaskConical,
  ArrowUp,
  ArrowDown,
  X,
  CheckCircle2,
  AlertTriangle,
  Minus,
  GitBranch,
  Database,
  Activity
} from 'lucide-react'

type YoloState =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'TURN_COMPLETE'
  | 'WAITING_FOR_USER'
  | 'WAITING_EXTERNAL'
  | 'PAUSED'
  | 'COMPLETE'
  | 'FAILED'
  | 'STOPPED'
  | 'CRASHED'

type StageId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
type GateStatus = 'pass' | 'fail' | 'none'

interface YoloSnapshot {
  sessionId: string
  goal: string
  phase: 'P0' | 'P1' | 'P2' | 'P3'
  state: YoloState
  currentTurn: number
  activeStage: StageId
  budgetUsed: { tokens: number; costUsd: number; turns: number }
  budgetCaps?: { maxTurns: number; maxTokens: number; maxCostUsd: number; deadlineIso?: string }
  pendingQuestion?: {
    id?: string
    question: string
    options?: string[]
    context?: string
    checkpoint?: 'problem-freeze' | 'baseline-freeze' | 'claim-freeze' | 'final-scope'
    blocking?: boolean
  }
  pendingExternalTaskId?: string
  pendingResourceExtension?: {
    id: string
    requestedAt: string
    requestedBy: 'user' | 'agent'
    rationale: string
    delta: {
      maxTurns: number
      maxTokens: number
      maxCostUsd: number
    }
  }
  runtimeStatus?: {
    lease?: {
      ownerId?: string
      acquiredAt?: string
      heartbeatAt?: string
      staleAfterSec?: number
      takeoverReason?: string
      takeoverFromOwnerId?: string
    }
    latestCheckpoint?: {
      checkpointId?: string
      fileName?: string
      createdAt?: string
      trigger?: string
      turnNumber?: number
      runtimeState?: YoloState
    }
    checkpointCount?: number
  }
}

interface TurnReport {
  turnNumber: number
  turnSpec: { objective: string; stage: string }
  summary: string
    gateImpact?: {
      status: string
      gateResult?: { passed: boolean }
      snapshotManifest?: {
        evidencePolicy?: {
          crossBranchCountableLinkIds?: string[]
          keyRunMissingParityContractLinkIds?: string[]
          invalidCountableLinkIds?: string[]
        }
        causality?: {
          requiredClaims?: number
          satisfiedClaims?: number
          interventionLinkCount?: number
          counterfactualLinkCount?: number
          correlationOnlyLinkCount?: number
          missingClaimIds?: string[]
        }
        claimDecisionBinding?: {
          assertedClaimCount?: number
          assertedClaimWithFreezeRefCount?: number
          missingFreezeRefClaimIds?: string[]
        }
        directEvidence?: {
          requiredClaims?: number
          satisfiedClaims?: number
          missingClaimIds?: string[]
        }
      }
    }
  reviewerSnapshot?: {
    status?: 'not-run' | 'completed'
    notes?: string[]
    reviewerPasses?: Array<{
      persona?: 'Novelty' | 'System' | 'Evaluation' | 'Writing'
      hardBlockers?: Array<{ label?: string }>
    }>
    consensusBlockers?: Array<{
      label?: string
      voteCount?: number
      personas?: Array<'Novelty' | 'System' | 'Evaluation' | 'Writing'>
    }>
  }
  readinessSnapshot?: {
    phase?: 'P0' | 'P1' | 'P2' | 'P3'
    stage?: StageId
    pass?: boolean
    requiredFailed?: Array<'TG0' | 'TG1' | 'TG2' | 'TG3' | 'TG4'>
  }
  riskDelta?: string[]
  consumedBudgets?: {
    turnCostUsd?: number
    turnTokens?: number
    toolCalls?: number
    wallClockSec?: number
    readBytes?: number
    discoveryOps?: number
    promptTokens?: number
    completionTokens?: number
    stepCount?: number
  }
  assetDiff?: { created: string[] }
  nonProgress?: boolean
}

interface BranchNode {
  nodeId: string
  branchId: string
  parentNodeId?: string
  stage: StageId
  status: 'active' | 'paused' | 'merged' | 'pruned' | 'invalidated'
  summary: string
  mergedFrom?: string[]
  createdByTurn?: number
}

interface BranchSnapshot {
  activeBranchId: string
  activeNodeId: string
  rootNodeId: string
  nodes: BranchNode[]
}

interface AssetRecord {
  id: string
  type: string
  payload: Record<string, unknown>
  supersedes?: string
  createdAt: string
  createdByTurn: number
  createdByAttempt: number
}

interface EventRecord {
  at: string
  type: string
  text: string
}

interface QueuedUserInput {
  id: string
  text: string
  priority: 'urgent' | 'normal'
  createdAt: string
  source: 'chat' | 'system'
}

interface ExternalWaitTask {
  id: string
  sessionId: string
  status: 'waiting' | 'satisfied' | 'canceled' | 'expired' | 'open' | 'resolved' | 'cancelled'
  stage?: StageId
  branchId?: string
  nodeId?: string
  title: string
  reason?: string
  requiredArtifacts?: Array<{ kind: string; pathHint?: string; description: string }>
  completionRule: string
  resumeAction: string
  uploadDir?: string
  details?: string
  createdAt: string
  resolvedAt?: string
  resolutionNote?: string
}

interface WaitTaskValidationResult {
  taskId: string
  status: ExternalWaitTask['status']
  uploadDir?: string
  requiredUploads: string[]
  missingRequiredUploads: string[]
  hasAnyUpload: boolean
  checks: Array<{ name: string; passed: boolean; detail?: string }>
  ok: boolean
  reason?: string
}

type EvidenceGraphLane = 'claim' | 'link' | 'evidence' | 'decision'

interface EvidenceGraphNode {
  id: string
  label: string
  lane: EvidenceGraphLane
  assetType: string
  external: boolean
  x: number
  y: number
}

interface EvidenceGraphEdge {
  id: string
  from: string
  to: string
  kind: 'claim_link' | 'link_evidence' | 'supersedes'
}

const api = (window as any).api
const STAGES: StageId[] = ['S1', 'S2', 'S3', 'S4', 'S5']

function isStageId(value: string): value is StageId {
  return STAGES.includes(value as StageId)
}

function turnGateStatus(turn: TurnReport): GateStatus {
  const status = turn.gateImpact?.status
  if (status === 'pass' || turn.gateImpact?.gateResult?.passed === true) return 'pass'
  if (status === 'fail' || status === 'rollback-needed' || turn.gateImpact?.gateResult?.passed === false) return 'fail'
  return 'none'
}

function buildStateSummary(
  state: YoloState | undefined,
  activeTurn: TurnReport | null
): { title: string; tone: string; detail: string } | null {
  if (!state) return null
  if (state === 'FAILED') {
    return {
      title: 'Run Failed',
      tone: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
      detail: activeTurn?.summary ?? 'Session entered FAILED state.'
    }
  }
  if (state === 'STOPPED') {
    return {
      title: 'Run Stopped',
      tone: 'border-slate-500/40 bg-slate-500/10 text-slate-200',
      detail: 'Session was stopped by user. You can resume from the last durable boundary.'
    }
  }
  if (state === 'COMPLETE') {
    return {
      title: 'Run Complete',
      tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
      detail: activeTurn?.summary ?? 'Session reached COMPLETE.'
    }
  }
  if (state === 'PAUSED') {
    return {
      title: 'Paused',
      tone: 'border-slate-500/40 bg-slate-500/10 text-slate-200',
      detail: 'Execution paused. Resume continues from next planning boundary.'
    }
  }
  return null
}

const defaultOptions = {
  budget: { maxTurns: 12, maxTokens: 120000, maxCostUsd: 12 },
  models: { planner: 'gpt-5.2', coordinator: 'gpt-5.2' }
}

function stateTone(state?: YoloState): string {
  switch (state) {
    case 'EXECUTING': return 'bg-teal-500/20 text-teal-300 border-teal-500/40'
    case 'WAITING_FOR_USER': return 'bg-amber-500/20 text-amber-300 border-amber-500/40'
    case 'PAUSED': return 'bg-slate-500/20 text-slate-300 border-slate-500/40'
    case 'FAILED':
    case 'CRASHED': return 'bg-rose-500/20 text-rose-300 border-rose-500/40'
    case 'COMPLETE': return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
    default: return 'bg-neutral-500/20 text-neutral-300 border-neutral-500/40'
  }
}

function collectStringIds(value: unknown, sink: Set<string>): void {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized) sink.add(normalized)
    return
  }
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (normalized) sink.add(normalized)
  }
}

function toGraphLabel(asset: AssetRecord | undefined, fallbackId: string): string {
  if (!asset) return fallbackId
  if (asset.type === 'Claim') {
    const statement =
      (typeof asset.payload.statement === 'string' && asset.payload.statement)
      || (typeof asset.payload.claim === 'string' && asset.payload.claim)
      || (typeof asset.payload.text === 'string' && asset.payload.text)
      || ''
    if (statement) return statement
  }
  if (asset.type === 'EvidenceLink') {
    const relation = typeof asset.payload.relation === 'string' ? asset.payload.relation : 'linked'
    const policy = typeof asset.payload.countingPolicy === 'string' ? asset.payload.countingPolicy : 'countable'
    return `${relation} · ${policy}`
  }
  if (asset.type === 'RunRecord') {
    const runKey = typeof asset.payload.runKey === 'string' ? asset.payload.runKey : ''
    if (runKey) return `runKey=${runKey}`
  }
  return asset.type
}

function laneFromId(id: string, assetType?: string): EvidenceGraphLane {
  if (assetType === 'EvidenceLink' || id.startsWith('EvidenceLink-')) return 'link'
  if (assetType === 'Claim' || id.startsWith('Claim-')) return 'claim'
  if (assetType === 'Decision' || id.startsWith('Decision-')) return 'decision'
  return 'evidence'
}

function formatEvent(payload: any): EventRecord {
  const at = payload?.timestamp || payload?.at || new Date().toISOString()
  if (!payload || typeof payload !== 'object') {
    return { at, type: 'unknown', text: String(payload) }
  }

  const type = String(payload.type || 'event')
  switch (type) {
    case 'session_started':
      return { at, type, text: `Session started (${payload.phase ?? 'P0'})` }
    case 'session_restored':
      return {
        at,
        type,
        text: `Session restored (${payload.sessionId ?? 'unknown'}) · turn ${payload.turn ?? 0}`
      }
    case 'state_changed':
      return { at, type, text: `State ${payload.from ?? 'null'} -> ${payload.to} (${payload.reason ?? 'n/a'})` }
    case 'state_transition':
      return { at, type, text: `State ${payload.from ?? 'unknown'} -> ${payload.to ?? 'unknown'} (${payload.reason ?? 'n/a'})` }
    case 'turn_planning':
      return { at, type, text: `Planning turn ${payload.turn} (${payload.stage})` }
    case 'turn_committed':
      return {
        at,
        type,
        text: `Turn ${payload.turn} committed · assets +${payload.assetsCreated ?? 0} · ${payload.gateStatus ?? 'none'}`
      }
    case 'semantic_review_evaluated':
      return {
        at,
        type,
        text: Array.isArray(payload.consensusBlockerLabels) && payload.consensusBlockerLabels.length > 0
          ? `Semantic review blockers: ${payload.consensusBlockerLabels.join(', ')}`
          : 'Semantic review: no consensus blocker'
      }
    case 'pause_requested':
      return { at, type, text: 'Pause requested at next turn boundary.' }
    case 'input_enqueued':
      return { at, type, text: `Input queued (${payload.priority ?? 'normal'})` }
    case 'input_queue_changed':
      return { at, type, text: `Input queue updated · ${payload.count ?? 0} pending` }
    case 'loop_error':
      return { at, type, text: `Loop error: ${payload.message ?? 'unknown error'}` }
    case 'crash_recovery':
      return { at, type, text: `Crash recovery finished · last durable turn ${payload.lastDurableTurn ?? 0}` }
    case 'summary_exported':
      return { at, type, text: `Summary exported: ${payload.path ?? ''}` }
    case 'claim_evidence_table_exported':
      return { at, type, text: `Claim-evidence table exported: ${payload.path ?? ''}` }
    case 'asset_inventory_exported':
      return { at, type, text: `Asset inventory exported: ${payload.path ?? ''}` }
    case 'final_bundle_exported':
      return {
        at,
        type,
        text: `${payload.auto ? 'Final bundle auto-exported' : 'Final bundle exported'}: ${payload.path ?? ''}`
      }
    case 'wait_external_requested':
      return { at, type, text: `External wait requested: ${payload.title ?? payload.id ?? ''}` }
    case 'wait_external_resolved':
      return { at, type, text: `External wait resolved: ${payload.id ?? ''}` }
    case 'wait_external_cancelled':
      return { at, type, text: `External wait cancelled: ${payload.id ?? ''}` }
    case 'fulltext_wait_requested':
      return { at, type, text: `Full-text wait requested: ${payload.citation ?? payload.id ?? ''}` }
    case 'checkpoint_confirmed':
      return { at, type, text: `Checkpoint confirmed: ${payload.decisionAssetId ?? ''}` }
    case 'checkpoint_restored':
      return { at, type, text: `Checkpoint restore ${payload.restored ? 'completed' : 'not available'} · turn ${payload.turn ?? 0}` }
    case 'override_decision_recorded':
      return { at, type, text: `Override decision recorded: ${payload.decisionAssetId ?? ''} -> ${payload.targetNodeId ?? ''}` }
    case 'maintenance_alert':
      return {
        at,
        type,
        text: `${payload.severity ?? 'warning'} · ${payload.kind ?? 'maintenance'} · ${payload.message ?? ''}`
      }
    case 'resource_extension_requested':
      return { at, type, text: `Resource extension requested: ${payload.requestId ?? ''}` }
    case 'resource_extension_resolved':
      return {
        at,
        type,
        text: `Resource extension ${payload.approved ? 'approved' : 'rejected'}: ${payload.requestId ?? ''}${payload.budget ? ` · turns=${payload.budget.maxTurns} tokens=${payload.budget.maxTokens} cost=${payload.budget.maxCostUsd}` : ''}`
      }
    case 'ingress_files_added':
      return {
        at,
        type,
        text: `Ingress files added (${payload.fileCount ?? 0}) -> ${payload.uploadDir ?? ''}`
      }
    default:
      return { at, type, text: JSON.stringify(payload) }
  }
}

function FolderGate({ onPick }: { onPick: () => Promise<void> }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center px-8 t-text">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />
      <div className="max-w-xl text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl t-bg-surface border t-border">
          <FolderOpen className="h-9 w-9 text-teal-300" />
        </div>
        <h1 className="mb-2 text-3xl font-semibold" style={{ fontFamily: "'Playfair Display', serif" }}>YOLO Researcher</h1>
        <p className="mb-8 text-sm t-text-secondary">
          Select a project folder to start autonomous YOLO turns with structured checkpoints.
        </p>
        <button
          className="rounded-xl bg-teal-500 px-6 py-3 text-sm font-medium text-white hover:bg-teal-400 transition-colors no-drag"
          onClick={onPick}
        >
          Open Project Folder
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [projectPath, setProjectPath] = useState('')
  const [goal, setGoal] = useState('Investigate a systems bottleneck and produce evidence-backed draft skeleton.')
  const [goalSessionId, setGoalSessionId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<YoloSnapshot | null>(null)
  const [turnReports, setTurnReports] = useState<TurnReport[]>([])
  const [events, setEvents] = useState<EventRecord[]>([])
  const [rawEvents, setRawEvents] = useState<any[]>([])
  const [rightView, setRightView] = useState<'timeline' | 'branches' | 'assets' | 'matrix' | 'diagnostics'>('timeline')
  const [branchSnapshot, setBranchSnapshot] = useState<BranchSnapshot | null>(null)
  const [assetRecords, setAssetRecords] = useState<AssetRecord[]>([])
  const [queuedInputs, setQueuedInputs] = useState<QueuedUserInput[]>([])
  const [waitTasks, setWaitTasks] = useState<ExternalWaitTask[]>([])
  const [waitValidation, setWaitValidation] = useState<WaitTaskValidationResult | null>(null)
  const [queueOpen, setQueueOpen] = useState(true)
  const [selectedPhase, setSelectedPhase] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P0')
  const [selectedStage, setSelectedStage] = useState<StageId>('S1')
  const [timelineStageFilter, setTimelineStageFilter] = useState<'ALL' | StageId>('ALL')
  const [timelineGateFilter, setTimelineGateFilter] = useState<'ALL' | GateStatus>('ALL')
  const [timelineProgressFilter, setTimelineProgressFilter] = useState<'ALL' | 'PROGRESS' | 'NON_PROGRESS'>('ALL')
  const [selectedTurnNumber, setSelectedTurnNumber] = useState<number | null>(null)
  const [replyText, setReplyText] = useState('')
  const [isStarting, setIsStarting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [waitTitle, setWaitTitle] = useState('Collect external experiment artifacts')
  const [waitRule, setWaitRule] = useState('Upload experiment outputs and run metadata')
  const [waitResumeAction, setWaitResumeAction] = useState('Validate logs and continue next planning turn')
  const [waitDetails, setWaitDetails] = useState('')
  const [waitResolutionNote, setWaitResolutionNote] = useState('External artifacts uploaded and verified')
  const [waitCancelReason, setWaitCancelReason] = useState('External dependency no longer required')
  const [fullTextCitation, setFullTextCitation] = useState('Doe et al. (2024) systems paper')
  const [fullTextRequiredFiles, setFullTextRequiredFiles] = useState('paper.pdf')
  const [fullTextReason, setFullTextReason] = useState('Paywall or auth blocked programmatic retrieval')
  const [resourceDeltaTurns, setResourceDeltaTurns] = useState('2')
  const [resourceDeltaTokens, setResourceDeltaTokens] = useState('20000')
  const [resourceDeltaCostUsd, setResourceDeltaCostUsd] = useState('2')
  const [resourceRationale, setResourceRationale] = useState('Need additional budget to complete planned evaluation scope')
  const [resourceDecisionNote, setResourceDecisionNote] = useState('Approved by user')
  const [overrideTargetNodeId, setOverrideTargetNodeId] = useState('N-002')
  const [overrideRationale, setOverrideRationale] = useState('Accept risk and revisit invalidated node for targeted verification')
  const [overrideRiskAccepted, setOverrideRiskAccepted] = useState('Potential gate contract violation acknowledged')
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null)
  const [showSupersedesEdges, setShowSupersedesEdges] = useState(true)

  const activeTurn = useMemo(() => (turnReports.length > 0 ? turnReports[turnReports.length - 1] : null), [turnReports])
  const isCheckpointModal = snapshot?.state === 'WAITING_FOR_USER' && Boolean(snapshot?.pendingQuestion?.checkpoint)
  const budgetCaps = snapshot?.budgetCaps ?? defaultOptions.budget
  const budgetUsage = useMemo(() => {
    const used = snapshot?.budgetUsed ?? { tokens: 0, costUsd: 0, turns: 0 }
    const tokenRatio = budgetCaps.maxTokens > 0 ? used.tokens / budgetCaps.maxTokens : 0
    const costRatio = budgetCaps.maxCostUsd > 0 ? used.costUsd / budgetCaps.maxCostUsd : 0
    const turnRatio = budgetCaps.maxTurns > 0 ? used.turns / budgetCaps.maxTurns : 0
    const maxRatio = Math.max(tokenRatio, costRatio, turnRatio)
    return { used, tokenRatio, costRatio, turnRatio, maxRatio }
  }, [snapshot?.budgetUsed, budgetCaps.maxTokens, budgetCaps.maxCostUsd, budgetCaps.maxTurns])
  const budgetAlert = useMemo(() => {
    if (budgetUsage.maxRatio >= 0.95) return { label: 'Critical', tone: 'text-rose-300 border-rose-500/40 bg-rose-500/10' }
    if (budgetUsage.maxRatio >= 0.8) return { label: 'Warning', tone: 'text-amber-300 border-amber-500/40 bg-amber-500/10' }
    return { label: 'Healthy', tone: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' }
  }, [budgetUsage.maxRatio])
  const budgetTrend = useMemo(() => {
    const recent = turnReports.slice(-5)
    if (recent.length === 0) {
      return {
        sampleSize: 0,
        avgTokensPerTurn: 0,
        avgCostPerTurn: 0,
        projectedTurnsLeftByTokens: null as number | null,
        projectedTurnsLeftByCost: null as number | null
      }
    }

    const totalTokens = recent.reduce((sum, turn) => sum + (turn.consumedBudgets?.turnTokens ?? 0), 0)
    const totalCost = recent.reduce((sum, turn) => sum + (turn.consumedBudgets?.turnCostUsd ?? 0), 0)
    const avgTokensPerTurn = totalTokens / recent.length
    const avgCostPerTurn = totalCost / recent.length
    const tokensRemaining = Math.max(0, budgetCaps.maxTokens - (snapshot?.budgetUsed?.tokens ?? 0))
    const costRemaining = Math.max(0, budgetCaps.maxCostUsd - (snapshot?.budgetUsed?.costUsd ?? 0))

    return {
      sampleSize: recent.length,
      avgTokensPerTurn,
      avgCostPerTurn,
      projectedTurnsLeftByTokens: avgTokensPerTurn > 0 ? tokensRemaining / avgTokensPerTurn : null,
      projectedTurnsLeftByCost: avgCostPerTurn > 0 ? costRemaining / avgCostPerTurn : null
    }
  }, [turnReports, budgetCaps.maxTokens, budgetCaps.maxCostUsd, snapshot?.budgetUsed?.tokens, snapshot?.budgetUsed?.costUsd])
  const stateSummary = useMemo(() => buildStateSummary(snapshot?.state, activeTurn), [snapshot?.state, activeTurn])
  const failureInfo = useMemo(() => {
    if (snapshot?.state !== 'FAILED') return null
    const failureEvent = rawEvents.find((event) => {
      if (!event || typeof event !== 'object') return false
      if (event.type === 'loop_error') return true
      return event.type === 'state_transition' && event.to === 'FAILED'
    })

    const reason = String(failureEvent?.message || failureEvent?.reason || activeTurn?.summary || 'Unknown runtime failure')
    const lower = reason.toLowerCase()
    const category = lower.includes('budget')
      ? 'budget_exhausted'
      : lower.includes('deadlock')
        ? 'unrecoverable_deadlock'
        : lower.includes('gate') || lower.includes('constraint')
          ? 'gate_or_constraint_failure'
          : 'runtime_error'

    return { category, reason }
  }, [snapshot?.state, rawEvents, activeTurn?.summary])
  const totalCreatedAssets = useMemo(
    () => turnReports.reduce((sum, turn) => sum + (turn.assetDiff?.created?.length ?? 0), 0),
    [turnReports]
  )
  const assetTypeCounts = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const asset of assetRecords) {
      grouped.set(asset.type, (grouped.get(asset.type) ?? 0) + 1)
    }
    return Array.from(grouped.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [assetRecords])
  const claimMatrixRows = useMemo(() => {
    const claims = assetRecords.filter((asset) => /claim/i.test(asset.type))
    const evidenceLinks = assetRecords.filter((asset) => /evidencelink/i.test(asset.type))
    const linkedByClaim = new Map<string, Array<{ id: string; policy: 'countable' | 'cite_only' | 'needs_revalidate' }>>()

    for (const link of evidenceLinks) {
      const payload = link.payload ?? {}
      const ids = new Set<string>()
      const countingPolicyRaw = typeof payload.countingPolicy === 'string' ? payload.countingPolicy : ''
      const countingPolicy = countingPolicyRaw === 'cite_only' || countingPolicyRaw === 'needs_revalidate'
        ? countingPolicyRaw
        : 'countable'

      const pushValue = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) ids.add(value.trim())
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && item.trim()) ids.add(item.trim())
          }
        }
      }

      pushValue(payload.claimId)
      pushValue(payload.claimIds)
      pushValue(payload.targetClaimId)
      pushValue(payload.targetClaimIds)

      for (const claimId of ids) {
        const existing = linkedByClaim.get(claimId) ?? []
        existing.push({ id: link.id, policy: countingPolicy })
        linkedByClaim.set(claimId, existing)
      }
    }

    const tierRank: Record<string, number> = { primary: 0, secondary: 1, exploratory: 2 }

    return claims
      .map((claim) => {
        const payload = claim.payload ?? {}
        const state = typeof payload.state === 'string' ? payload.state : 'proposed'
        const tier = typeof payload.tier === 'string' ? payload.tier : 'secondary'
        const linked = linkedByClaim.get(claim.id) ?? []
        const countableIds = linked.filter((item) => item.policy === 'countable').map((item) => item.id)
        const citeOnlyIds = linked.filter((item) => item.policy === 'cite_only').map((item) => item.id)
        const needsRevalidateIds = linked.filter((item) => item.policy === 'needs_revalidate').map((item) => item.id)
        const hasPrimaryGap = state === 'asserted' && tier === 'primary' && countableIds.length === 0
        const coverageStatus = countableIds.length > 0
          ? 'countable'
          : citeOnlyIds.length > 0
            ? 'cite_only'
            : needsRevalidateIds.length > 0
              ? 'needs_revalidate'
              : 'empty'

        const summary =
          (typeof claim.payload.statement === 'string' && claim.payload.statement)
          || (typeof claim.payload.claim === 'string' && claim.payload.claim)
          || (typeof claim.payload.title === 'string' && claim.payload.title)
          || 'No claim summary in payload.'

        return {
          id: claim.id,
          summary,
          tier,
          state,
          coverageStatus,
          hasPrimaryGap,
          countableIds,
          citeOnlyIds,
          needsRevalidateIds
        }
      })
      .filter((row) => row.state === 'asserted')
      .sort((a, b) => {
        const rankA = tierRank[a.tier] ?? 99
        const rankB = tierRank[b.tier] ?? 99
        if (rankA !== rankB) return rankA - rankB
        return a.id.localeCompare(b.id)
      })
  }, [assetRecords])
  const latestClaimEvidenceTable = useMemo(() => {
    const latest = assetRecords
      .filter((asset) => asset.type === 'ClaimEvidenceTable')
      .sort((a, b) => a.createdByTurn - b.createdByTurn || a.id.localeCompare(b.id))
      .at(-1)
    if (!latest) return null

    const payload = latest.payload ?? {}
    const coverage = typeof payload.coverage === 'object' && payload.coverage ? payload.coverage as Record<string, unknown> : {}
    const completeness = typeof payload.completeness === 'object' && payload.completeness
      ? payload.completeness as Record<string, unknown>
      : {}
    const rows = Array.isArray(payload.rows)
      ? payload.rows
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const id = typeof row.claimId === 'string' ? row.claimId : ''
          if (!id) return null
          const tier = typeof row.tier === 'string' ? row.tier : 'secondary'
          const state = typeof row.state === 'string' ? row.state : 'asserted'
          const summary = typeof row.summary === 'string' ? row.summary : 'No claim summary in payload.'
          const coverageStatus = typeof row.coverageStatus === 'string' ? row.coverageStatus : 'empty'
          const toStringArray = (value: unknown): string[] => (
            Array.isArray(value)
              ? value.filter((v): v is string => typeof v === 'string')
              : []
          )
          const countableIds = toStringArray(row.countableEvidenceIds)
          const citeOnlyIds = toStringArray(row.citeOnlyEvidenceIds)
          const needsRevalidateIds = toStringArray(row.needsRevalidateEvidenceIds)
          return {
            id,
            summary,
            tier,
            state,
            coverageStatus,
            hasPrimaryGap: state === 'asserted' && tier === 'primary' && countableIds.length === 0,
            countableIds,
            citeOnlyIds,
            needsRevalidateIds
          }
        })
        .filter((row): row is {
          id: string
          summary: string
          tier: string
          state: string
          coverageStatus: string
          hasPrimaryGap: boolean
          countableIds: string[]
          citeOnlyIds: string[]
          needsRevalidateIds: string[]
        } => row !== null)
      : []

    return {
      assetId: latest.id,
      createdByTurn: latest.createdByTurn,
      rowCount: rows.length,
      assertedPrimary: typeof coverage.assertedPrimary === 'number' ? coverage.assertedPrimary : 0,
      coveredPrimary: typeof coverage.coveredPrimary === 'number' ? coverage.coveredPrimary : 0,
      assertedPrimaryCoverage: typeof coverage.assertedPrimaryCoverage === 'number' ? coverage.assertedPrimaryCoverage : null,
      assertedSecondary: typeof coverage.assertedSecondary === 'number' ? coverage.assertedSecondary : 0,
      coveredSecondary: typeof coverage.coveredSecondary === 'number' ? coverage.coveredSecondary : 0,
      assertedSecondaryCoverage: typeof coverage.assertedSecondaryCoverage === 'number' ? coverage.assertedSecondaryCoverage : null,
      primaryPass: completeness.assertedPrimaryCoveragePass === true,
      secondaryPass: completeness.assertedSecondaryCoveragePass === true,
      rows
    }
  }, [assetRecords])
  const matrixRows = useMemo(() => {
    if (latestClaimEvidenceTable?.rows.length) return latestClaimEvidenceTable.rows
    return claimMatrixRows
  }, [latestClaimEvidenceTable, claimMatrixRows])
  const evidenceGraph = useMemo(() => {
    const recentAssets = [...assetRecords]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-220)
    const byId = new Map<string, AssetRecord>()
    for (const asset of recentAssets) {
      byId.set(asset.id, asset)
    }

    const nodeMeta = new Map<string, Omit<EvidenceGraphNode, 'x' | 'y'>>()
    const edgeMap = new Map<string, EvidenceGraphEdge>()

    const ensureNode = (id: string, override?: Partial<Omit<EvidenceGraphNode, 'id' | 'x' | 'y'>>): void => {
      if (!id.trim()) return
      const existing = nodeMeta.get(id)
      const asset = byId.get(id)
      const lane = override?.lane ?? laneFromId(id, asset?.type)
      const label = override?.label ?? toGraphLabel(asset, id)
      const assetType = override?.assetType ?? asset?.type ?? 'ReferencedAsset'
      const external = override?.external ?? !asset
      if (existing) {
        nodeMeta.set(id, {
          ...existing,
          lane,
          label,
          assetType,
          external
        })
        return
      }
      nodeMeta.set(id, {
        id,
        lane,
        label,
        assetType,
        external
      })
    }

    const addEdge = (from: string, to: string, kind: EvidenceGraphEdge['kind']): void => {
      if (!from.trim() || !to.trim() || from === to) return
      ensureNode(from)
      ensureNode(to)
      const key = `${kind}:${from}->${to}`
      if (edgeMap.has(key)) return
      edgeMap.set(key, { id: key, from, to, kind })
    }

    for (const asset of recentAssets) {
      ensureNode(asset.id, { assetType: asset.type, external: false })
      if (asset.supersedes) {
        addEdge(asset.id, asset.supersedes, 'supersedes')
      }
      if (asset.type !== 'EvidenceLink') continue

      const payload = asset.payload ?? {}
      const claimIds = new Set<string>()
      collectStringIds(payload.claimId, claimIds)
      collectStringIds(payload.claimIds, claimIds)
      collectStringIds(payload.targetClaimId, claimIds)
      collectStringIds(payload.targetClaimIds, claimIds)
      for (const claimId of claimIds) {
        ensureNode(claimId, { lane: 'claim' })
        addEdge(claimId, asset.id, 'claim_link')
      }

      const evidenceIds = new Set<string>()
      collectStringIds(payload.evidenceId, evidenceIds)
      collectStringIds(payload.evidenceIds, evidenceIds)
      collectStringIds(payload.runRecordId, evidenceIds)
      collectStringIds(payload.runRecordIds, evidenceIds)
      collectStringIds(payload.sourceAssetId, evidenceIds)
      collectStringIds(payload.sourceAssetIds, evidenceIds)
      for (const evidenceId of evidenceIds) {
        ensureNode(evidenceId, { lane: laneFromId(evidenceId), external: !byId.has(evidenceId) })
        addEdge(asset.id, evidenceId, 'link_evidence')
      }
    }

    const laneX: Record<EvidenceGraphLane, number> = {
      claim: 12,
      link: 38,
      evidence: 68,
      decision: 88
    }
    const laneIds: Record<EvidenceGraphLane, string[]> = {
      claim: [],
      link: [],
      evidence: [],
      decision: []
    }

    for (const node of nodeMeta.values()) {
      laneIds[node.lane].push(node.id)
    }
    for (const lane of Object.keys(laneIds) as EvidenceGraphLane[]) {
      laneIds[lane].sort((a, b) => a.localeCompare(b))
    }

    const positioned: EvidenceGraphNode[] = []
    for (const lane of Object.keys(laneIds) as EvidenceGraphLane[]) {
      const ids = laneIds[lane]
      if (ids.length === 0) continue
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]
        const meta = nodeMeta.get(id)
        if (!meta) continue
        positioned.push({
          ...meta,
          x: laneX[lane],
          y: ((index + 1) / (ids.length + 1)) * 100
        })
      }
    }

    const nodeById = new Map<string, EvidenceGraphNode>(positioned.map((node) => [node.id, node]))
    const edges = Array.from(edgeMap.values())
      .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to))
      .sort((a, b) => a.id.localeCompare(b.id))

    return {
      nodes: positioned,
      nodeById,
      edges,
      counts: {
        claims: positioned.filter((node) => node.lane === 'claim').length,
        links: positioned.filter((node) => node.lane === 'link').length,
        evidence: positioned.filter((node) => node.lane === 'evidence').length,
        decisions: positioned.filter((node) => node.lane === 'decision').length
      }
    }
  }, [assetRecords])
  const selectedGraphNode = useMemo(
    () => (selectedGraphNodeId ? evidenceGraph.nodeById.get(selectedGraphNodeId) ?? null : null),
    [selectedGraphNodeId, evidenceGraph]
  )
  const selectedGraphAsset = useMemo(
    () => (selectedGraphNodeId ? assetRecords.find((asset) => asset.id === selectedGraphNodeId) ?? null : null),
    [selectedGraphNodeId, assetRecords]
  )
  const completeCoverageSummary = useMemo(() => {
    if (latestClaimEvidenceTable) {
      return {
        source: 'ClaimEvidenceTable',
        assertedPrimary: latestClaimEvidenceTable.assertedPrimary,
        coveredPrimary: latestClaimEvidenceTable.coveredPrimary,
        primaryRatio: latestClaimEvidenceTable.assertedPrimaryCoverage,
        assertedSecondary: latestClaimEvidenceTable.assertedSecondary,
        coveredSecondary: latestClaimEvidenceTable.coveredSecondary,
        secondaryRatio: latestClaimEvidenceTable.assertedSecondaryCoverage,
        primaryPass: latestClaimEvidenceTable.primaryPass,
        secondaryPass: latestClaimEvidenceTable.secondaryPass
      }
    }

    let assertedPrimary = 0
    let coveredPrimary = 0
    let assertedSecondary = 0
    let coveredSecondary = 0
    for (const row of claimMatrixRows) {
      if (row.tier === 'primary') {
        assertedPrimary += 1
        if (row.countableIds.length > 0) coveredPrimary += 1
      } else if (row.tier === 'secondary') {
        assertedSecondary += 1
        if (row.countableIds.length > 0) coveredSecondary += 1
      }
    }
    const primaryRatio = assertedPrimary === 0 ? 1 : coveredPrimary / assertedPrimary
    const secondaryRatio = assertedSecondary === 0 ? 1 : coveredSecondary / assertedSecondary
    return {
      source: 'derived',
      assertedPrimary,
      coveredPrimary,
      primaryRatio,
      assertedSecondary,
      coveredSecondary,
      secondaryRatio,
      primaryPass: primaryRatio >= 1,
      secondaryPass: secondaryRatio >= 0.85
    }
  }, [latestClaimEvidenceTable, claimMatrixRows])
  const canPause = snapshot?.state === 'EXECUTING' || snapshot?.state === 'PLANNING'
  const canResume = snapshot?.state === 'PAUSED' || snapshot?.state === 'WAITING_FOR_USER' || snapshot?.state === 'STOPPED'
  const canStop = snapshot?.state === 'PLANNING'
    || snapshot?.state === 'EXECUTING'
    || snapshot?.state === 'TURN_COMPLETE'
    || snapshot?.state === 'WAITING_FOR_USER'
    || snapshot?.state === 'WAITING_EXTERNAL'
    || snapshot?.state === 'PAUSED'
  const filteredTurns = useMemo(() => {
    return [...turnReports]
      .reverse()
      .filter((turn) => {
        const stageOk = timelineStageFilter === 'ALL' || turn.turnSpec?.stage === timelineStageFilter
        const gateOk = timelineGateFilter === 'ALL' || turnGateStatus(turn) === timelineGateFilter
        const progressOk = timelineProgressFilter === 'ALL'
          || (timelineProgressFilter === 'NON_PROGRESS' ? Boolean(turn.nonProgress) : !turn.nonProgress)
        return stageOk && gateOk && progressOk
      })
  }, [turnReports, timelineStageFilter, timelineGateFilter, timelineProgressFilter])
  const selectedTurn = useMemo(() => {
    if (selectedTurnNumber === null) return activeTurn
    return turnReports.find((turn) => turn.turnNumber === selectedTurnNumber) ?? activeTurn
  }, [selectedTurnNumber, turnReports, activeTurn])
  const pendingWaitTask = useMemo(() => {
    if (!snapshot?.pendingExternalTaskId) return null
    return waitTasks.find((task) => task.id === snapshot.pendingExternalTaskId) ?? null
  }, [snapshot?.pendingExternalTaskId, waitTasks])
  const maintenanceAlerts = useMemo(() => (
    rawEvents
      .filter((event) => event?.type === 'maintenance_alert')
      .slice(0, 20)
  ), [rawEvents])
  const governanceSummary = useMemo(() => {
    const countIdsInRiskNote = (riskDelta: string[], prefix: string): number => {
      const matched = riskDelta.find((note) => note.startsWith(prefix))
      if (!matched) return 0
      const idx = matched.indexOf(':')
      if (idx === -1) return 0
      return matched
        .slice(idx + 1)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .length
    }

    let overrideDecisionCount = 0
    let claimFreezeDecisionCount = 0
    for (const asset of assetRecords) {
      if (asset.type !== 'Decision') continue
      const kind = typeof asset.payload?.kind === 'string' ? asset.payload.kind : ''
      const checkpoint = typeof asset.payload?.checkpoint === 'string' ? asset.payload.checkpoint : ''
      if (kind === 'override') overrideDecisionCount += 1
      if (kind === 'claim-freeze' || checkpoint === 'claim-freeze') claimFreezeDecisionCount += 1
    }

    const invalidatedNodeCount = (branchSnapshot?.nodes ?? [])
      .filter((node) => node.status === 'invalidated')
      .length
    const maintenanceErrorCount = maintenanceAlerts
      .filter((event) => event?.severity === 'error')
      .length
    const readinessGateFailureAlertCount = maintenanceAlerts
      .filter((event) => event?.kind === 'readiness_gate_failure')
      .length
    const latestTurn = turnReports[turnReports.length - 1]
    const latestPolicy = turnReports[turnReports.length - 1]?.gateImpact?.snapshotManifest?.evidencePolicy
    const invalidCountableLinkCount = Array.isArray(latestPolicy?.invalidCountableLinkIds)
      ? latestPolicy.invalidCountableLinkIds.length
      : 0
    const missingParityContractLinkCount = Array.isArray(latestPolicy?.keyRunMissingParityContractLinkIds)
      ? latestPolicy.keyRunMissingParityContractLinkIds.length
      : 0
    const latestCausality = turnReports[turnReports.length - 1]?.gateImpact?.snapshotManifest?.causality
    const causalityMissingClaimCount = Array.isArray(latestCausality?.missingClaimIds)
      ? latestCausality.missingClaimIds.length
      : 0
    const latestClaimDecisionBinding = turnReports[turnReports.length - 1]?.gateImpact?.snapshotManifest?.claimDecisionBinding
    const missingClaimDecisionBindingCount = Array.isArray(latestClaimDecisionBinding?.missingFreezeRefClaimIds)
      ? latestClaimDecisionBinding.missingFreezeRefClaimIds.length
      : 0
    const latestDirectEvidence = turnReports[turnReports.length - 1]?.gateImpact?.snapshotManifest?.directEvidence
    const directEvidenceMissingClaimCount = Array.isArray(latestDirectEvidence?.missingClaimIds)
      ? latestDirectEvidence.missingClaimIds.length
      : 0
    const latestReviewerSnapshot = latestTurn?.reviewerSnapshot
    const semanticReviewerCount = Array.isArray(latestReviewerSnapshot?.reviewerPasses)
      ? latestReviewerSnapshot.reviewerPasses.length
      : 0
    const semanticConsensusBlockerCount = Array.isArray(latestReviewerSnapshot?.consensusBlockers)
      ? latestReviewerSnapshot.consensusBlockers.length
      : 0
    const latestReadiness = latestTurn?.readinessSnapshot
    const readinessRequiredFailedCount = Array.isArray(latestReadiness?.requiredFailed)
      ? latestReadiness.requiredFailed.length
      : 0
    const crossBranchDefaultedCount = countIdsInRiskNote(
      latestTurn?.riskDelta ?? [],
      'cross-branch evidence defaulted to cite_only'
    )
    const crossBranchAutoUpgradedCount = countIdsInRiskNote(
      latestTurn?.riskDelta ?? [],
      'cross-branch evidence auto-upgraded to countable'
    )

    return {
      overrideDecisionCount,
      claimFreezeDecisionCount,
      invalidatedNodeCount,
      maintenanceAlertCount: maintenanceAlerts.length,
      maintenanceErrorCount,
      readinessGateFailureAlertCount,
      readinessRequiredFailedCount,
      semanticReviewerCount,
      semanticConsensusBlockerCount,
      crossBranchDefaultedCount,
      crossBranchAutoUpgradedCount,
      invalidCountableLinkCount,
      missingParityContractLinkCount,
      causalityMissingClaimCount,
      missingClaimDecisionBindingCount,
      directEvidenceMissingClaimCount
    }
  }, [assetRecords, branchSnapshot?.nodes, maintenanceAlerts, turnReports])

  useEffect(() => {
    setWaitValidation(null)
  }, [pendingWaitTask?.id])

  const stageGates = useMemo(() => {
    const initial: Record<StageId, {
      status: 'pass' | 'fail' | 'none'
      lastTurn?: number
      objective?: string
      summary?: string
    }> = {
      S1: { status: 'none' },
      S2: { status: 'none' },
      S3: { status: 'none' },
      S4: { status: 'none' },
      S5: { status: 'none' }
    }

    for (const turn of turnReports) {
      const stage = turn.turnSpec?.stage
      if (!stage || !isStageId(stage)) continue

      const gateStatus = turn.gateImpact?.status
      let status: 'pass' | 'fail' | 'none' = 'none'
      if (gateStatus === 'pass' || turn.gateImpact?.gateResult?.passed === true) {
        status = 'pass'
      } else if (gateStatus === 'fail' || gateStatus === 'rollback-needed' || turn.gateImpact?.gateResult?.passed === false) {
        status = 'fail'
      }

      initial[stage] = {
        status,
        lastTurn: turn.turnNumber,
        objective: turn.turnSpec?.objective,
        summary: turn.summary
      }
    }

    return initial
  }, [turnReports])

  useEffect(() => {
    if (snapshot?.activeStage) setSelectedStage(snapshot.activeStage)
  }, [snapshot?.activeStage])

  useEffect(() => {
    if (snapshot?.phase) setSelectedPhase(snapshot.phase)
  }, [snapshot?.phase])

  useEffect(() => {
    if (!snapshot?.sessionId) return
    if (goalSessionId === snapshot.sessionId) return
    setGoal(snapshot.goal || '')
    setGoalSessionId(snapshot.sessionId)
  }, [snapshot?.sessionId, snapshot?.goal, goalSessionId])

  useEffect(() => {
    if (snapshot?.state === 'FAILED') {
      setRightView('diagnostics')
    }
  }, [snapshot?.state])

  useEffect(() => {
    if (turnReports.length === 0) {
      setSelectedTurnNumber(null)
      return
    }
    if (selectedTurnNumber === null) {
      setSelectedTurnNumber(turnReports[turnReports.length - 1]?.turnNumber ?? null)
      return
    }
    const exists = turnReports.some((turn) => turn.turnNumber === selectedTurnNumber)
    if (!exists) {
      setSelectedTurnNumber(turnReports[turnReports.length - 1]?.turnNumber ?? null)
    }
  }, [turnReports, selectedTurnNumber])

  useEffect(() => {
    if (!selectedGraphNodeId) return
    const exists = evidenceGraph.nodes.some((node) => node.id === selectedGraphNodeId)
    if (!exists) {
      setSelectedGraphNodeId(null)
    }
  }, [selectedGraphNodeId, evidenceGraph.nodes])

  async function refreshQueue() {
    try {
      const queue = await api.yoloGetInputQueue()
      setQueuedInputs(Array.isArray(queue) ? queue : [])
    } catch {
      setQueuedInputs([])
    }
  }

  async function refreshWaitTasks() {
    try {
      const tasks = await api.yoloListWaitTasks()
      setWaitTasks(Array.isArray(tasks) ? tasks : [])
      setWaitValidation((prev) => {
        if (!prev) return prev
        const stillExists = (Array.isArray(tasks) ? tasks : []).some((task) => task.id === prev.taskId)
        return stillExists ? prev : null
      })
    } catch {
      setWaitTasks([])
      setWaitValidation(null)
    }
  }

  async function refreshBranchSnapshot() {
    try {
      const next = await api.yoloGetBranchSnapshot()
      setBranchSnapshot(next ?? null)
    } catch {
      setBranchSnapshot(null)
    }
  }

  async function refreshAssets() {
    try {
      const assets = await api.yoloGetAssets()
      setAssetRecords(Array.isArray(assets) ? assets : [])
    } catch {
      setAssetRecords([])
    }
  }

  async function refreshHistory() {
    const [reports, history] = await Promise.all([
      api.yoloGetTurnReports().catch(() => []),
      api.yoloGetEvents().catch(() => [])
    ])
    setTurnReports(reports || [])
    setRawEvents(Array.isArray(history) ? (history as any[]).slice(0, 120) : [])
    setEvents((history as any[]).map((item) => formatEvent(item)).slice(0, 120))
    await Promise.all([refreshBranchSnapshot(), refreshAssets()])
  }

  useEffect(() => {
    api.getCurrentSession().then((session: { projectPath: string }) => {
      if (session?.projectPath) setProjectPath(session.projectPath)
    })

    const unsubState = api.onYoloState((payload: YoloSnapshot) => {
      setSnapshot(payload)
      void refreshQueue()
      void refreshWaitTasks()
      void refreshBranchSnapshot()
      void refreshAssets()
    })
    const unsubTurn = api.onYoloTurnReport((payload: TurnReport) => {
      setTurnReports((prev) => [...prev, payload])
      void refreshQueue()
      void refreshBranchSnapshot()
      void refreshAssets()
    })
    const unsubQuestion = api.onYoloQuestion((payload: any) => {
      setEvents((prev) => [{ at: new Date().toISOString(), type: 'question', text: `Question: ${payload?.question ?? ''}` }, ...prev].slice(0, 80))
      setRawEvents((prev) => [{ type: 'question', timestamp: new Date().toISOString(), ...payload }, ...prev].slice(0, 120))
    })
    const unsubEvent = api.onYoloEvent((payload: any) => {
      setEvents((prev) => [formatEvent(payload), ...prev].slice(0, 80))
      setRawEvents((prev) => [payload, ...prev].slice(0, 120))
      if (payload?.type === 'input_queue_changed') {
        void refreshQueue()
      }
      if (
        payload?.type === 'wait_external_requested'
        || payload?.type === 'wait_external_resolved'
        || payload?.type === 'wait_external_cancelled'
        || payload?.type === 'fulltext_wait_requested'
      ) {
        void refreshWaitTasks()
      }
      if (payload?.type === 'turn_committed') {
        void refreshBranchSnapshot()
        void refreshAssets()
      }
    })
    const unsubClosed = api.onProjectClosed(() => {
      setProjectPath('')
      setSnapshot(null)
      setTurnReports([])
      setEvents([])
      setRawEvents([])
      setBranchSnapshot(null)
      setAssetRecords([])
      setRightView('timeline')
      setQueuedInputs([])
      setWaitTasks([])
      setWaitValidation(null)
      setGoalSessionId(null)
      setSelectedPhase('P0')
      setActionError(null)
      setActionNotice(null)
      setResourceDecisionNote('Approved by user')
      setOverrideTargetNodeId('N-002')
      setOverrideRationale('Accept risk and revisit invalidated node for targeted verification')
      setOverrideRiskAccepted('Potential gate contract violation acknowledged')
    })

    api.yoloGetSnapshot().then((s: YoloSnapshot | null) => setSnapshot(s)).catch(() => {})
    void refreshHistory()
    void refreshQueue()
    void refreshWaitTasks()

    return () => {
      unsubState(); unsubTurn(); unsubQuestion(); unsubEvent(); unsubClosed()
    }
  }, [])

  async function pickFolder() {
    const picked = await api.pickFolder()
    if (!picked) return
    setProjectPath(picked.projectPath)
    setActionError(null)
    setActionNotice(null)
    const s = await api.yoloGetSnapshot().catch(() => null)
    setSnapshot(s)
    await refreshHistory()
    await refreshQueue()
    await refreshWaitTasks()
  }

  async function startYolo() {
    setIsStarting(true)
    setActionError(null)
    setActionNotice(null)
    try {
      const started = await api.yoloStart(goal, { ...defaultOptions, phase: selectedPhase })
      setSnapshot(started)
      await refreshHistory()
      await refreshQueue()
      await refreshWaitTasks()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsStarting(false)
    }
  }

  async function pauseYolo() {
    setActionError(null)
    setActionNotice(null)
    try {
      const s = await api.yoloPause()
      setSnapshot(s)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function resumeYolo() {
    setActionError(null)
    setActionNotice(null)
    try {
      const s = await api.yoloResume()
      setSnapshot(s)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function stopYolo() {
    setActionError(null)
    setActionNotice(null)
    try {
      const s = await api.yoloStop()
      setSnapshot(s)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function restoreFromCheckpoint() {
    setActionError(null)
    setActionNotice(null)
    try {
      const result = await api.yoloRestoreCheckpoint()
      setSnapshot(result.snapshot ?? null)
      await refreshHistory()
      setActionNotice(result.restored ? 'Restored from latest checkpoint.' : 'No checkpoint available for restore.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function submitReply() {
    const text = replyText.trim()
    if (!text) return
    await api.yoloEnqueueInput(text, 'urgent')
    setReplyText('')
    await refreshQueue()
  }

  async function exportSummary() {
    setActionError(null)
    try {
      const result = await api.yoloExportSummary()
      setActionNotice(`Summary exported to ${result.path}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function exportClaimEvidenceTable() {
    setActionError(null)
    try {
      const result = await api.yoloExportClaimEvidenceTable()
      setActionNotice(`Claim-evidence table exported to ${result.path}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function exportAssetInventory() {
    setActionError(null)
    try {
      const result = await api.yoloExportAssetInventory()
      setActionNotice(`Asset inventory exported to ${result.path}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function exportFinalBundle() {
    setActionError(null)
    try {
      const result = await api.yoloExportFinalBundle()
      setActionNotice(`Final bundle manifest exported to ${result.manifestPath}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function requestWaitExternal() {
    setActionError(null)
    setActionNotice(null)
    try {
      await api.yoloWaitExternal({
        title: waitTitle,
        completionRule: waitRule,
        resumeAction: waitResumeAction,
        details: waitDetails
      })
      await refreshWaitTasks()
      const s = await api.yoloGetSnapshot().catch(() => null)
      setSnapshot(s)
      setActionNotice('External wait requested.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function requestFullTextWait() {
    setActionError(null)
    setActionNotice(null)
    try {
      const requiredFiles = fullTextRequiredFiles
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      await api.yoloRequestFullTextWait({
        citation: fullTextCitation,
        requiredFiles,
        reason: fullTextReason
      })
      await refreshWaitTasks()
      const s = await api.yoloGetSnapshot().catch(() => null)
      setSnapshot(s)
      setActionNotice('Full-text wait requested.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function resolveWaitTask() {
    setActionError(null)
    setActionNotice(null)
    try {
      const pendingId = snapshot?.pendingExternalTaskId
      if (!pendingId) throw new Error('No pending external task.')
      await api.yoloResolveWaitTask({ taskId: pendingId, resolutionNote: waitResolutionNote })
      await refreshWaitTasks()
      const s = await api.yoloGetSnapshot().catch(() => null)
      setSnapshot(s)
      setActionNotice('External wait resolved.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function validateWaitTask() {
    setActionError(null)
    setActionNotice(null)
    try {
      const pendingId = snapshot?.pendingExternalTaskId
      if (!pendingId) throw new Error('No pending external task.')
      const result = await api.yoloValidateWaitTask({ taskId: pendingId })
      setWaitValidation(result)
      setActionNotice(result.ok ? 'Wait task validation passed.' : `Wait task validation failed: ${result.reason ?? 'missing uploads'}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function cancelWaitTask() {
    setActionError(null)
    setActionNotice(null)
    try {
      const pendingId = snapshot?.pendingExternalTaskId
      if (!pendingId) throw new Error('No pending external task.')
      await api.yoloCancelWaitTask({ taskId: pendingId, reason: waitCancelReason })
      await refreshWaitTasks()
      const s = await api.yoloGetSnapshot().catch(() => null)
      setSnapshot(s)
      setActionNotice('External wait cancelled.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function addIngressFiles(taskId?: string) {
    setActionError(null)
    setActionNotice(null)
    try {
      const result = await api.yoloAddIngressFiles(taskId ? { taskId } : undefined)
      if (result.files.length === 0) {
        setActionNotice(`No files selected. Upload dir: ${result.uploadDir}`)
        return
      }
      setActionNotice(`Added ${result.files.length} file(s) to ${result.uploadDir}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function requestResourceExtension() {
    setActionError(null)
    setActionNotice(null)
    try {
      await api.yoloRequestResourceExtension({
        rationale: resourceRationale,
        delta: {
          maxTurns: Number(resourceDeltaTurns) || 0,
          maxTokens: Number(resourceDeltaTokens) || 0,
          maxCostUsd: Number(resourceDeltaCostUsd) || 0
        },
        requestedBy: 'user'
      })
      const s = await api.yoloGetSnapshot().catch(() => null)
      setSnapshot(s)
      setActionNotice('Resource extension requested; waiting for decision.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function resolveResourceExtension(approved: boolean) {
    setActionError(null)
    setActionNotice(null)
    try {
      await api.yoloResolveResourceExtension({
        approved,
        note: resourceDecisionNote
      })
      const s = await api.yoloGetSnapshot().catch(() => null)
      setSnapshot(s)
      setActionNotice(`Resource extension ${approved ? 'approved' : 'rejected'}.`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function recordOverrideDecision() {
    setActionError(null)
    setActionNotice(null)
    try {
      const result = await api.yoloRecordOverrideDecision({
        targetNodeId: overrideTargetNodeId,
        rationale: overrideRationale,
        riskAccepted: overrideRiskAccepted
      })
      setActionNotice(`Override decision recorded: ${result.decisionAssetId}`)
      await refreshAssets()
      await refreshHistory()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function submitQuickReply(text: string) {
    await api.yoloEnqueueInput(text, 'urgent')
    await refreshQueue()
  }

  async function setQueuePriority(id: string, priority: 'urgent' | 'normal') {
    await api.yoloQueueReprioritize(id, priority)
    await refreshQueue()
  }

  async function moveQueueItem(id: string, toIndex: number) {
    await api.yoloQueueMove(id, toIndex)
    await refreshQueue()
  }

  async function removeQueueItem(id: string) {
    await api.yoloQueueRemove(id)
    await refreshQueue()
  }

  const quickOptions = useMemo(() => {
    const options = snapshot?.pendingQuestion?.options
    if (options && options.length > 0) return options
    if (snapshot?.pendingQuestion?.checkpoint) return ['Confirm', 'Edit', 'Reject']
    return []
  }, [snapshot?.pendingQuestion?.options, snapshot?.pendingQuestion?.checkpoint])

  if (!projectPath) return <FolderGate onPick={pickFolder} />

  return (
    <div className="flex h-screen w-screen flex-col t-text">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-20" />

      <header className="no-drag border-b t-border px-6 pt-10 pb-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold" style={{ fontFamily: "'Playfair Display', serif" }}>YOLO Mission Control</h1>
            <p className="text-xs t-text-secondary mt-1">{projectPath}</p>
          </div>
          <div className={`rounded-full border px-3 py-1 text-xs font-medium ${stateTone(snapshot?.state)}`}>
            {snapshot?.state ?? 'IDLE'}
          </div>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[1.2fr_1fr] gap-4 p-4">
        <section className="min-h-0 rounded-2xl border t-border t-bg-surface p-4">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <FlaskConical size={16} className="text-teal-300" />
            Mission Control
          </div>

          <label className="mb-2 block text-xs uppercase tracking-wide t-text-secondary">Goal</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            className="mb-3 w-full resize-none rounded-xl border t-border bg-transparent p-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
          />

          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="t-text-secondary">Phase</span>
            <select
              value={selectedPhase}
              onChange={(e) => setSelectedPhase(e.target.value as 'P0' | 'P1' | 'P2' | 'P3')}
              className="rounded-md border t-border bg-transparent px-2 py-1"
              disabled={Boolean(snapshot?.sessionId)}
            >
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <button className="rounded-lg bg-teal-500 px-3 py-2 text-xs font-medium text-white disabled:opacity-60" onClick={startYolo} disabled={isStarting}>
              <Play size={13} className="inline mr-1" /> Start
            </button>
            <button className="rounded-lg border t-border px-3 py-2 text-xs font-medium disabled:opacity-50" onClick={pauseYolo} disabled={!canPause}>
              <Pause size={13} className="inline mr-1" /> Pause
            </button>
            <button className="rounded-lg border t-border px-3 py-2 text-xs font-medium disabled:opacity-50" onClick={resumeYolo} disabled={!canResume}>
              <Play size={13} className="inline mr-1" /> Resume
            </button>
            <button className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-medium text-rose-300 disabled:opacity-50" onClick={stopYolo} disabled={!canStop}>
              <Square size={13} className="inline mr-1" /> Stop
            </button>
          </div>

          {actionError && (
            <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {actionError}
            </div>
          )}
          {actionNotice && (
            <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              {actionNotice}
            </div>
          )}

          <div className={`mb-4 rounded-xl border px-3 py-2 text-xs ${budgetAlert.tone}`}>
            <div className="font-medium">Budget {budgetAlert.label}</div>
            <div className="mt-1">
              tokens {Math.round(budgetUsage.tokenRatio * 100)}% · cost {Math.round(budgetUsage.costRatio * 100)}% · turns {Math.round(budgetUsage.turnRatio * 100)}%
            </div>
          </div>

          <div className="mb-4 rounded-xl border t-border p-3 text-xs">
            <div className="font-medium t-text-secondary">Burn Rate (last {budgetTrend.sampleSize || 0} turns)</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">avg tokens / turn</div>
                <div className="mt-1 text-sm font-semibold">{Math.round(budgetTrend.avgTokensPerTurn).toLocaleString()}</div>
              </div>
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">avg cost / turn</div>
                <div className="mt-1 text-sm font-semibold">${budgetTrend.avgCostPerTurn.toFixed(3)}</div>
              </div>
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">token runway</div>
                <div className="mt-1 text-sm font-semibold">
                  {budgetTrend.projectedTurnsLeftByTokens === null ? '-' : `${Math.max(0, Math.floor(budgetTrend.projectedTurnsLeftByTokens))} turns`}
                </div>
              </div>
              <div className="rounded-lg t-bg-elevated p-2">
                <div className="t-text-muted">cost runway</div>
                <div className="mt-1 text-sm font-semibold">
                  {budgetTrend.projectedTurnsLeftByCost === null ? '-' : `${Math.max(0, Math.floor(budgetTrend.projectedTurnsLeftByCost))} turns`}
                </div>
              </div>
            </div>
          </div>

          {stateSummary && (
            <div className={`mb-4 rounded-xl border px-3 py-2 text-xs ${stateSummary.tone}`}>
              <div className="font-medium">{stateSummary.title}</div>
              <div className="mt-1">{stateSummary.detail}</div>
              {snapshot?.state === 'FAILED' && failureInfo && (
                <div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-100">
                  <div>category: {failureInfo.category}</div>
                  <div className="mt-0.5">reason: {failureInfo.reason}</div>
                </div>
              )}
              {snapshot?.state === 'STOPPED' && (
                <div className="mt-2 rounded-lg border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-[11px] text-slate-100">
                  turns: {snapshot.budgetUsed.turns} · assets: {totalCreatedAssets} · tokens: {snapshot.budgetUsed.tokens.toLocaleString()} · cost: ${snapshot.budgetUsed.costUsd.toFixed(3)}
                </div>
              )}
              {snapshot?.state === 'COMPLETE' && (
                <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-100">
                  <div>
                    source: {completeCoverageSummary.source}
                    {' · '}
                    primary {completeCoverageSummary.coveredPrimary}/{completeCoverageSummary.assertedPrimary}
                    {' · '}
                    ratio {(completeCoverageSummary.primaryRatio ?? 0).toFixed(2)}
                    {' · '}
                    {completeCoverageSummary.primaryPass ? 'pass' : 'fail'}
                  </div>
                  <div className="mt-0.5">
                    secondary {completeCoverageSummary.coveredSecondary}/{completeCoverageSummary.assertedSecondary}
                    {' · '}
                    ratio {(completeCoverageSummary.secondaryRatio ?? 0).toFixed(2)}
                    {' · '}
                    {completeCoverageSummary.secondaryPass ? 'pass' : 'fail'}
                  </div>
                  <div className="mt-1">
                    <button
                      onClick={() => setRightView('matrix')}
                      className="mr-2 rounded-md border border-emerald-400/40 px-2 py-1 text-[11px] text-emerald-50 hover:bg-emerald-500/20"
                    >
                      Open Evidence Map
                    </button>
                    <button
                      onClick={exportFinalBundle}
                      className="rounded-md border border-emerald-400/40 px-2 py-1 text-[11px] text-emerald-50 hover:bg-emerald-500/20"
                    >
                      Export Final Bundle
                    </button>
                  </div>
                </div>
              )}
              {(snapshot?.state === 'FAILED' || snapshot?.state === 'STOPPED' || snapshot?.state === 'COMPLETE') && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {snapshot?.state === 'FAILED' && (
                    <button
                      onClick={() => setRightView('diagnostics')}
                      className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                    >
                      Inspect Diagnostics
                    </button>
                  )}
                  {(snapshot?.state === 'FAILED' || snapshot?.state === 'STOPPED') && selectedPhase !== 'P0' && (
                    <button
                      onClick={restoreFromCheckpoint}
                      className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                    >
                      Restore Checkpoint
                    </button>
                  )}
                  {snapshot?.state === 'STOPPED' && (
                    <button
                      onClick={resumeYolo}
                      className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                    >
                      Resume Session
                    </button>
                  )}
                  <button
                    onClick={startYolo}
                    className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                  >
                    Restart New Run
                  </button>
                  <button
                    onClick={exportSummary}
                    className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                  >
                    Export Summary
                  </button>
                  <button
                    onClick={exportClaimEvidenceTable}
                    className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                  >
                    Export Claim Table
                  </button>
                  <button
                    onClick={exportAssetInventory}
                    className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                  >
                    Export Assets
                  </button>
                  <button
                    onClick={exportFinalBundle}
                    className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
                  >
                    Export Final Bundle
                  </button>
                </div>
              )}
            </div>
          )}

          <div
            className={`mb-4 rounded-xl border px-3 py-2 text-xs ${
              completeCoverageSummary.primaryPass && completeCoverageSummary.secondaryPass
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-100'
            }`}
          >
            <div className="font-medium">Claim Coverage</div>
            <div className="mt-1 t-text-secondary">
              source {completeCoverageSummary.source}
            </div>
            <div className="mt-1">
              primary {completeCoverageSummary.coveredPrimary}/{completeCoverageSummary.assertedPrimary}
              {' · '}
              ratio {(completeCoverageSummary.primaryRatio ?? 0).toFixed(2)}
              {' · '}
              target 1.00
              {' · '}
              {completeCoverageSummary.primaryPass ? 'pass' : 'fail'}
            </div>
            <div className="mt-1">
              secondary {completeCoverageSummary.coveredSecondary}/{completeCoverageSummary.assertedSecondary}
              {' · '}
              ratio {(completeCoverageSummary.secondaryRatio ?? 0).toFixed(2)}
              {' · '}
              target 0.85
              {' · '}
              {completeCoverageSummary.secondaryPass ? 'pass' : 'fail'}
            </div>
          </div>

          <div
            className={`mb-4 rounded-xl border px-3 py-2 text-xs ${
              governanceSummary.maintenanceErrorCount > 0 || governanceSummary.invalidatedNodeCount > 0
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                : 't-border'
            }`}
          >
            <div className="font-medium">Governance Overview</div>
            <div className="mt-1">
              overrides {governanceSummary.overrideDecisionCount}
              {' · '}
              claim-freeze decisions {governanceSummary.claimFreezeDecisionCount}
              {' · '}
              invalidated nodes {governanceSummary.invalidatedNodeCount}
            </div>
            <div className="mt-1 t-text-secondary">
              maintenance alerts {governanceSummary.maintenanceAlertCount}
              {' · '}
              critical/error {governanceSummary.maintenanceErrorCount}
              {' · '}
              readiness alerts {governanceSummary.readinessGateFailureAlertCount}
              {' · '}
              readiness required-fail {governanceSummary.readinessRequiredFailedCount}
              {' · '}
              semantic reviewers {governanceSummary.semanticReviewerCount}
              {' · '}
              semantic consensus blockers {governanceSummary.semanticConsensusBlockerCount}
              {' · '}
              cross-branch defaulted {governanceSummary.crossBranchDefaultedCount}
              {' · '}
              cross-branch auto-upgraded {governanceSummary.crossBranchAutoUpgradedCount}
              {' · '}
              invalid countable links {governanceSummary.invalidCountableLinkCount}
              {' · '}
              missing parity contract links {governanceSummary.missingParityContractLinkCount}
              {' · '}
              causality missing claims {governanceSummary.causalityMissingClaimCount}
              {' · '}
              claim-freeze binding gaps {governanceSummary.missingClaimDecisionBindingCount}
              {' · '}
              direct-evidence gaps {governanceSummary.directEvidenceMissingClaimCount}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => setRightView('branches')}
                className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
              >
                Inspect Branches
              </button>
              <button
                onClick={() => setRightView('diagnostics')}
                className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/10"
              >
                Inspect Diagnostics
              </button>
            </div>
          </div>

          <div className="mb-4 rounded-xl border t-border p-3">
            <div className="mb-2 text-xs font-medium t-text-secondary">Stage Progress</div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {STAGES.map((stage, index) => {
                const info = stageGates[stage]
                const isCurrent = snapshot?.activeStage === stage
                return (
                  <React.Fragment key={stage}>
                    <button
                      onClick={() => setSelectedStage(stage)}
                      className={`flex min-w-[72px] items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs ${
                        isCurrent ? 'border-teal-500/60 bg-teal-500/10 text-teal-200' : 't-border t-text-secondary'
                      }`}
                      title={`Inspect ${stage}`}
                    >
                      {info.status === 'pass' && <CheckCircle2 size={12} className="text-emerald-300" />}
                      {info.status === 'fail' && <AlertTriangle size={12} className="text-rose-300" />}
                      {info.status === 'none' && <Minus size={12} className="t-text-muted" />}
                      {stage}
                    </button>
                    {index < STAGES.length - 1 && <div className="h-px min-w-4 flex-1 t-border bg-current opacity-25" />}
                  </React.Fragment>
                )
              })}
            </div>
            <div className="mt-3 rounded-lg t-bg-elevated p-2 text-xs">
              <div className="font-medium">
                {selectedStage} · {stageGates[selectedStage].status === 'none' ? 'not-evaluated' : stageGates[selectedStage].status}
                {stageGates[selectedStage].lastTurn ? ` · turn ${stageGates[selectedStage].lastTurn}` : ''}
              </div>
              <div className="mt-1 t-text-secondary">
                {stageGates[selectedStage].summary ?? 'No gate result yet for this stage.'}
              </div>
            </div>
          </div>

          <div className="mb-4 rounded-xl border t-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium t-text-secondary">
                Input Queue ({queuedInputs.length})
              </div>
              <button className="rounded-md border t-border px-2 py-1 text-[11px]" onClick={() => setQueueOpen((v) => !v)}>
                {queueOpen ? 'Collapse' : 'Expand'}
              </button>
            </div>
            <div className="mb-2 text-[11px] t-text-muted">
              Queued messages are merged at the next turn boundary.
            </div>
            {queueOpen && (
              queuedInputs.length === 0 ? (
                <div className="rounded-lg t-bg-elevated p-2 text-xs t-text-muted">No queued input.</div>
              ) : (
                <div className="space-y-2">
                  {queuedInputs.map((item, index) => (
                    <div key={item.id} className="rounded-lg border t-border p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs">{item.text}</div>
                          <div className="mt-1 text-[11px] t-text-muted">
                            {new Date(item.createdAt).toLocaleTimeString()} · {item.source}
                            {` · est. turn ${(snapshot?.currentTurn ?? 0) + 1}`}
                          </div>
                        </div>
                        <button
                          onClick={() => removeQueueItem(item.id)}
                          className="rounded-md border border-rose-500/40 p-1 text-rose-300 hover:bg-rose-500/10"
                          title="Remove"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <button
                          onClick={() => setQueuePriority(item.id, item.priority === 'urgent' ? 'normal' : 'urgent')}
                          className={`rounded-md border px-2 py-1 text-[11px] ${item.priority === 'urgent' ? 'border-amber-500/50 text-amber-300' : 't-border t-text-secondary'}`}
                        >
                          {item.priority}
                        </button>
                        <button
                          onClick={() => moveQueueItem(item.id, index - 1)}
                          disabled={index === 0}
                          className="rounded-md border t-border p-1 disabled:opacity-40"
                          title="Move up"
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          onClick={() => moveQueueItem(item.id, index + 1)}
                          disabled={index === queuedInputs.length - 1}
                          className="rounded-md border t-border p-1 disabled:opacity-40"
                          title="Move down"
                        >
                          <ArrowDown size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {selectedPhase !== 'P0' && (
            <div className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
              <div className="mb-2 text-xs font-medium text-sky-200">External Wait</div>
              {snapshot?.state === 'WAITING_EXTERNAL' ? (
                <div className="space-y-2 text-xs">
                  <div className="rounded-lg border border-sky-500/30 p-2">
                    <div className="font-medium">{pendingWaitTask?.title ?? 'Pending external task'}</div>
                    <div className="mt-1 t-text-secondary">{pendingWaitTask?.completionRule}</div>
                    {pendingWaitTask?.requiredArtifacts && pendingWaitTask.requiredArtifacts.length > 0 && (
                      <div className="mt-1 text-[11px] t-text-muted">
                        required: {pendingWaitTask.requiredArtifacts.map((item) => item.pathHint || item.description).join(', ')}
                      </div>
                    )}
                    {pendingWaitTask?.uploadDir && (
                      <div className="mt-1 text-[11px] t-text-muted">uploadDir: {pendingWaitTask.uploadDir}</div>
                    )}
                  </div>
                  <button
                    onClick={() => addIngressFiles(pendingWaitTask?.id)}
                    className="rounded-md border border-sky-400/40 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/10"
                  >
                    Add Files To Upload Dir
                  </button>
                  <button
                    onClick={validateWaitTask}
                    className="rounded-md border border-sky-400/40 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/10"
                  >
                    Validate Uploads
                  </button>
                  {waitValidation && waitValidation.taskId === pendingWaitTask?.id && (
                    <div className={`rounded-lg border px-2 py-1 text-[11px] ${waitValidation.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'}`}>
                      {waitValidation.ok
                        ? `Validation passed${waitValidation.requiredUploads.length > 0 ? ` · required files present (${waitValidation.requiredUploads.join(', ')})` : ''}`
                        : `Validation failed · ${waitValidation.reason ?? 'missing required uploads'}`}
                      {waitValidation.checks.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {waitValidation.checks.map((check) => (
                            <div key={check.name}>
                              {check.passed ? 'PASS' : 'FAIL'} · {check.name}
                              {check.detail ? ` · ${check.detail}` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <input
                    value={waitResolutionNote}
                    onChange={(e) => setWaitResolutionNote(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Resolution note..."
                  />
                  <input
                    value={waitCancelReason}
                    onChange={(e) => setWaitCancelReason(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Cancel reason..."
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={resolveWaitTask}
                      className="rounded-md border border-sky-400/40 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/10"
                    >
                      Mark External Task Complete
                    </button>
                    <button
                      onClick={cancelWaitTask}
                      className="rounded-md border border-amber-500/40 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
                    >
                      Cancel External Task
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    value={waitTitle}
                    onChange={(e) => setWaitTitle(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Task title..."
                  />
                  <input
                    value={waitRule}
                    onChange={(e) => setWaitRule(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Completion rule..."
                  />
                  <input
                    value={waitResumeAction}
                    onChange={(e) => setWaitResumeAction(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Resume action..."
                  />
                  <input
                    value={waitDetails}
                    onChange={(e) => setWaitDetails(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Optional details..."
                  />
                  <button
                    onClick={requestWaitExternal}
                    className="rounded-md border border-sky-400/40 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/10"
                  >
                    Enter WAITING_EXTERNAL
                  </button>
                  <button
                    onClick={() => addIngressFiles()}
                    className="rounded-md border border-sky-400/40 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/10"
                  >
                    Stage Files For Next Turn
                  </button>

                  <div className="mt-2 border-t border-sky-500/20 pt-2 text-[11px] text-sky-200">
                    Missing Full-text Shortcut
                  </div>
                  <input
                    value={fullTextCitation}
                    onChange={(e) => setFullTextCitation(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Citation..."
                  />
                  <input
                    value={fullTextRequiredFiles}
                    onChange={(e) => setFullTextRequiredFiles(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Required files (comma-separated)..."
                  />
                  <input
                    value={fullTextReason}
                    onChange={(e) => setFullTextReason(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30"
                    placeholder="Reason full text is missing..."
                  />
                  <button
                    onClick={requestFullTextWait}
                    className="rounded-md border border-sky-400/40 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/10"
                  >
                    Request Full-text WAITING_EXTERNAL
                  </button>
                </div>
              )}
            </div>
          )}

          {selectedPhase !== 'P0' && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="mb-2 text-xs font-medium text-amber-200">Resource Extension</div>
              {snapshot?.pendingResourceExtension ? (
                <div className="space-y-2 text-xs">
                  <div className="rounded-lg border border-amber-500/30 p-2">
                    <div className="font-medium">Request {snapshot.pendingResourceExtension.id}</div>
                    <div className="mt-1 t-text-secondary">
                      +turns {snapshot.pendingResourceExtension.delta.maxTurns}
                      {' · '}
                      +tokens {snapshot.pendingResourceExtension.delta.maxTokens}
                      {' · '}
                      +cost ${snapshot.pendingResourceExtension.delta.maxCostUsd.toFixed(3)}
                    </div>
                    <div className="mt-1 text-[11px] t-text-muted">{snapshot.pendingResourceExtension.rationale}</div>
                  </div>
                  <input
                    value={resourceDecisionNote}
                    onChange={(e) => setResourceDecisionNote(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Decision note..."
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => resolveResourceExtension(true)}
                      className="rounded-md border border-emerald-500/40 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/10"
                    >
                      Approve Extension
                    </button>
                    <button
                      onClick={() => resolveResourceExtension(false)}
                      className="rounded-md border border-rose-500/40 px-3 py-2 text-xs font-medium text-rose-200 hover:bg-rose-500/10"
                    >
                      Reject Extension
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={resourceRationale}
                    onChange={(e) => setResourceRationale(e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Why extension is needed..."
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      value={resourceDeltaTurns}
                      onChange={(e) => setResourceDeltaTurns(e.target.value)}
                      className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                      placeholder="+turns"
                    />
                    <input
                      value={resourceDeltaTokens}
                      onChange={(e) => setResourceDeltaTokens(e.target.value)}
                      className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                      placeholder="+tokens"
                    />
                    <input
                      value={resourceDeltaCostUsd}
                      onChange={(e) => setResourceDeltaCostUsd(e.target.value)}
                      className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                      placeholder="+cost usd"
                    />
                  </div>
                  <button
                    onClick={requestResourceExtension}
                    className="rounded-md border border-amber-500/40 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
                  >
                    Request Extension
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl t-bg-elevated p-3">
              <div className="t-text-secondary">Current Turn</div>
              <div className="mt-1 text-sm font-semibold">{snapshot?.currentTurn ?? 0}</div>
            </div>
            <div className="rounded-xl t-bg-elevated p-3">
              <div className="t-text-secondary">Active Stage</div>
              <div className="mt-1 text-sm font-semibold">{snapshot?.activeStage ?? 'S1'}</div>
            </div>
            <div className="rounded-xl t-bg-elevated p-3">
              <div className="t-text-secondary">Tokens Used</div>
              <div className="mt-1 text-sm font-semibold">
                {(snapshot?.budgetUsed?.tokens ?? 0).toLocaleString()} / {budgetCaps.maxTokens.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl t-bg-elevated p-3">
              <div className="t-text-secondary">Cost Used</div>
              <div className="mt-1 text-sm font-semibold">
                ${(snapshot?.budgetUsed?.costUsd ?? 0).toFixed(3)} / ${budgetCaps.maxCostUsd.toFixed(3)}
              </div>
            </div>
            <div className="rounded-xl t-bg-elevated p-3">
              <div className="t-text-secondary">Turns Used</div>
              <div className="mt-1 text-sm font-semibold">
                {snapshot?.budgetUsed?.turns ?? 0} / {budgetCaps.maxTurns}
              </div>
            </div>
            <div className="rounded-xl t-bg-elevated p-3">
              <div className="t-text-secondary">Assets Created</div>
              <div className="mt-1 text-sm font-semibold">{totalCreatedAssets}</div>
            </div>
          </div>

          {activeTurn && (
            <div className="mt-4 rounded-xl border t-border p-3">
              <div className="text-xs t-text-secondary">Current Objective</div>
              <div className="mt-1 text-sm font-medium">{activeTurn.turnSpec?.objective}</div>
              <div className="mt-2 text-xs t-text-secondary">Summary</div>
              <div className="mt-1 text-sm">{activeTurn.summary}</div>
            </div>
          )}

          {snapshot?.state === 'WAITING_FOR_USER' && !isCheckpointModal && (
            <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
                <Bot size={14} /> Question
              </div>
              <p className="text-sm">{snapshot.pendingQuestion?.question}</p>
              {snapshot.pendingQuestion?.context && (
                <p className="mt-2 text-xs t-text-secondary">{snapshot.pendingQuestion.context}</p>
              )}

              {quickOptions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {quickOptions.map((option) => (
                    <button
                      key={option}
                      onClick={() => submitQuickReply(option)}
                      className="rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-3 flex gap-2">
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="flex-1 rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  placeholder="Type your response..."
                />
                <button onClick={submitReply} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-medium text-black">
                  <Send size={12} className="inline mr-1" /> Send
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="min-h-0 rounded-2xl border t-border t-bg-surface p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {rightView === 'timeline' && <Timer size={16} className="text-teal-300" />}
              {rightView === 'branches' && <GitBranch size={16} className="text-teal-300" />}
              {rightView === 'assets' && <Database size={16} className="text-teal-300" />}
              {rightView === 'matrix' && <GitBranch size={16} className="text-teal-300" />}
              {rightView === 'diagnostics' && <Activity size={16} className="text-teal-300" />}
              {rightView === 'timeline' && 'Turn Timeline'}
              {rightView === 'branches' && 'Branch Explorer'}
              {rightView === 'assets' && 'Asset Inventory'}
              {rightView === 'matrix' && 'Evidence Map'}
              {rightView === 'diagnostics' && 'Diagnostics'}
            </div>
            <div className="flex items-center gap-1 text-[11px]">
              <button
                onClick={() => setRightView('timeline')}
                className={`rounded-md border px-2 py-1 ${rightView === 'timeline' ? 'border-teal-500/60 bg-teal-500/10 text-teal-200' : 't-border t-text-secondary'}`}
              >
                Timeline
              </button>
              <button
                onClick={() => setRightView('branches')}
                className={`rounded-md border px-2 py-1 ${rightView === 'branches' ? 'border-teal-500/60 bg-teal-500/10 text-teal-200' : 't-border t-text-secondary'}`}
              >
                Branches
              </button>
              <button
                onClick={() => setRightView('assets')}
                className={`rounded-md border px-2 py-1 ${rightView === 'assets' ? 'border-teal-500/60 bg-teal-500/10 text-teal-200' : 't-border t-text-secondary'}`}
              >
                Assets
              </button>
              <button
                onClick={() => setRightView('matrix')}
                className={`rounded-md border px-2 py-1 ${rightView === 'matrix' ? 'border-teal-500/60 bg-teal-500/10 text-teal-200' : 't-border t-text-secondary'}`}
              >
                Evidence
              </button>
              <button
                onClick={() => setRightView('diagnostics')}
                className={`rounded-md border px-2 py-1 ${rightView === 'diagnostics' ? 'border-teal-500/60 bg-teal-500/10 text-teal-200' : 't-border t-text-secondary'}`}
              >
                Diagnostics
              </button>
            </div>
          </div>
          {rightView === 'timeline' && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <label className="t-text-secondary">Stage</label>
                <select
                  value={timelineStageFilter}
                  onChange={(e) => setTimelineStageFilter((e.target.value as 'ALL' | StageId))}
                  className="rounded-md border t-border bg-transparent px-2 py-1"
                >
                  <option value="ALL">All</option>
                  {STAGES.map((stage) => (
                    <option key={stage} value={stage}>{stage}</option>
                  ))}
                </select>
                <label className="ml-2 t-text-secondary">Gate</label>
                <select
                  value={timelineGateFilter}
                  onChange={(e) => setTimelineGateFilter((e.target.value as 'ALL' | GateStatus))}
                  className="rounded-md border t-border bg-transparent px-2 py-1"
                >
                  <option value="ALL">All</option>
                  <option value="pass">Pass</option>
                  <option value="fail">Fail</option>
                  <option value="none">Not-evaluated</option>
                </select>
                <label className="ml-2 t-text-secondary">Progress</label>
                <select
                  value={timelineProgressFilter}
                  onChange={(e) => setTimelineProgressFilter((e.target.value as 'ALL' | 'PROGRESS' | 'NON_PROGRESS'))}
                  className="rounded-md border t-border bg-transparent px-2 py-1"
                >
                  <option value="ALL">All</option>
                  <option value="PROGRESS">Progress</option>
                  <option value="NON_PROGRESS">Non-progress</option>
                </select>
              </div>

              <div className="h-[58%] overflow-auto pr-1">
                {filteredTurns.length === 0 ? (
                  <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">No turns yet.</div>
                ) : (
                  <div className="space-y-2">
                    {filteredTurns.map((turn) => (
                      <div
                        key={turn.turnNumber}
                        className={`rounded-xl border p-3 ${turn.nonProgress ? 'border-amber-500/40 bg-amber-500/5' : 't-border'} ${selectedTurn?.turnNumber === turn.turnNumber ? 'ring-1 ring-teal-500/50' : ''}`}
                      >
                        <div className="flex items-center justify-between text-xs t-text-secondary">
                          <span>Turn {turn.turnNumber}</span>
                          <span>{turn.turnSpec?.stage}</span>
                        </div>
                        <div className="mt-1 text-sm font-medium">{turn.turnSpec?.objective}</div>
                        <div className="mt-1 text-xs t-text-secondary">{turn.summary}</div>
                        <div className="mt-2 text-[11px] t-text-muted">
                          assets +{turn.assetDiff?.created?.length ?? 0} · tokens {turn.consumedBudgets?.turnTokens ?? 0} · ${turn.consumedBudgets?.turnCostUsd?.toFixed?.(3) ?? '0.000'}
                        </div>
                        {turn.nonProgress && (
                          <div className="mt-1 text-[11px] text-amber-300">Non-progress turn</div>
                        )}
                        <div className="mt-2">
                          <button
                            onClick={() => setSelectedTurnNumber(turn.turnNumber)}
                            className="rounded-md border t-border px-2 py-1 text-[11px]"
                          >
                            Inspect
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-xl border t-border p-3 text-xs">
                <div className="mb-1 font-medium">Turn Details</div>
                {!selectedTurn ? (
                  <div className="t-text-muted">Select a turn to inspect.</div>
                ) : (
                  <div className="space-y-1 t-text-secondary">
                    <div>Turn {selectedTurn.turnNumber} · Stage {selectedTurn.turnSpec?.stage}</div>
                    <div>Objective: {selectedTurn.turnSpec?.objective}</div>
                    <div>Gate: {turnGateStatus(selectedTurn)}</div>
                    <div>Assets created: {selectedTurn.assetDiff?.created?.length ?? 0}</div>
                    <div>Tokens: {selectedTurn.consumedBudgets?.turnTokens ?? 0}</div>
                    <div>Cost: ${(selectedTurn.consumedBudgets?.turnCostUsd ?? 0).toFixed(3)}</div>
                    <div>Progress: {selectedTurn.nonProgress ? 'non-progress' : 'progress'}</div>
                    <div>
                      Reviewer: {selectedTurn.reviewerSnapshot?.status ?? 'not-run'}
                      {selectedTurn.reviewerSnapshot?.status === 'completed'
                        ? ` · passes ${selectedTurn.reviewerSnapshot?.reviewerPasses?.length ?? 0}`
                        : ''}
                      {selectedTurn.reviewerSnapshot?.status === 'completed'
                        ? ` · consensus ${selectedTurn.reviewerSnapshot?.consensusBlockers?.length ?? 0}`
                        : ''}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {rightView === 'branches' && (
            <div className="h-[74%] overflow-auto pr-1 space-y-3">
              {!branchSnapshot || branchSnapshot.nodes.length === 0 ? (
                <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">No branch nodes yet.</div>
              ) : (
                <div className="space-y-2">
                  {[...branchSnapshot.nodes].reverse().map((node) => {
                    const active = node.nodeId === branchSnapshot.activeNodeId
                    return (
                      <div
                        key={node.nodeId}
                        className={`rounded-xl border p-3 ${active ? 'border-teal-500/50 bg-teal-500/5' : 't-border'}`}
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium">{node.nodeId}</span>
                          <span className={`${active ? 'text-teal-300' : 't-text-secondary'}`}>{node.status}</span>
                        </div>
                        <div className="mt-1 text-[11px] t-text-secondary">
                          {node.branchId} · {node.stage}
                          {typeof node.createdByTurn === 'number' ? ` · t${node.createdByTurn}` : ''}
                        </div>
                        <div className="mt-1 text-xs">{node.summary || 'No summary'}</div>
                        <div className="mt-1 text-[11px] t-text-muted">
                          parent: {node.parentNodeId ?? '-'}
                          {node.mergedFrom && node.mergedFrom.length > 0 ? ` · mergedFrom: ${node.mergedFrom.join(', ')}` : ''}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <div className="mb-2 font-medium text-amber-200">Decision Override</div>
                <div className="space-y-2">
                  <input
                    value={overrideTargetNodeId}
                    onChange={(e) => setOverrideTargetNodeId(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Target node id (e.g. N-002)"
                  />
                  <textarea
                    value={overrideRationale}
                    onChange={(e) => setOverrideRationale(e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Override rationale..."
                  />
                  <input
                    value={overrideRiskAccepted}
                    onChange={(e) => setOverrideRiskAccepted(e.target.value)}
                    className="w-full rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    placeholder="Risk accepted note..."
                  />
                  <button
                    onClick={recordOverrideDecision}
                    className="rounded-md border border-amber-500/40 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
                  >
                    Record Override Decision
                  </button>
                </div>
              </div>
            </div>
          )}

          {rightView === 'assets' && (
            <div className="h-[74%] overflow-auto pr-1">
              <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Total Assets: {assetRecords.length}</div>
                  <button
                    onClick={exportAssetInventory}
                    className="rounded-md border t-border px-2 py-1 text-[11px] hover:bg-white/5"
                  >
                    Export
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {assetTypeCounts.length === 0 ? (
                    <span className="t-text-muted">No asset types yet.</span>
                  ) : assetTypeCounts.map(([type, count]) => (
                    <span key={type} className="rounded-md border t-border px-2 py-0.5">
                      {type} · {count}
                    </span>
                  ))}
                </div>
              </div>
              {assetRecords.length === 0 ? (
                <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">No assets yet.</div>
              ) : (
                <div className="space-y-2">
                  {[...assetRecords].reverse().slice(0, 120).map((asset) => (
                    <div key={asset.id} className="rounded-xl border t-border p-3">
                      <div className="text-xs font-medium">{asset.id}</div>
                      <div className="mt-1 text-[11px] t-text-secondary">
                        {asset.type} · turn {asset.createdByTurn} · attempt {asset.createdByAttempt}
                      </div>
                      <div className="mt-1 text-[11px] t-text-muted">
                        created: {new Date(asset.createdAt).toLocaleString()}
                        {asset.supersedes ? ` · supersedes ${asset.supersedes}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {rightView === 'matrix' && (
            <div className="h-[74%] overflow-auto pr-1">
              <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">Evidence Graph</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowSupersedesEdges((value) => !value)}
                      className="rounded-md border t-border px-2 py-1 text-[11px] hover:bg-white/5"
                    >
                      {showSupersedesEdges ? 'Hide supersedes' : 'Show supersedes'}
                    </button>
                    <button
                      onClick={exportClaimEvidenceTable}
                      className="rounded-md border t-border px-2 py-1 text-[11px] hover:bg-white/5"
                    >
                      Export
                    </button>
                  </div>
                </div>
                <div className="mt-2 t-text-secondary">
                  claims {evidenceGraph.counts.claims}
                  {' · '}
                  links {evidenceGraph.counts.links}
                  {' · '}
                  evidence {evidenceGraph.counts.evidence}
                  {' · '}
                  decisions/other {evidenceGraph.counts.decisions}
                  {' · '}
                  edges {evidenceGraph.edges.length}
                </div>
                {evidenceGraph.nodes.length === 0 ? (
                  <div className="mt-2 t-text-muted">
                    No graphable evidence assets yet.
                  </div>
                ) : (
                  <div className="relative mt-3 h-[360px] overflow-hidden rounded-xl border t-border bg-slate-950/40">
                    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
                      {evidenceGraph.edges
                        .filter((edge) => showSupersedesEdges || edge.kind !== 'supersedes')
                        .map((edge) => {
                          const from = evidenceGraph.nodeById.get(edge.from)
                          const to = evidenceGraph.nodeById.get(edge.to)
                          if (!from || !to) return null

                          const controlX = (from.x + to.x) / 2
                          const path = `M ${from.x} ${from.y} C ${controlX} ${from.y}, ${controlX} ${to.y}, ${to.x} ${to.y}`
                          const stroke = edge.kind === 'claim_link'
                            ? '#2dd4bf'
                            : edge.kind === 'link_evidence'
                              ? '#38bdf8'
                              : '#f59e0b'
                          return (
                            <path
                              key={edge.id}
                              d={path}
                              fill="none"
                              stroke={stroke}
                              strokeWidth={edge.kind === 'supersedes' ? 0.35 : 0.45}
                              strokeDasharray={edge.kind === 'supersedes' ? '1.5 1.5' : undefined}
                              opacity={edge.kind === 'supersedes' ? 0.65 : 0.8}
                            />
                          )
                        })}
                    </svg>
                    <div className="absolute inset-0">
                      {evidenceGraph.nodes.map((node) => {
                        const tone = node.lane === 'claim'
                          ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
                          : node.lane === 'link'
                            ? 'border-sky-400/40 bg-sky-500/10 text-sky-100'
                            : node.lane === 'evidence'
                              ? 'border-violet-400/40 bg-violet-500/10 text-violet-100'
                              : 'border-amber-400/40 bg-amber-500/10 text-amber-100'
                        return (
                          <button
                            key={node.id}
                            onClick={() => setSelectedGraphNodeId(node.id)}
                            title={node.id}
                            style={{ left: `${node.x}%`, top: `${node.y}%` }}
                            className={`absolute w-[148px] -translate-x-1/2 -translate-y-1/2 rounded-lg border px-2 py-1 text-left text-[10px] ${tone} ${
                              selectedGraphNodeId === node.id ? 'ring-1 ring-white/50' : ''
                            }`}
                          >
                            <div className="truncate font-medium">{node.id}</div>
                            <div className="truncate opacity-90">{node.label}</div>
                            <div className="mt-0.5 text-[9px] uppercase tracking-wide opacity-80">
                              {node.assetType}{node.external ? ' · external' : ''}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              {(selectedGraphNode || selectedGraphAsset) && (
                <div className="mb-3 rounded-xl border t-border p-3 text-xs">
                  <div className="font-medium">Selected Node</div>
                  {selectedGraphNode && (
                    <div className="mt-2 space-y-1 t-text-secondary">
                      <div>{selectedGraphNode.id}</div>
                      <div>
                        lane {selectedGraphNode.lane}
                        {' · '}
                        type {selectedGraphNode.assetType}
                        {selectedGraphNode.external ? ' · external reference' : ''}
                      </div>
                      <div className="t-text-muted">{selectedGraphNode.label}</div>
                    </div>
                  )}
                  {selectedGraphAsset && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded-lg t-bg-elevated p-2 text-[11px]">
                      {JSON.stringify(selectedGraphAsset.payload, null, 2)}
                    </pre>
                  )}
                </div>
              )}
              <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
                <div className="font-medium">Latest ClaimEvidenceTable</div>
                {latestClaimEvidenceTable ? (
                  <div className="mt-2 space-y-1 t-text-secondary">
                    <div>asset {latestClaimEvidenceTable.assetId} · turn {latestClaimEvidenceTable.createdByTurn} · rows {latestClaimEvidenceTable.rowCount}</div>
                    <div>
                      primary {latestClaimEvidenceTable.coveredPrimary}/{latestClaimEvidenceTable.assertedPrimary}
                      {' · '}
                      ratio {latestClaimEvidenceTable.assertedPrimaryCoverage === null ? '-' : latestClaimEvidenceTable.assertedPrimaryCoverage.toFixed(2)}
                      {' · '}
                      {latestClaimEvidenceTable.primaryPass ? 'pass' : 'fail'}
                    </div>
                    <div>
                      secondary {latestClaimEvidenceTable.coveredSecondary}/{latestClaimEvidenceTable.assertedSecondary}
                      {' · '}
                      ratio {latestClaimEvidenceTable.assertedSecondaryCoverage === null ? '-' : latestClaimEvidenceTable.assertedSecondaryCoverage.toFixed(2)}
                      {' · '}
                      {latestClaimEvidenceTable.secondaryPass ? 'pass' : 'fail'}
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 t-text-muted">
                    No persisted ClaimEvidenceTable asset yet. Export will use a derived fallback snapshot.
                  </div>
                )}
              </div>
              {matrixRows.length === 0 ? (
                <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">
                  No asserted claims yet. Promote claims to `asserted` to populate the matrix.
                </div>
              ) : (
                <div className="space-y-2">
                  {matrixRows.map((row) => (
                    <div
                      key={row.id}
                      className={`rounded-xl border p-3 ${row.hasPrimaryGap ? 'border-rose-500/40 bg-rose-500/5' : 't-border'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-medium">{row.id}</div>
                        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide">
                          <span className="rounded-full border t-border px-2 py-0.5">{row.tier}</span>
                          <span className="rounded-full border t-border px-2 py-0.5">{row.coverageStatus}</span>
                        </div>
                      </div>
                      <div className="mt-1 text-xs t-text-secondary">{row.summary}</div>
                      <div className="mt-2 text-[11px] t-text-muted">
                        countable {row.countableIds.length}
                        {' · '}
                        cite_only {row.citeOnlyIds.length}
                        {' · '}
                        needs_revalidate {row.needsRevalidateIds.length}
                      </div>
                      {row.hasPrimaryGap && (
                        <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                          Primary asserted claim has no countable evidence link.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {rightView === 'diagnostics' && (
            <div className="h-[74%] overflow-auto pr-1">
              <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
                <div className="font-medium">Maintenance Alerts</div>
                <div className="mt-2 space-y-1">
                  {maintenanceAlerts.length === 0 ? (
                    <div className="t-text-muted">No maintenance alerts.</div>
                  ) : maintenanceAlerts.map((event, index) => (
                    <div key={`maintenance-${index}`} className="rounded-md border t-border px-2 py-1">
                      <div className="t-text-muted">
                        {new Date(String(event?.timestamp || Date.now())).toLocaleTimeString()}
                      </div>
                      <div className="font-medium">{String(event?.kind ?? 'maintenance')}</div>
                      <div className="t-text-secondary">{String(event?.message ?? '')}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
                <div className="font-medium">Runtime Durability</div>
                <div className="mt-2 space-y-1 t-text-secondary">
                  <div>checkpoints: {snapshot?.runtimeStatus?.checkpointCount ?? 0}</div>
                  <div>
                    lease owner: {snapshot?.runtimeStatus?.lease?.ownerId ?? '-'}
                    {snapshot?.runtimeStatus?.lease?.takeoverReason ? ` (${snapshot.runtimeStatus.lease.takeoverReason})` : ''}
                  </div>
                  <div>
                    heartbeat: {snapshot?.runtimeStatus?.lease?.heartbeatAt ? new Date(snapshot.runtimeStatus.lease.heartbeatAt).toLocaleString() : '-'}
                  </div>
                  <div>
                    latest checkpoint: {snapshot?.runtimeStatus?.latestCheckpoint?.fileName ?? '-'}
                    {typeof snapshot?.runtimeStatus?.latestCheckpoint?.turnNumber === 'number'
                      ? ` · turn ${snapshot.runtimeStatus.latestCheckpoint.turnNumber}`
                      : ''}
                  </div>
                </div>
              </div>

              <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
                <div className="font-medium">Turn Runtime Metrics</div>
                <div className="mt-2 space-y-1">
                  {[...turnReports].slice(-8).reverse().map((turn) => (
                    <div key={`diag-turn-${turn.turnNumber}`} className="rounded-md border t-border px-2 py-1">
                      <div className="font-medium">t{turn.turnNumber} · {turn.turnSpec?.stage}</div>
                      <div className="t-text-secondary">
                        tools {turn.consumedBudgets?.toolCalls ?? 0}
                        {' · '}
                        wall {turn.consumedBudgets?.wallClockSec ?? 0}s
                        {' · '}
                        read {(turn.consumedBudgets?.readBytes ?? 0).toLocaleString()}B
                        {' · '}
                        discovery {turn.consumedBudgets?.discoveryOps ?? 0}
                      </div>
                      <div className="t-text-secondary">
                        prompt {turn.consumedBudgets?.promptTokens ?? 0}
                        {' · '}
                        completion {turn.consumedBudgets?.completionTokens ?? 0}
                        {' · '}
                        total {turn.consumedBudgets?.turnTokens ?? 0}
                        {' · '}
                        ${Number(turn.consumedBudgets?.turnCostUsd ?? 0).toFixed(3)}
                      </div>
                    </div>
                  ))}
                  {turnReports.length === 0 && (
                    <div className="t-text-muted">No turn metrics yet.</div>
                  )}
                </div>
              </div>

              <div className="rounded-xl t-bg-elevated p-3 text-xs">
                <div className="font-medium">Raw Event Feed</div>
                <div className="mt-2 space-y-1">
                  {rawEvents.length === 0 ? (
                    <div className="t-text-muted">No raw events yet.</div>
                  ) : rawEvents.slice(0, 40).map((event, index) => (
                    <div key={`raw-event-${index}`} className="rounded-md border t-border px-2 py-1">
                      <div className="t-text-muted">
                        {new Date(String(event?.timestamp || Date.now())).toLocaleTimeString()}
                      </div>
                      <div className="font-medium">{String(event?.type ?? 'event')}</div>
                      <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all text-[10px] t-text-secondary">
                        {JSON.stringify(event, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="mt-4 h-[36%] overflow-auto rounded-xl t-bg-elevated p-3">
            <div className="mb-2 text-xs font-medium t-text-secondary">Events</div>
            <div className="space-y-1 text-[11px] t-text-secondary">
              {events.length === 0 ? (
                <div className="t-text-muted">No events yet.</div>
              ) : events.map((event, index) => (
                <div key={`${event.at}-${index}`} className="border-b t-border-subtle pb-1">
                  <div className="t-text-muted">{new Date(event.at).toLocaleTimeString()}</div>
                  <div className="font-medium">{event.type}</div>
                  <div>{event.text}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {isCheckpointModal && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6">
          <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-amber-500/40 bg-neutral-950 p-4 shadow-2xl">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
              <Bot size={14} /> Checkpoint Decision
            </div>
            <p className="text-sm">{snapshot?.pendingQuestion?.question}</p>
            {snapshot?.pendingQuestion?.context && (
              <p className="mt-2 text-xs t-text-secondary">{snapshot.pendingQuestion.context}</p>
            )}
            {quickOptions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {quickOptions.map((option) => (
                  <button
                    key={`modal-${option}`}
                    onClick={() => submitQuickReply(option)}
                    className="rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                className="flex-1 rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                placeholder="Type your decision..."
              />
              <button onClick={submitReply} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-medium text-black">
                <Send size={12} className="inline mr-1" /> Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
