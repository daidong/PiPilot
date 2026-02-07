import { KernelV2Storage } from '../../../src/kernel-v2/storage.js'
import type { V2TaskState } from '../../../src/kernel-v2/types.js'
import type { TaskAnchor } from '../types.js'

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeBlockedBy(input?: string[]): string[] {
  if (!Array.isArray(input)) return []
  return input.map(item => item.trim()).filter(Boolean)
}

function toAnchor(task: V2TaskState | null, sessionId: string): TaskAnchor {
  if (!task) {
    return {
      currentGoal: 'Not set yet',
      nowDoing: 'Understand the latest request',
      blockedBy: [],
      nextAction: 'Identify the next concrete step',
      updatedAt: nowIso(),
      sessionId
    }
  }

  return {
    currentGoal: task.currentGoal,
    nowDoing: task.nowDoing,
    blockedBy: normalizeBlockedBy(task.blockedBy),
    nextAction: task.nextAction,
    updatedAt: task.updatedAt,
    sessionId
  }
}

async function resolveProjectId(storage: KernelV2Storage, sessionId: string): Promise<string> {
  const bound = await storage.getBoundProjectId(sessionId)
  if (bound) return bound

  const created = await storage.getOrCreateProject()
  await storage.bindSessionToProject(sessionId, created.projectId)
  return created.projectId
}

async function resolveActiveTask(storage: KernelV2Storage, projectId: string): Promise<V2TaskState | null> {
  const tasks = await storage.listTasks(projectId)
  if (tasks.length === 0) return null
  return tasks.find(task => task.status !== 'done') ?? tasks[0] ?? null
}

async function upsertAnchorTask(
  storage: KernelV2Storage,
  projectId: string,
  sessionId: string,
  next: Omit<TaskAnchor, 'updatedAt' | 'sessionId'>
): Promise<V2TaskState> {
  const existing = await resolveActiveTask(storage, projectId)
  const blockedBy = normalizeBlockedBy(next.blockedBy)
  const status = blockedBy.length > 0 ? 'blocked' : 'in_progress'
  const updatedAt = nowIso()

  const task: V2TaskState = existing
    ? {
        ...existing,
        currentGoal: next.currentGoal,
        nowDoing: next.nowDoing,
        blockedBy,
        nextAction: next.nextAction,
        status,
        lastSessionId: sessionId,
        updatedAt
      }
    : {
        taskId: `task_manual_${Date.now().toString(36)}`,
        projectId,
        status,
        currentGoal: next.currentGoal,
        nowDoing: next.nowDoing,
        blockedBy,
        nextAction: next.nextAction,
        lastSessionId: sessionId,
        updatedAt
      }

  await storage.upsertTask(task)
  return task
}

export async function readKernelTaskAnchor(projectPath: string, sessionId: string): Promise<TaskAnchor> {
  const storage = new KernelV2Storage(projectPath)
  await storage.init()
  const projectId = await resolveProjectId(storage, sessionId)
  const task = await resolveActiveTask(storage, projectId)
  return toAnchor(task, sessionId)
}

export async function setKernelTaskAnchor(
  projectPath: string,
  sessionId: string,
  anchor: Omit<TaskAnchor, 'updatedAt' | 'sessionId'>
): Promise<TaskAnchor> {
  const storage = new KernelV2Storage(projectPath)
  await storage.init()
  const projectId = await resolveProjectId(storage, sessionId)
  const task = await upsertAnchorTask(storage, projectId, sessionId, anchor)
  return toAnchor(task, sessionId)
}

export async function updateKernelTaskAnchor(
  projectPath: string,
  sessionId: string,
  patch: Partial<Omit<TaskAnchor, 'updatedAt' | 'sessionId'>>
): Promise<TaskAnchor> {
  const storage = new KernelV2Storage(projectPath)
  await storage.init()
  const projectId = await resolveProjectId(storage, sessionId)
  const existing = await resolveActiveTask(storage, projectId)
  const base = toAnchor(existing, sessionId)

  const next: Omit<TaskAnchor, 'updatedAt' | 'sessionId'> = {
    currentGoal: typeof patch.currentGoal === 'string' ? patch.currentGoal : base.currentGoal,
    nowDoing: typeof patch.nowDoing === 'string' ? patch.nowDoing : base.nowDoing,
    blockedBy: patch.blockedBy ? normalizeBlockedBy(patch.blockedBy) : base.blockedBy,
    nextAction: typeof patch.nextAction === 'string' ? patch.nextAction : base.nextAction
  }

  const task = await upsertAnchorTask(storage, projectId, sessionId, next)
  return toAnchor(task, sessionId)
}

