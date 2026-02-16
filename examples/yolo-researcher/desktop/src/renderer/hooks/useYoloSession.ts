// Central session hook — owns all state, effects, computed values, and actions

import { useEffect, useMemo, useState } from 'react'
import type {
  ActivityItem,
  YoloSnapshot,
  TurnReport,
  EventRecord,
  BranchSnapshot,
  AssetRecord,
  QueuedUserInput,
  ExternalWaitTask,
  WaitTaskValidationResult,
  StageId,
  GateStatus,
  TabId,
  StageGateInfo,
  BudgetUsageInfo,
  BudgetTrendInfo,
  FailureInfo,
  GovernanceSummary,
  CoverageSummary,
  ClaimMatrixRow,
  LatestClaimEvidenceTable,
  EvidenceGraphData,
  EvidenceGraphNode,
  EvidenceGraphEdge,
  EvidenceGraphLane,
  SessionActions,
  InteractionContext,
  DrawerChatMessage,
  DrawerState,
  PaperRecord,
  ReviewRecord,
} from '@/lib/types'
import {
  STAGES,
  isStageId,
  turnGateStatus,
  buildStateSummary,
  defaultOptions,
  stateTone,
  collectStringIds,
  toGraphLabel,
  laneFromId,
  formatEvent,
} from '@/lib/formatters'

const api = (window as any).api

export function useYoloSession() {
  // ─── Group A: Core session state ───────────────────────────────────
  const [projectPath, setProjectPath] = useState('')
  const [goal, setGoal] = useState('Investigate a systems bottleneck and produce evidence-backed draft skeleton.')
  const [goalSessionId, setGoalSessionId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<YoloSnapshot | null>(null)
  const [turnReports, setTurnReports] = useState<TurnReport[]>([])
  const [events, setEvents] = useState<EventRecord[]>([])
  const [rawEvents, setRawEvents] = useState<any[]>([])
  const [branchSnapshot, setBranchSnapshot] = useState<BranchSnapshot | null>(null)
  const [assetRecords, setAssetRecords] = useState<AssetRecord[]>([])
  const [queuedInputs, setQueuedInputs] = useState<QueuedUserInput[]>([])
  const [waitTasks, setWaitTasks] = useState<ExternalWaitTask[]>([])
  const [waitValidation, setWaitValidation] = useState<WaitTaskValidationResult | null>(null)
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>([])
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  // ─── Group A2: Research.md state ──────────────────────────────────
  const [researchMd, setResearchMd] = useState('')
  const [researchMdLoaded, setResearchMdLoaded] = useState(false)

  // ─── Group A3: Paper library state ──────────────────────────────
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [reviews, setReviews] = useState<ReviewRecord[]>([])

  // ─── Group B: View/UI state ────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('timeline')
  const [queueOpen, setQueueOpen] = useState(true)
  const [selectedStage, setSelectedStage] = useState<StageId>('S1')
  const [timelineStageFilter, setTimelineStageFilter] = useState<'ALL' | StageId>('ALL')
  const [timelineGateFilter, setTimelineGateFilter] = useState<'ALL' | GateStatus>('ALL')
  const [timelineProgressFilter, setTimelineProgressFilter] = useState<'ALL' | 'PROGRESS' | 'NON_PROGRESS'>('ALL')
  const [selectedTurnNumber, setSelectedTurnNumber] = useState<number | null>(null)
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null)
  const [showSupersedesEdges, setShowSupersedesEdges] = useState(true)
  const legacyEvidenceEnabled = activeTab === 'evidence'

  // ─── Group C: Drawer state ──────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerInteraction, setDrawerInteraction] = useState<InteractionContext | null>(null)
  const [drawerChat, setDrawerChat] = useState<DrawerChatMessage[]>([])
  const [drawerChatLoading, setDrawerChatLoading] = useState(false)

  // ─── Computed values ───────────────────────────────────────────────
  const activeTurn = useMemo(
    () => (turnReports.length > 0 ? turnReports[turnReports.length - 1] : null),
    [turnReports]
  )

  const isCheckpointModal = snapshot?.state === 'WAITING_FOR_USER' && Boolean(snapshot?.pendingQuestion?.checkpoint)

  const budgetCaps = snapshot?.budgetCaps ?? defaultOptions.budget

  const budgetUsage: BudgetUsageInfo = useMemo(() => {
    const used = snapshot?.budgetUsed ?? { tokens: 0, costUsd: 0, turns: 0 }
    const costRatio = budgetCaps.maxCostUsd > 0 ? used.costUsd / budgetCaps.maxCostUsd : 0
    const turnRatio = budgetCaps.maxTurns > 0 ? used.turns / budgetCaps.maxTurns : 0
    const maxRatio = Math.max(costRatio, turnRatio)
    return { used, costRatio, turnRatio, maxRatio }
  }, [snapshot?.budgetUsed, budgetCaps.maxCostUsd, budgetCaps.maxTurns])

  const budgetAlert = useMemo(() => {
    if (budgetUsage.maxRatio >= 0.95) return { label: 'Critical', tone: 't-accent-rose border-rose-500/40 bg-rose-500/10' }
    if (budgetUsage.maxRatio >= 0.8) return { label: 'Warning', tone: 't-accent-amber border-amber-500/40 bg-amber-500/10' }
    return { label: 'Healthy', tone: 't-accent-emerald border-emerald-500/40 bg-emerald-500/10' }
  }, [budgetUsage.maxRatio])

  const budgetTrend: BudgetTrendInfo = useMemo(() => {
    const recent = turnReports.slice(-5)
    if (recent.length === 0) {
      return {
        sampleSize: 0,
        avgTokensPerTurn: 0,
        avgCostPerTurn: 0,
        projectedTurnsLeftByTokens: null,
        projectedTurnsLeftByCost: null
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

  const stateSummary = useMemo(
    () => buildStateSummary(snapshot?.state, activeTurn),
    [snapshot?.state, activeTurn]
  )

  const failureInfo: FailureInfo | null = useMemo(() => {
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

  const claimMatrixRows: ClaimMatrixRow[] = useMemo(() => {
    if (!legacyEvidenceEnabled) return []
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
  }, [assetRecords, legacyEvidenceEnabled])

  const latestClaimEvidenceTable: LatestClaimEvidenceTable | null = useMemo(() => {
    if (!legacyEvidenceEnabled) return null
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
    const rows: ClaimMatrixRow[] = Array.isArray(payload.rows)
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
        .filter((row): row is ClaimMatrixRow => row !== null)
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
  }, [assetRecords, legacyEvidenceEnabled])

  const matrixRows = useMemo(() => {
    if (!legacyEvidenceEnabled) return []
    if (latestClaimEvidenceTable?.rows.length) return latestClaimEvidenceTable.rows
    return claimMatrixRows
  }, [latestClaimEvidenceTable, claimMatrixRows, legacyEvidenceEnabled])

  const evidenceGraph: EvidenceGraphData = useMemo(() => {
    if (!legacyEvidenceEnabled) {
      return {
        nodes: [],
        nodeById: new Map<string, EvidenceGraphNode>(),
        edges: [],
        graphW: 0,
        graphH: 0,
        nodeW: 160,
        nodeH: 52,
        counts: {
          claims: 0,
          links: 0,
          evidence: 0,
          decisions: 0
        }
      }
    }
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
        nodeMeta.set(id, { ...existing, lane, label, assetType, external })
        return
      }
      nodeMeta.set(id, { id, lane, label, assetType, external })
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

    // Pixel-based layout: each node gets proper spacing
    const NODE_W = 160
    const NODE_H = 52
    const GAP_Y = 12
    const LANE_GAP = 20
    const PADDING = 16

    // Collect nodes per lane, maintaining order
    const laneIds: Record<EvidenceGraphLane, string[]> = { claim: [], link: [], evidence: [], decision: [] }
    for (const node of nodeMeta.values()) {
      laneIds[node.lane].push(node.id)
    }
    for (const lane of Object.keys(laneIds) as EvidenceGraphLane[]) {
      laneIds[lane].sort((a, b) => a.localeCompare(b))
    }

    // Only include lanes that have nodes
    const activeLanes = (Object.keys(laneIds) as EvidenceGraphLane[]).filter((lane) => laneIds[lane].length > 0)
    const maxPerLane = Math.max(1, ...activeLanes.map((lane) => laneIds[lane].length))
    const graphW = activeLanes.length * (NODE_W + LANE_GAP) - LANE_GAP + PADDING * 2
    const graphH = maxPerLane * (NODE_H + GAP_Y) - GAP_Y + PADDING * 2

    const positioned: EvidenceGraphNode[] = []
    for (let laneIdx = 0; laneIdx < activeLanes.length; laneIdx++) {
      const lane = activeLanes[laneIdx]
      const ids = laneIds[lane]
      const cx = PADDING + laneIdx * (NODE_W + LANE_GAP) + NODE_W / 2
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index]
        const meta = nodeMeta.get(id)
        if (!meta) continue
        const cy = PADDING + index * (NODE_H + GAP_Y) + NODE_H / 2
        positioned.push({ ...meta, x: cx, y: cy })
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
      graphW,
      graphH,
      nodeW: NODE_W,
      nodeH: NODE_H,
      counts: {
        claims: positioned.filter((node) => node.lane === 'claim').length,
        links: positioned.filter((node) => node.lane === 'link').length,
        evidence: positioned.filter((node) => node.lane === 'evidence').length,
        decisions: positioned.filter((node) => node.lane === 'decision').length
      }
    }
  }, [assetRecords, legacyEvidenceEnabled])

  const selectedGraphNode = useMemo(
    () => (selectedGraphNodeId ? evidenceGraph.nodeById.get(selectedGraphNodeId) ?? null : null),
    [selectedGraphNodeId, evidenceGraph]
  )

  const selectedGraphAsset = useMemo(
    () => (selectedGraphNodeId ? assetRecords.find((asset) => asset.id === selectedGraphNodeId) ?? null : null),
    [selectedGraphNodeId, assetRecords]
  )

  const completeCoverageSummary: CoverageSummary = useMemo(() => {
    if (!legacyEvidenceEnabled) {
      return {
        source: 'disabled',
        assertedPrimary: 0,
        coveredPrimary: 0,
        primaryRatio: null,
        assertedSecondary: 0,
        coveredSecondary: 0,
        secondaryRatio: null,
        primaryPass: true,
        secondaryPass: true
      }
    }
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
  }, [latestClaimEvidenceTable, claimMatrixRows, legacyEvidenceEnabled])

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

  const governanceSummary: GovernanceSummary = useMemo(() => {
    const countIdsInRiskNote = (riskDelta: string[], prefix: string): number => {
      const matched = riskDelta.find((note) => note.startsWith(prefix))
      if (!matched) return 0
      const idx = matched.indexOf(':')
      if (idx === -1) return 0
      return matched.slice(idx + 1).split(',').map((item) => item.trim()).filter(Boolean).length
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

    const invalidatedNodeCount = (branchSnapshot?.nodes ?? []).filter((node) => node.status === 'invalidated').length
    const maintenanceErrorCount = maintenanceAlerts.filter((event) => event?.severity === 'error').length
    const readinessGateFailureAlertCount = maintenanceAlerts.filter((event) => event?.kind === 'readiness_gate_failure').length

    const latestTurn = turnReports[turnReports.length - 1]
    const latestPolicy = latestTurn?.gateImpact?.snapshotManifest?.evidencePolicy
    const invalidCountableLinkCount = Array.isArray(latestPolicy?.invalidCountableLinkIds) ? latestPolicy.invalidCountableLinkIds.length : 0
    const missingParityContractLinkCount = Array.isArray(latestPolicy?.keyRunMissingParityContractLinkIds) ? latestPolicy.keyRunMissingParityContractLinkIds.length : 0
    const latestCausality = latestTurn?.gateImpact?.snapshotManifest?.causality
    const causalityMissingClaimCount = Array.isArray(latestCausality?.missingClaimIds) ? latestCausality.missingClaimIds.length : 0
    const latestClaimDecisionBinding = latestTurn?.gateImpact?.snapshotManifest?.claimDecisionBinding
    const missingClaimDecisionBindingCount = Array.isArray(latestClaimDecisionBinding?.missingFreezeRefClaimIds) ? latestClaimDecisionBinding.missingFreezeRefClaimIds.length : 0
    const latestDirectEvidence = latestTurn?.gateImpact?.snapshotManifest?.directEvidence
    const directEvidenceMissingClaimCount = Array.isArray(latestDirectEvidence?.missingClaimIds) ? latestDirectEvidence.missingClaimIds.length : 0
    const latestReviewerSnapshot = latestTurn?.reviewerSnapshot
    const semanticReviewerCount = Array.isArray(latestReviewerSnapshot?.reviewerPasses) ? latestReviewerSnapshot.reviewerPasses.length : 0
    const semanticConsensusBlockerCount = Array.isArray(latestReviewerSnapshot?.consensusBlockers) ? latestReviewerSnapshot.consensusBlockers.length : 0
    const latestReadiness = latestTurn?.readinessSnapshot
    const readinessRequiredFailedCount = Array.isArray(latestReadiness?.requiredFailed) ? latestReadiness.requiredFailed.length : 0
    const crossBranchDefaultedCount = countIdsInRiskNote(latestTurn?.riskDelta ?? [], 'cross-branch evidence defaulted to cite_only')
    const crossBranchAutoUpgradedCount = countIdsInRiskNote(latestTurn?.riskDelta ?? [], 'cross-branch evidence auto-upgraded to countable')

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

  const stageGates: Record<StageId, StageGateInfo> = useMemo(() => {
    const initial: Record<StageId, StageGateInfo> = {
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
      let status: GateStatus = 'none'
      if (gateStatus === 'pass' || turn.gateImpact?.gateResult?.passed === true) {
        status = 'pass'
      } else if (gateStatus === 'fail' || gateStatus === 'rollback-needed' || turn.gateImpact?.gateResult?.passed === false) {
        status = 'fail'
      }
      initial[stage] = { status, lastTurn: turn.turnNumber, objective: turn.turnSpec?.objective, summary: turn.summary }
    }
    return initial
  }, [turnReports])

  const quickOptions = useMemo(() => {
    const options = snapshot?.pendingQuestion?.options
    if (options && options.length > 0) return options
    if (snapshot?.pendingQuestion?.checkpoint) return ['Confirm', 'Edit', 'Reject']
    return []
  }, [snapshot?.pendingQuestion?.options, snapshot?.pendingQuestion?.checkpoint])

  // ─── Sync effects ──────────────────────────────────────────────────
  useEffect(() => { setWaitValidation(null) }, [pendingWaitTask?.id])

  useEffect(() => {
    if (snapshot?.activeStage) setSelectedStage(snapshot.activeStage)
  }, [snapshot?.activeStage])

  useEffect(() => {
    if (!snapshot?.sessionId) return
    if (goalSessionId === snapshot.sessionId) return
    setGoal(snapshot.goal || '')
    setGoalSessionId(snapshot.sessionId)
  }, [snapshot?.sessionId, snapshot?.goal, goalSessionId])

  useEffect(() => {
    if (snapshot?.state === 'FAILED') {
      setActiveTab('system')
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
    if (!exists) setSelectedGraphNodeId(null)
  }, [selectedGraphNodeId, evidenceGraph.nodes])

  // ─── Refresh helpers ───────────────────────────────────────────────
  async function refreshQueue() {
    try {
      const queue = await api.yoloGetInputQueue()
      setQueuedInputs(Array.isArray(queue) ? queue : [])
    } catch { setQueuedInputs([]) }
  }

  async function refreshWaitTasks() {
    try {
      const tasks = await api.yoloListWaitTasks()
      setWaitTasks(Array.isArray(tasks) ? tasks : [])
      setWaitValidation((prev) => {
        if (!prev) return prev
        const stillExists = (Array.isArray(tasks) ? tasks : []).some((task: ExternalWaitTask) => task.id === prev.taskId)
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
    } catch { setBranchSnapshot(null) }
  }

  async function refreshAssets() {
    try {
      const assets = await api.yoloGetAssets()
      setAssetRecords(Array.isArray(assets) ? assets : [])
    } catch { setAssetRecords([]) }
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

  async function loadResearchMd() {
    try {
      const result = await api.readResearchMd()
      if (result.success) {
        setResearchMd(result.content ?? '')
        setResearchMdLoaded(true)
      }
    } catch {
      // Ignore — research.md may not exist yet
    }
  }

  async function loadPapers() {
    try {
      const [paperList, reviewList] = await Promise.all([
        api.listPapers().catch(() => []),
        api.listReviews().catch(() => []),
      ])
      setPapers(paperList || [])
      setReviews(reviewList || [])
    } catch {
      // Ignore — paper library may not exist yet
    }
  }

  function resetSession() {
    setProjectPath('')
    setSnapshot(null)
    setTurnReports([])
    setEvents([])
    setRawEvents([])
    setBranchSnapshot(null)
    setAssetRecords([])
    setActivityFeed([])
    setActiveTab('timeline')
    setQueuedInputs([])
    setWaitTasks([])
    setWaitValidation(null)
    setGoalSessionId(null)
    setResearchMd('')
    setResearchMdLoaded(false)
    setPapers([])
    setReviews([])
    setActionError(null)
    setActionNotice(null)
    setIsStarting(false)
    setIsStopping(false)
    setDrawerOpen(false)
    setDrawerInteraction(null)
    setDrawerChat([])
    setDrawerChatLoading(false)
  }

  // ─── IPC listeners ─────────────────────────────────────────────────
  useEffect(() => {
    // Restore session first, then fetch history — turn reports are only
    // populated in main-process state after restoreSessionFromDisk completes,
    // so we must wait for getCurrentSession before calling refreshHistory.
    api.getCurrentSession().then(async (session: { projectPath: string }) => {
      if (session?.projectPath) setProjectPath(session.projectPath)
      await refreshHistory()
      await refreshQueue()
      await refreshWaitTasks()
      await loadResearchMd()
      await loadPapers()
    })

    const unsubState = api.onYoloState((payload: YoloSnapshot) => {
      setSnapshot(payload)
      // Clear "starting" spinner once the session has moved beyond IDLE
      if (payload.state && payload.state !== 'IDLE') {
        setIsStarting(false)
      }
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
      void loadPapers()
    })
    const unsubQuestion = api.onYoloQuestion((payload: any) => {
      setEvents((prev) => [{ at: new Date().toISOString(), type: 'question', text: `Question: ${payload?.question ?? ''}` }, ...prev].slice(0, 80))
      setRawEvents((prev) => [{ type: 'question', timestamp: new Date().toISOString(), ...payload }, ...prev].slice(0, 120))
    })
    const unsubEvent = api.onYoloEvent((payload: any) => {
      setEvents((prev) => [formatEvent(payload), ...prev].slice(0, 80))
      setRawEvents((prev) => [payload, ...prev].slice(0, 120))
      if (payload?.type === 'input_queue_changed') void refreshQueue()
      if (
        payload?.type === 'wait_external_requested'
        || payload?.type === 'wait_external_resolved'
        || payload?.type === 'wait_external_cancelled'
        || payload?.type === 'fulltext_wait_requested'
      ) void refreshWaitTasks()
      if (payload?.type === 'turn_committed') {
        void refreshBranchSnapshot()
        void refreshAssets()
      }
      if (payload?.type === 'session_restored') {
        void refreshHistory()
      }
    })
    const unsubActivity = api.onYoloActivity((payload: ActivityItem) => {
      if (payload.kind === 'llm_text') {
        // Replace the existing llm_text entry with the same id (accumulated buffer)
        setActivityFeed((prev) => {
          const idx = prev.findIndex((item) => item.kind === 'llm_text' && item.id === payload.id)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = payload
            return next
          }
          return [payload, ...prev].slice(0, 50)
        })
      } else {
        setActivityFeed((prev) => [payload, ...prev].slice(0, 50))
      }
    })
    const unsubDrawer = api.onDrawerStateChanged((payload: DrawerState) => {
      setDrawerInteraction(payload.interaction)
      setDrawerChat(payload.chatHistory)
      if (payload.interaction) setDrawerOpen(true)
      if (!payload.interaction) setDrawerOpen(false)
    })
    const unsubClosed = api.onProjectClosed(() => resetSession())

    api.yoloGetSnapshot().then((s: YoloSnapshot | null) => setSnapshot(s)).catch(() => {})

    return () => {
      unsubState(); unsubTurn(); unsubQuestion(); unsubEvent(); unsubActivity(); unsubDrawer(); unsubClosed()
    }
  }, [])

  // ─── Actions (accept params, no form closure) ──────────────────────
  const actions: SessionActions = {
    async pickFolder() {
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
      await loadResearchMd()
      await loadPapers()
    },

    async closeProject() {
      try {
        await api.closeProject()
      } catch {
        // Best effort — resetSession will be triggered by the onProjectClosed listener
      }
    },

    async startYolo() {
      setIsStarting(true)
      setActionError(null)
      setActionNotice(null)
      try {
        const started = await api.yoloStart(goal, defaultOptions)
        setSnapshot(started)
        await refreshHistory()
        await refreshQueue()
        await refreshWaitTasks()
        // isStarting is cleared by the IPC state listener when state moves beyond IDLE
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
        setIsStarting(false)
      }
    },

    async restartYolo() {
      setIsStarting(true)
      setActionError(null)
      setActionNotice(null)
      setActivityFeed([])
      try {
        // Stop current session first to force a fresh start
        await api.yoloStop().catch(() => {})
        const started = await api.yoloStart(goal, defaultOptions)
        setSnapshot(started)
        setTurnReports([])
        setEvents([])
        setRawEvents([])
        setBranchSnapshot(null)
        setAssetRecords([])
        await refreshHistory()
        await refreshQueue()
        await refreshWaitTasks()
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
        setIsStarting(false)
      }
    },

    async pauseYolo() {
      setActionError(null)
      setActionNotice(null)
      try {
        const s = await api.yoloPause()
        setSnapshot(s)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async resumeYolo() {
      setActionError(null)
      setActionNotice(null)
      try {
        const s = await api.yoloResume()
        setSnapshot(s)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async stopYolo() {
      setActionError(null)
      setActionNotice(null)
      setIsStopping(true)
      try {
        const s = await api.yoloStop()
        setSnapshot(s)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      } finally {
        setIsStopping(false)
      }
    },

    async restoreFromCheckpoint() {
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
    },

    async submitReply(text: string) {
      if (!text.trim()) return
      await api.yoloEnqueueInput(text.trim(), 'urgent')
      await refreshQueue()
    },

    async submitQuickReply(text: string) {
      await api.yoloEnqueueInput(text, 'urgent')
      await refreshQueue()
    },

    async yoloEnqueueInput(text: string, priority?: 'urgent' | 'normal') {
      if (!text.trim()) return
      await api.yoloEnqueueInput(text.trim(), priority ?? 'normal')
      await refreshQueue()
    },

    async exportSummary() {
      setActionError(null)
      try {
        const result = await api.yoloExportSummary()
        setActionNotice(`Summary exported to ${result.path}`)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async exportClaimEvidenceTable() {
      setActionError(null)
      try {
        const result = await api.yoloExportClaimEvidenceTable()
        setActionNotice(`Claim-evidence table exported to ${result.path}`)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async exportAssetInventory() {
      setActionError(null)
      try {
        const result = await api.yoloExportAssetInventory()
        setActionNotice(`Asset inventory exported to ${result.path}`)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async exportFinalBundle() {
      setActionError(null)
      try {
        const result = await api.yoloExportFinalBundle()
        setActionNotice(`Final bundle manifest exported to ${result.manifestPath}`)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async requestWaitExternal({ title, completionRule, resumeAction, details }) {
      setActionError(null)
      setActionNotice(null)
      try {
        await api.yoloWaitExternal({ title, completionRule, resumeAction, details })
        await refreshWaitTasks()
        const s = await api.yoloGetSnapshot().catch(() => null)
        setSnapshot(s)
        setActionNotice('External wait requested.')
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async requestFullTextWait({ citation, requiredFiles, reason }) {
      setActionError(null)
      setActionNotice(null)
      try {
        const files = requiredFiles.split(',').map((item) => item.trim()).filter(Boolean)
        await api.yoloRequestFullTextWait({ citation, requiredFiles: files, reason })
        await refreshWaitTasks()
        const s = await api.yoloGetSnapshot().catch(() => null)
        setSnapshot(s)
        setActionNotice('Full-text wait requested.')
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async resolveWaitTask(resolutionNote: string) {
      setActionError(null)
      setActionNotice(null)
      try {
        const pendingId = snapshot?.pendingExternalTaskId
        if (!pendingId) throw new Error('No pending external task.')
        await api.yoloResolveWaitTask({ taskId: pendingId, resolutionNote })
        await refreshWaitTasks()
        const s = await api.yoloGetSnapshot().catch(() => null)
        setSnapshot(s)
        setActionNotice('External wait resolved.')
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async validateWaitTask() {
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
    },

    async cancelWaitTask(reason: string) {
      setActionError(null)
      setActionNotice(null)
      try {
        const pendingId = snapshot?.pendingExternalTaskId
        if (!pendingId) throw new Error('No pending external task.')
        await api.yoloCancelWaitTask({ taskId: pendingId, reason })
        await refreshWaitTasks()
        const s = await api.yoloGetSnapshot().catch(() => null)
        setSnapshot(s)
        setActionNotice('External wait cancelled.')
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async addIngressFiles(taskId?: string) {
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
    },

    async requestResourceExtension({ rationale, deltaTurns, deltaTokens, deltaCostUsd }) {
      setActionError(null)
      setActionNotice(null)
      try {
        await api.yoloRequestResourceExtension({
          rationale,
          delta: {
            maxTurns: Number(deltaTurns) || 0,
            maxTokens: Number(deltaTokens) || 0,
            maxCostUsd: Number(deltaCostUsd) || 0
          },
          requestedBy: 'user'
        })
        const s = await api.yoloGetSnapshot().catch(() => null)
        setSnapshot(s)
        setActionNotice('Resource extension requested; waiting for decision.')
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async resolveResourceExtension(approved: boolean, note: string) {
      setActionError(null)
      setActionNotice(null)
      try {
        await api.yoloResolveResourceExtension({ approved, note })
        const s = await api.yoloGetSnapshot().catch(() => null)
        setSnapshot(s)
        setActionNotice(`Resource extension ${approved ? 'approved' : 'rejected'}.`)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async recordOverrideDecision({ targetNodeId, rationale, riskAccepted }) {
      setActionError(null)
      setActionNotice(null)
      try {
        const result = await api.yoloRecordOverrideDecision({ targetNodeId, rationale, riskAccepted })
        setActionNotice(`Override decision recorded: ${result.decisionAssetId}`)
        await refreshAssets()
        await refreshHistory()
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    },

    async setQueuePriority(id: string, priority: 'urgent' | 'normal') {
      await api.yoloQueueReprioritize(id, priority)
      await refreshQueue()
    },

    async moveQueueItem(id: string, toIndex: number) {
      await api.yoloQueueMove(id, toIndex)
      await refreshQueue()
    },

    async removeQueueItem(id: string) {
      await api.yoloQueueRemove(id)
      await refreshQueue()
    },

    async saveResearchMd(content: string) {
      setActionError(null)
      setActionNotice(null)
      const result = await api.saveResearchMd(content)
      if (!result.success) {
        setActionError(result.error ?? 'Failed to save research.md')
      } else {
        setActionNotice('research.md saved')
        await loadResearchMd()
      }
    },

    async saveGoalToResearchMd(newGoal: string) {
      const KEYWORD = 'Users Overall Research Goal:'
      let updated: string
      if (researchMd.includes(KEYWORD)) {
        updated = researchMd.replace(
          new RegExp(`${KEYWORD}[^\\n]*`),
          `${KEYWORD}\n${newGoal}`
        )
      } else {
        updated = `${KEYWORD}\n${newGoal}\n\n${researchMd}`
      }
      if (updated.length > 5000) {
        setActionError('research.md would exceed 5000 character limit.')
        return
      }
      const result = await api.saveResearchMd(updated)
      if (!result.success) {
        setActionError(result.error ?? 'Failed to save research.md')
      } else {
        setGoal(newGoal)
        setActionNotice('Goal updated in research.md')
        await loadResearchMd()
      }
    },

    async refreshPapers() {
      await loadPapers()
    },

    async readReview(reviewId: string) {
      try {
        const result = await api.readReview(reviewId)
        return result?.content ?? ''
      } catch {
        return ''
      }
    },

    setGoal,
    setActiveTab,
    setSelectedStage,
    setTimelineStageFilter,
    setTimelineGateFilter,
    setTimelineProgressFilter,
    setSelectedTurnNumber,
    setSelectedGraphNodeId,
    setShowSupersedesEdges,
    setQueueOpen,

    async openDrawer() {
      const state = await api.drawerGetState()
      setDrawerInteraction(state.interaction)
      setDrawerChat(state.chatHistory)
      setDrawerOpen(true)
    },

    closeDrawer() {
      setDrawerOpen(false)
    },

    async sendDrawerChat(message: string) {
      if (!drawerInteraction) return
      setDrawerChatLoading(true)
      const userMsg: DrawerChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
      }
      setDrawerChat((prev) => [...prev, userMsg])
      try {
        const response = await api.drawerChat({ message, interactionId: drawerInteraction.interactionId })
        setDrawerChat((prev) => [...prev, response])
      } finally {
        setDrawerChatLoading(false)
      }
    },

    async executeDrawerAction(actionId: string, text?: string) {
      if (!drawerInteraction) return
      await api.drawerAction({ interactionId: drawerInteraction.interactionId, actionId, text })
    },
  }

  return {
    // State
    projectPath,
    goal,
    snapshot,
    turnReports,
    events,
    rawEvents,
    branchSnapshot,
    assetRecords,
    activityFeed,
    researchMd,
    researchMdLoaded,
    papers,
    reviews,
    queuedInputs,
    waitTasks,
    waitValidation,
    isStarting,
    isStopping,
    actionError,
    actionNotice,
    activeTab,
    queueOpen,
    selectedStage,
    timelineStageFilter,
    timelineGateFilter,
    timelineProgressFilter,
    selectedTurnNumber,
    selectedGraphNodeId,
    showSupersedesEdges,

    // Computed
    activeTurn,
    isCheckpointModal,
    budgetCaps,
    budgetUsage,
    budgetAlert,
    budgetTrend,
    stateSummary,
    failureInfo,
    totalCreatedAssets,
    assetTypeCounts,
    claimMatrixRows,
    latestClaimEvidenceTable,
    matrixRows,
    evidenceGraph,
    selectedGraphNode,
    selectedGraphAsset,
    completeCoverageSummary,
    canPause,
    canResume,
    canStop,
    filteredTurns,
    selectedTurn,
    pendingWaitTask,
    maintenanceAlerts,
    governanceSummary,
    stageGates,
    quickOptions,

    // Drawer
    drawerOpen,
    drawerInteraction,
    drawerChat,
    drawerChatLoading,

    // Actions
    actions,
  }
}

export type YoloSessionReturn = ReturnType<typeof useYoloSession>
