// Pure helper functions for the YOLO Researcher desktop UI

import type {
  StageId,
  GateStatus,
  YoloState,
  TurnReport,
  AssetRecord,
  EvidenceGraphLane,
  EventRecord,
  ReviewerProcessReview,
} from './types'

// Translate raw planner action identifiers to user-facing labels
const ACTION_LABELS: Record<string, string> = {
  explore: 'Exploring',
  refine_question: 'Refining question',
  issue_experiment_request: 'Requesting experiment',
  digest_uploaded_results: 'Digesting results',
  synthesize: 'Synthesizing',
  deep_dive: 'Deep diving',
  validate: 'Validating',
  compare: 'Comparing',
  collect_evidence: 'Collecting evidence',
  resolve_conflict: 'Resolving conflict',
}
export function friendlyAction(action: string | undefined): string {
  if (!action) return ''
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ')
}

export const STAGES: StageId[] = ['S1', 'S2', 'S3', 'S4', 'S5']

export const STAGE_LABELS: Record<StageId, string> = {
  S1: 'Problem Framing',
  S2: 'Measurement Design',
  S3: 'Execution Planning',
  S4: 'Result Analysis',
  S5: 'Final Synthesis',
}

export function isStageId(value: string): value is StageId {
  return STAGES.includes(value as StageId)
}

// Translate any stage ID to its full label (e.g. "S1" → "Discovery")
export function friendlyStage(id: string | undefined | null): string {
  if (!id) return ''
  const label = STAGE_LABELS[id as StageId]
  return label ?? id
}

// Replace internal stage refs in LLM-generated text with user-facing labels.
export function cleanStageRefs(text: string): string {
  return text.replace(/\bS([1-5])\b/g, (_, num) => {
    const stage = `S${num}` as StageId
    return STAGE_LABELS[stage] ?? stage
  })
}

// Translate branch IDs: B-001 → "Research Line 1"
export function friendlyBranch(id: string | undefined | null): string {
  if (!id) return ''
  const m = id.match(/^B-0*(\d+)$/i)
  return m ? `Research Line ${parseInt(m[1], 10)}` : id
}

// Translate node IDs: N-001 → "Step 1"
export function friendlyNode(id: string | undefined | null): string {
  if (!id) return ''
  const m = id.match(/^N-0*(\d+)$/i)
  return m ? `Step ${parseInt(m[1], 10)}` : id
}

// Translate internal state machine names to user-friendly labels
const STATE_LABELS: Record<string, string> = {
  IDLE: 'Ready',
  STARTING: 'Starting',
  PLANNING: 'Planning',
  EXECUTING: 'Researching',
  TURN_COMPLETE: 'Cycle Done',
  WAITING_FOR_USER: 'Waiting for You',
  WAITING_EXTERNAL: 'Waiting for Data',
  PAUSED: 'Paused',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
  STOPPED: 'Stopped',
  STOPPING: 'Stopping',
  CRASHED: 'Crashed',
}
export function friendlyState(state: string | undefined | null): string {
  if (!state) return 'Ready'
  return STATE_LABELS[state] ?? state
}

export type MissionUiState = YoloState | 'STARTING'

export function missionStateLabel(state: MissionUiState | undefined | null): string {
  if (!state) return 'Ready'
  if (state === 'STARTING') return 'Starting'
  if (state === 'STOPPING') return 'Stopping'
  if (state === 'PLANNING' || state === 'EXECUTING' || state === 'TURN_COMPLETE') return 'Running'
  if (state === 'WAITING_FOR_USER') return 'Need Your Input'
  if (state === 'WAITING_EXTERNAL') return 'Need External Input'
  if (state === 'IDLE') return 'Ready'
  return friendlyState(state)
}

// Make raw asset IDs more readable: "RiskRegister_v1-t004-a1-003" → "RiskRegister v1 (#3, cycle 4)"
export function friendlyAssetId(id: string): string {
  const m = id.match(/^(.+)-t(\d+)-a(\d+)-(\d+)$/)
  if (!m) return id
  const type = m[1].replace(/_/g, ' ')
  const turn = parseInt(m[2], 10)
  const seq = parseInt(m[4], 10)
  return `${type} (#${seq}, cycle ${turn})`
}

export function turnGateStatus(turn: TurnReport): GateStatus {
  const status = turn.gateImpact?.status
  if (status === 'pass' || turn.gateImpact?.gateResult?.passed === true) {
    // Gate passed structurally — check for advisory warnings in riskDelta
    const hasAdvisory = turn.riskDelta?.some((note: string) => note.startsWith('Advisory:')) ?? false
    return hasAdvisory ? 'advisory' : 'pass'
  }
  if (status === 'fail' || status === 'rollback-needed' || turn.gateImpact?.gateResult?.passed === false) return 'fail'
  return 'none'
}

export function buildStateSummary(
  state: YoloState | undefined,
  activeTurn: TurnReport | null
): { title: string; tone: string; detail: string } | null {
  if (!state) return null
  if (state === 'FAILED') {
    return {
      title: 'Run Failed',
      tone: 'border-rose-500/40 bg-rose-500/10 t-accent-rose',
      detail: activeTurn?.summary ?? 'Session entered FAILED state.'
    }
  }
  if (state === 'STOPPED') {
    return {
      title: 'Run Stopped',
      tone: 'border-slate-500/40 bg-slate-500/10 t-accent-slate',
      detail: 'Session was stopped by user. You can resume from the last durable boundary.'
    }
  }
  if (state === 'COMPLETE') {
    return {
      title: 'Run Complete',
      tone: 'border-emerald-500/40 bg-emerald-500/10 t-accent-emerald',
      detail: activeTurn?.summary ?? 'Session reached COMPLETE.'
    }
  }
  if (state === 'PAUSED') {
    return {
      title: 'Paused',
      tone: 'border-slate-500/40 bg-slate-500/10 t-accent-slate',
      detail: 'Execution paused. Resume continues from next planning boundary.'
    }
  }
  return null
}

export const defaultOptions = {
  budget: { maxTurns: 12, maxTokens: 500_000, maxCostUsd: 12 },
  models: { planner: 'gpt-5.2', coordinator: 'gpt-5.2' },
  mode: 'lean_v2' as const
}

export function stateTone(state?: MissionUiState): string {
  switch (state) {
    case 'STARTING':
    case 'EXECUTING': return 'bg-teal-500/20 t-accent-teal border-teal-500/40'
    case 'PLANNING':
    case 'TURN_COMPLETE': return 'bg-teal-500/20 t-accent-teal border-teal-500/40'
    case 'STOPPING': return 'bg-rose-500/20 t-accent-rose border-rose-500/40'
    case 'WAITING_EXTERNAL':
    case 'WAITING_FOR_USER': return 'bg-amber-500/20 t-accent-amber border-amber-500/40'
    case 'PAUSED': return 'bg-slate-500/20 t-accent-slate border-slate-500/40'
    case 'FAILED':
    case 'CRASHED': return 'bg-rose-500/20 t-accent-rose border-rose-500/40'
    case 'COMPLETE': return 'bg-emerald-500/20 t-accent-emerald border-emerald-500/40'
    default: return 'bg-neutral-500/20 t-text-secondary border-neutral-500/40'
  }
}

export function collectStringIds(value: unknown, sink: Set<string>): void {
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

export function toGraphLabel(asset: AssetRecord | undefined, fallbackId: string): string {
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

export function laneFromId(id: string, assetType?: string): EvidenceGraphLane {
  if (assetType === 'EvidenceLink' || id.startsWith('EvidenceLink-')) return 'link'
  if (assetType === 'Claim' || id.startsWith('Claim-')) return 'claim'
  if (assetType === 'Decision' || id.startsWith('Decision-')) return 'decision'
  return 'evidence'
}

// CSS classes for lane-colored card styling per asset type
export function laneToneFromType(assetType: string): string {
  const lane = laneFromId('', assetType)
  switch (lane) {
    case 'claim':    return 'border-emerald-400/50 bg-emerald-500/15 t-accent-emerald'
    case 'link':     return 'border-sky-400/50 bg-sky-500/15 t-accent-sky'
    case 'decision': return 'border-amber-400/50 bg-amber-500/15 t-accent-amber'
    default:         return 'border-violet-400/50 bg-violet-500/15 t-accent-violet'
  }
}

// Tailwind bg color class for the colored dot in filter pills
export function laneDotColor(assetType: string): string {
  const lane = laneFromId('', assetType)
  switch (lane) {
    case 'claim':    return 'bg-emerald-500'
    case 'link':     return 'bg-sky-500'
    case 'decision': return 'bg-amber-500'
    default:         return 'bg-violet-500'
  }
}

// Lowercased searchable string from asset ID, type, and key payload fields
export function assetSearchableText(asset: AssetRecord): string {
  const parts: string[] = [friendlyAssetId(asset.id).toLowerCase(), asset.type.toLowerCase()]
  const p = asset.payload
  if (typeof p.statement === 'string') parts.push(p.statement.toLowerCase())
  if (typeof p.claim === 'string') parts.push(p.claim.toLowerCase())
  if (typeof p.text === 'string') parts.push(p.text.toLowerCase())
  if (typeof p.relation === 'string') parts.push(p.relation.toLowerCase())
  if (typeof p.runKey === 'string') parts.push(p.runKey.toLowerCase())
  if (typeof p.kind === 'string') parts.push(p.kind.toLowerCase())
  if (typeof p.rationale === 'string') parts.push(p.rationale.toLowerCase())
  return parts.join(' ')
}

// Walk the supersedes chain backward from an asset (cycle-safe)
export function buildSupersedesChain(assetId: string, assetMap: Map<string, AssetRecord>): AssetRecord[] {
  const chain: AssetRecord[] = []
  let currentId = assetMap.get(assetId)?.supersedes
  const visited = new Set<string>()
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const ancestor = assetMap.get(currentId)
    if (!ancestor) break
    chain.push(ancestor)
    currentId = ancestor.supersedes
  }
  return chain
}

// Translate event type IDs to user-friendly labels
const EVENT_TYPE_LABELS: Record<string, string> = {
  session_started: 'Session Started',
  session_restored: 'Session Restored',
  session_continue: 'Session Continued',
  state_changed: 'Status Changed',
  state_transition: 'Status Changed',
  turn_planning: 'Planning Cycle',
  turn_committed: 'Cycle Completed',
  semantic_review_evaluated: 'Quality Review',
  pause_requested: 'Pause Requested',
  input_enqueued: 'Input Queued',
  input_queue_changed: 'Queue Updated',
  loop_error: 'Error',
  loop_stopped: 'Stopped',
  crash_recovery: 'Recovery',
  summary_exported: 'Export',
  claim_evidence_table_exported: 'Export',
  asset_inventory_exported: 'Export',
  final_bundle_exported: 'Export',
  wait_external_requested: 'Waiting for Data',
  wait_external_resolved: 'External Data Received',
  wait_external_cancelled: 'External Wait Cancelled',
  fulltext_wait_requested: 'Full Text Requested',
  checkpoint_confirmed: 'Checkpoint Saved',
  checkpoint_restored: 'Checkpoint Restored',
  override_decision_recorded: 'Investigation Redirected',
  maintenance_alert: 'System Alert',
  resource_extension_requested: 'Budget Extension Requested',
  resource_extension_resolved: 'Budget Extension Decision',
  ingress_files_added: 'Files Added',
}

export function formatEvent(payload: any): EventRecord {
  const at = payload?.timestamp || payload?.at || new Date().toISOString()
  if (!payload || typeof payload !== 'object') {
    return { at, type: 'unknown', text: String(payload) }
  }

  const rawType = String(payload.type || 'event')
  const type = EVENT_TYPE_LABELS[rawType] ?? rawType
  switch (rawType) {
    case 'session_started':
      return { at, type, text: 'Research session started' }
    case 'session_restored':
      return {
        at,
        type,
        text: `Previous session restored · cycle ${payload.turn ?? 0}`
      }
    case 'state_changed':
      return { at, type, text: `${friendlyState(payload.from)} → ${friendlyState(payload.to)}${payload.reason ? ` (${payload.reason})` : ''}` }
    case 'state_transition':
      return { at, type, text: `${friendlyState(payload.from)} → ${friendlyState(payload.to)}${payload.reason ? ` (${payload.reason})` : ''}` }
    case 'turn_planning':
      return { at, type, text: `Planning research cycle ${payload.turn} · focus: ${friendlyStage(payload.stage)}` }
    case 'turn_committed':
      return {
        at,
        type,
        text: `Cycle ${payload.turn} completed · ${payload.assetsCreated ?? 0} new artifacts · quality gate: ${payload.gateStatus === 'pass' ? 'passed' : payload.gateStatus === 'fail' ? 'failed' : 'not evaluated'}`
      }
    case 'semantic_review_evaluated':
      return {
        at,
        type,
        text: Array.isArray(payload.consensusBlockerLabels) && payload.consensusBlockerLabels.length > 0
          ? `Quality review flagged issues: ${payload.consensusBlockerLabels.join(', ')}`
          : 'Quality review passed — no issues found'
      }
    case 'pause_requested':
      return { at, type, text: 'Session will pause after the current cycle finishes.' }
    case 'input_enqueued':
      return { at, type, text: `Your input has been queued (${payload.priority === 'urgent' ? 'high priority' : 'normal priority'})` }
    case 'input_queue_changed':
      return { at, type, text: `Input queue updated · ${payload.count ?? 0} messages pending` }
    case 'loop_error':
      return { at, type, text: `Error: ${payload.message ?? 'unknown error'}` }
    case 'loop_stopped':
      return { at, type, text: payload.message ?? 'Session stopped' }
    case 'crash_recovery':
      return { at, type, text: `Session recovered from crash · safe point: cycle ${payload.lastDurableTurn ?? 0}` }
    case 'summary_exported':
      return { at, type, text: `Summary exported to: ${payload.path ?? ''}` }
    case 'claim_evidence_table_exported':
      return { at, type, text: `Claim-evidence table exported to: ${payload.path ?? ''}` }
    case 'asset_inventory_exported':
      return { at, type, text: `Artifact inventory exported to: ${payload.path ?? ''}` }
    case 'final_bundle_exported':
      return {
        at,
        type,
        text: `${payload.auto ? 'Final research bundle auto-exported' : 'Final research bundle exported'} to: ${payload.path ?? ''}`
      }
    case 'wait_external_requested':
      return { at, type, text: `Paused for external data: ${payload.title ?? payload.id ?? ''}` }
    case 'wait_external_resolved':
      return { at, type, text: `External data received, resuming research` }
    case 'wait_external_cancelled':
      return { at, type, text: `External data request cancelled` }
    case 'fulltext_wait_requested':
      return { at, type, text: `Waiting for full text: ${payload.citation ?? payload.id ?? ''}` }
    case 'checkpoint_confirmed':
      return { at, type, text: `Research checkpoint saved` }
    case 'checkpoint_restored':
      return { at, type, text: `Checkpoint ${payload.restored ? 'restored successfully' : 'not available'} · cycle ${payload.turn ?? 0}` }
    case 'override_decision_recorded':
      return { at, type, text: `Investigation redirected to ${friendlyNode(payload.targetNodeId)}` }
    case 'maintenance_alert':
      return {
        at,
        type,
        text: `${payload.severity ?? 'warning'}: ${payload.message ?? ''}`
      }
    case 'resource_extension_requested':
      return { at, type, text: `Additional budget requested` }
    case 'resource_extension_resolved':
      return {
        at,
        type,
        text: `Budget extension ${payload.approved ? 'approved' : 'rejected'}${payload.budget ? ` · +${payload.budget.maxTurns} cycles, +${payload.budget.maxTokens} tokens, +$${payload.budget.maxCostUsd}` : ''}`
      }
    case 'ingress_files_added':
      return {
        at,
        type,
        text: `${payload.fileCount ?? 0} file(s) added to upload directory`
      }
    default:
      return { at, type, text: JSON.stringify(payload) }
  }
}

// ─── Experiment details parser ──────────────────────────────────────────

export interface ExperimentDetails {
  assetRef?: string
  why?: string
  objective?: string
  setup?: string
  protocol?: string[]
  controls?: string
  metrics?: string
  expectedResult?: string
  outputFormat?: string
  checklist?: string[]
}

const EXPERIMENT_SECTIONS = [
  'Why this experiment:',
  'Objective:',
  'Setup / Environment:',
  'Execution protocol:',
  'Controls:',
  'Metrics to report:',
  'Expected result:',
  'Output format:',
  'Submission checklist:',
] as const

/**
 * Parse the `details` string from an ExternalWaitTask into structured sections.
 * Returns null if the text doesn't look like a structured experiment request.
 */
export function parseExperimentDetails(details: string): ExperimentDetails | null {
  // Quick check: must contain at least 3 known section headers to be parseable
  const headerHits = EXPERIMENT_SECTIONS.filter((h) => details.includes(h))
  if (headerHits.length < 3) return null

  const result: ExperimentDetails = {}

  // Extract asset ref from first line ("Experiment Request: ...")
  const firstLine = details.split('\n')[0]?.trim() ?? ''
  if (firstLine.startsWith('Experiment Request:')) {
    result.assetRef = firstLine.replace('Experiment Request:', '').trim()
  }

  // Split by known headers and collect content
  function extract(header: string): string | undefined {
    const idx = details.indexOf(header)
    if (idx === -1) return undefined
    const start = idx + header.length
    // Find the next header after this one
    let end = details.length
    for (const h of EXPERIMENT_SECTIONS) {
      if (h === header) continue
      const hIdx = details.indexOf(h, start)
      if (hIdx !== -1 && hIdx < end) end = hIdx
    }
    return details.slice(start, end).trim() || undefined
  }

  result.why = extract('Why this experiment:')
  result.objective = extract('Objective:')
  result.setup = extract('Setup / Environment:')
  result.controls = extract('Controls:')
  result.metrics = extract('Metrics to report:')
  result.expectedResult = extract('Expected result:')
  result.outputFormat = extract('Output format:')

  // Parse numbered-list sections
  const protocolRaw = extract('Execution protocol:')
  if (protocolRaw) {
    result.protocol = protocolRaw
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean)
  }

  const checklistRaw = extract('Submission checklist:')
  if (checklistRaw) {
    result.checklist = checklistRaw
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean)
  }

  return result
}

// ─── User-facing question/context translation ──────────────────────────

const BLOCKER_LABELS: Record<string, string> = {
  claim_without_direct_evidence: 'Some claims lack direct supporting evidence',
  causality_gap: 'Cause-and-effect relationships are not fully established',
  parity_violation_unresolved: 'Contradictory evidence has not been resolved',
  reproducibility_gap: 'Results may not be reproducible with the current evidence',
  overclaim: 'Some conclusions go beyond what the evidence supports',
}

function friendlyBlockerList(raw: string): string {
  const labels = raw.split(/,\s*/).map((label) => {
    const trimmed = label.trim()
    return BLOCKER_LABELS[trimmed] ?? trimmed.replace(/_/g, ' ')
  })
  return labels.join('; ')
}

// Translate internal consensus detail strings like "claim_without_direct_evidence(3/3), reproducibility_gap(3/3)"
function friendlyConsensusDetails(raw: string): string {
  return raw
    .split(/,\s*/)
    .map((item) => {
      const m = item.trim().match(/^(.+)\((\d+)\/(\d+)\)$/)
      if (!m) return item.trim().replace(/_/g, ' ')
      const label = BLOCKER_LABELS[m[1]] ?? m[1].replace(/_/g, ' ')
      return `${label} (${m[2]} of ${m[3]} reviewers agree)`
    })
    .join('; ')
}

// Rewrite internal pendingQuestion text into user-friendly language
export function friendlyQuestion(question: string): string {
  // "Semantic review consensus blocker detected: claim_without_direct_evidence, reproducibility_gap."
  const semanticMatch = question.match(/^Semantic review consensus blocker detected:\s*(.+)\.?$/)
  if (semanticMatch) {
    return `The quality review found issues that need your attention:\n${friendlyBlockerList(semanticMatch[1])}`
  }

  // "Scope negotiation required before continuing: overclaim, causality_gap."
  const scopeMatch = question.match(/^Scope negotiation required before continuing:\s*(.+)\.?$/)
  if (scopeMatch) {
    return `Before continuing, the following concerns need to be addressed:\n${friendlyBlockerList(scopeMatch[1])}`
  }

  // "Please upload full text for: Doe et al. (2024)"
  const fullTextMatch = question.match(/^Please upload full text for:\s*(.+)$/)
  if (fullTextMatch) {
    return `The full text of "${fullTextMatch[1]}" is needed to continue. Please upload it.`
  }

  // "semantic consensus blockers require user confirmation: ..."
  const confirmMatch = question.match(/^semantic consensus blockers require user confirmation:\s*(.+)$/)
  if (confirmMatch) {
    return `The quality review flagged issues that need your decision:\n${friendlyBlockerList(confirmMatch[1])}`
  }

  return question
}

// Rewrite internal pendingQuestion context into user-friendly language
export function friendlyQuestionContext(context: string | undefined): string | undefined {
  if (!context) return undefined

  // "stage=S2; consensus=claim_without_direct_evidence(3/3), reproducibility_gap(3/3)"
  const consensusMatch = context.match(/^stage=(\w+);\s*consensus=(.+)$/)
  if (consensusMatch) {
    const stage = friendlyStage(consensusMatch[1])
    return `Current focus: ${stage}. Details: ${friendlyConsensusDetails(consensusMatch[2])}`
  }

  // "stage=S3; blockers=overclaim, causality_gap"
  const blockerMatch = context.match(/^stage=(\w+);\s*blockers=(.+)$/)
  if (blockerMatch) {
    const stage = friendlyStage(blockerMatch[1])
    return `Current focus: ${stage}. Issues: ${friendlyBlockerList(blockerMatch[2])}`
  }

  // "waitTask=xxx | uploadDir=yyy | requiredFiles=zzz"
  const waitMatch = context.match(/waitTask=/)
  if (waitMatch) {
    const uploadDir = context.match(/uploadDir=([^|]+)/)?.[1]?.trim()
    const why = context.match(/why=([^|]+)/)?.[1]?.trim()
    const objective = context.match(/objective=([^|]+)/)?.[1]?.trim()
    const method = context.match(/method=([^|]+)/)?.[1]?.trim()
    const expected = context.match(/expectedResult=([^|]+)/)?.[1]?.trim()
    const files = context.match(/requiredFiles=([^|]+)/)?.[1]?.trim()
    const parts: string[] = []
    if (uploadDir) parts.push(`Upload folder: ${uploadDir}`)
    if (why) parts.push(`Why: ${why}`)
    if (objective) parts.push(`Objective: ${objective}`)
    if (method) parts.push(`Method: ${method}`)
    if (expected) parts.push(`Expected result: ${expected}`)
    if (files && files !== 'any full-text artifact') parts.push(`Required files: ${files}`)
    return parts.length > 0 ? parts.join('\n') : undefined
  }

  // "deltaTurns=+2 | deltaTokens=+20000 | deltaCostUsd=+2.000 | rationale=..."
  const deltaMatch = context.match(/deltaTurns=/)
  if (deltaMatch) {
    const turns = context.match(/deltaTurns=\+?(\d+)/)?.[1]
    const tokens = context.match(/deltaTokens=\+?(\d+)/)?.[1]
    const cost = context.match(/deltaCostUsd=\+?([\d.]+)/)?.[1]
    const rationale = context.match(/rationale=(.+)/)?.[1]
    const parts: string[] = []
    if (turns) parts.push(`+${turns} cycles`)
    if (tokens) parts.push(`+${Number(tokens).toLocaleString()} tokens`)
    if (cost) parts.push(`+$${cost}`)
    let result = `Requesting: ${parts.join(', ')}`
    if (rationale) result += `. Reason: ${rationale}`
    return result
  }

  return context
}

// ─── User-facing error translation ──────────────────────────────────

const ERROR_CATEGORY_LABELS: Record<string, string> = {
  runtime_error: 'Internal Error',
  planner_error: 'Planning Error',
  coordinator_error: 'Execution Error',
  budget_exhausted: 'Budget Exhausted',
  gate_failure: 'Quality Gate Failed',
  user_abort: 'Stopped by User',
}

export function friendlyErrorReason(reason: string): string {
  // "branch node not found: N-004"
  const branchNodeMatch = reason.match(/^branch node not found:\s*(.+)$/)
  if (branchNodeMatch) {
    return `The planner tried to navigate to investigation step "${friendlyNode(branchNodeMatch[1])}" which doesn't exist. This is an internal planning error — restarting the run should resolve it.`
  }

  // "asset supersedes integrity violation: missing=..."
  const supersedesMatch = reason.match(/^asset supersedes integrity violation/)
  if (supersedesMatch) {
    return 'An artifact referenced a previous version that doesn\'t exist. This is an internal data consistency issue — restarting should resolve it.'
  }

  // "cannot revisit/merge/prune to node ... with status invalidated"
  const invalidatedMatch = reason.match(/^cannot (\w+) to node (\S+) with status invalidated/)
  if (invalidatedMatch) {
    return `Cannot ${invalidatedMatch[1]} to ${friendlyNode(invalidatedMatch[2])} because it was previously invalidated. Use "Redirect Investigation" to override this.`
  }

  // Clean any remaining stage/node refs
  return cleanStageRefs(reason)
    .replace(/\bN-0*(\d+)\b/g, (_, num) => `Step ${parseInt(num, 10)}`)
    .replace(/\bB-0*(\d+)\b/g, (_, num) => `Research Line ${parseInt(num, 10)}`)
}

export function friendlyErrorCategory(category: string): string {
  return ERROR_CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ')
}

// ─── Thinking narrative helpers ─────────────────────────────

// Translate raw planner action identifiers to narrative sentences
const NARRATIVE_ACTION_LABELS: Record<string, string> = {
  explore: 'Exploring the problem space',
  refine_question: 'Refining the research question',
  issue_experiment_request: 'Designing an experiment',
  digest_uploaded_results: 'Analyzing uploaded results',
  synthesize: 'Synthesizing findings',
  deep_dive: 'Deep diving into specifics',
  validate: 'Validating results',
  compare: 'Comparing alternatives',
  collect_evidence: 'Collecting evidence',
  resolve_conflict: 'Resolving conflicting evidence',
}

export function narrativeAction(action: string | undefined): string {
  if (!action) return 'Working'
  return NARRATIVE_ACTION_LABELS[action] ?? action.replace(/_/g, ' ')
}

// CSS class string for reviewer verdict badges
export function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'pass': return 'border-emerald-500/40 t-accent-emerald bg-emerald-500/5'
    case 'revise': return 'border-amber-500/40 t-accent-amber bg-amber-500/5'
    case 'block': return 'border-rose-500/40 t-accent-rose bg-rose-500/5'
    default: return 't-border t-text-secondary'
  }
}
