import { listFocusEntries, addFocusEntry, removeFocusEntry, clearFocusEntries, pruneExpiredFocusAtTurnBoundary } from '../memory-v2/store.js'
import type { FocusEntry, FocusRefType } from '../types.js'

export interface FocusAddResult {
  success: boolean
  entry?: FocusEntry
  error?: string
}

export interface FocusListResult {
  success: boolean
  entries: FocusEntry[]
}

export interface FocusRemoveResult {
  success: boolean
  removed: boolean
}

export interface FocusPruneResult {
  success: boolean
  expired: number
  kept: number
}

export function focusAdd(
  projectPath: string,
  params: {
    sessionId: string
    refType: FocusRefType
    refId: string
    reason: string
    score?: number
    source?: 'manual' | 'auto'
    ttl?: string
  }
): FocusAddResult {
  const result = addFocusEntry(projectPath, {
    sessionId: params.sessionId,
    refType: params.refType,
    refId: params.refId,
    reason: params.reason,
    score: params.score ?? 1,
    source: params.source ?? 'manual',
    ttl: params.ttl ?? '2h'
  })

  if (!result.ok || !result.entry) {
    return { success: false, error: result.reason ?? 'Failed to add focus entry.' }
  }

  return { success: true, entry: result.entry }
}

export function focusList(projectPath: string, sessionId: string): FocusListResult {
  return {
    success: true,
    entries: listFocusEntries(projectPath, sessionId)
  }
}

export function focusRemove(projectPath: string, sessionId: string, idOrRef: string): FocusRemoveResult {
  return {
    success: true,
    removed: removeFocusEntry(projectPath, sessionId, idOrRef)
  }
}

export function focusClear(projectPath: string, sessionId: string): FocusRemoveResult {
  clearFocusEntries(projectPath, sessionId)
  return { success: true, removed: true }
}

export function focusPrune(projectPath: string, sessionId: string): FocusPruneResult {
  const result = pruneExpiredFocusAtTurnBoundary(projectPath, sessionId)
  return {
    success: true,
    expired: result.expired,
    kept: result.kept
  }
}
