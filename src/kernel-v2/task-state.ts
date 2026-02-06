import type { V2TaskAnchor, V2TaskState } from './types.js'
import { KernelV2Storage } from './storage.js'

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
}

function extractGoalFromPrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Handle current user request'
  return trimmed.length > 180 ? trimmed.slice(0, 177) + '...' : trimmed
}

function inferBlockedBy(text: string): string[] {
  const lowered = text.toLowerCase()
  if (!lowered.includes('block') && !lowered.includes('cannot') && !lowered.includes('failed')) {
    return []
  }
  const candidates = text
    .split(/[\n.;]/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => /block|cannot|failed|permission|missing/i.test(s))
  return candidates.slice(0, 3)
}

export class TaskStateCoordinator {
  constructor(private readonly storage: KernelV2Storage) {}

  async resolveOrCreate(projectId: string, sessionId: string, userPrompt: string): Promise<V2TaskState> {
    const tasks = await this.storage.listTasks(projectId)
    const key = normalizeKey(userPrompt)

    const matched = tasks.find(t => {
      const hay = `${t.currentGoal} ${t.nowDoing} ${t.nextAction}`.toLowerCase()
      return key.split('-').some(part => part.length > 3 && hay.includes(part))
    })

    if (matched) {
      const updated: V2TaskState = {
        ...matched,
        status: matched.status === 'done' ? 'in_progress' : matched.status,
        nowDoing: `Working on: ${extractGoalFromPrompt(userPrompt)}`,
        nextAction: 'Produce the next actionable update',
        lastSessionId: sessionId,
        updatedAt: nowIso()
      }
      await this.storage.upsertTask(updated)
      return updated
    }

    const created: V2TaskState = {
      taskId: `task_${key || Date.now().toString(36)}`,
      projectId,
      status: 'in_progress',
      currentGoal: extractGoalFromPrompt(userPrompt),
      nowDoing: `Working on: ${extractGoalFromPrompt(userPrompt)}`,
      blockedBy: [],
      nextAction: 'Analyze relevant files and propose concrete edits',
      lastSessionId: sessionId,
      updatedAt: nowIso()
    }

    await this.storage.upsertTask(created)
    return created
  }

  async updateAfterAssistant(projectId: string, taskId: string, sessionId: string, assistantOutput: string): Promise<V2TaskState | null> {
    const task = await this.storage.getTask(projectId, taskId)
    if (!task) return null

    const blockers = inferBlockedBy(assistantOutput)
    const updated: V2TaskState = {
      ...task,
      status: blockers.length > 0 ? 'blocked' : 'in_progress',
      blockedBy: blockers,
      nowDoing: blockers.length > 0 ? 'Waiting for blocker resolution' : 'Continuing implementation',
      nextAction: blockers.length > 0
        ? 'Resolve blockers then continue'
        : 'Proceed to next concrete change and verification',
      lastSessionId: sessionId,
      updatedAt: nowIso()
    }

    await this.storage.upsertTask(updated)
    return updated
  }

  toAnchor(task: V2TaskState | null): V2TaskAnchor {
    if (!task) {
      return {
        currentGoal: 'Not set yet',
        nowDoing: 'Understanding the request',
        blockedBy: [],
        nextAction: 'Identify the first concrete step'
      }
    }

    return {
      currentGoal: task.currentGoal,
      nowDoing: task.nowDoing,
      blockedBy: task.blockedBy,
      nextAction: task.nextAction
    }
  }

  buildContinuitySummary(task: V2TaskState | null): string {
    const anchor = this.toAnchor(task)
    return `Goal=${anchor.currentGoal}; Doing=${anchor.nowDoing}; Blocked=${anchor.blockedBy.join('|') || 'none'}; Next=${anchor.nextAction}`
  }
}
