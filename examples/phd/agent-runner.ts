import { createAgent, packs } from '../../src/index.js'

import type {
  AgentTaskUpdate,
  ExploreTurnDraft,
  ExploreTurnResult,
  MemoryDigest,
  RamEventType,
  ReviewAction,
  ReviewPacketType,
  TaskBoard,
  TaskItem,
  ToolEvent
} from './types.js'

export interface RunExploreTurnOptions {
  projectRoot: string
  packetId: string
  taskBoard: TaskBoard
  activeTask: TaskItem
  memoryDigest?: MemoryDigest
}

const EVENT_TYPES: ReadonlySet<RamEventType> = new Set([
  'reviewable_artifact_ready',
  'decision_required',
  'blocked',
  'preflight_failed',
  'contradictory_evidence',
  'scope_drift',
  'milestone_completed',
  'risk_escalation'
])

const PACKET_TYPES: ReadonlySet<ReviewPacketType> = new Set([
  'code_change',
  'experiment_result',
  'analysis_note',
  'decision_gate',
  'blocking_note'
])

const REVIEW_ACTIONS: ReadonlySet<ReviewAction> = new Set([
  'approve',
  'request_changes',
  'reject'
])

function nowIso(): string {
  return new Date().toISOString()
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const direct = raw.trim()
  if (!direct) return null

  try {
    const parsed = JSON.parse(direct)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }

  const fencedMatch = direct.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fall through
    }
  }

  const start = direct.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < direct.length; i += 1) {
    const ch = direct[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = direct.slice(start, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
          }
        } catch {
          return null
        }
      }
    }
  }

  return null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeTaskUpdates(raw: unknown, activeTaskId: string, eventType: RamEventType): AgentTaskUpdate[] {
  if (!Array.isArray(raw)) {
    return [{
      task_id: activeTaskId,
      status: eventType === 'blocked' ? 'BLOCKED' : 'IN_REVIEW'
    }]
  }

  const updates: AgentTaskUpdate[] = []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const taskId = asString(row.task_id)
    if (!taskId) continue
    const nextStatusRaw = asString(row.status).toUpperCase()
    const status: AgentTaskUpdate['status'] =
      nextStatusRaw === 'DOING' || nextStatusRaw === 'BLOCKED' || nextStatusRaw === 'IN_REVIEW'
        ? nextStatusRaw
        : eventType === 'blocked'
          ? 'BLOCKED'
          : 'IN_REVIEW'
    const note = asString(row.note)
    const acceptAdd = asStringArray(row.accept_criteria_add)
    updates.push({
      task_id: taskId,
      status,
      ...(note ? { note } : {}),
      ...(acceptAdd.length > 0 ? { accept_criteria_add: acceptAdd } : {})
    })
  }

  if (updates.length === 0) {
    updates.push({
      task_id: activeTaskId,
      status: eventType === 'blocked' ? 'BLOCKED' : 'IN_REVIEW'
    })
  }
  return updates
}

function normalizeDraftFromObject(
  payload: Record<string, unknown>,
  fallback: {
    taskId: string
    packetId: string
    taskTitle: string
  }
): ExploreTurnDraft {
  const eventType = asString(payload.event_type) as RamEventType
  const normalizedEvent: RamEventType = EVENT_TYPES.has(eventType)
    ? eventType
    : 'reviewable_artifact_ready'

  const type = asString(payload.type) as ReviewPacketType
  const normalizedType: ReviewPacketType = PACKET_TYPES.has(type)
    ? type
    : normalizedEvent === 'blocked'
      ? 'blocking_note'
      : normalizedEvent === 'decision_required'
        ? 'decision_gate'
        : 'analysis_note'

  const deliverablesRaw = Array.isArray(payload.deliverables) ? payload.deliverables : []
  const deliverables: ExploreTurnDraft['deliverables'] = deliverablesRaw
    .map((item) => {
      const row = asRecord(item)
      if (!row) return null
      const deliverablePath = asString(row.path)
      if (!deliverablePath) return null
      const kind = asString(row.kind) as ExploreTurnDraft['deliverables'][number]['kind']
      const normalizedKind = (
        kind === 'data' || kind === 'figure' || kind === 'script' || kind === 'code' || kind === 'note' || kind === 'log'
      )
        ? kind
        : 'other'
      return { path: deliverablePath, kind: normalizedKind }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  const scopeRaw = asRecord(payload.scope)
  const scopeCostRaw = asRecord(scopeRaw?.cost)
  const preflightRaw = asRecord(payload.preflight)
  const preflightChecksRaw = Array.isArray(preflightRaw?.checks) ? preflightRaw?.checks : []

  const askRaw = Array.isArray(payload.ask) ? payload.ask : []
  const ask: ExploreTurnDraft['ask'] = askRaw
    .map((item) => {
      const row = asRecord(item)
      if (!row) return null
      const question = asString(row.question)
      if (!question) return null
      const rawType = asString(row.type)
      const type = rawType === 'text' ? 'text' : 'choice'
      const options = asStringArray(row.options)
      return {
        question,
        type,
        ...(options.length > 0 ? { options } : {})
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  const recommendationRaw = asRecord(payload.recommendation)
  const suggestedAction = asString(recommendationRaw?.suggested_user_action) as ReviewAction
  const recommendationRationale = asString(recommendationRaw?.rationale)
  const recommendation = REVIEW_ACTIONS.has(suggestedAction) && recommendationRationale
    ? {
      suggested_user_action: suggestedAction,
      rationale: recommendationRationale
    }
    : undefined

  const fallbackDeliverables = [
    { path: `notes/${fallback.packetId.toLowerCase()}-summary.md`, kind: 'note' as const }
  ]

  return {
    event_type: normalizedEvent,
    type: normalizedType,
    title: asString(payload.title, `Review packet for ${fallback.taskTitle}`),
    summary: asString(payload.summary, 'Produced an incremental research artifact and prepared a review package.'),
    what_changed: asStringArray(payload.what_changed),
    scope: {
      repo_changes: Boolean(scopeRaw?.repo_changes),
      data_paths: asStringArray(scopeRaw?.data_paths),
      env: asString(scopeRaw?.env, 'local'),
      cost: {
        cpu_hours: Number(scopeCostRaw?.cpu_hours ?? 0),
        cloud_usd: Number(scopeCostRaw?.cloud_usd ?? 0)
      }
    },
    deliverables: deliverables.length > 0 ? deliverables : fallbackDeliverables,
    reproduce_commands: asStringArray(payload.reproduce_commands),
    preflight: {
      status: asString(preflightRaw?.status) === 'fail'
        ? 'fail'
        : asString(preflightRaw?.status) === 'pass'
          ? 'pass'
          : 'not_run',
      checks: preflightChecksRaw
        .map((item) => {
          const row = asRecord(item)
          if (!row) return null
          const name = asString(row.name)
          if (!name) return null
          const status: 'pass' | 'fail' = asString(row.status) === 'fail' ? 'fail' : 'pass'
          const log = asString(row.log)
          return { name, status, ...(log ? { log } : {}) }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    },
    risks: asStringArray(payload.risks),
    ask,
    ...(recommendation ? { recommendation } : {}),
    rollback_plan: asStringArray(payload.rollback_plan),
    task_updates: normalizeTaskUpdates(payload.task_updates, fallback.taskId, normalizedEvent),
    evidence_paths: asStringArray(payload.evidence_paths)
  }
}

function formatMemoryLines(lines: string[]): string {
  if (lines.length === 0) return '- (none)'
  return lines.map((line) => `- ${line}`).join('\n')
}

function buildExplorePrompt(input: {
  packetId: string
  board: TaskBoard
  activeTask: TaskItem
  memoryDigest?: MemoryDigest
}): string {
  const compactTaskboard = JSON.stringify({
    project: input.board.project,
    tasks: input.board.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      accept_criteria: task.accept_criteria,
      outputs: task.outputs,
      blockers: task.blockers,
      notes: task.notes
    }))
  }, null, 2)

  const memory = input.memoryDigest
  const memoryBlock = memory
    ? [
      'Memory digest (use this to keep continuity, avoid repeating mistakes, and preserve user intent):',
      '- Latest facts:',
      formatMemoryLines(memory.latest_facts),
      '- Latest constraints:',
      formatMemoryLines(memory.latest_constraints),
      '- Latest decisions:',
      formatMemoryLines(memory.latest_decisions),
      '- Open questions:',
      formatMemoryLines(memory.open_questions),
      '- Key artifacts:',
      formatMemoryLines(memory.key_artifacts)
    ].join('\n')
    : 'Memory digest: unavailable for this turn.'

  return [
    'You are the Explore Loop executor for Research Assistant Mode (RAM v0.2).',
    'Goal: complete one event-driven turn and prepare one review packet draft.',
    '',
    'Rules:',
    '- Work only under the project directory.',
    '- Prefer using tools (read/write/edit/bash) to create reproducible artifacts.',
    '- Never claim task DONE; task completion is only after user UI approve.',
    '- No time-based triggers.',
    '- If blocked or high-impact decision is needed, set event_type accordingly.',
    '',
    `Current packet_id: ${input.packetId}`,
    `Active task: ${input.activeTask.id} - ${input.activeTask.title}`,
    '',
    'Taskboard snapshot:',
    compactTaskboard,
    '',
    memoryBlock,
    '',
    'Return strict JSON object only with schema:',
    '{',
    '  "event_type": "reviewable_artifact_ready|decision_required|blocked|preflight_failed|contradictory_evidence|scope_drift|milestone_completed|risk_escalation",',
    '  "type": "code_change|experiment_result|analysis_note|decision_gate|blocking_note",',
    '  "title": "string",',
    '  "summary": "string",',
    '  "what_changed": ["string"],',
    '  "scope": {',
    '    "repo_changes": true,',
    '    "data_paths": ["path"],',
    '    "env": "local",',
    '    "cost": { "cpu_hours": 0.2, "cloud_usd": 0 }',
    '  },',
    '  "deliverables": [{ "path": "path", "kind": "data|figure|script|code|note|log|other" }],',
    '  "reproduce_commands": ["command"],',
    '  "preflight": {',
    '    "status": "pass|fail|not_run",',
    '    "checks": [{ "name": "string", "status": "pass|fail", "log": "path optional" }]',
    '  },',
    '  "risks": ["string"],',
    '  "ask": [{ "question": "string", "type": "choice|text", "options": ["optional"] }],',
    '  "recommendation": { "suggested_user_action": "approve|request_changes|reject", "rationale": "string" },',
    '  "rollback_plan": ["string"],',
    '  "task_updates": [{',
    '    "task_id": "task id",',
    '    "status": "DOING|BLOCKED|IN_REVIEW",',
    '    "note": "optional note",',
    '    "accept_criteria_add": ["optional criteria"]',
    '  }],',
    '  "evidence_paths": ["path"]',
    '}',
    '',
    'Output JSON only, no markdown wrapper.'
  ].join('\n')
}

export async function runExploreTurn(options: RunExploreTurnOptions): Promise<ExploreTurnResult> {
  const apiKey = process.env.OPENAI_API_KEY ?? ''
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for examples/phd (scripted mode removed).')
  }

  const toolEvents: ToolEvent[] = []
  const pushToolEvent = (event: ToolEvent): void => {
    toolEvents.push(event)
  }

  const agent = createAgent({
    apiKey,
    provider: 'openai',
    model: 'gpt-5.2',
    skipConfigFile: true,
    projectPath: options.projectRoot,
    identity: 'You are RAM Explore Agent. Produce evidence-backed, reviewable artifacts.',
    constraints: [
      'Never mark task as DONE; user approve gate is required.',
      'Always return JSON object as requested.',
      'Prefer reproducible commands and artifact paths in project root.',
      'Avoid destructive operations.'
    ],
    packs: [
      packs.safe(),
      packs.exec({
        approvalMode: 'none'
      }),
      packs.todo()
    ],
    onToolCall: (tool: string, input: unknown) => {
      pushToolEvent({
        timestamp: nowIso(),
        phase: 'call',
        tool,
        input
      })
    },
    onToolResult: (tool: string, result: unknown) => {
      const payload = asRecord(result)
      pushToolEvent({
        timestamp: nowIso(),
        phase: 'result',
        tool,
        result,
        success: Boolean(payload?.success),
        ...(typeof payload?.error === 'string' ? { error: payload.error } : {})
      })
    },
    maxSteps: 24
  })

  try {
    await agent.ensureInit()
    const response = await agent.run(buildExplorePrompt({
      packetId: options.packetId,
      board: options.taskBoard,
      activeTask: options.activeTask,
      memoryDigest: options.memoryDigest
    }))
    const rawOutput = response.output?.trim() || ''
    const parsed = extractJsonObject(rawOutput)
    const draft = parsed
      ? normalizeDraftFromObject(parsed, {
        taskId: options.activeTask.id,
        packetId: options.packetId,
        taskTitle: options.activeTask.title
      })
      : {
        event_type: 'preflight_failed' as RamEventType,
        type: 'analysis_note' as ReviewPacketType,
        title: `Fallback packet for ${options.activeTask.id}`,
        summary: 'Agent output was not valid JSON; generated fallback packet for manual review.',
        what_changed: ['Agent raw output captured for inspection.'],
        scope: {
          repo_changes: false,
          data_paths: [],
          env: 'local',
          cost: { cpu_hours: 0, cloud_usd: 0 }
        },
        deliverables: [{ path: `notes/${options.packetId.toLowerCase()}-agent-output.txt`, kind: 'log' as const }],
        reproduce_commands: [],
        preflight: {
          status: 'fail' as const,
          checks: [{ name: 'json_output_parse', status: 'fail' as const }]
        },
        risks: ['Structured output parsing failed; requires manual inspection.'],
        ask: [{
          question: 'Should we retry this turn with tighter output constraints?',
          type: 'choice' as const,
          options: ['retry_now', 'manual_adjustment']
        }],
        recommendation: {
          suggested_user_action: 'request_changes' as const,
          rationale: 'Output contract was not satisfied.'
        },
        rollback_plan: ['No destructive operation was performed.'],
        task_updates: [{ task_id: options.activeTask.id, status: 'IN_REVIEW' as const }],
        evidence_paths: []
      }

    return {
      draft,
      rawOutput: rawOutput || '(empty output)',
      toolEvents
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      draft: {
        event_type: 'blocked',
        type: 'blocking_note',
        title: `Blocked packet for ${options.activeTask.id}`,
        summary: `createAgent execution failed: ${message}`,
        what_changed: ['Turn failed before stable artifact generation.'],
        scope: {
          repo_changes: false,
          data_paths: [],
          env: 'local',
          cost: { cpu_hours: 0, cloud_usd: 0 }
        },
        deliverables: [{ path: `notes/${options.packetId.toLowerCase()}-agent-output.txt`, kind: 'log' }],
        reproduce_commands: [],
        preflight: {
          status: 'fail',
          checks: [{ name: 'agent_run', status: 'fail' }]
        },
        risks: [message],
        ask: [{
          question: 'Should we retry this turn after fixing the blocking issue?',
          type: 'choice',
          options: ['retry', 'adjust_scope']
        }],
        recommendation: {
          suggested_user_action: 'request_changes',
          rationale: 'Execution error must be resolved before continuing.'
        },
        rollback_plan: ['No destructive operations were executed.'],
        task_updates: [{ task_id: options.activeTask.id, status: 'BLOCKED' }],
        evidence_paths: []
      },
      rawOutput: `LLM failure: ${message}`,
      toolEvents
    }
  } finally {
    await agent.destroy()
  }
}
