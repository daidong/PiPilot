import * as path from 'node:path'

import type {
  PendingUserInput,
  PlanBoardItem,
  ProjectUpdate,
  TurnContext,
  TurnStatus
} from './types.js'
import { toIso, writeText } from './utils.js'

const PLAN_ID_RE = /^P\d+$/i

function normalizePlanId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toUpperCase()
  if (!trimmed) return ''
  if (PLAN_ID_RE.test(trimmed)) return trimmed
  const numeric = trimmed.replace(/[^0-9]/g, '')
  if (!numeric) return ''
  return `P${Number.parseInt(numeric, 10)}`
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function buildNativeTurnFilePaths(input: { turnDir: string, artifactsDir: string }) {
  return {
    cmdPath: path.join(input.turnDir, 'cmd.txt'),
    stdoutPath: path.join(input.turnDir, 'stdout.txt'),
    stderrPath: path.join(input.turnDir, 'stderr.txt'),
    exitCodePath: path.join(input.turnDir, 'exit_code.txt'),
    resultPath: path.join(input.turnDir, 'result.json'),
    actionPath: path.join(input.turnDir, 'action.md'),
    toolEventsPath: path.join(input.artifactsDir, 'tool-events.jsonl'),
    rawOutputPath: path.join(input.artifactsDir, 'agent-output.txt')
  }
}

export async function executeNativeTurnOutcome(session: any, input: {
  context: TurnContext
  pendingUserInputs: PendingUserInput[]
}): Promise<{
  outcome: any
  consumedPendingUserInputs: boolean
}> {
  try {
    const outcome = await session.config.agent.runTurn(input.context)
    if (input.pendingUserInputs.length > 0) {
      await session.clearQueuedUserInputs()
      return {
        outcome,
        consumedPendingUserInputs: true
      }
    }
    return {
      outcome,
      consumedPendingUserInputs: false
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      outcome: {
        intent: 'Handle native turn runtime error',
        status: 'failure',
        summary: `Native turn runtime error: ${message}`,
        primaryAction: 'agent.run',
        updateSummary: ['Next: inspect runtime error and retry with narrower scope.']
      },
      consumedPendingUserInputs: false
    }
  }
}

export async function writeProvisionalTurnArtifacts(session: any, input: {
  paths: {
    cmdPath: string
    stdoutPath: string
    stderrPath: string
    exitCodePath: string
    resultPath: string
  }
  status: TurnStatus
  cmd: string
  stdout: string
  stderr: string
  exitCode: number
}): Promise<void> {
  await writeText(input.paths.cmdPath, input.cmd ? `${input.cmd}\n` : '')
  await writeText(input.paths.stdoutPath, input.stdout)
  await writeText(input.paths.stderrPath, input.stderr)
  await writeText(input.paths.exitCodePath, `${input.exitCode}\n`)
  await writeText(input.paths.resultPath, `${JSON.stringify({
    status: input.status,
    phase: 'provisional',
    timestamp: toIso(session.now())
  }, null, 2)}\n`)
}

export async function writeFinalTurnArtifacts(input: {
  paths: { resultPath: string, actionPath: string }
  resultPayload: Record<string, unknown>
  actionMarkdown: string
}): Promise<void> {
  await writeText(input.paths.resultPath, `${JSON.stringify(input.resultPayload, null, 2)}\n`)
  await writeText(input.paths.actionPath, input.actionMarkdown)
}

export async function applyOutcomeProjectUpdate(session: any, input: {
  projectUpdate?: ProjectUpdate
  plannerCheckpointDue: boolean
  evidenceRefMap: Record<string, string>
  fallbackEvidencePath: string
  toolEvents: any[]
  artifactsDir: string
  updateSummaryLines: string[]
}): Promise<boolean> {
  if (!input.projectUpdate) {
    return false
  }

  const governanceFiltered = session.filterProjectUpdateForGovernanceWindow({
    update: input.projectUpdate,
    plannerCheckpointDue: input.plannerCheckpointDue
  })
  input.updateSummaryLines.push(...governanceFiltered.notes)

  const candidateUpdate = governanceFiltered.update
  if (!candidateUpdate) {
    input.updateSummaryLines.push('PROJECT.md structured update skipped: no eligible fields for this turn.')
    return false
  }

  const evidenceAttached = session.attachRuntimeEvidenceToProjectUpdate({
    update: candidateUpdate,
    evidenceRefMap: input.evidenceRefMap,
    fallbackEvidencePath: input.fallbackEvidencePath
  })
  input.updateSummaryLines.push(...evidenceAttached.notes.slice(0, 2))

  const groundedUpdate = await session.demoteSpeculativeEnvironmentConstraints({
    update: evidenceAttached.update,
    toolEvents: input.toolEvents
  })
  input.updateSummaryLines.push(...groundedUpdate.notes.slice(0, 2))

  try {
    const normalizedProjectUpdate = await session.normalizeAndValidateProjectUpdate(groundedUpdate.update)
    await session.projectStore.applyUpdate(normalizedProjectUpdate.update)
    input.updateSummaryLines.push(...normalizedProjectUpdate.notes.slice(0, 2))
    input.updateSummaryLines.push('PROJECT.md: applied structured update from native turn.')
    return true
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    let repaired = false

    const repairAttempt = await session.repairProjectUpdateEvidencePaths({
      update: groundedUpdate.update,
      artifactsDir: input.artifactsDir,
      validationMessage: message
    })

    if (repairAttempt) {
      try {
        const groundedRepairedUpdate = await session.demoteSpeculativeEnvironmentConstraints({
          update: repairAttempt.update,
          toolEvents: input.toolEvents
        })
        const normalizedRepairedUpdate = await session.normalizeAndValidateProjectUpdate(groundedRepairedUpdate.update)
        await session.projectStore.applyUpdate(normalizedRepairedUpdate.update)
        repaired = true
        input.updateSummaryLines.push(...groundedRepairedUpdate.notes.slice(0, 2))
        input.updateSummaryLines.push(...normalizedRepairedUpdate.notes.slice(0, 2))
        input.updateSummaryLines.push('PROJECT.md: applied structured update after same-turn evidence repair.')
        input.updateSummaryLines.push(...repairAttempt.notes.slice(0, 3))
        return true
      } catch (repairError) {
        message = repairError instanceof Error ? repairError.message : String(repairError)
      }
    }

    if (!repaired) {
      input.updateSummaryLines.push(`PROJECT.md structured update skipped: ${message}`)
    }
    return false
  }
}

export async function applyNativeTurnPlanDeltas(
  session: any,
  input: {
    activePlanId: string
    statusChange: string
    deltaText: string
    planEvidencePaths: string[]
    turnStatus: TurnStatus
    dropReason: string
    replacedBy?: string | null
    allowStructuralPlanChanges: boolean
    coTouchedPlanIds: string[]
    currentBoard: PlanBoardItem[]
    projectedUpdate?: ProjectUpdate
    workspaceWriteTouches: string[]
  },
  context: { summary: string, blockedReason: string | null }
): Promise<{
  turnStatus: TurnStatus
  summary: string
  blockedReason: string | null
  planDeltaApplied: boolean
  planDeltaWarning: string
  coPlanStatusChanges: string[]
  coPlanWarnings: string[]
}> {
  let turnStatus = input.turnStatus
  let summary = context.summary
  let blockedReason = context.blockedReason
  let planDeltaApplied = false
  let planDeltaWarning = ''
  const coPlanStatusChanges: string[] = []
  const coPlanWarnings: string[] = []

  if (input.activePlanId) {
    const planDelta = await session.projectStore.applyTurnPlanDelta({
      activePlanId: input.activePlanId,
      statusChange: input.statusChange,
      delta: input.deltaText,
      evidencePaths: input.planEvidencePaths,
      turnStatus,
      dropReason: input.dropReason,
      replacedBy: input.replacedBy,
      allowStructuralPlanChanges: input.allowStructuralPlanChanges
    })
    planDeltaApplied = planDelta.applied
    planDeltaWarning = planDelta.warning?.trim() || ''
    if (!planDeltaApplied && turnStatus === 'success') {
      turnStatus = 'no_delta'
      blockedReason = blockedReason || 'plan_delta_not_applied'
      summary = `NO_DELTA: ${planDeltaWarning || 'plan delta not applied'}. ${summary}`
    }
  }

  if (turnStatus === 'success' && planDeltaApplied && input.coTouchedPlanIds.length > 0) {
    for (const coPlanId of input.coTouchedPlanIds) {
      const coPlanItem = session.resolveProjectedPlanItem(
        coPlanId,
        input.currentBoard,
        input.projectedUpdate
      )
      if (!coPlanItem) {
        coPlanWarnings.push(`co-plan not found: ${coPlanId}`)
        continue
      }

      const fromStatus = coPlanItem.status
      let coStatusChange = `${coPlanId} ${fromStatus} -> ${fromStatus}`
      let coCheck = session.validatePlanProgressAgainstDoneDefinition({
        status: turnStatus,
        activePlanId: coPlanId,
        statusChange: coStatusChange,
        explicitEvidencePaths: input.planEvidencePaths,
        cumulativeEvidencePaths: dedupeStrings([...(coPlanItem.evidencePaths ?? []), ...input.planEvidencePaths]),
        planItem: coPlanItem,
        workspaceWriteTouches: input.workspaceWriteTouches
      })
      if (!coCheck.ok) {
        coPlanWarnings.push(`co-plan skipped ${coPlanId}: ${coCheck.reason}`)
        continue
      }

      if (coCheck.doneReady) {
        coStatusChange = `${coPlanId} ${fromStatus} -> DONE`
        coCheck = session.validatePlanProgressAgainstDoneDefinition({
          status: turnStatus,
          activePlanId: coPlanId,
          statusChange: coStatusChange,
          explicitEvidencePaths: input.planEvidencePaths,
          cumulativeEvidencePaths: dedupeStrings([...(coPlanItem.evidencePaths ?? []), ...input.planEvidencePaths]),
          planItem: coPlanItem,
          workspaceWriteTouches: input.workspaceWriteTouches
        })
        if (!coCheck.ok) {
          coPlanWarnings.push(`co-plan skipped ${coPlanId}: ${coCheck.reason}`)
          continue
        }
      }

      const coPlanDelta = await session.projectStore.applyTurnPlanDelta({
        activePlanId: coPlanId,
        statusChange: coStatusChange,
        evidencePaths: input.planEvidencePaths,
        turnStatus,
        allowStructuralPlanChanges: input.allowStructuralPlanChanges
      })
      if (coPlanDelta.applied) {
        coPlanStatusChanges.push(coStatusChange)
        continue
      }
      coPlanWarnings.push(`co-plan delta not applied ${coPlanId}: ${coPlanDelta.warning || 'unknown'}`)
    }
  }

  return {
    turnStatus,
    summary,
    blockedReason,
    planDeltaApplied,
    planDeltaWarning,
    coPlanStatusChanges,
    coPlanWarnings
  }
}

export async function applyNativeTurnProjectMutations(session: any, input: any): Promise<any> {
  let finalStatus = input.finalStatus
  let summary = input.summary
  let blockedReason = input.blockedReason

  const updateSummaryLines = [
    ...input.preflightNotes.map((line: string) => line.trim()).filter(Boolean),
    ...input.outcomeUpdateSummary.map((line: string) => line.trim()).filter(Boolean)
  ]
  if (input.planAttribution.reason) {
    updateSummaryLines.push(`Plan attribution: ${input.planAttribution.reason}${input.activePlanId ? ` -> ${input.activePlanId}` : ''}`)
  }
  if (input.coTouchedPlanIds.length > 0) {
    updateSummaryLines.push(`Plan co-touch: ${input.coTouchedPlanIds.join(', ')}`)
  }
  if (input.coTouchedDeliverablePlanIds.length > 0) {
    updateSummaryLines.push(`Plan co-touch deliverable hit: ${input.coTouchedDeliverablePlanIds.join(', ')}`)
  }
  if (!input.doneDefinitionCheck.ok && input.coTouchedDeliverablePlanIds.length > 0) {
    updateSummaryLines.push(`Primary plan gate bypassed via co-touch deliverable accounting (${input.doneDefinitionCheck.reason}).`)
  }
  if (input.microCheckpointApplied && input.activePlanId && input.microCheckpointDeliverable) {
    updateSummaryLines.push(`Micro-checkpoint: aligned ${input.activePlanId} deliverable -> ${input.microCheckpointDeliverable}`)
  }
  if (input.missingOutcomeEvidencePaths.length > 0) {
    const preview = input.missingOutcomeEvidencePaths[0]
    updateSummaryLines.push(`Ignored ${input.missingOutcomeEvidencePaths.length} missing outcome evidence path(s); first=${preview}`)
  }
  if (input.semanticGateAudit.invoked) {
    const semanticState = input.semanticGateAudit.accepted
      ? 'accepted'
      : (input.semanticGateAudit.reject_reason || 'rejected')
    updateSummaryLines.push(`Semantic gate (${input.semanticGateAudit.mode}): ${semanticState}`)
  }
  if (input.codingAgentSessionObservation.observed && input.codingAgentSessionObservation.hasRunningOnly) {
    const stateLabel = input.codingAgentSessionObservation.warmupLikely ? 'warmup' : 'running'
    updateSummaryLines.push(`Coding-agent session: ${stateLabel} (polls=${input.codingAgentSessionObservation.pollCount}).`)
  }

  let projectUpdated = await applyOutcomeProjectUpdate(session, {
    projectUpdate: input.outcomeProjectUpdate,
    plannerCheckpointDue: input.plannerCheckpointDue,
    evidenceRefMap: input.evidenceRefMap,
    fallbackEvidencePath: session.toEvidencePath(input.resultPath),
    toolEvents: input.toolEvents,
    artifactsDir: input.artifactsDir,
    updateSummaryLines
  })

  if (input.microCheckpointApplied && input.activePlanId && input.projectedPlanItem) {
    try {
      await session.projectStore.applyUpdate({
        planBoard: [{
          id: input.projectedPlanItem.id,
          title: input.projectedPlanItem.title,
          status: input.projectedPlanItem.status,
          doneDefinition: [...(input.projectedPlanItem.doneDefinition ?? [])],
          evidencePaths: [...(input.projectedPlanItem.evidencePaths ?? [])],
          nextMinStep: input.projectedPlanItem.nextMinStep,
          dropReason: input.projectedPlanItem.dropReason,
          replacedBy: input.projectedPlanItem.replacedBy ?? null,
          priority: input.projectedPlanItem.priority
        }]
      })
      projectUpdated = true
    } catch (microCheckpointError) {
      const message = microCheckpointError instanceof Error ? microCheckpointError.message : String(microCheckpointError)
      updateSummaryLines.push(`Micro-checkpoint apply skipped: ${message}`)
    }
  }

  const planDeltaResult = await applyNativeTurnPlanDeltas(session, {
    activePlanId: input.activePlanId,
    statusChange: input.statusChange,
    deltaText: input.deltaText,
    planEvidencePaths: input.planEvidencePaths,
    turnStatus: finalStatus,
    dropReason: input.dropReason,
    replacedBy: input.replacedBy,
    allowStructuralPlanChanges: input.plannerCheckpointDue,
    coTouchedPlanIds: input.coTouchedPlanIds,
    currentBoard: input.currentBoard,
    projectedUpdate: input.projectedPlanUpdate,
    workspaceWriteTouches: input.workspaceWriteTouches
  }, {
    summary,
    blockedReason
  })
  finalStatus = planDeltaResult.turnStatus
  summary = planDeltaResult.summary
  blockedReason = planDeltaResult.blockedReason

  const doneEntries = (
    finalStatus === 'success' && input.deltaReasons.length > 0 && input.actionFingerprint
      ? [{
        text: input.actionFingerprint,
        evidencePath: input.businessArtifactEvidencePaths[0] ?? session.toEvidencePath(input.resultPath)
      }]
      : []
  )

  const curatedKeyArtifacts = dedupeStrings([
    ...input.businessArtifactEvidencePaths,
    ...input.normalizedOutcomeEvidencePaths,
    ...input.runtimeControlEvidencePaths,
    ...input.literatureCachePaths
  ])
  const autoProjectUpdate: ProjectUpdate = {
    ...(curatedKeyArtifacts.length > 0 ? { keyArtifacts: curatedKeyArtifacts } : {}),
    ...(doneEntries.length > 0 ? { done: doneEntries } : {})
  }
  await session.projectStore.applyUpdate(autoProjectUpdate)
  projectUpdated = true
  updateSummaryLines.push('PROJECT.md: applied runtime-generated evidence pointers.')

  let clearedRedundancyBlocked = false
  if (finalStatus === 'success' && input.deltaReasons.length > 0 && input.actionFingerprint) {
    clearedRedundancyBlocked = await session.failureStore.clearRedundancyBlocked({
      fingerprint: input.actionFingerprint,
      resolved: 'New delta artifact produced for previously blocked fingerprint.',
      evidencePath: session.toEvidencePath(input.resultPath)
    })
  }

  if (input.consumedPendingUserInputs) {
    updateSummaryLines.push(`User input: consumed ${input.pendingUserInputs.length} queued item(s).`)
  }

  let persistedProject = input.currentProject
  if (projectUpdated) {
    const panel = await session.projectStore.load()
    persistedProject = panel
    updateSummaryLines.push(`PROJECT.md: plan=${panel.currentPlan.length}, facts=${panel.facts.length}, artifacts=${panel.keyArtifacts.length}`)
    if (planDeltaResult.planDeltaApplied) {
      updateSummaryLines.push(`Plan Board: updated ${input.activePlanId} (${input.statusChange || finalStatus}).`)
    } else if (input.activePlanId && planDeltaResult.planDeltaWarning) {
      updateSummaryLines.push(`Plan Board warning: ${planDeltaResult.planDeltaWarning}`)
    }
    if (planDeltaResult.coPlanStatusChanges.length > 0) {
      updateSummaryLines.push(`Plan Board: co-updated ${planDeltaResult.coPlanStatusChanges.join('; ')}`)
    }
    if (planDeltaResult.coPlanWarnings.length > 0) {
      updateSummaryLines.push(`Plan Board co-update warning: ${planDeltaResult.coPlanWarnings[0]}`)
    }
  }

  if (input.failureEntry) {
    updateSummaryLines.push(`FAILURES.md: ${input.failureEntry.status} recorded for fingerprint ${input.failureEntry.fingerprint}`)
  }
  if (input.clearedBlocked) {
    updateSummaryLines.push('FAILURES.md: BLOCKED fingerprint cleared after successful verification.')
  }
  if (clearedRedundancyBlocked) {
    updateSummaryLines.push('FAILURES.md: REDUNDANT block cleared after new delta.')
  }
  if (doneEntries.length > 0) {
    updateSummaryLines.push('PROJECT.md: Done (Do-not-repeat) updated with action fingerprint.')
  }
  if (input.literatureCachePaths.length > 0) {
    updateSummaryLines.push(`Literature cache: saved ${input.literatureCachePaths.length} document(s) under turn artifacts.`)
  }
  if (finalStatus === 'no_delta') {
    updateSummaryLines.push('NO_DELTA: no new verifiable artifact/evidence package was produced this turn.')
  }
  if (input.plannerCheckpoint?.due) {
    updateSummaryLines.push(`Planner checkpoint due: ${input.plannerCheckpoint.reasons.join(', ')}`)
  }

  return {
    finalStatus,
    summary,
    blockedReason,
    updateSummaryLines,
    persistedProject,
    planDeltaApplied: planDeltaResult.planDeltaApplied,
    planDeltaWarning: planDeltaResult.planDeltaWarning,
    coPlanStatusChanges: planDeltaResult.coPlanStatusChanges,
    coPlanWarnings: planDeltaResult.coPlanWarnings,
    clearedRedundancyBlocked,
    doneEntries
  }
}

export async function buildNativeTurnResultPayload(session: any, input: any): Promise<{
  resultPayload: Record<string, unknown>
  stageStatus: any
}> {
  const producedDeliverables = await session.findProducedDeliverables()
  const stageStatus = session.inferStage(producedDeliverables)

  const claimsCoverage = input.persistedProject.claims.length > 0
    ? {
      claims_total: input.persistedProject.claims.length,
      claims_covered: input.persistedProject.claims.filter((c: any) => c.status === 'covered').length,
      claims_coverage: Number((input.persistedProject.claims.filter((c: any) => c.status === 'covered').length / input.persistedProject.claims.length).toFixed(2))
    }
    : {}
  const goalConstraintsFingerprint = session.computeGoalConstraintsFingerprint(input.persistedProject)
  const planBoardHash = session.computePlanBoardFingerprint(input.persistedProject)
  const runtimeVersion = await session.resolveRuntimeVersionInfo()

  return {
    stageStatus,
    resultPayload: {
      status: input.finalStatus,
      intent: input.intent,
      summary: input.summary,
      primary_action: input.primaryAction,
      active_plan_id: input.activePlanId || null,
      status_change: input.statusChange || null,
      delta: input.deltaText || null,
      evidence_paths: input.uniqueEvidencePaths,
      evidence_refs: input.evidenceRefMap,
      plan_evidence_paths: input.planEvidencePaths,
      action_fingerprint: input.actionFingerprint,
      action_type: input.actionType,
      exit_code: input.exitCode,
      runtime: input.runtime,
      cmd: input.cmd,
      cwd: input.cwd,
      last_failed_cmd: input.latestFailure?.cmd || null,
      last_failed_exit_code: typeof input.latestFailure?.exitCode === 'number' ? input.latestFailure.exitCode : null,
      last_failed_error_excerpt: input.latestFailure?.errorExcerpt || null,
      last_failure_kind: input.latestFailure?.failureKind || null,
      last_failure_tool: input.latestFailure?.tool || null,
      duration_sec: input.durationSec,
      timestamp: toIso(input.turnEndedAt),
      tool_events_path: session.toEvidencePath(input.toolEventsPath),
      tool_events_count: input.toolEventsCount,
      delta_reasons: input.deltaReasons,
      governance_only_turn: input.governanceOnlyTurn,
      stage_status: stageStatus,
      planner_checkpoint_due: input.plannerCheckpoint?.due ?? false,
      planner_checkpoint_reasons: input.plannerCheckpoint?.reasons ?? [],
      plan_board_hash: planBoardHash,
      runtime_version: runtimeVersion,
      plan_attribution_reason: input.planAttribution.reason,
      plan_attribution_ambiguous: input.planAttribution.ambiguous,
      co_touched_plan_ids: input.coTouchedPlanIds,
      co_touched_deliverable_plan_ids: input.coTouchedDeliverablePlanIds,
      co_plan_status_changes: input.coPlanStatusChanges,
      micro_checkpoint_applied: input.microCheckpointApplied,
      ...(input.microCheckpointDeliverable ? { micro_checkpoint_deliverable: input.microCheckpointDeliverable } : {}),
      goal_constraints_fingerprint: goalConstraintsFingerprint,
      ...(input.deterministicFingerprint ? { failure_fingerprint: input.deterministicFingerprint } : {}),
      ...(input.clearedBlocked ? { unblock_verified: true } : {}),
      ...(input.blockedReason ? { blocked_reason: input.blockedReason } : {}),
      semantic_gate: {
        enabled: input.semanticGateAudit.enabled,
        mode: input.semanticGateAudit.mode,
        eligible: input.semanticGateAudit.eligible,
        invoked: input.semanticGateAudit.invoked,
        prompt_version: input.semanticGateAudit.prompt_version,
        model_id: input.semanticGateAudit.model_id,
        temperature: input.semanticGateAudit.temperature,
        input_hash: input.semanticGateAudit.input_hash,
        output: input.semanticGateAudit.output,
        accepted: input.semanticGateAudit.accepted,
        ...(input.semanticGateAudit.reject_reason ? { reject_reason: input.semanticGateAudit.reject_reason } : {})
      },
      coding_agent_sessions: {
        observed: input.codingAgentSessionObservation.observed,
        session_ids: input.codingAgentSessionObservation.sessionIds,
        started_session_ids: input.codingAgentSessionObservation.startedSessionIds,
        polled_session_ids: input.codingAgentSessionObservation.polledSessionIds,
        logged_session_ids: input.codingAgentSessionObservation.loggedSessionIds,
        running_session_ids: input.codingAgentSessionObservation.runningSessionIds,
        completed_session_ids: input.codingAgentSessionObservation.completedSessionIds,
        failed_session_ids: input.codingAgentSessionObservation.failedSessionIds,
        has_terminal: input.codingAgentSessionObservation.hasTerminal,
        has_running_only: input.codingAgentSessionObservation.hasRunningOnly,
        warmup_likely: input.codingAgentSessionObservation.warmupLikely,
        poll_count: input.codingAgentSessionObservation.pollCount,
        observation_window_ms: input.codingAgentSessionObservation.observationWindowMs
      },
      ...claimsCoverage
    }
  }
}

export function prepareNativeTurnPlanProgress(session: any, input: any) {
  const projectedPlanUpdate = input.plannerCheckpointDue ? input.outcomeProjectUpdate : undefined
  const projectedPlanIds = new Set<string>(input.currentBoard.map((item: any) => item.id))
  if (input.plannerCheckpointDue && Array.isArray(projectedPlanUpdate?.planBoard)) {
    for (const item of projectedPlanUpdate.planBoard) {
      const id = normalizePlanId(item.id)
      if (id) projectedPlanIds.add(id)
    }
  }

  const planAttribution = session.derivePlanAttribution({
    currentBoard: input.currentBoard,
    projectedUpdate: projectedPlanUpdate,
    explicitEvidencePaths: input.explicitPlanEvidencePaths,
    workspaceWriteTouches: input.workspaceWriteTouches,
    hintedActivePlanId: input.hintedActivePlanId,
    clearedBlocked: input.clearedBlocked
  })
  const activePlanId = planAttribution.activePlanId
  const coTouchedPlanIds = dedupeStrings(
    planAttribution.coTouchedPlanIds.filter((id: string) => id && id !== activePlanId)
  )
  const planExists = activePlanId
    ? projectedPlanIds.has(activePlanId)
    : false
  let projectedPlanItem = session.resolveProjectedPlanItem(
    activePlanId,
    input.currentBoard,
    projectedPlanUpdate
  )
  let statusChange = ''
  let doneDefinitionCheck = {
    ok: true,
    reason: '',
    deliverableTouched: false,
    doneReady: false
  }
  const recomputeDoneDefinitionCheck = () => {
    statusChange = session.deriveRuntimeStatusChange({
      activePlanId,
      finalStatus: input.finalStatus,
      planItem: projectedPlanItem,
      doneReady: false
    })
    doneDefinitionCheck = session.validatePlanProgressAgainstDoneDefinition({
      status: input.finalStatus,
      activePlanId,
      statusChange,
      explicitEvidencePaths: input.planEvidencePaths,
      cumulativeEvidencePaths: dedupeStrings([...(projectedPlanItem?.evidencePaths ?? []), ...input.planEvidencePaths]),
      planItem: projectedPlanItem,
      workspaceWriteTouches: input.workspaceWriteTouches
    })
    if (input.finalStatus === 'success' && doneDefinitionCheck.ok && doneDefinitionCheck.doneReady) {
      statusChange = session.deriveRuntimeStatusChange({
        activePlanId,
        finalStatus: input.finalStatus,
        planItem: projectedPlanItem,
        doneReady: true
      })
      doneDefinitionCheck = session.validatePlanProgressAgainstDoneDefinition({
        status: input.finalStatus,
        activePlanId,
        statusChange,
        explicitEvidencePaths: input.planEvidencePaths,
        cumulativeEvidencePaths: dedupeStrings([...(projectedPlanItem?.evidencePaths ?? []), ...input.planEvidencePaths]),
        planItem: projectedPlanItem,
        workspaceWriteTouches: input.workspaceWriteTouches
      })
    }
  }
  recomputeDoneDefinitionCheck()

  let microCheckpointApplied = false
  let microCheckpointDeliverable = ''
  if (input.finalStatus === 'success' && activePlanId && projectedPlanItem && !doneDefinitionCheck.deliverableTouched && !input.clearedBlocked) {
    const deliverableCandidates = session.inferDeliverableCandidatesForMicroCheckpoint({
      workspaceWriteTouches: input.workspaceWriteTouches,
      businessArtifactEvidencePaths: input.businessArtifactEvidencePaths,
      planEvidencePaths: input.planEvidencePaths
    })
    const inferredDeliverable = deliverableCandidates[0] || ''
    if (inferredDeliverable) {
      const alignedDoneDefinition = session.alignDoneDefinitionDeliverable(
        projectedPlanItem.doneDefinition ?? [],
        inferredDeliverable
      )
      const before = JSON.stringify(projectedPlanItem.doneDefinition ?? [])
      const after = JSON.stringify(alignedDoneDefinition)
      if (before !== after) {
        projectedPlanItem = {
          ...projectedPlanItem,
          doneDefinition: alignedDoneDefinition
        }
        microCheckpointApplied = true
        microCheckpointDeliverable = inferredDeliverable
        recomputeDoneDefinitionCheck()
      }
    }
  }

  const coTouchedDeliverablePlanIds = dedupeStrings(
    coTouchedPlanIds.filter((coPlanId: string) => {
      const coPlanItem = session.resolveProjectedPlanItem(
        coPlanId,
        input.currentBoard,
        projectedPlanUpdate
      )
      if (!coPlanItem) return false
      const doneDefinition = (coPlanItem.doneDefinition ?? [])
        .map((line: string) => line.trim())
        .filter(Boolean)
      if (doneDefinition.length === 0) return false
      const parsedRules = session.parseDoneDefinitionRules(doneDefinition)
      if (parsedRules.invalidRows.length > 0 || parsedRules.deliverables.length === 0) return false
      const touched = session.collectTouchedDeliverables(
        input.planEvidencePaths,
        parsedRules.deliverables,
        input.workspaceWriteTouches
      )
      return touched.length > 0
    })
  )

  let deltaText = session.deriveRuntimeDelta({
    actionLabel: input.hintedDeltaText || input.primaryAction,
    businessArtifacts: input.businessArtifactEvidencePaths,
    workspaceWriteTouches: input.workspaceChangedFiles,
    deliverablesTouched: planAttribution.deliverablesTouched,
    clearedBlocked: input.clearedBlocked,
    failureRecorded: input.failureRecorded
  })
  if (input.hintedDeltaText && !planAttribution.deliverablesTouched.length) {
    deltaText = input.hintedDeltaText
  }

  return {
    projectedPlanUpdate,
    planAttribution,
    activePlanId,
    coTouchedPlanIds,
    planExists,
    projectedPlanItem,
    statusChange,
    doneDefinitionCheck,
    microCheckpointApplied,
    microCheckpointDeliverable,
    coTouchedDeliverablePlanIds,
    deltaText
  }
}

export async function applyNativeTurnStatusGuards(session: any, input: any): Promise<any> {
  let finalStatus = input.finalStatus
  let summary = input.summary
  let blockedReason: string | null = null
  let doneDefinitionCheck = { ...input.doneDefinitionCheck }
  const deltaReasons = [...input.deltaReasons]
  let statusChange = input.statusChange
  let failureEntry = input.failureEntry

  if (finalStatus === 'success' && input.planAttributionAmbiguous) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: multiple plan deliverables touched in one turn. ${summary}`
    blockedReason = 'multiple_plan_deliverables_touched'
  }
  if (finalStatus === 'success' && !input.activePlanId) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: missing active_plan_id. ${summary}`
    blockedReason = 'missing_active_plan_id'
  }
  if (finalStatus === 'success' && !input.planExists) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: unknown active_plan_id (${input.activePlanId}). ${summary}`
    blockedReason = 'unknown_active_plan_id'
  }
  if (finalStatus === 'success' && !doneDefinitionCheck.ok && input.coTouchedDeliverablePlanIds.length === 0) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: ${doneDefinitionCheck.reason}. ${summary}`
    blockedReason = doneDefinitionCheck.reason
  }
  const hasAnyPlanDeliverableTouch = doneDefinitionCheck.deliverableTouched || input.coTouchedDeliverablePlanIds.length > 0
  if (finalStatus === 'success' && !hasAnyPlanDeliverableTouch && !input.clearedBlocked) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: missing_plan_deliverable_touch. ${summary}`
    blockedReason = 'missing_plan_deliverable_touch'
  }
  if (finalStatus === 'success' && input.repoCodeTouch.touched && !input.codingLargeRepoUsage.usedCodeEditWorkflow) {
    finalStatus = 'no_delta'
    const scriptHint = input.codingLargeRepoUsage.used
      ? `observed coding-large-repo/${input.codingLargeRepoUsage.script || 'unknown'} (code edits require delegate-coding-agent or agent-start)`
      : 'coding-large-repo workflow missing'
    summary = `NO_DELTA: repo_code_edit_without_coding_large_repo (${input.repoCodeTouch.path}). ${scriptHint}. ${summary}`
    blockedReason = 'repo_code_edit_without_coding_large_repo'
  }
  if (finalStatus === 'success' && input.openaiScriptIssue) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: openai_script_compat_issue (${input.openaiScriptIssue.reason} at ${input.openaiScriptIssue.path}). ${summary}`
    blockedReason = 'openai_script_compat_issue'
  }
  const onlyRunArtifactsTouched = input.workspaceWriteTouches.length > 0
    && input.workspaceWriteTouches.every((entry: string) => session.normalizeProjectPathPointer(entry).startsWith('runs/'))
  if (
    finalStatus === 'success'
    && input.codingLargeRepoUsage.used
    && input.codingAgentSessionObservation.observed
    && input.codingAgentSessionObservation.hasRunningOnly
    && !input.codingAgentSessionObservation.hasTerminal
    && !input.repoCodeTouch.touched
    && onlyRunArtifactsTouched
    && !input.clearedBlocked
  ) {
    const sessionLabel = input.codingAgentSessionObservation.sessionIds.slice(0, 2).join(', ') || 'coding-agent-session'
    if (input.codingAgentSessionObservation.warmupLikely) {
      finalStatus = 'no_delta'
      blockedReason = 'delegate_session_in_warmup'
      summary = `NO_DELTA: delegate_session_in_warmup (${sessionLabel}). ${summary}`
    } else {
      finalStatus = 'no_delta'
      blockedReason = 'delegate_session_in_flight'
      summary = `NO_DELTA: delegate_session_in_flight (${sessionLabel}). ${summary}`
    }
    if (!deltaReasons.includes('delegate_session_in_flight')) {
      deltaReasons.push('delegate_session_in_flight')
    }
  }
  if (finalStatus === 'success' && deltaReasons.length === 0) {
    finalStatus = 'no_delta'
    summary = `NO_DELTA: ${summary}`
    blockedReason = 'no_delta'
  }

  if (finalStatus === 'no_delta' && blockedReason === 'missing_plan_deliverable_touch') {
    const semanticHardViolations = session.collectSemanticHardViolations({
      blockedReason,
      toolEvents: input.toolEvents
    })
    const hasHardViolations = semanticHardViolations.length > 0
    const hasConcreteWorkEvidence = (
      input.changedFiles.length > 0
      || Boolean(input.patchPath)
      || input.businessArtifactEvidencePaths.length > 0
      || input.bashHasAnyOutputOnSuccess
    )
    input.semanticGateAudit.eligible = hasConcreteWorkEvidence && !hasHardViolations
    if (!input.semanticGateAudit.eligible && hasHardViolations) {
      input.semanticGateAudit.reject_reason = `hard_violation:${semanticHardViolations[0]}`
    }

    if (input.semanticGateConfig.enabled && input.semanticGateAudit.eligible) {
      const semanticInput = session.buildSemanticGateInput({
        turnNumber: input.turnNumber,
        activePlanId: input.activePlanId,
        finalStatus,
        blockedReason,
        planItem: input.projectedPlanItem,
        planEvidencePaths: input.planEvidencePaths,
        businessArtifactEvidencePaths: input.businessArtifactEvidencePaths,
        workspaceWriteTouches: input.workspaceWriteTouches,
        changedFiles: input.changedFiles,
        patchPath: input.patchPath,
        exitCode: input.exitCode,
        hardViolations: semanticHardViolations,
        codingLargeRepoRequired: input.repoCodeTouch.touched,
        maxInputChars: input.semanticGateConfig.maxInputChars
      })
      input.semanticGateAudit.input_hash = semanticInput.inputHash
      input.semanticGateAudit.invoked = true

      let semanticRaw: unknown
      try {
        if (session.config.semanticGateEvaluator) {
          semanticRaw = await session.config.semanticGateEvaluator(semanticInput.payload)
        } else {
          semanticRaw = {
            schema: 'yolo.semantic_gate.output.v1',
            verdict: 'abstain',
            confidence: 0,
            notes: 'semanticGateEvaluator not configured'
          }
        }
      } catch (error) {
        semanticRaw = {
          schema: 'yolo.semantic_gate.output.v1',
          verdict: 'abstain',
          confidence: 0,
          notes: `semantic evaluator error: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      const semanticOutput = session.normalizeSemanticGateOutput(semanticRaw)
      input.semanticGateAudit.output = semanticOutput
      const evidenceRefValidation = await session.validateSemanticGateEvidenceRefs({
        turnNumber: input.turnNumber,
        output: semanticOutput
      })

      const activeRules = session.parseDoneDefinitionRules(input.projectedPlanItem?.doneDefinition ?? [])
      const activeDeliverables = new Set(activeRules.deliverables)
      const touchedDeliverables = dedupeStrings(
        (semanticOutput.touched_deliverables ?? [])
          .map((item: any) => session.normalizeDeliverableTarget(item.id).value)
          .filter(Boolean)
      )
      const hasDeliverableIntersection = touchedDeliverables.some((item) => activeDeliverables.has(item))

      if (!evidenceRefValidation.ok) {
        input.semanticGateAudit.reject_reason = evidenceRefValidation.reason
      } else if (semanticOutput.verdict !== 'touched') {
        input.semanticGateAudit.reject_reason = `verdict_${semanticOutput.verdict}`
      } else if (semanticOutput.confidence < input.semanticGateConfig.confidenceThreshold) {
        input.semanticGateAudit.reject_reason = `confidence_below_threshold:${input.semanticGateConfig.confidenceThreshold}`
      } else if (!hasDeliverableIntersection) {
        input.semanticGateAudit.reject_reason = 'deliverable_intersection_miss'
      } else if (input.semanticGateConfig.mode === 'enforce_touch_only') {
        input.semanticGateAudit.accepted = true
        doneDefinitionCheck = {
          ...doneDefinitionCheck,
          deliverableTouched: true
        }
        if (!deltaReasons.includes('plan_deliverable_touched')) {
          deltaReasons.push('plan_deliverable_touched')
        }
        if (!deltaReasons.includes('semantic_plan_deliverable_touched')) {
          deltaReasons.push('semantic_plan_deliverable_touched')
        }

        finalStatus = 'success'
        blockedReason = null
        summary = summary.replace(/^NO_DELTA:\s*missing_plan_deliverable_touch\.?\s*/i, '').trim()
        if (!summary) {
          summary = 'Semantic gate confirmed deliverable touch from this turn evidence.'
        }
        statusChange = session.deriveRuntimeStatusChange({
          activePlanId: input.activePlanId,
          finalStatus,
          planItem: input.projectedPlanItem,
          doneReady: doneDefinitionCheck.doneReady
        })
      } else {
        input.semanticGateAudit.reject_reason = input.semanticGateConfig.mode === 'shadow'
          ? 'shadow_mode'
          : `unsupported_mode:${input.semanticGateConfig.mode}`
      }
    }
  }

  if (finalStatus === 'no_delta' && !input.governanceOnlyTurn && (input.doneFingerprintHit || input.priorFingerprintCount > 0)) {
    const redundant = await session.failureStore.recordRedundancyBlocked({
      fingerprint: input.actionFingerprint,
      errorLine: 'Repeated action fingerprint produced NO_DELTA.',
      evidencePath: session.toEvidencePath(input.resultPath)
    })
    failureEntry = redundant
    finalStatus = 'blocked'
    blockedReason = 'redundant_no_delta'
    summary = `Redundant action blocked: ${input.actionFingerprint}`
    if (!deltaReasons.includes('redundancy_blocked')) {
      deltaReasons.push('redundancy_blocked')
    }
  }

  return {
    finalStatus,
    summary,
    blockedReason,
    doneDefinitionCheck,
    deltaReasons,
    statusChange,
    failureEntry
  }
}
