import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Message } from '../llm/index.js'
import type { MemoryNamespace } from '../types/memory.js'
import { countTokens } from '../utils/tokenizer.js'
import type {
  KernelV2Config,
  KernelV2IntegrityReport,
  KernelV2ReplayPayload,
  KernelV2ReplayRef,
  KernelV2ResolvedConfig,
  KernelV2TelemetryEvent,
  V2ContextAssemblyResult,
  V2ContinuityRecord,
  V2MemoryWriteCandidate,
  V2ProjectRecord,
  V2TaskAnchor,
  V2TaskState,
  V2ArtifactRecord,
  KernelV2TurnCompletionInput,
  KernelV2TurnInput,
  V2TurnRecord
} from './types.js'
import { resolveKernelV2Config } from './defaults.js'
import { KernelV2Storage } from './storage.js'
import { TaskStateCoordinator } from './task-state.js'
import { MemoryWriteGateV2 } from './memory-write-gate-v2.js'
import { ContextAssemblerV2 } from './context-assembler-v2.js'
import { CompactionEngineV2 } from './compaction-engine-v2.js'
import { KernelV2MemoryStorageAdapter } from './memory-storage-adapter.js'
import { KernelV2Telemetry } from './telemetry.js'
import { MemoryLifecycleManager, type LifecycleReport } from './lifecycle.js'

export interface KernelV2 {
  readonly config: KernelV2ResolvedConfig
  init(): Promise<void>
  runTurn(input: KernelV2TurnInput, completion?: KernelV2TurnCompletionInput): Promise<{ projectId: string; task: V2TaskState; context: V2ContextAssemblyResult }>
  beginTurn(params: {
    sessionId: string
    userPrompt: string
    systemPromptTokens: number
    toolSchemasTokens: number
    selectedContext?: string
    additionalInstructions?: string
  }): Promise<{ projectId: string; task: V2TaskState; context: V2ContextAssemblyResult }>
  completeTurn(params: {
    sessionId: string
    messages: Message[]
    promptTokens: number
  }): Promise<void>
  replay(ref: KernelV2ReplayRef, options?: { sessionId?: string; projectId?: string }): Promise<KernelV2ReplayPayload>
  getTaskState(projectId: string, taskId: string): Promise<V2TaskState | null>
  listActiveTasks(projectId: string): Promise<V2TaskState[]>
  getSessionContinuity(projectId: string, sessionId: string): Promise<V2ContinuityRecord | null>
  resolveProject(input: { sessionId: string; projectId?: string }): Promise<V2ProjectRecord>
  switchProject(projectId: string, sessionId: string): Promise<void>
  getMemoryStorage(sessionId: string): KernelV2MemoryStorageAdapter
  putMemory(params: {
    sessionId: string
    namespace: MemoryNamespace
    key: string
    value: unknown
    valueText?: string
    sourceType: 'user' | 'tool' | 'turn'
  }): Promise<void>
  verifyIntegrity(scope?: 'workspace' | 'project' | 'file'): Promise<KernelV2IntegrityReport>
  runMemoryLifecycle(mode: 'weekly' | 'on-demand', projectId?: string): Promise<LifecycleReport>
  destroy(): Promise<void>
  addArtifact(params: {
    sessionId: string
    type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content'
    path: string
    mimeType: string
    summary: string
    sourceRef: string
  }): Promise<V2ArtifactRecord>
}

function toText(content: Message['content']): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function normalizeRole(role: Message['role']): 'user' | 'assistant' | 'tool' | null {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role
  return null
}

function shouldPersistAsConversation(role: 'user' | 'assistant' | 'tool', content: string): boolean {
  if (!content.trim()) return false
  if (role !== 'user') return true
  if (content.includes('[REFERENCE MATERIAL]')) return false
  if (content.includes('<accumulated-findings>')) return false
  return true
}

function trimTextByTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  if (countTokens(text) <= maxTokens) return { text, truncated: false }

  const lines = text.split('\n')
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const lineTokens = countTokens(line)
    if (used + lineTokens > maxTokens) {
      break
    }
    kept.push(line)
    used += lineTokens
  }
  return { text: kept.join('\n'), truncated: true }
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath)
  const normalizedTarget = path.resolve(targetPath)
  if (normalizedRoot === normalizedTarget) return true
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
}

function taskAnchorToText(anchor: V2TaskAnchor): string {
  return [
    `CurrentGoal: ${anchor.currentGoal}`,
    `NowDoing: ${anchor.nowDoing}`,
    `BlockedBy: ${anchor.blockedBy.length > 0 ? anchor.blockedBy.join('; ') : 'None'}`,
    `NextAction: ${anchor.nextAction}`
  ].join('\n')
}

function createMinimalTask(projectId: string, sessionId: string, userPrompt: string): V2TaskState {
  const trimmed = userPrompt.trim()
  const goal = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : (trimmed || 'Handle current user request')
  return {
    taskId: `minimal_${Date.now().toString(36)}`,
    projectId,
    status: 'in_progress',
    currentGoal: goal,
    nowDoing: 'Using minimal profile (no task-state persistence)',
    blockedBy: [],
    nextAction: 'Continue with current user request',
    lastSessionId: sessionId,
    updatedAt: new Date().toISOString()
  }
}

function buildMinimalContinuitySummary(assistantText: string): string {
  const condensed = assistantText
    .replace(/\s+/g, ' ')
    .trim()
  if (!condensed) return 'No assistant output yet.'
  return condensed.length > 220 ? `${condensed.slice(0, 217)}...` : condensed
}

function createSkippedLifecycleReport(mode: 'weekly' | 'on-demand'): LifecycleReport {
  const timestamp = new Date().toISOString()
  return {
    mode,
    startedAt: timestamp,
    finishedAt: timestamp,
    consolidated: 0,
    deprecated: 0,
    archived: 0
  }
}

export class KernelV2Impl implements KernelV2 {
  readonly config: KernelV2ResolvedConfig

  private readonly storage: KernelV2Storage
  private readonly taskCoordinator: TaskStateCoordinator
  private readonly gate: MemoryWriteGateV2
  private readonly assembler: ContextAssemblerV2
  private readonly compaction: CompactionEngineV2
  private readonly telemetry: KernelV2Telemetry
  private readonly lifecycle: MemoryLifecycleManager
  private readonly activeProjectBySession = new Map<string, string>()
  private readonly activeTaskBySession = new Map<string, string>()
  private readonly failSafeBySession = new Map<string, boolean>()

  constructor(
    private readonly projectPath: string,
    config: KernelV2Config | undefined,
    contextWindow: number,
    modelId: string,
    private readonly debug = false
  ) {
    this.config = resolveKernelV2Config(config, contextWindow, modelId)
    this.telemetry = new KernelV2Telemetry(projectPath, this.config, this.debug)

    this.storage = new KernelV2Storage(projectPath)
    this.taskCoordinator = new TaskStateCoordinator(this.storage)
    this.gate = new MemoryWriteGateV2(this.storage, {
      maxWritesPerTurn: this.config.memory.writeGate.maxWritesPerTurn,
      maxWritesPerSession: this.config.memory.writeGate.maxWritesPerSession,
      preFlushReserve: this.config.compaction.preFlush.writeReserve
    }, (event) => this.emit(event))
    this.assembler = new ContextAssemblerV2(this.storage, this.config, (event) => this.emit(event))
    this.compaction = new CompactionEngineV2(this.storage, this.gate, this.config, (event) => this.emit(event))
    this.lifecycle = new MemoryLifecycleManager(projectPath, this.storage, this.config, (event) => this.emit(event))
  }

  private emit(event: KernelV2TelemetryEvent): void {
    this.telemetry.emit(event)
  }

  async init(): Promise<void> {
    await this.storage.init()

    if (this.config.storage.integrity.verifyOnStartup) {
      const integrity = await this.storage.verifyIntegrity()
      if (integrity.ok) {
        this.emit({
          event: 'storage.integrity.check.ok',
          payload: { root: this.projectPath },
          message: 'storage-integrity ok'
        })
      } else {
        this.emit({
          event: 'storage.integrity.check.failed',
          payload: { issues: integrity.issues.length },
          message: `storage-integrity failed issues=${integrity.issues.length}`
        })

        const recovery = await this.storage.recoverIntegrity({
          autoTruncateToLastValidRecord: this.config.storage.recovery.autoTruncateToLastValidRecord,
          createRecoverySnapshot: this.config.storage.recovery.createRecoverySnapshot
        })
        this.emit({
          event: 'storage.recovery.applied',
          payload: {
            recovered: recovery.recovered,
            failed: recovery.failed,
            issues: recovery.issues.length
          },
          message: `storage-recovery recovered=${recovery.recovered} failed=${recovery.failed}`
        })
      }
    }

    if (this.config.profile === 'legacy') {
      const lifecycleReport = await this.lifecycle.maybeRunWeekly()
      if (lifecycleReport) {
        this.emit({
          event: 'memory.lifecycle.weekly',
          payload: lifecycleReport as unknown as Record<string, unknown>,
          message: `weekly-lifecycle consolidated=${lifecycleReport.consolidated} deprecated=${lifecycleReport.deprecated} archived=${lifecycleReport.archived}`
        })
      }
    } else {
      this.emit({
        event: 'memory.lifecycle.skipped',
        payload: { profile: this.config.profile, reason: 'minimal-profile' },
        message: `memory-lifecycle skipped profile=${this.config.profile}`
      })
    }
  }

  async verifyIntegrity(scope: 'workspace' | 'project' | 'file' = 'workspace'): Promise<KernelV2IntegrityReport> {
    const result = await this.storage.verifyIntegrity()
    return {
      ok: result.ok,
      checkedAt: new Date().toISOString(),
      scope,
      issues: result.issues
    }
  }

  async runMemoryLifecycle(mode: 'weekly' | 'on-demand', _projectId?: string): Promise<LifecycleReport> {
    if (this.config.profile !== 'legacy') {
      const report = createSkippedLifecycleReport(mode)
      this.emit({
        event: 'memory.lifecycle.skipped',
        payload: { profile: this.config.profile, mode },
        message: `memory-lifecycle skipped profile=${this.config.profile} mode=${mode}`
      })
      return report
    }
    return this.lifecycle.run(mode)
  }

  async destroy(): Promise<void> {
    await this.telemetry.flush()
  }

  async addArtifact(params: {
    sessionId: string
    type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content'
    path: string
    mimeType: string
    summary: string
    sourceRef: string
  }): Promise<V2ArtifactRecord> {
    const projectId = await this.ensureProject(params.sessionId)
    const artifact = await this.storage.addArtifact({
      projectId,
      type: params.type,
      path: params.path,
      mimeType: params.mimeType,
      summary: params.summary,
      sourceRef: params.sourceRef
    })

    this.emit({
      event: 'artifact.added',
      payload: {
        sessionId: params.sessionId,
        projectId,
        artifactId: artifact.id,
        type: artifact.type
      },
      message: `artifact added id=${artifact.id} type=${artifact.type}`
    })

    return artifact
  }

  async runTurn(input: KernelV2TurnInput, completion?: KernelV2TurnCompletionInput): Promise<{ projectId: string; task: V2TaskState; context: V2ContextAssemblyResult }> {
    const turn = await this.beginTurn(input)
    if (completion) {
      const messages: Message[] = completion.messages.map(message => ({
        role: message.role,
        content: message.content
      }))
      await this.completeTurn({
        sessionId: input.sessionId,
        messages,
        promptTokens: completion.promptTokens
      })
    }
    return turn
  }

  private async ensureProject(sessionId: string): Promise<string> {
    const cached = this.activeProjectBySession.get(sessionId)
    if (cached) return cached

    const bound = await this.storage.getBoundProjectId(sessionId)
    if (bound) {
      this.activeProjectBySession.set(sessionId, bound)
      return bound
    }

    const project = await this.storage.getOrCreateProject()
    await this.storage.bindSessionToProject(sessionId, project.projectId)
    this.activeProjectBySession.set(sessionId, project.projectId)
    return project.projectId
  }

  getMemoryStorage(sessionId: string): KernelV2MemoryStorageAdapter {
    return new KernelV2MemoryStorageAdapter(this.gate, () => sessionId)
  }

  async putMemory(params: {
    sessionId: string
    namespace: MemoryNamespace
    key: string
    value: unknown
    valueText?: string
    sourceType: 'user' | 'tool' | 'turn'
  }): Promise<void> {
    await this.gate.writeCandidate({
      namespace: params.namespace,
      key: params.key,
      value: params.value,
      valueText: params.valueText,
      sourceType: params.sourceType === 'user' ? 'user' : (params.sourceType === 'tool' ? 'tool' : 'turn'),
      sourceRef: `${params.sourceType}:${params.namespace}:${params.key}`,
      createdBy: params.sourceType === 'user' ? 'user' : 'model',
      confidence: 0.9
    }, params.sessionId, 'normal')
  }

  async beginTurn(params: {
    sessionId: string
    userPrompt: string
    systemPromptTokens: number
    toolSchemasTokens: number
    selectedContext?: string
    additionalInstructions?: string
  }): Promise<{ projectId: string; task: V2TaskState; context: V2ContextAssemblyResult }> {
    this.gate.beginTurn()
    const isLegacyProfile = this.config.profile === 'legacy'

    const projectId = await this.ensureProject(params.sessionId)

    const userTurn = await this.storage.appendTurn(params.sessionId, {
      role: 'user',
      content: params.userPrompt
    })

    const task = isLegacyProfile
      ? await this.taskCoordinator.resolveOrCreate(projectId, params.sessionId, params.userPrompt)
      : createMinimalTask(projectId, params.sessionId, params.userPrompt)
    if (isLegacyProfile) {
      this.activeTaskBySession.set(params.sessionId, task.taskId)
    } else {
      this.activeTaskBySession.delete(params.sessionId)
    }

    const context = await this.assembler.assemble(params.sessionId, projectId, {
      systemPromptTokens: params.systemPromptTokens,
      toolSchemasTokens: params.toolSchemasTokens,
      selectedContext: params.selectedContext,
      additionalInstructions: params.additionalInstructions,
      query: params.userPrompt
    })

    this.emit({
      event: 'context.protected_zone.kept',
      payload: {
        sessionId: params.sessionId,
        protectedTurnsRequested: context.protectedTurnsRequested,
        protectedTurnsKept: context.protectedTurnsKept,
        protectedTurnsDropped: context.protectedTurnsDropped,
        degraded: context.degradedZones
      },
      message: `protected-zone kept=${context.protectedTurnsKept} dropped=${context.protectedTurnsDropped} degraded=${context.degradedZones.join(',') || 'none'}`
    })

    if (context.protectedTurnsDropped > 0) {
      this.emit({
        event: 'context.protected_zone.dropped',
        payload: {
          sessionId: params.sessionId,
          protectedTurnsRequested: context.protectedTurnsRequested,
          protectedTurnsKept: context.protectedTurnsKept,
          protectedTurnsDropped: context.protectedTurnsDropped
        },
        message: `protected-zone dropped=${context.protectedTurnsDropped}`
      })
    }

    const wasFailSafe = this.failSafeBySession.get(params.sessionId) ?? false
    if (context.failSafeMode && !wasFailSafe) {
      this.emit({
        event: 'context.failsafe.entered',
        payload: { sessionId: params.sessionId },
        message: `failsafe entered session=${params.sessionId}`
      })
    }
    if (!context.failSafeMode && wasFailSafe) {
      this.emit({
        event: 'context.failsafe.exited',
        payload: { sessionId: params.sessionId },
        message: `failsafe exited session=${params.sessionId}`
      })
    }
    this.failSafeBySession.set(params.sessionId, context.failSafeMode)

    if (isLegacyProfile) {
      this.emit({
        event: 'task.anchor.injected',
        payload: {
          sessionId: params.sessionId,
          taskId: task.taskId,
          anchor: context.taskAnchor
        },
        message: `task-anchor injected task=${task.taskId}`
      })

      await this.gate.writeCandidate({
        namespace: 'task',
        key: `${task.taskId}.goal`,
        value: {
          currentGoal: task.currentGoal,
          nowDoing: task.nowDoing,
          nextAction: task.nextAction,
          blockedBy: task.blockedBy
        },
        valueText: `Task anchor for ${task.taskId}`,
        sourceType: 'turn',
        sourceRef: userTurn.id,
        createdBy: 'model',
        confidence: 0.8,
        overwrite: true
      }, params.sessionId)
    }

    return { projectId, task, context }
  }

  private extractConversationTurns(messages: Message[]): Array<{ role: 'assistant' | 'tool'; content: string }> {
    const out: Array<{ role: 'assistant' | 'tool'; content: string }> = []

    for (const msg of messages) {
      const role = normalizeRole(msg.role)
      if (!role || role === 'user') continue
      const text = toText(msg.content)
      if (!shouldPersistAsConversation(role, text)) continue
      out.push({ role, content: text })
    }

    return out
  }

  async completeTurn(params: {
    sessionId: string
    messages: Message[]
    promptTokens: number
  }): Promise<void> {
    const isLegacyProfile = this.config.profile === 'legacy'
    const projectId = await this.ensureProject(params.sessionId)

    const conversationTurns = this.extractConversationTurns(params.messages)
    const persisted: V2TurnRecord[] = []
    for (const item of conversationTurns) {
      const turn = await this.storage.appendTurn(params.sessionId, {
        role: item.role,
        content: item.content
      })
      persisted.push(turn)
    }

    const assistantText = conversationTurns
      .filter(t => t.role === 'assistant')
      .map(t => t.content)
      .join('\n')

    const taskId = isLegacyProfile
      ? this.activeTaskBySession.get(params.sessionId)
      : undefined
    const updatedTask = (isLegacyProfile && taskId)
      ? await this.taskCoordinator.updateAfterAssistant(projectId, taskId, params.sessionId, assistantText)
      : null

    const continuitySummary = isLegacyProfile
      ? this.taskCoordinator.buildContinuitySummary(updatedTask)
      : buildMinimalContinuitySummary(assistantText)
    await this.storage.writeContinuity({
      id: `cont_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      sessionId: params.sessionId,
      summary: continuitySummary,
      activeTaskIds: (isLegacyProfile && updatedTask) ? [updatedTask.taskId] : [],
      carryOverNextActions: (isLegacyProfile && updatedTask?.nextAction) ? [updatedTask.nextAction] : [],
      knownBlockers: (isLegacyProfile && updatedTask?.blockedBy) ? updatedTask.blockedBy : [],
      createdAt: new Date().toISOString()
    })

    const preFlushCandidates: V2MemoryWriteCandidate[] = (isLegacyProfile && updatedTask)
      ? [{
          namespace: 'task',
          key: `${updatedTask.taskId}.checkpoint`,
          value: {
            currentGoal: updatedTask.currentGoal,
            nowDoing: updatedTask.nowDoing,
            nextAction: updatedTask.nextAction,
            blockedBy: updatedTask.blockedBy
          },
          valueText: `Checkpoint for ${updatedTask.taskId}`,
          sourceType: 'turn',
          sourceRef: persisted[persisted.length - 1]?.id ?? `session:${params.sessionId}`,
          createdBy: 'model',
          confidence: 0.7,
          overwrite: true
        }]
      : []

    const compacted = await this.compaction.maybeCompact({
      sessionId: params.sessionId,
      promptTokens: params.promptTokens,
      protectedRecentTurns: this.config.context.protectedRecentTurns,
      preFlushCandidates
    })

    if (compacted.compacted) {
      this.emit({
        event: 'context.degradation.applied',
        payload: { sessionId: params.sessionId, segmentId: compacted.segment?.id },
        message: `compaction applied segment=${compacted.segment?.id ?? 'unknown'}`
      })
    }
  }

  async getTaskState(projectId: string, taskId: string): Promise<V2TaskState | null> {
    if (this.config.profile !== 'legacy') return null
    return this.storage.getTask(projectId, taskId)
  }

  async listActiveTasks(projectId: string): Promise<V2TaskState[]> {
    if (this.config.profile !== 'legacy') return []
    const tasks = await this.storage.listTasks(projectId)
    return tasks.filter(task => task.status !== 'done')
  }

  async getSessionContinuity(projectId: string, sessionId: string): Promise<V2ContinuityRecord | null> {
    return this.storage.getContinuity(projectId, sessionId)
  }

  async resolveProject(input: { sessionId: string; projectId?: string }): Promise<V2ProjectRecord> {
    if (input.projectId) {
      const explicit = await this.storage.getProject(input.projectId)
      if (!explicit) {
        throw new Error(`Project not found: ${input.projectId}`)
      }
      await this.storage.bindSessionToProject(input.sessionId, explicit.projectId)
      this.activeProjectBySession.set(input.sessionId, explicit.projectId)
      return explicit
    }

    const projectId = await this.ensureProject(input.sessionId)
    const project = await this.storage.getProject(projectId)
    if (!project) {
      throw new Error(`Project not found after resolution: ${projectId}`)
    }
    return project
  }

  async switchProject(projectId: string, sessionId: string): Promise<void> {
    const project = await this.storage.getProject(projectId)
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const currentProjectId = await this.ensureProject(sessionId)
    if (currentProjectId !== projectId) {
      const activeTaskId = this.config.profile === 'legacy'
        ? this.activeTaskBySession.get(sessionId)
        : undefined
      const activeTask = activeTaskId
        ? await this.storage.getTask(currentProjectId, activeTaskId)
        : null
      const summary = this.config.profile === 'legacy'
        ? this.taskCoordinator.buildContinuitySummary(activeTask)
        : 'Switched active project context.'
      await this.storage.writeContinuity({
        id: `cont_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        projectId: currentProjectId,
        sessionId,
        summary,
        activeTaskIds: (this.config.profile === 'legacy' && activeTask) ? [activeTask.taskId] : [],
        carryOverNextActions: (this.config.profile === 'legacy' && activeTask?.nextAction) ? [activeTask.nextAction] : [],
        knownBlockers: (this.config.profile === 'legacy' && activeTask?.blockedBy) ? activeTask.blockedBy : [],
        createdAt: new Date().toISOString()
      })
    }

    await this.storage.bindSessionToProject(sessionId, project.projectId)
    this.activeProjectBySession.set(sessionId, project.projectId)
    this.activeTaskBySession.delete(sessionId)
  }

  async replay(ref: KernelV2ReplayRef, options?: { sessionId?: string; projectId?: string }): Promise<KernelV2ReplayPayload> {
    if (ref.type === 'url') {
      return {
        found: true,
        ref,
        source: 'url',
        content: ref.value
      }
    }

    if (ref.type === 'path') {
      const filePath = path.isAbsolute(ref.value)
        ? path.resolve(ref.value)
        : path.resolve(this.projectPath, ref.value)
      if (!isWithinRoot(this.projectPath, filePath)) {
        return {
          found: false,
          ref,
          source: 'filesystem',
          content: ''
        }
      }
      try {
        const raw = await fs.readFile(filePath, 'utf-8')
        const trimmed = trimTextByTokens(raw, this.config.retrieval.rawScanLimitTokens)
        return {
          found: true,
          ref,
          source: 'filesystem',
          content: trimmed.text,
          truncated: trimmed.truncated,
          metadata: {
            path: filePath
          }
        }
      } catch {
        return {
          found: false,
          ref,
          source: 'filesystem',
          content: ''
        }
      }
    }

    const memoryFacts = await this.storage.listMemoryFacts()
    const memoryFact = memoryFacts.find(fact => fact.id === ref.value)
    if (memoryFact) {
      return {
        found: true,
        ref,
        source: 'memory',
        content: `${memoryFact.namespace}:${memoryFact.key}\n${memoryFact.valueText ?? JSON.stringify(memoryFact.value, null, 2)}`,
        metadata: {
          status: memoryFact.status,
          updatedAt: memoryFact.updatedAt
        }
      }
    }

    const projectIds = options?.projectId
      ? [options.projectId]
      : (await this.storage.listProjects()).map(project => project.projectId)
    for (const projectId of projectIds) {
      const task = await this.storage.getTask(projectId, ref.value)
      if (task) {
        return {
          found: true,
          ref,
          source: 'task',
          content: taskAnchorToText({
            currentGoal: task.currentGoal,
            nowDoing: task.nowDoing,
            blockedBy: task.blockedBy,
            nextAction: task.nextAction
          }),
          metadata: {
            projectId,
            status: task.status,
            updatedAt: task.updatedAt
          }
        }
      }
    }

    const candidateSessions = options?.sessionId
      ? [options.sessionId]
      : await this.storage.listSessionIds()
    for (const sessionId of candidateSessions) {
      const segments = await this.storage.listCompactSegments(sessionId)
      const matched = segments.find(segment => segment.id === ref.value)
      if (matched) {
        return {
          found: true,
          ref,
          source: 'segment',
          content: matched.summary,
          metadata: {
            sessionId,
            turnRange: matched.turnRange,
            replayRefs: matched.replayRefs
          }
        }
      }
    }

    return {
      found: false,
      ref,
      source: 'unknown',
      content: ''
    }
  }
}

export function createKernelV2(params: {
  projectPath: string
  config: KernelV2Config | undefined
  contextWindow: number
  modelId: string
  debug?: boolean
}): KernelV2 {
  return new KernelV2Impl(
    params.projectPath,
    params.config,
    params.contextWindow,
    params.modelId,
    params.debug ?? false
  )
}
