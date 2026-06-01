/**
 * Artifact ledger (telemetry-trace v0.10 §8.1).
 *
 * Append-only event log of artifact ops. Coexists with the existing per-file
 * artifact JSON store (`lib/memory-v2/store.ts`) — the per-file store remains
 * the read-side authority for current content; this ledger captures the
 * temporal/causal stream for analysis.
 *
 * Idempotent on `(artifactId, version, op)`: replaying a row produces the same
 * result. Crash recovery may re-write rows; analysis tools dedupe.
 *
 * Schema:
 * ```
 * {
 *   artifactId, version, op, type, path, contentHash, diffPath?,
 *   versionBefore?, initiator, traceId?, spanId?, turnId?, toolCallId?,
 *   timestamp
 * }
 * ```
 *
 * Records only objective facts. No "anchor-factness" judgments — that's Layer 3.
 */

import { join } from 'node:path'
import { context, trace } from '@opentelemetry/api'
import { PATHS } from '../types.js'
import { appendJsonl, appendJsonlSync } from '../telemetry/jsonl-writer.js'
import { TURN_ID_KEY } from '../telemetry/context-keys.js'

export type ArtifactOp =
  | 'create'
  | 'edit'
  | 'overwrite'
  | 'delete'
  | 'convert'
  | 'export'
  | 'execute'
  | 'read'
  | 'imported' // §14.2 backfill marker

export type ArtifactInitiator = 'user' | 'assistant' | 'tool' | 'external'

export interface ArtifactLedgerRow {
  artifactId: string
  version: number
  op: ArtifactOp
  type: string
  path: string
  contentHash: string
  diffPath?: string
  versionBefore?: number | null
  initiator: ArtifactInitiator
  traceId?: string
  spanId?: string
  turnId?: string
  toolCallId?: string
  timestamp: string
  /** Optional: marks rows produced by the migrate-import-history CLI (§14.2). */
  importMeta?: { source: string; fileMtime?: string }
}

type LedgerRowInput = Omit<ArtifactLedgerRow, 'timestamp' | 'traceId' | 'spanId'> & {
  timestamp?: string
  traceId?: string
  spanId?: string
}

export interface ArtifactLedgerWriter {
  append(row: LedgerRowInput): Promise<boolean>
  /**
   * Synchronous append — guarantees the row is durable before returning. Use
   * from synchronous APIs (e.g. memory-v2 store create/update/delete) so a
   * fire-and-forget async write can't race the caller (test teardown deleting
   * the dir, or a crash before the row lands).
   */
  appendSync(row: LedgerRowInput): boolean
  readonly filePath: string
}

/** Fill in trace context (from OTel if not supplied), timestamp, and strip undefined. */
function buildRow(row: LedgerRowInput): ArtifactLedgerRow {
  let traceId = row.traceId
  let spanId = row.spanId
  if (!traceId || !spanId) {
    const ctx = trace.getActiveSpan()?.spanContext()
    if (ctx) {
      traceId = traceId ?? ctx.traceId
      spanId = spanId ?? ctx.spanId
    }
  }
  // Phase T: pull turnId off the active turn context when the caller didn't
  // supply it (explicit value still wins). The coordinator publishes
  // TURN_ID_KEY for the whole turn, so in-turn artifact ops carry turnId
  // without every call site threading it. Rows written outside a turn context
  // (migrate-import-history backfill, background tasks) resolve to undefined —
  // left turn-less by design, recovered via the timestamp-window join.
  let turnId = row.turnId
  if (!turnId) {
    const ctxTurn = context.active().getValue(TURN_ID_KEY)
    if (typeof ctxTurn === 'string') turnId = ctxTurn
  }
  const fullRow: ArtifactLedgerRow = {
    artifactId: row.artifactId,
    version: row.version,
    op: row.op,
    type: row.type,
    path: row.path,
    contentHash: row.contentHash,
    diffPath: row.diffPath,
    versionBefore: row.versionBefore ?? null,
    initiator: row.initiator,
    traceId,
    spanId,
    turnId,
    toolCallId: row.toolCallId,
    timestamp: row.timestamp ?? new Date().toISOString(),
    importMeta: row.importMeta
  }
  for (const k of Object.keys(fullRow) as (keyof ArtifactLedgerRow)[]) {
    if (fullRow[k] === undefined) delete fullRow[k]
  }
  return fullRow
}

/**
 * Build a project-scoped artifact-ledger writer. Trace context is auto-pulled
 * from the OTel global context if the caller doesn't supply traceId/spanId.
 */
export function createArtifactLedgerWriter(projectPath: string): ArtifactLedgerWriter {
  const filePath = join(projectPath, PATHS.ledgerArtifact)
  return {
    filePath,
    append(row) {
      return appendJsonl(filePath, buildRow(row), { onError: () => {} })
    },
    appendSync(row) {
      return appendJsonlSync(filePath, buildRow(row), { onError: () => {} })
    }
  }
}
