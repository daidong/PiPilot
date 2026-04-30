/**
 * Audit subsystem public surface.
 *
 * RFC: docs/spec/trust-audit.md (current: v0.8) §4 + §5.
 *
 * Layering:
 *   types.ts   — pure types (AuditRequest, AuditReport, Finding, AuditEvent)
 *   store.ts   — write-once JSON files at .research-pilot/audit-reports/
 *   prompt.ts  — prosecutor system prompt + scope summary
 *   tools.ts   — restricted toolset (read-only over project; submit_audit_report)
 *   auditor.ts — entrypoint runAudit() that constructs the isolated pi-mono Agent
 */

export * from './types.js'
export { runAudit } from './auditor.js'
export type { RunAuditOptions } from './auditor.js'
export {
  newAuditId,
  writeAuditReport,
  readAuditReport,
  listAuditReports,
  readAuditState,
  setFindingResolution,
  auditPaths
} from './store.js'
