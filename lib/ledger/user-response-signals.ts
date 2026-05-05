/**
 * User-response signals ledger (telemetry-trace v0.10 §8.3).
 *
 * Records raw signals only — no `signal` enum, no `confidence`, no
 * approval/rejection labels. Layer 3 reads this ledger plus the trace's user
 * message events to classify what the user response *meant*. PiPilot runtime
 * never makes that classification.
 */

import { join } from 'node:path'
import { trace } from '@opentelemetry/api'
import { PATHS } from '../types.js'
import { appendJsonl } from '../telemetry/jsonl-writer.js'

export interface UserResponseSignalRow {
  turnId: string
  previousTurnId?: string
  previousAssistantMsgId?: string
  gapMsSincePreviousAssistant?: number
  messageContentHash: string
  messageCharLen: number
  referencedArtifactIds: string[]
  uiInteractionsSincePreviousAssistant?: Array<{
    kind: 'view' | 'hover' | 'scroll' | 'dismiss'
    target: string
    durationMs?: number
  }>
  sessionTerminatedAfterThis?: boolean
  traceId?: string
  timestamp: string
}

export interface UserResponseSignalsWriter {
  append(row: Omit<UserResponseSignalRow, 'timestamp' | 'traceId'> & {
    timestamp?: string
    traceId?: string
  }): Promise<boolean>
  readonly filePath: string
}

export function createUserResponseSignalsWriter(projectPath: string): UserResponseSignalsWriter {
  const filePath = join(projectPath, PATHS.userResponseSignals)
  return {
    filePath,
    async append(row) {
      let traceId = row.traceId
      if (!traceId) {
        const span = trace.getActiveSpan()
        traceId = span?.spanContext().traceId
      }
      const fullRow: UserResponseSignalRow = {
        turnId: row.turnId,
        previousTurnId: row.previousTurnId,
        previousAssistantMsgId: row.previousAssistantMsgId,
        gapMsSincePreviousAssistant: row.gapMsSincePreviousAssistant,
        messageContentHash: row.messageContentHash,
        messageCharLen: row.messageCharLen,
        referencedArtifactIds: row.referencedArtifactIds ?? [],
        uiInteractionsSincePreviousAssistant: row.uiInteractionsSincePreviousAssistant,
        sessionTerminatedAfterThis: row.sessionTerminatedAfterThis,
        traceId,
        timestamp: row.timestamp ?? new Date().toISOString()
      }
      for (const k of Object.keys(fullRow) as (keyof UserResponseSignalRow)[]) {
        if (fullRow[k] === undefined) delete fullRow[k]
      }
      return appendJsonl(filePath, fullRow, { onError: () => {} })
    }
  }
}
