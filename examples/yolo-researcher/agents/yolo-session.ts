import * as crypto from 'node:crypto'

import { YoloSession } from '../runtime/session.js'
import type { ActivityEvent, ReviewEngine, TurnPlanner, YoloCoordinator, YoloSessionOptions } from '../runtime/types.js'
import { createYoloCoordinator } from './coordinator.js'
import type { YoloCoordinatorConfig } from './coordinator.js'
import { createYoloPlanner } from './planner.js'
import type { YoloPlannerConfig } from './planner.js'
import { createYoloReviewEngine } from './reviewer.js'
import type { YoloReviewerConfig } from './reviewer.js'

export interface CreateYoloSessionConfig {
  projectPath: string
  goal: string
  options: YoloSessionOptions
  sessionId?: string
  onActivity?: (event: ActivityEvent) => void
  coordinator?: YoloCoordinator
  planner?: TurnPlanner
  reviewEngine?: ReviewEngine
  coordinatorConfig?: Omit<YoloCoordinatorConfig, 'projectPath' | 'model'> & {
    model?: string
  }
  plannerConfig?: Omit<YoloPlannerConfig, 'projectPath' | 'model'> & {
    model?: string
  }
  reviewerConfig?: Omit<YoloReviewerConfig, 'projectPath' | 'model'> & {
    model?: string
  }
}

export function createYoloSession(config: CreateYoloSessionConfig): YoloSession {
  const sessionId = config.sessionId ?? crypto.randomUUID()

  const coordinator = config.coordinator ?? createYoloCoordinator({
    projectPath: config.projectPath,
    model: config.coordinatorConfig?.model ?? config.options.models.coordinator,
    apiKey: config.coordinatorConfig?.apiKey,
    maxSteps: config.coordinatorConfig?.maxSteps,
    maxTokens: config.coordinatorConfig?.maxTokens,
    debug: config.coordinatorConfig?.debug,
    identityPrompt: config.coordinatorConfig?.identityPrompt,
    constraints: config.coordinatorConfig?.constraints,
    mode: config.options.mode ?? 'legacy',
    allowBash: config.coordinatorConfig?.allowBash,
    enableLiteratureTools: config.coordinatorConfig?.enableLiteratureTools,
    enableLiteratureSubagent: config.coordinatorConfig?.enableLiteratureSubagent,
    literatureSubagentMaxCallsPerTurn: config.coordinatorConfig?.literatureSubagentMaxCallsPerTurn,
    enableDataSubagent: config.coordinatorConfig?.enableDataSubagent,
    dataSubagentMaxCallsPerTurn: config.coordinatorConfig?.dataSubagentMaxCallsPerTurn,
    enableWritingSubagent: config.coordinatorConfig?.enableWritingSubagent,
    writingSubagentMaxCallsPerTurn: config.coordinatorConfig?.writingSubagentMaxCallsPerTurn,
    enableResearchSkills: config.coordinatorConfig?.enableResearchSkills,
    externalSkillsDir: config.coordinatorConfig?.externalSkillsDir,
    watchExternalSkills: config.coordinatorConfig?.watchExternalSkills,
    braveApiKey: config.coordinatorConfig?.braveApiKey,
    onActivity: config.onActivity,
    createAgentInstance: config.coordinatorConfig?.createAgentInstance
  })

  const planner = config.planner ?? createYoloPlanner({
    projectPath: config.projectPath,
    model: config.plannerConfig?.model ?? config.options.models.planner,
    apiKey: config.plannerConfig?.apiKey,
    maxSteps: config.plannerConfig?.maxSteps,
    maxTokens: config.plannerConfig?.maxTokens,
    debug: config.plannerConfig?.debug,
    identityPrompt: config.plannerConfig?.identityPrompt,
    constraints: config.plannerConfig?.constraints,
    createAgentInstance: config.plannerConfig?.createAgentInstance
  })

  const reviewEngine = config.reviewEngine ?? (
    config.options.phase === 'P3'
      ? createYoloReviewEngine({
          projectPath: config.projectPath,
          model: config.reviewerConfig?.model
            ?? config.options.models.reviewer
            ?? config.options.models.coordinator,
          apiKey: config.reviewerConfig?.apiKey,
          maxSteps: config.reviewerConfig?.maxSteps,
          maxTokens: config.reviewerConfig?.maxTokens,
          debug: config.reviewerConfig?.debug,
          identityPrompt: config.reviewerConfig?.identityPrompt,
          constraints: config.reviewerConfig?.constraints,
          onActivity: config.onActivity,
          createAgentInstance: config.reviewerConfig?.createAgentInstance
        })
      : undefined
  )

  const deps: { planner: TurnPlanner; reviewEngine?: ReviewEngine; onActivity?: (event: ActivityEvent) => void } = {
    planner,
    onActivity: config.onActivity
  }
  if (reviewEngine) deps.reviewEngine = reviewEngine

  return new YoloSession(
    config.projectPath,
    sessionId,
    config.goal,
    config.options,
    coordinator,
    deps
  )
}

export { YoloSession }
