/**
 * Personal Assistant Memory V2 Tools (RFC-013)
 */

import { existsSync } from 'fs'
import { defineTool } from '@framework/factories/define-tool.js'
import type { Tool } from '@framework/types/tool.js'
import type { ArtifactType, CLIContext } from '../types.js'
import {
  addFocusEntry,
  clearFocusEntries,
  createArtifact,
  linkFactToArtifacts,
  listFocusEntries,
  readTaskAnchor,
  removeFocusEntry,
  searchArtifacts,
  updateArtifact,
  updateTaskAnchor,
  unlinkFactFromArtifacts,
  pruneExpiredFocusAtTurnBoundary,
  type CreateArtifactInput
} from '../memory-v2/store.js'
import { memoryExplainBudget, memoryExplainFact, memoryExplainTurn } from '../commands/memory-explain.js'

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function maybeRegisterArtifactInKernel(
  runtime: { kernelV2?: unknown },
  params: {
    sessionId: string
    type: ArtifactType
    title: string
    path: string
    summary?: string
  }
): Promise<void> {
  const kernel = runtime.kernelV2 as {
    addArtifact?: (input: {
      sessionId: string
      type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content'
      path: string
      mimeType: string
      summary: string
      sourceRef: string
    }) => Promise<void>
  } | undefined

  if (!kernel?.addArtifact) return

  let type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content' = 'document'
  if (params.type === 'tool-output') type = 'tool-output'
  if (params.type === 'doc' || params.type === 'email-message' || params.type === 'email-thread') type = 'file-snapshot'

  await kernel.addArtifact({
    sessionId: params.sessionId,
    type,
    path: params.path,
    mimeType: 'application/json',
    summary: params.summary ?? params.title,
    sourceRef: `artifact:${params.type}:${params.title}`
  })
}

export function createArtifactCreateTool(sessionId: string, projectPath: string): Tool {
  return defineTool({
    name: 'artifact-create',
    description: 'Create an artifact (note, todo, doc, email-message, email-thread, calendar-event, scheduler-run, tool-output). Canonical persistence API for Personal Assistant Memory V2.',
    parameters: {
      type: {
        type: 'string',
        enum: ['note', 'todo', 'doc', 'email-message', 'email-thread', 'calendar-event', 'scheduler-run', 'tool-output'],
        required: true,
        description: 'Artifact type'
      },
      title: { type: 'string', required: true, description: 'Artifact title' },

      content: { type: 'string', required: false, description: 'Note/todo content' },
      status: { type: 'string', enum: ['pending', 'completed'], required: false, description: 'Todo status' },
      completedAt: { type: 'string', required: false, description: 'Todo completion time' },

      filePath: { type: 'string', required: false, description: 'Doc file path' },
      mimeType: { type: 'string', required: false, description: 'Doc MIME type' },
      description: { type: 'string', required: false, description: 'Doc description' },

      accountEmail: { type: 'string', required: false, description: 'Email account' },
      messageId: { type: 'string', required: false, description: 'Email message id' },
      threadId: { type: 'string', required: false, description: 'Email thread id' },
      from: { type: 'string', required: false, description: 'Sender' },
      to: { type: 'array', items: { type: 'string' }, required: false, description: 'Recipients' },
      cc: { type: 'array', items: { type: 'string' }, required: false, description: 'CC recipients' },
      subject: { type: 'string', required: false, description: 'Email subject' },
      snippet: { type: 'string', required: false, description: 'Email snippet' },
      bodyText: { type: 'string', required: false, description: 'Email body text' },
      sentAt: { type: 'string', required: false, description: 'Email sent timestamp' },

      participants: { type: 'array', items: { type: 'string' }, required: false, description: 'Thread participants' },
      latestSubject: { type: 'string', required: false, description: 'Thread latest subject' },
      latestSnippet: { type: 'string', required: false, description: 'Thread latest snippet' },
      messageCount: { type: 'number', required: false, description: 'Thread message count' },
      unreadCount: { type: 'number', required: false, description: 'Thread unread count' },

      eventId: { type: 'string', required: false, description: 'Calendar event id' },
      calendarName: { type: 'string', required: false, description: 'Calendar name' },
      startAt: { type: 'string', required: false, description: 'Event start (ISO)' },
      endAt: { type: 'string', required: false, description: 'Event end (ISO)' },
      location: { type: 'string', required: false, description: 'Event location' },
      attendees: { type: 'array', items: { type: 'string' }, required: false, description: 'Event attendees' },
      notes: { type: 'string', required: false, description: 'Event notes' },

      scheduledTaskId: { type: 'string', required: false, description: 'Scheduler task id' },
      instruction: { type: 'string', required: false, description: 'Scheduler instruction' },
      output: { type: 'string', required: false, description: 'Scheduler output' },
      error: { type: 'string', required: false, description: 'Scheduler error' },
      triggeredAt: { type: 'string', required: false, description: 'Scheduler run timestamp' },

      toolName: { type: 'string', required: false, description: 'Tool-output tool name' },
      outputPath: { type: 'string', required: false, description: 'Tool-output file path' },
      outputText: { type: 'string', required: false, description: 'Tool-output text' },

      tags: { type: 'array', items: { type: 'string' }, required: false, description: 'Artifact tags' },
      summary: { type: 'string', required: false, description: 'Artifact summary' }
    },
    execute: async (input, context) => {
      const args = input as Record<string, unknown>
      const type = String(args.type || '') as ArtifactType
      const title = String(args.title || '').trim()
      if (!title) return { success: false, error: 'title is required' }

      const cliContext: CLIContext = { sessionId, projectPath }

      let payload: CreateArtifactInput
      if (type === 'note') {
        payload = {
          type,
          title,
          content: String(args.content || ''),
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'agent-response' }
        }
      } else if (type === 'todo') {
        payload = {
          type,
          title,
          content: String(args.content || ''),
          status: (args.status as 'pending' | 'completed' | undefined) ?? 'pending',
          completedAt: typeof args.completedAt === 'string' ? args.completedAt : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'agent-response' }
        }
      } else if (type === 'doc') {
        const filePath = typeof args.filePath === 'string' ? args.filePath : ''
        if (!filePath) return { success: false, error: 'filePath is required for doc artifacts' }
        if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` }

        payload = {
          type,
          title,
          filePath,
          content: typeof args.content === 'string' ? args.content : undefined,
          mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
          description: typeof args.description === 'string' ? args.description : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'file-import' }
        }
      } else if (type === 'email-message') {
        payload = {
          type,
          title,
          accountEmail: typeof args.accountEmail === 'string' ? args.accountEmail : undefined,
          messageId: typeof args.messageId === 'string' ? args.messageId : undefined,
          threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
          from: typeof args.from === 'string' ? args.from : undefined,
          to: (args.to as string[] | undefined) ?? undefined,
          cc: (args.cc as string[] | undefined) ?? undefined,
          subject: typeof args.subject === 'string' ? args.subject : undefined,
          snippet: typeof args.snippet === 'string' ? args.snippet : undefined,
          bodyText: typeof args.bodyText === 'string' ? args.bodyText : undefined,
          sentAt: typeof args.sentAt === 'string' ? args.sentAt : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      } else if (type === 'email-thread') {
        const threadId = String(args.threadId || '').trim()
        if (!threadId) return { success: false, error: 'threadId is required for email-thread artifacts' }

        payload = {
          type,
          title,
          accountEmail: typeof args.accountEmail === 'string' ? args.accountEmail : undefined,
          threadId,
          participants: (args.participants as string[] | undefined) ?? undefined,
          latestSubject: typeof args.latestSubject === 'string' ? args.latestSubject : undefined,
          latestSnippet: typeof args.latestSnippet === 'string' ? args.latestSnippet : undefined,
          messageCount: typeof args.messageCount === 'number' ? args.messageCount : undefined,
          unreadCount: typeof args.unreadCount === 'number' ? args.unreadCount : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      } else if (type === 'calendar-event') {
        payload = {
          type,
          title,
          eventId: typeof args.eventId === 'string' ? args.eventId : undefined,
          calendarName: typeof args.calendarName === 'string' ? args.calendarName : undefined,
          startAt: typeof args.startAt === 'string' ? args.startAt : undefined,
          endAt: typeof args.endAt === 'string' ? args.endAt : undefined,
          location: typeof args.location === 'string' ? args.location : undefined,
          attendees: (args.attendees as string[] | undefined) ?? undefined,
          notes: typeof args.notes === 'string' ? args.notes : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      } else if (type === 'scheduler-run') {
        const instruction = typeof args.instruction === 'string' ? args.instruction : ''
        const status = (args.status as 'success' | 'failed' | undefined) ?? 'success'
        if (!instruction) return { success: false, error: 'instruction is required for scheduler-run artifacts' }

        payload = {
          type,
          title,
          scheduledTaskId: typeof args.scheduledTaskId === 'string' ? args.scheduledTaskId : undefined,
          instruction,
          status,
          output: typeof args.output === 'string' ? args.output : undefined,
          error: typeof args.error === 'string' ? args.error : undefined,
          triggeredAt: typeof args.triggeredAt === 'string' ? args.triggeredAt : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      } else {
        payload = {
          type: 'tool-output',
          title,
          toolName: typeof args.toolName === 'string' ? args.toolName : 'unknown',
          outputPath: typeof args.outputPath === 'string' ? args.outputPath : undefined,
          outputText: typeof args.outputText === 'string' ? args.outputText : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      }

      const { artifact, filePath } = createArtifact(payload, cliContext)
      await maybeRegisterArtifactInKernel(context.runtime, {
        sessionId,
        type: artifact.type,
        title: artifact.title,
        path: filePath,
        summary: artifact.summary
      })

      return {
        success: true,
        data: {
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          filePath
        }
      }
    }
  })
}

export function createArtifactUpdateTool(projectPath: string): Tool {
  return defineTool({
    name: 'artifact-update',
    description: 'Update fields for an existing artifact by id or id prefix.',
    parameters: {
      id: { type: 'string', required: true, description: 'Artifact id (full or prefix)' },
      title: { type: 'string', required: false, description: 'Updated title' },
      summary: { type: 'string', required: false, description: 'Updated summary' },
      tags: { type: 'array', items: { type: 'string' }, required: false, description: 'Updated tags' },
      content: { type: 'string', required: false, description: 'Updated content for note/todo/doc' },
      status: { type: 'string', enum: ['pending', 'completed'], required: false, description: 'Todo status' },
      completedAt: { type: 'string', required: false, description: 'Todo completion timestamp' },
      description: { type: 'string', required: false, description: 'Doc description' }
    },
    execute: async (input, context) => {
      const args = input as Record<string, unknown>
      const id = String(args.id || '')
      if (!id) return { success: false, error: 'id is required' }

      const updated = updateArtifact(projectPath, id, {
        title: typeof args.title === 'string' ? args.title : undefined,
        summary: typeof args.summary === 'string' ? args.summary : undefined,
        tags: (args.tags as string[] | undefined) ?? undefined,
        content: typeof args.content === 'string' ? args.content : undefined,
        status: args.status === 'pending' || args.status === 'completed' ? args.status : undefined,
        completedAt: typeof args.completedAt === 'string' ? args.completedAt : undefined,
        description: typeof args.description === 'string' ? args.description : undefined
      })

      if (!updated) {
        return { success: false, error: `Artifact not found: ${id}` }
      }

      await maybeRegisterArtifactInKernel(context.runtime, {
        sessionId: context.sessionId,
        type: updated.artifact.type,
        title: updated.artifact.title,
        path: updated.filePath,
        summary: updated.artifact.summary
      })

      return {
        success: true,
        data: {
          id: updated.artifact.id,
          type: updated.artifact.type,
          title: updated.artifact.title,
          filePath: updated.filePath
        }
      }
    }
  })
}

export function createArtifactSearchTool(projectPath: string): Tool {
  return defineTool({
    name: 'artifact-search',
    description: 'Search artifacts by query terms and return ranked hits.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
      type: {
        type: 'string',
        enum: ['note', 'todo', 'doc', 'email-message', 'email-thread', 'calendar-event', 'scheduler-run', 'tool-output'],
        required: false,
        description: 'Optional artifact type filter'
      }
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const query = String(args.query || '').trim()
      if (!query) return { success: false, error: 'query is required' }

      const type = typeof args.type === 'string' ? args.type as ArtifactType : undefined
      const hits = searchArtifacts(projectPath, query, type ? [type] : undefined)
      return {
        success: true,
        data: hits.slice(0, 20).map(hit => ({
          id: hit.artifact.id,
          type: hit.artifact.type,
          title: hit.artifact.title,
          score: hit.score,
          match: hit.match
        }))
      }
    }
  })
}

export function createFactPromoteTool(projectPath: string): Tool {
  return defineTool({
    name: 'fact-promote',
    description: 'Promote durable memory through MemoryWriteGateV2 with provenance and optional artifact lineage.',
    parameters: {
      namespace: { type: 'string', required: true, description: 'Fact namespace' },
      key: { type: 'string', required: true, description: 'Fact key in namespace' },
      valueText: { type: 'string', required: true, description: 'Human-readable fact content' },
      valueJson: { type: 'string', required: false, description: 'Optional JSON value payload' },
      tags: { type: 'array', items: { type: 'string' }, required: false, description: 'Fact tags' },
      confidence: { type: 'number', required: false, description: 'Confidence score (0-1)' },
      derivedFromArtifactIds: {
        type: 'array',
        items: { type: 'string' },
        required: false,
        description: 'Artifact ids that support this fact'
      }
    },
    execute: async (input, context) => {
      const args = input as Record<string, unknown>
      const namespace = String(args.namespace || '').trim()
      const key = String(args.key || '').trim()
      const valueText = String(args.valueText || '').trim()
      if (!namespace || !key || !valueText) {
        return { success: false, error: 'namespace, key, and valueText are required' }
      }

      const memoryStorage = context.runtime.memoryStorage
      if (!memoryStorage) {
        return { success: false, error: 'memoryStorage unavailable in runtime' }
      }

      const confidence = typeof args.confidence === 'number' ? args.confidence : 0.9
      const derivedFromArtifactIds = ((args.derivedFromArtifactIds as string[] | undefined) ?? []).filter(Boolean)
      const value = typeof args.valueJson === 'string'
        ? parseJsonSafely(args.valueJson)
        : { text: valueText, confidence, derivedFromArtifactIds }

      const item = await memoryStorage.put({
        namespace,
        key,
        value,
        valueText,
        tags: ['fact', ...((args.tags as string[] | undefined) ?? []), ...derivedFromArtifactIds.map(id => `artifact:${id}`)],
        overwrite: true,
        provenance: {
          createdBy: 'model',
          sessionId: context.sessionId
        }
      })

      if (derivedFromArtifactIds.length > 0) {
        linkFactToArtifacts(projectPath, item.id, derivedFromArtifactIds)
      }

      return {
        success: true,
        data: {
          id: item.id,
          namespace: item.namespace,
          key: item.key,
          status: item.status,
          derivedFromArtifactIds
        }
      }
    }
  })
}

export function createFactDemoteTool(projectPath: string): Tool {
  return defineTool({
    name: 'fact-demote',
    description: 'Demote a durable fact (status=deprecated) through MemoryWriteGateV2.',
    parameters: {
      namespace: { type: 'string', required: true, description: 'Fact namespace' },
      key: { type: 'string', required: true, description: 'Fact key' }
    },
    execute: async (input, context) => {
      const args = input as Record<string, unknown>
      const namespace = String(args.namespace || '').trim()
      const key = String(args.key || '').trim()
      if (!namespace || !key) {
        return { success: false, error: 'namespace and key are required' }
      }

      const memoryStorage = context.runtime.memoryStorage
      if (!memoryStorage) {
        return { success: false, error: 'memoryStorage unavailable in runtime' }
      }

      const existing = await memoryStorage.get(namespace, key)
      if (!existing) {
        return { success: false, error: `Fact not found: ${namespace}:${key}` }
      }

      await memoryStorage.update(namespace, key, { status: 'deprecated' })
      unlinkFactFromArtifacts(projectPath, existing.id)

      return {
        success: true,
        data: {
          id: existing.id,
          namespace,
          key,
          status: 'deprecated'
        }
      }
    }
  })
}

export function createFocusTools(projectPath: string, sessionId: string): Tool[] {
  const add = defineTool({
    name: 'focus-add',
    description: 'Add a focus entry (session-scoped attention) with TTL. Expiry is applied at turn boundary.',
    parameters: {
      refType: { type: 'string', enum: ['artifact', 'fact', 'task'], required: true, description: 'Reference type' },
      refId: { type: 'string', required: true, description: 'Reference id' },
      reason: { type: 'string', required: true, description: 'Why this should be focused now' },
      score: { type: 'number', required: false, description: 'Priority score (higher=more focus)' },
      source: { type: 'string', enum: ['manual', 'auto'], required: false, description: 'Focus source' },
      ttl: { type: 'string', required: false, description: 'TTL preset: 30m, 2h, today' }
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const result = addFocusEntry(projectPath, {
        sessionId,
        refType: String(args.refType || 'artifact') as 'artifact' | 'fact' | 'task',
        refId: String(args.refId || ''),
        reason: String(args.reason || ''),
        score: typeof args.score === 'number' ? args.score : 1,
        source: String(args.source || 'manual') as 'manual' | 'auto',
        ttl: String(args.ttl || '2h')
      })

      if (!result.ok || !result.entry) {
        return { success: false, error: result.reason ?? 'Unable to add focus' }
      }

      return { success: true, data: result.entry }
    }
  })

  const remove = defineTool({
    name: 'focus-remove',
    description: 'Remove a focus entry by id or refId.',
    parameters: {
      idOrRef: { type: 'string', required: true, description: 'Focus id or referenced id' }
    },
    execute: async (input) => {
      const { idOrRef } = input as { idOrRef: string }
      const removed = removeFocusEntry(projectPath, sessionId, idOrRef)
      return { success: true, data: { removed } }
    }
  })

  const list = defineTool({
    name: 'focus-list',
    description: 'List active focus entries for this session.',
    parameters: {},
    execute: async () => ({ success: true, data: listFocusEntries(projectPath, sessionId) })
  })

  const clear = defineTool({
    name: 'focus-clear',
    description: 'Clear all focus entries for this session.',
    parameters: {},
    execute: async () => {
      const count = clearFocusEntries(projectPath, sessionId)
      return { success: true, data: { cleared: count } }
    }
  })

  return [add, remove, list, clear]
}

export function createTaskAnchorTools(projectPath: string): Tool[] {
  const set = defineTool({
    name: 'task-anchor-set',
    description: 'Set full task anchor state (CurrentGoal, NowDoing, BlockedBy, NextAction).',
    parameters: {
      currentGoal: { type: 'string', required: true, description: 'CurrentGoal' },
      nowDoing: { type: 'string', required: true, description: 'NowDoing' },
      blockedBy: { type: 'array', items: { type: 'string' }, required: false, description: 'BlockedBy list' },
      nextAction: { type: 'string', required: true, description: 'NextAction' }
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const next = updateTaskAnchor(projectPath, {
        currentGoal: String(args.currentGoal || ''),
        nowDoing: String(args.nowDoing || ''),
        blockedBy: (args.blockedBy as string[] | undefined) ?? [],
        nextAction: String(args.nextAction || '')
      })
      return { success: true, data: next }
    }
  })

  const update = defineTool({
    name: 'task-anchor-update',
    description: 'Partially update task anchor fields.',
    parameters: {
      currentGoal: { type: 'string', required: false, description: 'CurrentGoal' },
      nowDoing: { type: 'string', required: false, description: 'NowDoing' },
      blockedBy: { type: 'array', items: { type: 'string' }, required: false, description: 'BlockedBy list' },
      nextAction: { type: 'string', required: false, description: 'NextAction' }
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const next = updateTaskAnchor(projectPath, {
        currentGoal: typeof args.currentGoal === 'string' ? args.currentGoal : undefined,
        nowDoing: typeof args.nowDoing === 'string' ? args.nowDoing : undefined,
        blockedBy: (args.blockedBy as string[] | undefined) ?? undefined,
        nextAction: typeof args.nextAction === 'string' ? args.nextAction : undefined
      })
      return { success: true, data: next }
    }
  })

  const get = defineTool({
    name: 'task-anchor-get',
    description: 'Get current task anchor.',
    parameters: {},
    execute: async () => ({ success: true, data: readTaskAnchor(projectPath) })
  })

  return [set, update, get]
}

export interface MemoryExplainProvider {
  getTurnExplain?: () => unknown
  getBudgetExplain?: () => unknown
}

export function createMemoryExplainTool(projectPath: string, provider?: MemoryExplainProvider): Tool {
  return defineTool({
    name: 'memory-explain',
    description: 'Explain memory/context behavior. mode=turn|fact|budget',
    parameters: {
      mode: {
        type: 'string',
        enum: ['turn', 'fact', 'budget'],
        required: true,
        description: 'Explain mode'
      },
      factId: {
        type: 'string',
        required: false,
        description: 'Fact id (required for mode=fact)'
      }
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const mode = String(args.mode || 'turn')

      if (mode === 'fact') {
        const factId = String(args.factId || '').trim()
        if (!factId) return { success: false, error: 'factId is required for mode=fact' }
        const explained = memoryExplainFact(projectPath, factId)
        return explained.success
          ? { success: true, data: explained.data }
          : { success: false, error: explained.error }
      }

      if (mode === 'budget') {
        const explained = provider?.getBudgetExplain
          ? { success: true, data: provider.getBudgetExplain() }
          : memoryExplainBudget(projectPath)
        return explained.success
          ? { success: true, data: explained.data }
          : { success: false, error: explained.error }
      }

      const explained = provider?.getTurnExplain
        ? { success: true, data: provider.getTurnExplain() }
        : memoryExplainTurn(projectPath)
      return explained.success
        ? { success: true, data: explained.data }
        : { success: false, error: explained.error }
    }
  })
}

export function createFocusPruneTool(projectPath: string, sessionId: string): Tool {
  return defineTool({
    name: 'focus-prune',
    description: 'Prune expired focus entries at turn boundary and apply cooldown for expired auto-focus entries.',
    parameters: {},
    execute: async () => {
      const result = pruneExpiredFocusAtTurnBoundary(projectPath, sessionId)
      return { success: true, data: result }
    }
  })
}

export function createPersonalMemoryTools(params: {
  sessionId: string
  projectPath: string
  explainProvider?: MemoryExplainProvider
}): Tool[] {
  return [
    createArtifactCreateTool(params.sessionId, params.projectPath),
    createArtifactUpdateTool(params.projectPath),
    createArtifactSearchTool(params.projectPath),
    createFactPromoteTool(params.projectPath),
    createFactDemoteTool(params.projectPath),
    ...createFocusTools(params.projectPath, params.sessionId),
    createFocusPruneTool(params.projectPath, params.sessionId),
    ...createTaskAnchorTools(params.projectPath),
    createMemoryExplainTool(params.projectPath, params.explainProvider)
  ]
}
