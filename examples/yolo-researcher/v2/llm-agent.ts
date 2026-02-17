import { createAgent, mergePacks } from '../../../src/index.js'
import { packs } from '../../../src/packs/index.js'

import type { TurnContext, TurnDecision, YoloSingleAgent } from './types.js'

export interface LlmSingleAgentConfig {
  projectPath: string
  model: string
  apiKey?: string
  maxSteps?: number
  maxTokens?: number
  enableNetwork?: boolean
}

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text
}

function buildPrompt(context: TurnContext): string {
  const recent = context.recentTurns
    .map((turn) => `- ${turn.actionPath}: ${turn.summary}`)
    .join('\n')

  const blocked = context.failures
    .filter((item) => item.status === 'BLOCKED')
    .map((item) => `- [${item.runtime}] ${item.cmd} :: ${item.errorLine}`)
    .join('\n')

  return [
    'You are YOLO-Researcher v2 single-agent controller.',
    'Design axiom: minimal discipline to avoid death + evidence-driven strengthening.',
    '',
    'Hard rules:',
    '1) One turn does exactly one atomic action: Read|Exec|Edit|Write|Ask|Stop.',
    '2) Facts/Constraints require evidence path under runs/turn-xxxx/.',
    '3) Avoid commands listed as BLOCKED unless blockedOverrideReason is necessary and explicit.',
    '',
    `Turn: ${context.turnNumber}`,
    `Goal: ${context.project.goal}`,
    `Default runtime: ${context.project.defaultRuntime}`,
    '',
    'Current Plan:',
    ...context.project.currentPlan.map((item, idx) => `${idx + 1}. ${item}`),
    '',
    'Recent turn summaries:',
    recent || '- none',
    '',
    'Blocked failures:',
    blocked || '- none',
    '',
    'Respond with JSON only. Schema:',
    '{',
    '  "intent": "why this one action now",',
    '  "expectedOutcome": "what evidence this action should produce",',
    '  "action": {',
    '    "kind": "Read|Exec|Edit|Write|Ask|Stop",',
    '    "...": "action payload"',
    '  },',
    '  "projectUpdate": {',
    '    "currentPlan": ["up to 5 items"],',
    '    "facts": [{"text":"...","evidencePath":"runs/turn-0001/..."}],',
    '    "constraints": [{"text":"...","evidencePath":"runs/turn-0001/..."}],',
    '    "hypotheses": ["[HYP] ..."],',
    '    "keyArtifacts": ["runs/turn-0001/..."],',
    '    "defaultRuntime": "host|docker|venv"',
    '  },',
    '  "updateSummary": ["short pointer lines"]',
    '}',
    '',
    'If evidence is not produced yet, do not write facts. Use hypotheses instead.'
  ].join('\n')
}

function normalizeDecision(value: unknown): TurnDecision {
  if (!value || typeof value !== 'object') {
    throw new Error('LLM decision must be a JSON object')
  }

  const candidate = value as Record<string, unknown>
  const intent = typeof candidate.intent === 'string' ? candidate.intent.trim() : ''
  if (!intent) throw new Error('LLM decision missing intent')

  const action = candidate.action
  if (!action || typeof action !== 'object') {
    throw new Error('LLM decision missing action')
  }

  const kind = (action as Record<string, unknown>).kind
  if (typeof kind !== 'string' || !['Read', 'Exec', 'Edit', 'Write', 'Ask', 'Stop'].includes(kind)) {
    throw new Error('LLM action.kind is invalid')
  }

  return {
    intent,
    expectedOutcome: typeof candidate.expectedOutcome === 'string' ? candidate.expectedOutcome : undefined,
    action: action as TurnDecision['action'],
    projectUpdate: typeof candidate.projectUpdate === 'object' && candidate.projectUpdate
      ? candidate.projectUpdate as TurnDecision['projectUpdate']
      : undefined,
    updateSummary: Array.isArray(candidate.updateSummary)
      ? candidate.updateSummary.filter((item): item is string => typeof item === 'string')
      : undefined
  }
}

export class LlmSingleAgent implements YoloSingleAgent {
  private readonly agent: ReturnType<typeof createAgent>

  constructor(private readonly config: LlmSingleAgentConfig) {
    this.agent = createAgent({
      projectPath: this.config.projectPath,
      model: this.config.model,
      apiKey: this.config.apiKey,
      maxSteps: this.config.maxSteps ?? 8,
      maxTokens: this.config.maxTokens ?? 4_000,
      packs: [
        mergePacks(
          packs.safe(),
          packs.exec(),
          packs.exploration(),
          this.config.enableNetwork ? packs.network() : packs.discovery()
        )
      ],
      constraints: [
        'One turn = one atomic action. Avoid multi-step plans in a single turn.',
        'Prefer evidence-producing actions. Save raw output paths under runs/turn-xxxx/.',
        'Do not retry BLOCKED command/runtime pairs without explicit remediation.'
      ],
      identity: 'You are a single-agent autonomous researcher that follows YOLO v2 minimal discipline.'
    })
  }

  async decide(context: TurnContext): Promise<TurnDecision> {
    await this.agent.ensureInit()
    const result = await this.agent.run(buildPrompt(context))

    if (!result.success) {
      throw new Error(result.error || 'LLM single agent failed without error details')
    }

    const parsed = JSON.parse(extractJson(result.output)) as unknown
    return normalizeDecision(parsed)
  }

  async destroy(): Promise<void> {
    await this.agent.destroy()
  }
}

export function createLlmSingleAgent(config: LlmSingleAgentConfig): LlmSingleAgent {
  return new LlmSingleAgent(config)
}
