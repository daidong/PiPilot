/**
 * Ledger writers (telemetry-trace v0.10 §8).
 *
 * Each ledger is entity-keyed, append-only, and idempotent on its natural key.
 * Trace context is auto-pulled from OTel when callers don't supply it.
 */

export { createArtifactLedgerWriter } from './artifact-ledger.js'
export type {
  ArtifactLedgerRow,
  ArtifactLedgerWriter,
  ArtifactOp,
  ArtifactInitiator
} from './artifact-ledger.js'

export { createMemoryLedgerWriter } from './memory-ledger.js'
export type {
  MemoryLedgerRow,
  MemoryLedgerWriter,
  MemoryOp,
  MemoryScope,
  MemoryType
} from './memory-ledger.js'

export { createUserResponseSignalsWriter } from './user-response-signals.js'
export type {
  UserResponseSignalRow,
  UserResponseSignalsWriter
} from './user-response-signals.js'

export { createViewLogWriter } from './view-log.js'
export type { ViewLogRow, ViewLogWriter, ViewTargetKind, ViewOp } from './view-log.js'
