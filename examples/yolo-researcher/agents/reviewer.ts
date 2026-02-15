import { createAgent, packs, createTokenTracker } from '../../../src/index.js'
import type { TokenTracker } from '../../../src/index.js'

import {
  ANCHORED_LABELS,
  DisabledReviewEngine,
  REVIEWER_PERSONAS_BY_STAGE,
  buildConsensusBlockers,
  buildHeuristicBlockers
} from '../runtime/review-engine.js'
import type {
  ActivityEvent,
  AgentLike,
  AnchoredHardBlockerLabel,
  CoordinatorTurnResult,
  GateResult,
  PlannerOutput,
  ReviewEngine,
  ReviewerCriticalIssue,
  ReviewerFixPlanItem,
  ReviewerPass,
  ReviewerPersona,
  ReviewerProcessReview,
  ReviewerRewritePatch,
  SemanticReviewResult,
  SnapshotManifest,
  YoloStage
} from '../runtime/types.js'
import { randomId, nowIso } from '../runtime/utils.js'

interface ReviewerJsonOutput {
  notes?: unknown
  hardBlockers?: unknown
  verdict?: unknown
  critical_issues?: unknown
  fix_plan?: unknown
  rewrite_patch?: unknown
  confidence?: unknown
  notes_for_user?: unknown
}

interface ReviewerJsonHardBlocker {
  label?: unknown
  citations?: unknown
  assetRefs?: unknown
}

export interface YoloReviewerConfig {
  projectPath: string
  model: string
  apiKey?: string
  maxSteps?: number
  maxTokens?: number
  debug?: boolean
  identityPrompt?: string
  constraints?: string[]
  onActivity?: (event: ActivityEvent) => void
  tokenTracker?: TokenTracker
  createAgentInstance?: (input: { persona: ReviewerPersona }) => AgentLike
}

const DEFAULT_IDENTITY = [
  'You are a strict but practical scientific reviewer persona.',
  'Your job is critique-to-fix, not abstract scoring.',
  'Return concrete revision actions and optional rewrite patches.',
  '',
  'Output contract — return STRICT JSON with this schema:',
  '{"verdict":"pass|revise|block","critical_issues":[{"id":string,"severity":"high|medium|low","message":string}],"fix_plan":[{"issue_id":string,"action":string}],"rewrite_patch":{"apply":boolean,"target":"planner_output|coordinator_output","patch":object},"confidence":number,"notes_for_user":string,"notes":string[],"hardBlockers":[{"label":"claim_without_direct_evidence"|"causality_gap"|"parity_violation_unresolved"|"reproducibility_gap"|"overclaim","citations":string[],"assetRefs":string[]}]}',
  '',
  'Rules:',
  '- Prefer revise over block unless missing structure makes progress impossible.',
  '- critical_issues <= 3, each with concrete fix action.',
  '- rewrite_patch should be minimal and machine-applicable.',
  '- hardBlockers optional; include only anchored labels with concrete citations.'
].join('\n')

const DEFAULT_CONSTRAINTS = [
  'Output strict JSON only.',
  'Do not invent citations.',
  'Keep critical issues <= 3.',
  'Prioritize actionable fixes over commentary.',
  'Do not use ctx-get in reviewer; critique only from provided materials.'
]

const ANCHORED_LABEL_SET = new Set<string>(ANCHORED_LABELS)

const STAGE_LABELS: Record<YoloStage, string> = {
  S1: 'problem framing',
  S2: 'measurement design',
  S3: 'execution planning',
  S4: 'result analysis',
  S5: 'final synthesis'
}

function stageLabel(stage: YoloStage): string {
  return STAGE_LABELS[stage] ?? stage
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseReviewerJson(raw: string): ReviewerJsonOutput | undefined {
  const text = raw.trim()
  if (!text) return undefined

  const direct = tryParseReviewerJson(text)
  if (direct) return direct

  const codeFenceMatch = text.match(/```json\s*([\s\S]*?)```/i)
  if (codeFenceMatch?.[1]) {
    const parsed = tryParseReviewerJson(codeFenceMatch[1].trim())
    if (parsed) return parsed
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseReviewerJson(text.slice(firstBrace, lastBrace + 1))
  }

  return undefined
}

function tryParseReviewerJson(input: string): ReviewerJsonOutput | undefined {
  try {
    const parsed = JSON.parse(input)
    if (!isObject(parsed)) return undefined
    return parsed as ReviewerJsonOutput
  } catch {
    return undefined
  }
}

function normalizeHardBlockers(
  raw: unknown,
  notes: string[]
): Array<{ label: AnchoredHardBlockerLabel; citations: string[]; assetRefs: string[] }> {
  if (!Array.isArray(raw)) return []

  const normalized: Array<{ label: AnchoredHardBlockerLabel; citations: string[]; assetRefs: string[] }> = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const blocker = item as ReviewerJsonHardBlocker
    const label = typeof blocker.label === 'string' ? blocker.label.trim() : ''
    if (!ANCHORED_LABEL_SET.has(label)) {
      if (label) notes.push(`ignored non-anchored hard blocker label: ${label}`)
      continue
    }

    const citations = normalizeStringArray(blocker.citations)
    const assetRefs = normalizeStringArray(blocker.assetRefs)
    if (citations.length === 0 && assetRefs.length === 0) {
      notes.push(`downgraded blocker ${label} to advisory: missing citations`)
      continue
    }

    normalized.push({
      label: label as AnchoredHardBlockerLabel,
      citations: citations.length > 0 ? citations : assetRefs,
      assetRefs
    })
  }
  return normalized
}

function normalizeCriticalIssues(raw: unknown): ReviewerCriticalIssue[] {
  if (!Array.isArray(raw)) return []
  const normalized: ReviewerCriticalIssue[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const severityRaw = typeof item.severity === 'string' ? item.severity.trim() : ''
    const message = typeof item.message === 'string' ? item.message.trim() : ''
    if (!id || !message) continue
    const severity = (severityRaw === 'high' || severityRaw === 'medium' || severityRaw === 'low')
      ? severityRaw
      : 'medium'
    normalized.push({ id, severity, message })
    if (normalized.length >= 3) break
  }
  return normalized
}

function normalizeFixPlan(raw: unknown): ReviewerFixPlanItem[] {
  if (!Array.isArray(raw)) return []
  const normalized: ReviewerFixPlanItem[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const issueId = typeof item.issue_id === 'string' ? item.issue_id.trim() : ''
    const action = typeof item.action === 'string' ? item.action.trim() : ''
    if (!issueId || !action) continue
    normalized.push({ issue_id: issueId, action })
  }
  return normalized
}

function normalizeRewritePatch(raw: unknown): ReviewerRewritePatch {
  if (!isObject(raw)) {
    return { apply: false, target: 'coordinator_output', patch: {} }
  }

  const targetRaw = typeof raw.target === 'string' ? raw.target.trim() : ''
  const target = (targetRaw === 'planner_output' || targetRaw === 'coordinator_output')
    ? targetRaw
    : 'coordinator_output'

  return {
    apply: raw.apply === true,
    target,
    patch: isObject(raw.patch) ? raw.patch : {}
  }
}

function normalizeProcessReview(raw: ReviewerJsonOutput): ReviewerProcessReview {
  const verdictRaw = typeof raw.verdict === 'string' ? raw.verdict.trim() : ''
  const verdict = (verdictRaw === 'pass' || verdictRaw === 'revise' || verdictRaw === 'block')
    ? verdictRaw
    : 'revise'

  const criticalIssues = normalizeCriticalIssues(raw.critical_issues)
  const fixPlan = normalizeFixPlan(raw.fix_plan)
  const rewritePatch = normalizeRewritePatch(raw.rewrite_patch)
  const confidenceRaw = raw.confidence
  const confidence = (typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw))
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.65
  const notesForUser = typeof raw.notes_for_user === 'string' && raw.notes_for_user.trim()
    ? raw.notes_for_user.trim()
    : 'Review completed. Apply fix plan before next turn if issues remain.'

  return {
    verdict,
    critical_issues: criticalIssues,
    fix_plan: fixPlan,
    rewrite_patch: rewritePatch,
    confidence,
    notes_for_user: notesForUser
  }
}

function buildPersonaPrompt(input: {
  persona: ReviewerPersona
  stage: YoloStage
  manifest: SnapshotManifest
  gateResult: GateResult
  plannerOutput?: PlannerOutput
  coordinatorOutput?: CoordinatorTurnResult
}): string {
  return [
    'Run one critique-to-fix semantic review pass.',
    'Return STRICT JSON only (no prose).',
    'Minimum required JSON shape:',
    '{"verdict":"pass|revise|block","critical_issues":[{"id":"string","severity":"high|medium|low","message":"string"}],"fix_plan":[{"issue_id":"string","action":"string"}],"rewrite_patch":{"apply":"boolean","target":"planner_output|coordinator_output","patch":{}},"confidence":"number","notes_for_user":"string","notes":["string"],"hardBlockers":[{"label":"claim_without_direct_evidence|causality_gap|parity_violation_unresolved|reproducibility_gap|overclaim","citations":["string"],"assetRefs":["string"]}]}',
    `Persona: ${input.persona}`,
    `Stage: ${input.stage}`,
    `PlannerOutput: ${JSON.stringify(input.plannerOutput ?? null)}`,
    `CoordinatorOutput: ${JSON.stringify(input.coordinatorOutput ?? null)}`,
    `SnapshotManifest: ${JSON.stringify(input.manifest)}`,
    `GateResult: ${JSON.stringify(input.gateResult)}`
  ].join('\n')
}

function summarizeNotesForUser(reviewerPasses: ReviewerPass[]): string {
  const lines = reviewerPasses
    .map((pass) => pass.processReview?.notes_for_user)
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
  if (lines.length === 0) return 'No additional review notes.'
  return lines.slice(0, 3).join(' | ')
}

function aggregateProcessReview(
  reviewerPasses: ReviewerPass[],
  consensusBlockers: SemanticReviewResult['consensusBlockers']
): ReviewerProcessReview {
  const processPasses = reviewerPasses
    .map((pass) => pass.processReview)
    .filter((item): item is ReviewerProcessReview => Boolean(item))

  const blockVotes = processPasses.filter((pass) => pass.verdict === 'block').length
  const reviseVotes = processPasses.filter((pass) => pass.verdict === 'revise').length

  const verdict: ReviewerProcessReview['verdict'] = blockVotes >= 2
    ? 'block'
    : (reviseVotes > 0 || blockVotes > 0 ? 'revise' : 'pass')

  const issueMap = new Map<string, ReviewerCriticalIssue>()
  for (const pass of processPasses) {
    for (const issue of pass.critical_issues) {
      if (!issueMap.has(issue.id)) issueMap.set(issue.id, issue)
      if (issueMap.size >= 3) break
    }
    if (issueMap.size >= 3) break
  }

  if (issueMap.size === 0 && consensusBlockers.length > 0) {
    for (const blocker of consensusBlockers.slice(0, 3)) {
      issueMap.set(blocker.label, {
        id: blocker.label,
        severity: 'high',
        message: `Consensus blocker detected: ${blocker.label}`
      })
    }
  }

  const fixPlanMap = new Map<string, ReviewerFixPlanItem>()
  for (const pass of processPasses) {
    for (const fix of pass.fix_plan) {
      if (!fixPlanMap.has(fix.issue_id)) {
        fixPlanMap.set(fix.issue_id, fix)
      }
    }
  }
  if (fixPlanMap.size === 0) {
    for (const issue of issueMap.values()) {
      fixPlanMap.set(issue.id, {
        issue_id: issue.id,
        action: 'Address this issue with a concrete artifact/prompt revision before next turn.'
      })
    }
  }

  const rewritePatch = processPasses.find((pass) => pass.rewrite_patch.apply)?.rewrite_patch
    ?? { apply: false, target: 'coordinator_output', patch: {} }

  const confidence = processPasses.length > 0
    ? median(processPasses.map((pass) => pass.confidence))
    : 0.5

  return {
    verdict,
    critical_issues: Array.from(issueMap.values()).slice(0, 3),
    fix_plan: Array.from(fixPlanMap.values()),
    rewrite_patch: rewritePatch,
    confidence: Math.max(0, Math.min(1, confidence)),
    notes_for_user: summarizeNotesForUser(reviewerPasses)
  }
}

// Circuit-breaker: allow retry after this many evaluate() calls following a failure
const CIRCUIT_BREAKER_RETRY_AFTER = 3

class LlmBackedReviewEngine implements ReviewEngine {
  private readonly agents = new Map<ReviewerPersona, AgentLike>()
  private readonly initialized = new Set<ReviewerPersona>()
  private unavailableReason?: string
  private unavailableCallsSince = 0
  private readonly tokenTracker: TokenTracker
  private lastReportedReviewerCostUsd = 0

  constructor(private readonly config: YoloReviewerConfig) {
    this.tokenTracker = config.tokenTracker ?? createTokenTracker()
    this.tokenTracker.startRun(`reviewer-${Date.now()}`)
  }

  async evaluate(input: {
    phase: 'P0' | 'P1' | 'P2' | 'P3'
    stage: YoloStage
    manifest: SnapshotManifest
    gateResult: GateResult
    plannerOutput?: PlannerOutput
    coordinatorOutput?: CoordinatorTurnResult
  }): Promise<SemanticReviewResult> {
    if (input.phase !== 'P3') {
      return {
        enabled: false,
        reviewerPasses: [],
        consensusBlockers: [],
        advisoryNotes: [`semantic review disabled for phase ${input.phase}`],
        processReview: {
          verdict: 'pass',
          critical_issues: [],
          fix_plan: [],
          rewrite_patch: { apply: false, target: 'coordinator_output', patch: {} },
          confidence: 0.5,
          notes_for_user: `semantic review disabled for phase ${input.phase}`
        }
      }
    }

    // Circuit-breaker recovery: retry after enough calls have passed
    if (this.unavailableReason && !this.config.createAgentInstance) {
      this.unavailableCallsSince += 1
      if (this.unavailableCallsSince >= CIRCUIT_BREAKER_RETRY_AFTER) {
        this.unavailableReason = undefined
        this.unavailableCallsSince = 0
        // Clear stale agents so they get re-created on next getAgent()
        await this.resetAgents()
      }
    }

    this.emitActivity('reviewer_start', `reviewing ${stageLabel(input.stage)}`)

    const personas = REVIEWER_PERSONAS_BY_STAGE[input.stage]
    const reviewerPasses = await Promise.all(
      personas.map(async (persona) => this.runPersonaPass(persona, input))
    )
    const consensusBlockers = buildConsensusBlockers(reviewerPasses)
    const processReview = aggregateProcessReview(reviewerPasses, consensusBlockers)
    const advisoryNotes: string[] = []

    // Report reviewer cost
    const costSummary = this.tokenTracker.getSummary()
    const reviewerCostTotalUsd = costSummary?.cost?.totalCost ?? 0
    const reviewerCostDeltaUsd = Math.max(0, reviewerCostTotalUsd - this.lastReportedReviewerCostUsd)
    this.lastReportedReviewerCostUsd = reviewerCostTotalUsd
    if (reviewerCostDeltaUsd > 0) {
      advisoryNotes.push(`reviewer cost (this evaluate): $${reviewerCostDeltaUsd.toFixed(4)}`)
    }

    if (this.unavailableReason) {
      advisoryNotes.push(this.unavailableReason)
    }
    if (consensusBlockers.length > 0) {
      advisoryNotes.push(`semantic consensus blockers: ${consensusBlockers.map((item) => item.label).join(', ')}`)
    } else {
      advisoryNotes.push('semantic review found no consensus blockers')
    }
    advisoryNotes.push(`process review verdict: ${processReview.verdict}`)

    this.emitActivity('reviewer_end', `verdict: ${processReview.verdict}`)

    return {
      enabled: true,
      reviewerPasses,
      consensusBlockers,
      advisoryNotes,
      processReview
    }
  }

  async destroy(): Promise<void> {
    await this.resetAgents()
  }

  private async resetAgents(): Promise<void> {
    const destroyPromises: Promise<void>[] = []
    for (const agent of this.agents.values()) {
      if (agent.destroy) destroyPromises.push(agent.destroy())
    }
    await Promise.allSettled(destroyPromises)
    this.agents.clear()
    this.initialized.clear()
  }

  private emitActivity(kind: string, preview?: string): void {
    this.config.onActivity?.({
      id: randomId('act'),
      timestamp: nowIso(),
      kind: kind as ActivityEvent['kind'],
      agent: 'reviewer',
      preview
    })
  }

  private async runPersonaPass(
    persona: ReviewerPersona,
    input: {
      stage: YoloStage
      manifest: SnapshotManifest
      gateResult: GateResult
      plannerOutput?: PlannerOutput
      coordinatorOutput?: CoordinatorTurnResult
    }
  ): Promise<ReviewerPass> {
    const heuristicBlockers = buildHeuristicBlockers(input.manifest, input.gateResult)
    const fallbackPass = (reason: string): ReviewerPass => {
      const fallbackVerdict: ReviewerProcessReview['verdict'] = heuristicBlockers.length > 0 ? 'revise' : 'pass'
      return {
        persona,
        notes: [
          `${persona} review fallback: ${reason}`,
          `${persona} review pass for ${stageLabel(input.stage)}`,
          `manifest=${input.manifest.id}`
        ],
        hardBlockers: heuristicBlockers.map((item) => ({
          label: item.label,
          citations: item.citations,
          assetRefs: item.assetRefs
        })),
        processReview: {
          verdict: fallbackVerdict,
          critical_issues: heuristicBlockers.slice(0, 3).map((item) => ({
            id: item.label,
            severity: 'high',
            message: `Heuristic blocker detected: ${item.label}`
          })),
          fix_plan: heuristicBlockers.slice(0, 3).map((item) => ({
            issue_id: item.label,
            action: 'Provide direct evidence or repair structural gap before proceeding.'
          })),
          rewrite_patch: { apply: false, target: 'coordinator_output', patch: {} },
          confidence: 0.45,
          notes_for_user: `${persona} fallback review generated due to runtime failure.`
        }
      }
    }

    try {
      const agent = await this.getAgent(persona)
      this.emitActivity('tool_call', `${persona} reviewer pass for ${stageLabel(input.stage)}`)
      const prompt = buildPersonaPrompt({
        persona,
        stage: input.stage,
        manifest: input.manifest,
        gateResult: input.gateResult,
        plannerOutput: input.plannerOutput,
        coordinatorOutput: input.coordinatorOutput
      })
      const runResult = await agent.run(prompt)
      if (!runResult.success) {
        return fallbackPass(runResult.error ? `agent run failed: ${runResult.error}` : 'agent run failed')
      }

      // Track reviewer token costs
      if (runResult.usage?.tokens) {
        this.tokenTracker.recordCall(this.config.model, {
          promptTokens: runResult.usage.tokens.promptTokens ?? 0,
          completionTokens: runResult.usage.tokens.completionTokens ?? 0,
          totalTokens: runResult.usage.tokens.totalTokens ?? 0
        })
      }

      const parsed = parseReviewerJson(runResult.output)
      if (!parsed) {
        return fallbackPass('review output is not valid JSON')
      }

      const notes = normalizeStringArray(parsed.notes)
      if (notes.length === 0) {
        notes.push(`${persona} review pass for ${stageLabel(input.stage)}`)
      }
      const hardBlockers = normalizeHardBlockers(parsed.hardBlockers, notes)
      const processReview = normalizeProcessReview(parsed)
      this.emitActivity('tool_result', `${persona}: verdict=${processReview.verdict}`)
      return {
        persona,
        notes,
        hardBlockers,
        processReview
      }
    } catch (error) {
      return fallbackPass(error instanceof Error ? error.message : String(error))
    }
  }

  private async getAgent(persona: ReviewerPersona): Promise<AgentLike> {
    if (this.unavailableReason && !this.config.createAgentInstance) {
      throw new Error(this.unavailableReason)
    }

    let agent = this.agents.get(persona)
    if (!agent) {
      agent = this.config.createAgentInstance
        ? this.config.createAgentInstance({ persona })
        : this.defaultAgentFactory(persona)
      this.agents.set(persona, agent)
    }

    if (!this.initialized.has(persona)) {
      try {
        await agent.ensureInit()
        this.initialized.add(persona)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!this.config.createAgentInstance) {
          this.unavailableReason = `semantic reviewer unavailable: ${message}`
          this.unavailableCallsSince = 0
        }
        throw error
      }
    }

    return agent
  }

  private defaultAgentFactory(persona: ReviewerPersona): AgentLike {
    const agent = createAgent({
      projectPath: this.config.projectPath,
      apiKey: this.config.apiKey,
      model: this.config.model,
      maxSteps: this.config.maxSteps ?? 8,
      maxTokens: this.config.maxTokens,
      debug: this.config.debug,
      identity: this.config.identityPrompt
        ? `${this.config.identityPrompt}\nPersona: ${persona}`
        : `${DEFAULT_IDENTITY}\nPersona: ${persona}`,
      constraints: [...(this.config.constraints ?? DEFAULT_CONSTRAINTS)],
      packs: [packs.safe()],
      skipConfigFile: true
    })

    return {
      ensureInit: () => agent.ensureInit(),
      run: (prompt: string) => agent.run(prompt),
      destroy: () => agent.destroy()
    }
  }
}

export function createYoloReviewEngine(config: YoloReviewerConfig): ReviewEngine {
  if (!config.model.trim()) {
    return new DisabledReviewEngine()
  }
  return new LlmBackedReviewEngine(config)
}

export const __private = {
  parseReviewerJson,
  normalizeHardBlockers,
  normalizeProcessReview,
  aggregateProcessReview,
  buildPersonaPrompt
}
