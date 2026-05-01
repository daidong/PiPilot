/**
 * Audit subsystem — types.
 *
 * RFC: docs/spec/trust-audit.md §4 (auditor) + §5 (UI).
 *
 * Audit reports are write-once. They live at .research-pilot/audit-reports/
 * and are quarantined to the Audit tab — not surfaced in Library/Papers/
 * search (RFC §3.6 hard constraint).
 */

// ---------------------------------------------------------------------------
// Audit scope (input to runAudit)
// ---------------------------------------------------------------------------

/**
 * What the auditor reviews. The auditor walks the upstream cone of every
 * `rootNodeId` (graph-local provenance node ids). When `draftText` is
 * provided, the auditor checks claims in the draft against the upstream cone.
 */
export interface AuditScope {
  rootNodeIds: string[]
  /** Optional. Walks unbounded upstream when null/undefined (RFC §1: deep audit). */
  maxDepth?: number | null
}

export interface AuditRequest {
  scope: AuditScope
  /** Draft text to audit (when scope includes a draft node). */
  draftText?: string
  /** Override the auditor model. If null/undefined, the system picks one
   *  matched to the coordinator's vendor (RFC §4.1). */
  modelOverride?: string | null
  /** Optional category focus — when set, the auditor restricts findings to these. */
  focus?: FindingCategory[]
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'major' | 'minor' | 'info'

/**
 * Finding categories. Each one represents a *claim-vs-evidence* mismatch
 * found in the workspace; the audit subject is the paper, not the producing
 * agent's record-keeping.
 *
 * `reproducibility` was deliberately removed (2026-05): it conflated
 * "provenance graph is incomplete" with "the paper has a problem", which
 * generated false positives whenever the user produced files manually
 * outside the agent (e.g. a CSV from a separate analysis session, a
 * manuscript edited in their IDE between captures). Provenance gaps are
 * not findings; only contradicted or missing evidence is.
 */
export type FindingCategory =
  | 'data-misuse'        // wrong slice, wrong filter, wrong cohort
  | 'method'             // wrong test, violated assumptions, p-hacking
  | 'citation'           // wrong source, fabricated, misattributed
  | 'overreach'          // claim exceeds evidence
  | 'inconsistency'      // numbers don't match across artifacts

export interface Finding {
  id: string
  severity: Severity
  category: FindingCategory
  /** One-line claim of what is wrong. */
  claim: string
  /** Detailed evidence: quotes, hash references, reasoning. Multi-paragraph. */
  evidence: string
  /** Provenance node ids implicated by this finding. UI cross-highlights them. */
  implicatedNodeIds: string[]
  /** Optional: what the user could do to resolve. */
  suggestedAction?: string
}

/** User actions on a finding, persisted on the report after review. */
export type FindingResolution = 'open' | 'resolved' | 'dismissed'

export interface FindingState {
  findingId: string
  resolution: FindingResolution
  resolvedAt?: string
  /** Free-text reason — typically used when dismissing. */
  reason?: string
}

// ---------------------------------------------------------------------------
// Timeline (persisted narrative of how the audit was conducted)
// ---------------------------------------------------------------------------

/**
 * One step in the auditor's narrative. Persisted alongside the report so the
 * UI can replay the *process* (not just findings) for any historical audit.
 *
 * Shape mirrors the renderer-side `TimelineItem` so the same renderer can
 * draw both live and archived runs.
 */
export type AuditTimelineItem =
  | { kind: 'reasoning'; ts: string; text: string }
  | { kind: 'tool';      ts: string; name: string; args?: Record<string, unknown>; argsPreview?: string }
  | { kind: 'progress';  ts: string; message: string }
  | { kind: 'finding';   ts: string; findingId: string; severity: Severity; category: FindingCategory; claim: string }

// ---------------------------------------------------------------------------
// Audit report
// ---------------------------------------------------------------------------

/**
 * The auditor's output. Write-once on disk; the user's resolution actions
 * are appended to a separate `state.json` file in the same audit report
 * directory so the original remains immutable.
 */
export interface AuditReport {
  id: string                       // ULID-style, e.g. 'aud_01HXYZ...'
  createdAt: string                // ISO timestamp
  scope: AuditScope
  draftPreview?: string            // first ~500 chars of the draft if provided
  /** Provider:model string actually used, e.g. 'anthropic:claude-sonnet-4-6'. */
  model: string
  /** Number of upstream-cone nodes in scope at run time. */
  scopeNodeCount: number
  /** One-paragraph executive summary written by the auditor. */
  summary: string
  findings: Finding[]
  /** Token usage + estimated cost for this run, when the model layer reports them. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreateTokens?: number
    cost?: number
  }
  durationMs: number
  /** Errors / warnings encountered during the run (non-fatal). */
  warnings?: string[]
  /**
   * Narrative of *how* the auditor conducted the run — reasoning paragraphs,
   * tool calls, progress messages, and finding emissions, in emission order.
   * Persisted unbounded (RFC §1: deep audits — no truncation). UI replays this
   * for archived audits so the procedure is as reviewable as the findings.
   */
  timeline?: AuditTimelineItem[]
}

// ---------------------------------------------------------------------------
// Streamed events for IPC (audit:run subscribes)
// ---------------------------------------------------------------------------

export type AuditEvent =
  | { type: 'started'; auditId: string; model: string; scopeNodeCount: number }
  | { type: 'progress'; message: string }
  /**
   * One paragraph of the auditor's natural-language reasoning, emitted at
   * each turn boundary (just before the auditor calls a tool, or at end of
   * a no-tool turn). This is what tells the user *why* the next tool call
   * is happening, not just *what*.
   */
  | { type: 'reasoning'; text: string }
  /**
   * Structured tool call. `args` is the full argument object — the renderer
   * humanizes it (e.g. `{path: 'a/b/c.md'}` → "read c.md"); `argsPreview`
   * is a fallback short string for the activity log.
   */
  | { type: 'tool-call'; name: string; args?: Record<string, unknown>; argsPreview?: string }
  | { type: 'finding'; finding: Finding }
  | { type: 'completed'; report: AuditReport }
  | { type: 'error'; message: string }
