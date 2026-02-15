import { createAgent, packs } from '../../../src/index.js'
import type { AgentRunResult } from '../../../src/index.js'

import {
  ANCHORED_LABELS,
  DisabledReviewEngine,
  REVIEWER_PERSONAS_BY_STAGE,
  buildConsensusBlockers,
  buildHeuristicBlockers
} from '../runtime/review-engine.js'
import type {
  AnchoredHardBlockerLabel,
  GateResult,
  ReviewEngine,
  ReviewerPass,
  ReviewerPersona,
  SemanticReviewResult,
  SnapshotManifest,
  YoloStage
} from '../runtime/types.js'

interface ReviewerJsonOutput {
  notes?: unknown
  hardBlockers?: unknown
}

interface ReviewerJsonHardBlocker {
  label?: unknown
  citations?: unknown
  assetRefs?: unknown
}

export interface AgentLike {
  ensureInit: () => Promise<void>
  run: (prompt: string) => Promise<AgentRunResult>
  destroy?: () => Promise<void>
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
  createAgentInstance?: (input: { persona: ReviewerPersona }) => AgentLike
}

const DEFAULT_IDENTITY = [
  'You are a strict scientific reviewer persona.',
  'Ground every claim in provided manifest and gate context.',
  'Only report anchored hard blockers with concrete asset/run citations.'
].join(' ')

const DEFAULT_CONSTRAINTS = [
  'Output strict JSON only.',
  'Do not invent citations.',
  'Use anchored blocker labels only.',
  'If uncertain, return notes and no hard blockers.'
]

const ANCHORED_LABEL_SET = new Set<string>(ANCHORED_LABELS)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function buildPersonaPrompt(input: {
  persona: ReviewerPersona
  stage: YoloStage
  manifest: SnapshotManifest
  gateResult: GateResult
}): string {
  return [
    'Run one semantic review pass.',
    `Persona: ${input.persona}`,
    `Stage: ${input.stage}`,
    'Return STRICT JSON schema:',
    '{"notes": string[], "hardBlockers": [{"label": "claim_without_direct_evidence"|"causality_gap"|"parity_violation_unresolved"|"reproducibility_gap"|"overclaim", "citations": string[], "assetRefs": string[]}]}',
    'Rules:',
    '- hardBlockers must use anchored labels only.',
    '- each hardBlocker must cite concrete asset/run ids.',
    '- include unresolved concerns in notes.',
    `SnapshotManifest: ${JSON.stringify(input.manifest)}`,
    `GateResult: ${JSON.stringify(input.gateResult)}`
  ].join('\n')
}

class LlmBackedReviewEngine implements ReviewEngine {
  private readonly agents = new Map<ReviewerPersona, AgentLike>()
  private readonly initialized = new Set<ReviewerPersona>()
  private unavailableReason?: string

  constructor(private readonly config: YoloReviewerConfig) {}

  async evaluate(input: {
    phase: 'P0' | 'P1' | 'P2' | 'P3'
    stage: YoloStage
    manifest: SnapshotManifest
    gateResult: GateResult
  }): Promise<SemanticReviewResult> {
    if (input.phase !== 'P3') {
      return {
        enabled: false,
        reviewerPasses: [],
        consensusBlockers: [],
        advisoryNotes: [`semantic review disabled for phase ${input.phase}`]
      }
    }

    const personas = REVIEWER_PERSONAS_BY_STAGE[input.stage]
    const reviewerPasses = await Promise.all(
      personas.map(async (persona) => this.runPersonaPass(persona, input))
    )
    const consensusBlockers = buildConsensusBlockers(reviewerPasses)
    const advisoryNotes: string[] = []
    if (this.unavailableReason) {
      advisoryNotes.push(this.unavailableReason)
    }
    if (consensusBlockers.length > 0) {
      advisoryNotes.push(`semantic consensus blockers: ${consensusBlockers.map((item) => item.label).join(', ')}`)
    } else {
      advisoryNotes.push('semantic review found no consensus blockers')
    }

    return {
      enabled: true,
      reviewerPasses,
      consensusBlockers,
      advisoryNotes
    }
  }

  private async runPersonaPass(
    persona: ReviewerPersona,
    input: {
      stage: YoloStage
      manifest: SnapshotManifest
      gateResult: GateResult
    }
  ): Promise<ReviewerPass> {
    const heuristicBlockers = buildHeuristicBlockers(input.manifest, input.gateResult)
    const fallbackPass = (reason: string): ReviewerPass => ({
      persona,
      notes: [
        `${persona} review fallback: ${reason}`,
        `${persona} review pass for ${input.stage}`,
        `manifest=${input.manifest.id}`
      ],
      hardBlockers: heuristicBlockers.map((item) => ({
        label: item.label,
        citations: item.citations,
        assetRefs: item.assetRefs
      }))
    })

    try {
      const agent = await this.getAgent(persona)
      const prompt = buildPersonaPrompt({
        persona,
        stage: input.stage,
        manifest: input.manifest,
        gateResult: input.gateResult
      })
      const runResult = await agent.run(prompt)
      if (!runResult.success) {
        return fallbackPass(runResult.error ? `agent run failed: ${runResult.error}` : 'agent run failed')
      }

      const parsed = parseReviewerJson(runResult.output)
      if (!parsed) {
        return fallbackPass('review output is not valid JSON')
      }

      const notes = normalizeStringArray(parsed.notes)
      if (notes.length === 0) {
        notes.push(`${persona} review pass for ${input.stage}`)
      }
      const hardBlockers = normalizeHardBlockers(parsed.hardBlockers, notes)
      return {
        persona,
        notes,
        hardBlockers
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
  buildPersonaPrompt
}
