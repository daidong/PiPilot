/**
 * Memory ledger (telemetry-trace v0.10 §8.2).
 *
 * Append-only event log of memory ops. Coexists with the existing memory store.
 * Pure event log — every operation is a fact. No `state`, `confidence`,
 * `verifiedStatus`, `expirationTime`, `supersedes` fields (Layer 3 concerns,
 * removed in v0.3).
 *
 * `type` enum is descriptive of source, not evaluative:
 *   - user-stated-fact: came verbatim from a user message
 *   - extracted-claim: produced by the LLM extractor
 */

import { join } from 'node:path'
import { context, trace } from '@opentelemetry/api'
import { PATHS } from '../types.js'
import { appendJsonl } from '../telemetry/jsonl-writer.js'
import { TURN_ID_KEY } from '../telemetry/context-keys.js'

export type MemoryOp = 'search' | 'retrieve' | 'create' | 'update' | 'delete'
export type MemoryScope = 'session' | 'project' | 'user-global' | 'cross-project' | 'wiki'
/**
 * Source-descriptive categories. The first 4 (`user`, `feedback`, `project`,
 * `reference`) match the user-facing buckets exposed by the save-memory tool
 * (lib/memory/memory-tools.ts). The remaining 7 are inherited from the v0.3
 * spec for finer-grained provenance categories — used by future LLM-side
 * extractors but not the manual save-memory path.
 */
export type MemoryType =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference'
  | 'preference'
  | 'decision'
  | 'todo'
  | 'rationale'
  | 'artifact-summary'
  | 'user-stated-fact'
  | 'extracted-claim'

export interface MemoryLedgerRow {
  memoryId: string
  op: MemoryOp
  scope: MemoryScope
  type: MemoryType
  originatingProjectId?: string
  originatingArtifactId?: string
  provenance: {
    source: 'user-message' | 'tool-output' | 'extraction' | 'import'
    ref?: string
  }
  traceId?: string
  spanId?: string
  turnId?: string
  timestamp: string
}

export interface MemoryLedgerWriter {
  append(row: Omit<MemoryLedgerRow, 'timestamp' | 'traceId' | 'spanId'> & {
    timestamp?: string
    traceId?: string
    spanId?: string
  }): Promise<boolean>
  readonly filePath: string
}

export function createMemoryLedgerWriter(projectPath: string): MemoryLedgerWriter {
  const filePath = join(projectPath, PATHS.ledgerMemory)
  return {
    filePath,
    async append(row) {
      let traceId = row.traceId
      let spanId = row.spanId
      if (!traceId || !spanId) {
        const span = trace.getActiveSpan()
        const ctx = span?.spanContext()
        if (ctx) {
          traceId = traceId ?? ctx.traceId
          spanId = spanId ?? ctx.spanId
        }
      }
      // Phase T: pull turnId off the active turn context when the caller didn't
      // supply it (explicit value still wins). The coordinator publishes
      // TURN_ID_KEY for the whole turn, so in-turn memory ops carry turnId
      // without every call site threading it. Background ops that ran outside a
      // turn context resolve to undefined here — left turn-less by design.
      let turnId = row.turnId
      if (!turnId) {
        const ctxTurn = context.active().getValue(TURN_ID_KEY)
        if (typeof ctxTurn === 'string') turnId = ctxTurn
      }
      const fullRow: MemoryLedgerRow = {
        memoryId: row.memoryId,
        op: row.op,
        scope: row.scope,
        type: row.type,
        originatingProjectId: row.originatingProjectId,
        originatingArtifactId: row.originatingArtifactId,
        provenance: row.provenance,
        traceId,
        spanId,
        turnId,
        timestamp: row.timestamp ?? new Date().toISOString()
      }
      for (const k of Object.keys(fullRow) as (keyof MemoryLedgerRow)[]) {
        if (fullRow[k] === undefined) delete fullRow[k]
      }
      return appendJsonl(filePath, fullRow, { onError: () => {} })
    }
  }
}
