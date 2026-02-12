import { readLatestSessionSummary } from '../memory-v2/store.js'
import type { SessionSummary } from '../types.js'

export interface SessionSummaryResult {
  success: boolean
  summary?: SessionSummary
  error?: string
}

export function sessionSummaryGet(projectPath: string, sessionId: string): SessionSummaryResult {
  try {
    const summary = readLatestSessionSummary(projectPath, sessionId)
    return { success: true, summary: summary ?? undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
