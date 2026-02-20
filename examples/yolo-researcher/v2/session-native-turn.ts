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

function isNorthStarVerifyEvidencePath(rawPath: string): boolean {
  const normalized = rawPath.trim().replace(/\\/g, '/').toLowerCase()
  if (!normalized) return false
  const base = normalized.split('/').pop() || normalized
  return (
    /^northstar[._-]?verify([._-].+)?\.(txt|log|md|json)$/i.test(base)
    || normalized.includes('/northstar.verify.')
    || normalized.includes('/northstar-verify.')
  )
}

function hasWorkspaceDeltaOutsideRuns(session: any, paths: string[]): boolean {
  if (!Array.isArray(paths) || paths.length === 0) return false
  return paths.some((entry) => {
    const normalized = session.normalizeProjectPathPointer(String(entry || ''))
    return Boolean(normalized) && !normalized.startsWith('runs/')
  })
}

function isArtifactGravityMode(mode: string): boolean {
  return mode === 'artifact_gravity_v3_paper'
}

function isPaperMode(mode: string): boolean {
  return mode === 'artifact_gravity_v3_paper'
}

type NorthStarSemanticVerdict = 'advance_confirmed' | 'advance_weak' | 'no_progress' | 'regress' | 'abstain'

function isNorthStarSemanticVerdict(value: string): value is NorthStarSemanticVerdict {
  return (
    value === 'advance_confirmed'
    || value === 'advance_weak'
    || value === 'no_progress'
    || value === 'regress'
    || value === 'abstain'
  )
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
    orchestrationMode: 'artifact_gravity_v3_paper'
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
  const planGateEnforced = !isArtifactGravityMode(input.orchestrationMode)

  // In pure v3 artifact-gravity mode, plan board is background only.
  if (!planGateEnforced) {
    return {
      turnStatus,
      summary,
      blockedReason,
      planDeltaApplied: false,
      planDeltaWarning: '',
      coPlanStatusChanges: [],
      coPlanWarnings: []
    }
  }

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
    if (!planDeltaApplied && turnStatus === 'success' && planGateEnforced) {
      turnStatus = 'no_delta'
      blockedReason = blockedReason || 'plan_delta_not_applied'
      summary = `NO_DELTA: ${planDeltaWarning || 'plan delta not applied'}. ${summary}`
    }
  }

  if (planGateEnforced && turnStatus === 'success' && planDeltaApplied && input.coTouchedPlanIds.length > 0) {
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
  const plannerCheckpointRejections: string[] = []
  const artifactGravityMode = isArtifactGravityMode(input.orchestrationMode)
  let sanitizedOutcomeProjectUpdate = input.outcomeProjectUpdate

  const updateSummaryLines = [
    ...input.preflightNotes.map((line: string) => line.trim()).filter(Boolean),
    ...input.outcomeUpdateSummary.map((line: string) => line.trim()).filter(Boolean)
  ]
  if (artifactGravityMode && sanitizedOutcomeProjectUpdate) {
    const nextUpdate: Record<string, unknown> = { ...sanitizedOutcomeProjectUpdate }
    const rejectedFields: string[] = []
    if (Array.isArray(nextUpdate.planBoard)) {
      delete nextUpdate.planBoard
      rejectedFields.push('planBoard')
    }
    if (Array.isArray(nextUpdate.currentPlan)) {
      delete nextUpdate.currentPlan
      rejectedFields.push('currentPlan')
    }
    if (rejectedFields.length > 0) {
      plannerCheckpointRejections.push('v3_plan_fields_ignored')
      updateSummaryLines.push(`V3 guard: ignored model projectUpdate fields (${rejectedFields.join(', ')}).`)
    }
    sanitizedOutcomeProjectUpdate = Object.keys(nextUpdate).length > 0
      ? nextUpdate as ProjectUpdate
      : undefined
  } else if (!input.plannerCheckpointDue && sanitizedOutcomeProjectUpdate) {
    if (Array.isArray(sanitizedOutcomeProjectUpdate.planBoard)) {
      plannerCheckpointRejections.push('plan_board_update_outside_checkpoint')
    }
    if (Array.isArray(sanitizedOutcomeProjectUpdate.currentPlan)) {
      plannerCheckpointRejections.push('current_plan_rewrite_outside_checkpoint')
    }
    if (plannerCheckpointRejections.length > 0) {
      updateSummaryLines.push(`Planner checkpoint guard rejected: ${plannerCheckpointRejections.join(', ')}`)
    }
  }
  if (!artifactGravityMode) {
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
  }
  if (input.missingOutcomeEvidencePaths.length > 0) {
    const preview = input.missingOutcomeEvidencePaths[0]
    updateSummaryLines.push(`Ignored ${input.missingOutcomeEvidencePaths.length} missing outcome evidence path(s); first=${preview}`)
  }
  if (input.northStarSemanticGateAudit?.enabled) {
    const semanticState = input.northStarSemanticGateAudit.invoked
      ? (input.northStarSemanticGateAudit.effective_verdict || input.northStarSemanticGateAudit.derived_verdict || 'invoked')
      : (input.northStarSemanticGateAudit.reject_reason || 'not_invoked')
    updateSummaryLines.push(`NorthStar semantic gate (${input.northStarSemanticGateAudit.mode}): ${semanticState}`)
  }
  if (input.codingAgentSessionObservation.observed && input.codingAgentSessionObservation.hasRunningOnly) {
    const stateLabel = input.codingAgentSessionObservation.warmupLikely ? 'warmup' : 'running'
    updateSummaryLines.push(`Coding-agent session: ${stateLabel} (polls=${input.codingAgentSessionObservation.pollCount}).`)
  }
  if (artifactGravityMode) {
    const northStarStatus = input.northStarEvaluation?.gateSatisfied
      ? 'satisfied'
      : (input.northStarEvaluation?.reason || 'unsatisfied')
    updateSummaryLines.push(`NorthStar gate: ${northStarStatus}`)
    if (typeof input.northStarEvaluation?.realityCheckExecutedCount === 'number') {
      updateSummaryLines.push(
        `RealityCheck: executed=${input.northStarEvaluation.realityCheckExecutedCount},`
        + ` passed=${input.northStarEvaluation.realityCheckSucceededCount || 0},`
        + ` gate=${input.northStarEvaluation.realityCheckGateSatisfied ? 'pass' : 'fail'}`
      )
    }
    if (typeof input.northStarEvaluation?.externalCheckExecutedCount === 'number') {
      updateSummaryLines.push(
        `ExternalCheck: executed=${input.northStarEvaluation.externalCheckExecutedCount},`
        + ` passed=${input.northStarEvaluation.externalCheckSucceededCount || 0},`
        + ` due=${input.northStarEvaluation.externalCheckDueThisTurn ? 'yes' : 'no'},`
        + ` quota=${input.northStarEvaluation.externalCheckQuotaSatisfied ? 'pass' : 'fail'}`
      )
    }
    if (typeof input.northStarEvaluation?.scoreboardReady === 'boolean') {
      updateSummaryLines.push(
        `Scoreboard: ready=${input.northStarEvaluation.scoreboardReady ? 'yes' : 'no'},`
        + ` improved=${input.northStarEvaluation.scoreboardImproved ? 'yes' : 'no'},`
        + ` regressed=${input.northStarEvaluation.scoreboardRegressed ? 'yes' : 'no'}`
      )
    }
    if (input.northStarEvaluation?.verifiedGrowthContentProofRequired) {
      updateSummaryLines.push(
        `VerifiedGrowthProof: required=yes,`
        + ` delta=${input.northStarEvaluation.verifiedGrowthTotalDelta || 0},`
        + ` matched=${input.northStarEvaluation.verifiedGrowthMatchedDelta || 0},`
        + ` satisfied=${input.northStarEvaluation.verifiedGrowthContentProofSatisfied ? 'yes' : 'no'}`
      )
    }
    if (Array.isArray(input.northStarEvaluation?.policyViolations) && input.northStarEvaluation.policyViolations.length > 0) {
      updateSummaryLines.push(`NorthStar policy violations: ${input.northStarEvaluation.policyViolations.join(', ')}`)
    }
    if (input.northStarEvaluation?.pivotRollbackApplied) {
      updateSummaryLines.push(`NorthStar pivot rollback applied (${input.northStarEvaluation.pivotRollbackViolation || 'policy_violation'}).`)
    }
    if (input.northStarEvaluation?.pivotAllowed) {
      updateSummaryLines.push(
        `NorthStar pivot allowed: no_delta_streak=${input.northStarEvaluation.noDeltaStreak}`
        + `, realitycheck_no_exec_streak=${input.northStarEvaluation.realityCheckNoExecStreak || 0}`
      )
    }
  }

  let projectUpdated = await applyOutcomeProjectUpdate(session, {
    projectUpdate: sanitizedOutcomeProjectUpdate,
    plannerCheckpointDue: input.plannerCheckpointDue,
    evidenceRefMap: input.evidenceRefMap,
    fallbackEvidencePath: session.toEvidencePath(input.resultPath),
    toolEvents: input.toolEvents,
    artifactsDir: input.artifactsDir,
    updateSummaryLines
  })

  if (!artifactGravityMode && input.microCheckpointApplied && input.activePlanId && input.projectedPlanItem) {
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
    orchestrationMode: input.orchestrationMode,
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
    if (!artifactGravityMode) {
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
    plannerCheckpointRejections,
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
  const artifactGravityMode = isArtifactGravityMode(input.orchestrationMode)
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
  const planBoardHash = artifactGravityMode
    ? null
    : session.computePlanBoardFingerprint(input.persistedProject)
  const runtimeVersion = await session.resolveRuntimeVersionInfo()

  return {
    stageStatus,
    resultPayload: {
      status: input.finalStatus,
      intent: input.intent,
      summary: input.summary,
      primary_action: input.primaryAction,
      active_plan_id: artifactGravityMode ? null : (input.activePlanId || null),
      status_change: artifactGravityMode ? null : (input.statusChange || null),
      delta: input.deltaText || null,
      evidence_paths: input.uniqueEvidencePaths,
      evidence_refs: input.evidenceRefMap,
      plan_evidence_paths: artifactGravityMode ? [] : input.planEvidencePaths,
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
      planner_checkpoint_due: artifactGravityMode ? false : (input.plannerCheckpoint?.due ?? false),
      planner_checkpoint_reasons: artifactGravityMode ? [] : (input.plannerCheckpoint?.reasons ?? []),
      planner_checkpoint_rejections: input.plannerCheckpointRejections ?? [],
      plan_board_hash: planBoardHash,
      runtime_version: runtimeVersion,
      repo_target_policy: {
        require_repo_target: Boolean(input.requireRepoTarget)
      },
      artifact_uri_preferred: Boolean(input.artifactUriPreferred),
      orchestration_mode: input.orchestrationMode || 'artifact_gravity_v3_paper',
      northstar: {
        enabled: Boolean(input.northStarEvaluation?.enabled),
        objective_id: input.northStarEvaluation?.objectiveId || null,
        objective_version: Number(input.northStarEvaluation?.objectiveVersion || 1),
        contract_path: input.northStarEvaluation?.contractPath || null,
        artifact_gate: input.northStarEvaluation?.artifactGate || 'any',
        artifact_paths: Array.isArray(input.northStarEvaluation?.artifactPaths)
          ? input.northStarEvaluation.artifactPaths
          : [],
        internal_check_gate: input.northStarEvaluation?.internalCheckGate || 'any',
        internal_check_commands: Array.isArray(input.northStarEvaluation?.internalCheckCommands)
          ? input.northStarEvaluation.internalCheckCommands
          : [],
        internal_check_executed_commands: Array.isArray(input.northStarEvaluation?.internalCheckExecutedCommands)
          ? input.northStarEvaluation.internalCheckExecutedCommands
          : [],
        internal_check_succeeded_commands: Array.isArray(input.northStarEvaluation?.internalCheckSucceededCommands)
          ? input.northStarEvaluation.internalCheckSucceededCommands
          : [],
        internal_check_executed_count: Number(input.northStarEvaluation?.internalCheckExecutedCount || 0),
        internal_check_succeeded_count: Number(input.northStarEvaluation?.internalCheckSucceededCount || 0),
        internal_check_gate_satisfied: Boolean(input.northStarEvaluation?.internalCheckGateSatisfied),
        external_check_gate: input.northStarEvaluation?.externalCheckGate || 'any',
        external_check_commands: Array.isArray(input.northStarEvaluation?.externalCheckCommands)
          ? input.northStarEvaluation.externalCheckCommands
          : [],
        external_check_executed_commands: Array.isArray(input.northStarEvaluation?.externalCheckExecutedCommands)
          ? input.northStarEvaluation.externalCheckExecutedCommands
          : [],
        external_check_succeeded_commands: Array.isArray(input.northStarEvaluation?.externalCheckSucceededCommands)
          ? input.northStarEvaluation.externalCheckSucceededCommands
          : [],
        external_check_executed_count: Number(input.northStarEvaluation?.externalCheckExecutedCount || 0),
        external_check_succeeded_count: Number(input.northStarEvaluation?.externalCheckSucceededCount || 0),
        external_check_gate_satisfied: Boolean(input.northStarEvaluation?.externalCheckGateSatisfied),
        external_check_credit_granted: Boolean(input.northStarEvaluation?.externalCheckCreditGranted),
        external_check_candidate_artifact_paths: Array.isArray(input.northStarEvaluation?.externalCheckCandidateArtifactPaths)
          ? input.northStarEvaluation.externalCheckCandidateArtifactPaths
          : [],
        external_check_meaningful_artifact_paths: Array.isArray(input.northStarEvaluation?.externalCheckMeaningfulArtifactPaths)
          ? input.northStarEvaluation.externalCheckMeaningfulArtifactPaths
          : [],
        external_check_meaningful_artifact_count: Number(input.northStarEvaluation?.externalCheckMeaningfulArtifactPaths?.length || 0),
        external_check_volatile_only_artifact_paths: Array.isArray(input.northStarEvaluation?.externalCheckVolatileOnlyArtifactPaths)
          ? input.northStarEvaluation.externalCheckVolatileOnlyArtifactPaths
          : [],
        external_check_unchanged_artifact_paths: Array.isArray(input.northStarEvaluation?.externalCheckUnchangedArtifactPaths)
          ? input.northStarEvaluation.externalCheckUnchangedArtifactPaths
          : [],
        external_check_require_every: Number(input.northStarEvaluation?.externalCheckRequireEvery || 0),
        external_check_due_this_turn: Boolean(input.northStarEvaluation?.externalCheckDueThisTurn),
        external_check_quota_satisfied: Boolean(input.northStarEvaluation?.externalCheckQuotaSatisfied),
        external_check_no_success_streak: Number(input.northStarEvaluation?.externalCheckNoSuccessStreak || 0),
        scoreboard_metric_paths: Array.isArray(input.northStarEvaluation?.scoreboardMetricPaths)
          ? input.northStarEvaluation.scoreboardMetricPaths
          : [],
        scoreboard_metric_paths_valid: Boolean(input.northStarEvaluation?.scoreboardMetricPathsValid),
        scoreboard_values: input.northStarEvaluation?.scoreboardValues || {},
        scoreboard_previous_values: input.northStarEvaluation?.scoreboardPreviousValues || {},
        scoreboard_ready: Boolean(input.northStarEvaluation?.scoreboardReady),
        scoreboard_improved: Boolean(input.northStarEvaluation?.scoreboardImproved),
        scoreboard_regressed: Boolean(input.northStarEvaluation?.scoreboardRegressed),
        scoreboard_changed_keys: Array.isArray(input.northStarEvaluation?.scoreboardChangedKeys)
          ? input.northStarEvaluation.scoreboardChangedKeys
          : [],
        scoreboard_improved_keys: Array.isArray(input.northStarEvaluation?.scoreboardImprovedKeys)
          ? input.northStarEvaluation.scoreboardImprovedKeys
          : [],
        scoreboard_regressed_keys: Array.isArray(input.northStarEvaluation?.scoreboardRegressedKeys)
          ? input.northStarEvaluation.scoreboardRegressedKeys
          : [],
        verified_growth_keys: Array.isArray(input.northStarEvaluation?.verifiedGrowthKeys)
          ? input.northStarEvaluation.verifiedGrowthKeys
          : [],
        verified_growth_total_delta: Number(input.northStarEvaluation?.verifiedGrowthTotalDelta || 0),
        verified_growth_content_proof_required: Boolean(input.northStarEvaluation?.verifiedGrowthContentProofRequired),
        verified_growth_content_proof_satisfied: Boolean(input.northStarEvaluation?.verifiedGrowthContentProofSatisfied),
        verified_growth_content_proof_paths: Array.isArray(input.northStarEvaluation?.verifiedGrowthContentProofPaths)
          ? input.northStarEvaluation.verifiedGrowthContentProofPaths
          : [],
        verified_growth_matched_delta: Number(input.northStarEvaluation?.verifiedGrowthMatchedDelta || 0),
        verified_growth_missing_proof_reason: input.northStarEvaluation?.verifiedGrowthMissingProofReason || null,
        content_delta_proofs: Array.isArray(input.northStarEvaluation?.contentDeltaProofs)
          ? input.northStarEvaluation.contentDeltaProofs.map((proof: any) => ({
            path: proof.path,
            before_hash: proof.beforeHash || '',
            after_hash: proof.afterHash || '',
            before_semantic_hash: proof.beforeSemanticHash || '',
            after_semantic_hash: proof.afterSemanticHash || '',
            before_stable_semantic_hash: proof.beforeStableSemanticHash || '',
            after_stable_semantic_hash: proof.afterStableSemanticHash || '',
            before_content_kind: proof.beforeContentKind || 'missing',
            after_content_kind: proof.afterContentKind || 'missing',
            structured_diff: {
              significant_bytes_delta: Number(proof?.structuredDiff?.significantBytesDelta || 0),
              line_count_delta: Number(proof?.structuredDiff?.lineCountDelta || 0),
              non_empty_line_delta: Number(proof?.structuredDiff?.nonEmptyLineDelta || 0),
              csv_row_delta: Number(proof?.structuredDiff?.csvRowDelta || 0),
              csv_column_delta: Number(proof?.structuredDiff?.csvColumnDelta || 0),
              claims_status_delta: (proof?.structuredDiff?.claimsStatusDelta && typeof proof.structuredDiff.claimsStatusDelta === 'object')
                ? proof.structuredDiff.claimsStatusDelta
                : {},
              claims_status_column_present: Boolean(proof?.structuredDiff?.claimsStatusColumnPresent),
              changed_fields: Array.isArray(proof?.structuredDiff?.changedFields)
                ? proof.structuredDiff.changedFields
                : []
            }
          }))
          : [],
        reality_check_gate: input.northStarEvaluation?.realityCheckGate || 'any',
        reality_check_commands: Array.isArray(input.northStarEvaluation?.realityCheckCommands)
          ? input.northStarEvaluation.realityCheckCommands
          : [],
        reality_check_executed_commands: Array.isArray(input.northStarEvaluation?.realityCheckExecutedCommands)
          ? input.northStarEvaluation.realityCheckExecutedCommands
          : [],
        reality_check_succeeded_commands: Array.isArray(input.northStarEvaluation?.realityCheckSucceededCommands)
          ? input.northStarEvaluation.realityCheckSucceededCommands
          : [],
        reality_check_executed_count: Number(input.northStarEvaluation?.realityCheckExecutedCount || 0),
        reality_check_succeeded_count: Number(input.northStarEvaluation?.realityCheckSucceededCount || 0),
        reality_check_gate_satisfied: Boolean(input.northStarEvaluation?.realityCheckGateSatisfied),
        previous_gate_satisfied: typeof input.northStarEvaluation?.previousGateSatisfied === 'boolean'
          ? input.northStarEvaluation.previousGateSatisfied
          : null,
        reality_check_no_exec_streak: Number(input.northStarEvaluation?.realityCheckNoExecStreak || 0),
        anti_churn_triggered: Boolean(input.northStarEvaluation?.antiChurnTriggered),
        artifact_changed: Boolean(input.northStarEvaluation?.artifactChanged),
        changed_artifacts: Array.isArray(input.northStarEvaluation?.changedArtifacts)
          ? input.northStarEvaluation.changedArtifacts
          : [],
        verify_cmd: input.northStarEvaluation?.verifyCmd || null,
        verify_executed: Boolean(input.northStarEvaluation?.verifyExecuted),
        verify_succeeded: Boolean(input.northStarEvaluation?.verifySucceeded),
        gate_satisfied: Boolean(input.northStarEvaluation?.gateSatisfied),
        reason: input.northStarEvaluation?.reason || null,
        policy_violations: Array.isArray(input.northStarEvaluation?.policyViolations)
          ? input.northStarEvaluation.policyViolations
          : [],
        no_delta_streak: Number(input.northStarEvaluation?.noDeltaStreak || 0),
        pivot_allowed: Boolean(input.northStarEvaluation?.pivotAllowed),
        pivot_rollback_applied: Boolean(input.northStarEvaluation?.pivotRollbackApplied),
        pivot_rollback_violation: input.northStarEvaluation?.pivotRollbackViolation || null
      },
      northstar_semantic_gate: {
        enabled: Boolean(input.northStarSemanticGateAudit?.enabled),
        mode: input.northStarSemanticGateAudit?.mode || 'off',
        eligible: Boolean(input.northStarSemanticGateAudit?.eligible),
        invoked: Boolean(input.northStarSemanticGateAudit?.invoked),
        prompt_version: input.northStarSemanticGateAudit?.prompt_version || '',
        model_id: input.northStarSemanticGateAudit?.model_id || '',
        temperature: Number(input.northStarSemanticGateAudit?.temperature ?? 0),
        input_hash: input.northStarSemanticGateAudit?.input_hash || '',
        output: input.northStarSemanticGateAudit?.output ?? null,
        accepted: Boolean(input.northStarSemanticGateAudit?.accepted),
        derived_verdict: input.northStarSemanticGateAudit?.derived_verdict || null,
        effective_verdict: input.northStarSemanticGateAudit?.effective_verdict || null,
        reason_codes: Array.isArray(input.northStarSemanticGateAudit?.reason_codes)
          ? input.northStarSemanticGateAudit.reason_codes
          : [],
        required_actions: Array.isArray(input.northStarSemanticGateAudit?.required_actions)
          ? input.northStarSemanticGateAudit.required_actions
          : [],
        required_action_promotions: Array.isArray(input.northStarSemanticGateAudit?.required_action_promotions)
          ? input.northStarSemanticGateAudit.required_action_promotions
          : [],
        open_required_actions: Array.isArray(input.northStarSemanticOpenRequiredActions)
          ? input.northStarSemanticOpenRequiredActions
          : [],
        claim_audit_debt: Array.isArray(input.northStarSemanticGateAudit?.claim_audit_debt)
          ? input.northStarSemanticGateAudit.claim_audit_debt
          : [],
        low_confidence_coerced: Boolean(input.northStarSemanticGateAudit?.low_confidence_coerced),
        verdict_derivation_audit: input.northStarSemanticGateAudit?.verdict_derivation_audit || null,
        ...(input.northStarSemanticGateAudit?.status_mutation
          ? { status_mutation: input.northStarSemanticGateAudit.status_mutation }
          : {}),
        ...(input.northStarSemanticGateAudit?.reject_reason
          ? { reject_reason: input.northStarSemanticGateAudit.reject_reason }
          : {})
      },
      resolved_repo: input.resolvedRepoTarget?.repoId
        ? {
          repo_id: input.resolvedRepoTarget.repoId,
          repo_path: input.resolvedRepoTarget.repoPath,
          source: input.resolvedRepoTarget.source
        }
        : null,
      path_anchor_violation: {
        detected: Boolean(input.pathAnchorAudit?.detected),
        count: Number(input.pathAnchorAudit?.count || 0),
        samples: Array.isArray(input.pathAnchorAudit?.samples) ? input.pathAnchorAudit.samples : []
      },
      path_rewrite_events: Array.isArray(input.pathAnchorAudit?.rewriteEvents)
        ? input.pathAnchorAudit.rewriteEvents
        : [],
      path_anchor_metrics: {
        scanned_paths: Number(input.pathAnchorAudit?.scannedPaths || 0),
        nested_runs_count: Number(input.pathAnchorAudit?.nestedRunsCount || 0),
        rewritten_count: Number(input.pathAnchorAudit?.rewrittenCount || 0),
        mode: input.pathAnchorAudit?.mode || 'recover'
      },
      plan_attribution_reason: artifactGravityMode ? null : input.planAttribution.reason,
      plan_attribution_ambiguous: artifactGravityMode ? false : input.planAttribution.ambiguous,
      co_touched_plan_ids: artifactGravityMode ? [] : input.coTouchedPlanIds,
      co_touched_deliverable_plan_ids: artifactGravityMode ? [] : input.coTouchedDeliverablePlanIds,
      co_plan_status_changes: artifactGravityMode ? [] : input.coPlanStatusChanges,
      micro_checkpoint_applied: artifactGravityMode ? false : input.microCheckpointApplied,
      ...(!artifactGravityMode && input.microCheckpointDeliverable ? { micro_checkpoint_deliverable: input.microCheckpointDeliverable } : {}),
      goal_constraints_fingerprint: goalConstraintsFingerprint,
      ...(input.deterministicFingerprint ? { failure_fingerprint: input.deterministicFingerprint } : {}),
      ...(input.clearedBlocked ? { unblock_verified: true } : {}),
      ...(input.blockedReason ? { blocked_reason: input.blockedReason } : {}),
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

  if (isArtifactGravityMode(input.orchestrationMode)) {
    const planAttribution = {
      activePlanId: '',
      ambiguous: false,
      reason: 'v3_plan_logic_disabled',
      deliverablesTouched: [],
      coTouchedPlanIds: []
    }
    let deltaText = session.deriveRuntimeDelta({
      actionLabel: input.hintedDeltaText || input.primaryAction,
      businessArtifacts: input.businessArtifactEvidencePaths,
      workspaceWriteTouches: input.workspaceChangedFiles,
      deliverablesTouched: [],
      clearedBlocked: input.clearedBlocked,
      failureRecorded: input.failureRecorded
    })
    if (input.hintedDeltaText) {
      deltaText = input.hintedDeltaText
    }

    return {
      projectedPlanUpdate: undefined,
      planAttribution,
      activePlanId: '',
      coTouchedPlanIds: [],
      planExists: false,
      projectedPlanItem: null,
      statusChange: '',
      doneDefinitionCheck: {
        ok: true,
        reason: '',
        deliverableTouched: false,
        doneReady: false
      },
      microCheckpointApplied: false,
      microCheckpointDeliverable: '',
      coTouchedDeliverablePlanIds: [],
      deltaText
    }
  }

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
  let northStarSemanticOpenRequiredActions = await session.loadPreviousNorthStarSemanticOpenActions(input.turnNumber)

  if (input.forcedBlockedReason) {
    finalStatus = 'blocked'
    blockedReason = input.forcedBlockedReason
    summary = `BLOCKED: ${input.forcedBlockedReason}. ${summary}`
  }

  const artifactGravityMode = isArtifactGravityMode(input.orchestrationMode)
  const applyPlanDeterministicGates = () => {
    if (finalStatus !== 'success') return
    if (input.planAttributionAmbiguous) {
      finalStatus = 'no_delta'
      summary = `NO_DELTA: multiple plan deliverables touched in one turn. ${summary}`
      blockedReason = 'multiple_plan_deliverables_touched'
      return
    }
    if (!input.activePlanId) {
      finalStatus = 'no_delta'
      summary = `NO_DELTA: missing active_plan_id. ${summary}`
      blockedReason = 'missing_active_plan_id'
      return
    }
    if (!input.planExists) {
      finalStatus = 'no_delta'
      summary = `NO_DELTA: unknown active_plan_id (${input.activePlanId}). ${summary}`
      blockedReason = 'unknown_active_plan_id'
      return
    }
    if (!doneDefinitionCheck.ok && input.coTouchedDeliverablePlanIds.length === 0) {
      finalStatus = 'no_delta'
      summary = `NO_DELTA: ${doneDefinitionCheck.reason}. ${summary}`
      blockedReason = doneDefinitionCheck.reason
      return
    }
    const hasAnyPlanDeliverableTouch = doneDefinitionCheck.deliverableTouched || input.coTouchedDeliverablePlanIds.length > 0
    if (!hasAnyPlanDeliverableTouch && !input.clearedBlocked) {
      finalStatus = 'no_delta'
      summary = `NO_DELTA: missing_plan_deliverable_touch. ${summary}`
      blockedReason = 'missing_plan_deliverable_touch'
    }
  }

  if (artifactGravityMode) {
    if (finalStatus === 'success' || finalStatus === 'no_delta') {
      if (input.northStarEvaluation?.gateSatisfied) {
        finalStatus = 'success'
        blockedReason = null
        summary = summary.replace(/^NO_DELTA:\s*/i, '').trim() || summary
        if (input.northStarEvaluation.artifactChanged && !deltaReasons.includes('northstar_artifact_changed')) {
          deltaReasons.push('northstar_artifact_changed')
        }
        if (input.northStarEvaluation.verifySucceeded && !deltaReasons.includes('northstar_verify_succeeded')) {
          deltaReasons.push('northstar_verify_succeeded')
        }

        const verifyOnlySatisfied = Boolean(input.northStarEvaluation.verifySucceeded)
          && !Boolean(input.northStarEvaluation.artifactChanged)
        const hasSubstantiveArtifact = (input.businessArtifactEvidencePaths ?? [])
          .some((entry: string) => !isNorthStarVerifyEvidencePath(entry))
        const hasSubstantiveWorkspaceDelta = hasWorkspaceDeltaOutsideRuns(
          session,
          dedupeStrings([...(input.changedFiles ?? []), ...(input.workspaceWriteTouches ?? [])])
        ) || Boolean(input.repoCodeTouch?.touched)

        if (
          verifyOnlySatisfied
          && !hasSubstantiveArtifact
          && !hasSubstantiveWorkspaceDelta
          && !input.clearedBlocked
          && !input.failureEntry
        ) {
          finalStatus = 'no_delta'
          blockedReason = 'northstar_verify_only_no_substantive_delta'
          const normalizedSummary = summary.replace(/^NO_DELTA:\s*/i, '').trim()
          summary = `NO_DELTA: northstar_verify_only_no_substantive_delta. ${normalizedSummary || summary}`
          const filtered = deltaReasons.filter((reason) => reason !== 'northstar_verify_succeeded')
          deltaReasons.length = 0
          deltaReasons.push(...filtered)
        }
      } else {
        const reason = input.northStarEvaluation?.reason || 'northstar_no_verifiable_delta'
        const hardBlock = reason === 'northstar_repeated_no_delta_requires_pivot'
        finalStatus = hardBlock ? 'blocked' : 'no_delta'
        blockedReason = reason
        const normalizedSummary = summary.replace(/^(NO_DELTA|BLOCKED):\s*/i, '').trim()
        summary = hardBlock
          ? `BLOCKED: ${reason}. ${normalizedSummary || summary}`
          : `NO_DELTA: ${reason}. ${normalizedSummary || summary}`
      }
    }
  } else {
    applyPlanDeterministicGates()
  }

  if (isPaperMode(input.orchestrationMode)) {
    const hasNorthStarContract = Boolean(input.northStarContract)
    input.northStarSemanticGateAudit.eligible = Boolean(
      input.northStarSemanticGateConfig.enabled
      && hasNorthStarContract
      && input.northStarEvaluation?.enabled
    )

    if (!input.northStarSemanticGateAudit.eligible) {
      input.northStarSemanticGateAudit.reject_reason = hasNorthStarContract
        ? 'northstar_semantic_gate_ineligible'
        : 'missing_northstar_contract'
    }

    if (input.northStarSemanticGateConfig.enabled && input.northStarSemanticGateAudit.eligible) {
      const semanticHardViolations = session.collectSemanticHardViolations({
        blockedReason,
        toolEvents: input.toolEvents
      })

      const semanticInput = await session.buildNorthStarSemanticGateInput({
        turnNumber: input.turnNumber,
        mode: input.northStarSemanticGateConfig.mode,
        finalStatus,
        blockedReason,
        northStar: input.northStarContract,
        northStarEvaluation: input.northStarEvaluation,
        changedFiles: dedupeStrings([...(input.changedFiles ?? []), ...(input.workspaceWriteTouches ?? [])]),
        patchPath: input.patchPath,
        businessArtifactEvidencePaths: input.businessArtifactEvidencePaths,
        trustedEvidencePaths: input.trustedEvidencePaths ?? [],
        maxInputChars: input.northStarSemanticGateConfig.maxInputChars,
        resultPath: input.resultPath,
        hardViolations: semanticHardViolations
      })
      input.northStarSemanticGateAudit.input_hash = semanticInput.inputHash
      input.northStarSemanticGateAudit.invoked = true

      let semanticRaw: unknown
      try {
        if (session.config.northStarSemanticGateEvaluator) {
          semanticRaw = await session.config.northStarSemanticGateEvaluator(semanticInput.payload)
        } else {
          semanticRaw = {
            schema: 'yolo.northstar_semantic_gate.output.v1',
            confidence: 0,
            reason_codes: ['evaluator_not_configured'],
            summary: 'northStarSemanticGateEvaluator not configured',
            verdict: 'abstain'
          }
        }
      } catch (error) {
        semanticRaw = {
          schema: 'yolo.northstar_semantic_gate.output.v1',
          confidence: 0,
          reason_codes: ['evaluator_error'],
          summary: `semantic evaluator error: ${error instanceof Error ? error.message : String(error)}`,
          verdict: 'abstain'
        }
      }

      const semanticOutput = session.normalizeNorthStarSemanticGateOutput(semanticRaw)
      input.northStarSemanticGateAudit.output = semanticOutput

      const derived = session.deriveNorthStarSemanticVerdict({
        dimension_scores: semanticOutput.dimension_scores
      })
      const reasonCodes = dedupeStrings([
        ...(semanticOutput.reason_codes ?? []),
        ...semanticInput.reasonCodes,
        ...(derived.valid ? [] : ['invalid_dimension_scores'])
      ])

      const legacyVerdictRaw = typeof semanticOutput.verdict === 'string'
        ? semanticOutput.verdict.trim().toLowerCase()
        : ''
      const hasLegacyVerdict = isNorthStarSemanticVerdict(legacyVerdictRaw)
      if (hasLegacyVerdict && legacyVerdictRaw !== derived.verdict) {
        reasonCodes.push('verdict_mismatch')
      }

      let effectiveVerdict: NorthStarSemanticVerdict = derived.verdict
      if (
        effectiveVerdict !== 'abstain'
        && semanticOutput.confidence < input.northStarSemanticGateConfig.confidenceThreshold
      ) {
        effectiveVerdict = 'abstain'
        reasonCodes.push('low_confidence')
        input.northStarSemanticGateAudit.low_confidence_coerced = true
      }

      const deterministicTriggerCodes = session.collectNorthStarDeterministicTriggerCodes({
        claimQuality: semanticInput.claimQuality,
        reasonCodes,
        northStarEvaluation: input.northStarEvaluation
      })

      const actionPostProcess = session.postProcessNorthStarRequiredActions({
        turnNumber: input.turnNumber,
        actions: semanticOutput.required_actions ?? [],
        existingOpenActions: northStarSemanticOpenRequiredActions,
        deterministicTriggerCodes,
        claimQuality: semanticInput.claimQuality,
        config: input.northStarSemanticGateConfig,
        effectiveVerdict
      })
      northStarSemanticOpenRequiredActions = actionPostProcess.mergedOpenActions

      const claimAuditDebt = dedupeStrings([
        ...((semanticOutput.claim_audit?.unsupported_ids ?? []).map(String)),
        ...((semanticOutput.claim_audit?.contradicted_ids ?? []).map(String))
      ])

      input.northStarSemanticGateAudit.accepted = true
      input.northStarSemanticGateAudit.derived_verdict = derived.verdict
      input.northStarSemanticGateAudit.effective_verdict = effectiveVerdict
      input.northStarSemanticGateAudit.reason_codes = reasonCodes
      input.northStarSemanticGateAudit.required_actions = northStarSemanticOpenRequiredActions
      input.northStarSemanticGateAudit.required_action_promotions = actionPostProcess.promotions
      input.northStarSemanticGateAudit.claim_audit_debt = claimAuditDebt
      input.northStarSemanticGateAudit.verdict_derivation_audit = {
        dimension_scores: derived.normalizedScores,
        derived_verdict: derived.verdict,
        legacy_verdict: hasLegacyVerdict ? legacyVerdictRaw : null,
        legacy_verdict_ignored: true
      }

      if (input.northStarSemanticGateConfig.mode === 'enforce_downgrade_only') {
        const beforeStatus = finalStatus
        let mutationReason = 'semantic_noop_non_success'

        if (finalStatus === 'success') {
          if (effectiveVerdict === 'advance_confirmed') {
            mutationReason = 'semantic_advance_confirmed'
          } else if (effectiveVerdict === 'abstain') {
            mutationReason = input.northStarSemanticGateAudit.low_confidence_coerced
              ? 'semantic_low_confidence_abstain'
              : 'semantic_abstain_non_veto'
          } else if (effectiveVerdict === 'advance_weak' || effectiveVerdict === 'no_progress') {
            finalStatus = 'no_delta'
            blockedReason = `northstar_semantic_${effectiveVerdict}`
            mutationReason = `semantic_downgrade_${effectiveVerdict}`
            const normalizedSummary = summary.replace(/^NO_DELTA:\s*/i, '').trim()
            summary = `NO_DELTA: ${blockedReason}. ${normalizedSummary || summary}`
          } else if (effectiveVerdict === 'regress') {
            finalStatus = 'blocked'
            blockedReason = 'northstar_semantic_regress'
            mutationReason = 'semantic_downgrade_regress'
            summary = `BLOCKED: northstar_semantic_regress. ${summary}`
          }

          if (finalStatus === 'success' && actionPostProcess.blockingAction) {
            finalStatus = 'blocked'
            blockedReason = 'northstar_semantic_overdue_must_action'
            mutationReason = 'runtime_promoted_must_overdue'
            summary = `BLOCKED: northstar_semantic_overdue_must_action (${actionPostProcess.blockingAction.code}). ${summary}`
          }
        }

        input.northStarSemanticGateAudit.status_mutation = {
          from: beforeStatus,
          to: finalStatus,
          reason: mutationReason
        }
      } else if (input.northStarSemanticGateConfig.mode === 'shadow') {
        input.northStarSemanticGateAudit.status_mutation = {
          from: finalStatus,
          to: finalStatus,
          reason: 'shadow_no_mutation'
        }
      }
    }
  }

  if (!artifactGravityMode) {
    if (
      finalStatus === 'success'
      && input.repoCodeTouch.touched
      && input.requireRepoTarget
      && !input.resolvedRepoTarget?.repoId
    ) {
      finalStatus = 'no_delta'
      blockedReason = 'missing_repo_target'
      summary = `NO_DELTA: missing_repo_target for repo code touch (${input.repoCodeTouch.path}). ${summary}`
    }
    if (
      finalStatus === 'success'
      && input.repoCodeTouch.touched
      && input.requireRepoTarget
      && input.resolvedRepoTarget?.repoPath
      && input.repoCodeTouch.repo
      && input.resolvedRepoTarget.repoPath !== input.repoCodeTouch.repo
    ) {
      finalStatus = 'no_delta'
      blockedReason = 'repo_target_mismatch'
      summary = `NO_DELTA: repo_target_mismatch (target=${input.resolvedRepoTarget.repoPath}, touched=${input.repoCodeTouch.repo}). ${summary}`
    }
    if (finalStatus === 'success' && input.repoCodeTouch.touched && !input.codingLargeRepoUsage.usedCodeEditWorkflow) {
      finalStatus = 'no_delta'
      const scriptHint = input.codingLargeRepoUsage.used
        ? `observed coding-large-repo/${input.codingLargeRepoUsage.script || 'unknown'} (code edits require agent-run-to-completion)`
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
  }

  if (!artifactGravityMode && finalStatus === 'no_delta' && !input.governanceOnlyTurn && (input.doneFingerprintHit || input.priorFingerprintCount > 0)) {
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
    failureEntry,
    northStarSemanticOpenRequiredActions
  }
}
