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
import { trace } from '@opentelemetry/api'
import { PATHS } from '../types.js'
import { appendJsonl } from '../telemetry/jsonl-writer.js'

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

export interface ArtifactLedgerWriter {
  append(row: Omit<ArtifactLedgerRow, 'timestamp' | 'traceId' | 'spanId'> & {
    timestamp?: string
    traceId?: string
    spanId?: string
  }): Promise<boolean>
  readonly filePath: string
}

/**
 * Build a project-scoped artifact-ledger writer. Trace context is auto-pulled
 * from the OTel global context if the caller doesn't supply traceId/spanId.
 */
export function createArtifactLedgerWriter(projectPath: string): ArtifactLedgerWriter {
  const filePath = join(projectPath, PATHS.ledgerArtifact)
  return {
    filePath,
    async append(row) {
      // Pull trace context from OTel if not supplied.
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
        turnId: row.turnId,
        toolCallId: row.toolCallId,
        timestamp: row.timestamp ?? new Date().toISOString(),
        importMeta: row.importMeta
      }
      // Strip undefined for tidiness.
      for (const k of Object.keys(fullRow) as (keyof ArtifactLedgerRow)[]) {
        if (fullRow[k] === undefined) delete fullRow[k]
      }
      return appendJsonl(filePath, fullRow, { onError: () => {} })
    }
  }
}
