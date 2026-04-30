/**
 * Audit store — runs and findings.
 *
 * Phase 2: launch audits, stream events, list past reports, resolve findings.
 */

import { create } from 'zustand'

const api = (window as any).api

export type Severity = 'critical' | 'major' | 'minor' | 'info'
export type FindingCategory =
  | 'data-misuse' | 'method' | 'citation' | 'overreach' | 'inconsistency' | 'reproducibility'

export interface Finding {
  id: string
  severity: Severity
  category: FindingCategory
  claim: string
  evidence: string
  implicatedNodeIds: string[]
  suggestedAction?: string
}

export interface AuditReport {
  id: string
  createdAt: string
  scope: { rootNodeIds: string[]; maxDepth?: number | null }
  draftPreview?: string
  model: string
  scopeNodeCount: number
  summary: string
  findings: Finding[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreateTokens?: number
    cost?: number
  }
  durationMs: number
  warnings?: string[]
  /** Persisted narrative replay — present on reports written by the new auditor. */
  timeline?: TimelineItem[]
}

export type AuditEvent =
  | { type: 'started'; auditId: string; model: string; scopeNodeCount: number }
  | { type: 'progress'; message: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; name: string; args?: Record<string, unknown>; argsPreview?: string }
  | { type: 'finding'; finding: Finding }
  | { type: 'completed'; report: AuditReport }
  | { type: 'error'; message: string }

/**
 * Narrative timeline item — what the user actually reads during an audit run.
 * Reasoning paragraphs appear inline with the tool calls they led to, in the
 * order the auditor produced them.
 *
 * The 'finding' variant only appears in *persisted* timelines (replayed from
 * archived reports). Live runs surface findings via `liveFindings` and a
 * 'progress' breadcrumb so they can be cross-highlighted in real time.
 */
export type TimelineItem =
  | { kind: 'reasoning'; ts: string; text: string }
  | { kind: 'tool';      ts: string; name: string; args?: Record<string, unknown>; argsPreview?: string }
  | { kind: 'progress';  ts: string; message: string }
  | { kind: 'finding';   ts: string; findingId: string; severity: Severity; category: FindingCategory; claim: string }

interface RunState {
  /** True between started → completed/error. */
  running: boolean
  auditId: string | null
  model: string | null
  scopeNodeCount: number
  /**
   * Narrative timeline of the run — interleaved reasoning + tool calls in
   * the order the auditor produced them. Capped to keep memory bounded.
   */
  timeline: TimelineItem[]
  /** Findings streamed in during the run. */
  liveFindings: Finding[]
  error: string | null
  /** ISO timestamp of when the current run started — used for elapsed display. */
  startedAt: string | null
  /** Most recent tool call name + args (for toolbar live status + humanizing). */
  lastToolCall: { name: string; args?: Record<string, unknown>; argsPreview?: string } | null
  /** Tool turns observed so far (best-effort, for safeguard visibility). */
  toolTurnCount: number
}

interface AuditState {
  reports: AuditReport[]
  selectedAuditId: string | null
  selectedFindingId: string | null
  run: RunState

  loadReports: () => Promise<void>
  selectAudit: (id: string | null) => void
  selectFinding: (id: string | null) => void
  startAudit: (request: { rootNodeIds: string[]; maxDepth?: number | null; draftText?: string }) => Promise<AuditReport | null>
  cancelAudit: () => Promise<void>
  resolveFinding: (auditId: string, findingId: string, resolution: 'open' | 'resolved' | 'dismissed', reason?: string) => Promise<void>
}

const emptyRun: RunState = {
  running: false,
  auditId: null,
  model: null,
  scopeNodeCount: 0,
  timeline: [],
  liveFindings: [],
  error: null,
  startedAt: null,
  lastToolCall: null,
  toolTurnCount: 0
}

const TIMELINE_CAP = 400

export const useAuditStore = create<AuditState>((set, get) => ({
  reports: [],
  selectedAuditId: null,
  selectedFindingId: null,
  run: { ...emptyRun },

  loadReports: async () => {
    try {
      const r = await api?.auditList?.()
      if (r?.success) set({ reports: r.reports ?? [] })
    } catch (err) {
      console.warn('[Audit] loadReports failed:', err)
    }
  },

  selectAudit: (id) => set({ selectedAuditId: id, selectedFindingId: null }),
  selectFinding: (id) => set({ selectedFindingId: id }),

  startAudit: async (request) => {
    const startTs = new Date().toISOString()
    set({ run: { ...emptyRun, running: true, startedAt: startTs, timeline: [{ kind: 'progress', ts: startTs, message: 'starting…' }] } })

    // Subscribe to events for the duration of this run.
    const unsubscribe = api?.onAuditEvent?.((ev: AuditEvent) => {
      const ts = new Date().toISOString()
      const cur = get().run
      const append = (item: TimelineItem) =>
        cur.timeline.length >= TIMELINE_CAP
          ? [...cur.timeline.slice(-TIMELINE_CAP + 1), item]
          : [...cur.timeline, item]

      switch (ev.type) {
        case 'started':
          set({ run: { ...cur, running: true, auditId: ev.auditId, model: ev.model, scopeNodeCount: ev.scopeNodeCount,
            timeline: append({ kind: 'progress', ts, message: `Audit started · ${ev.scopeNodeCount} nodes in scope` }) } })
          break
        case 'reasoning':
          set({ run: { ...cur, timeline: append({ kind: 'reasoning', ts, text: ev.text }) } })
          break
        case 'tool-call':
          set({ run: { ...cur,
            lastToolCall: { name: ev.name, args: ev.args, argsPreview: ev.argsPreview },
            toolTurnCount: cur.toolTurnCount + 1,
            timeline: append({ kind: 'tool', ts, name: ev.name, args: ev.args, argsPreview: ev.argsPreview }) } })
          break
        case 'finding':
          set({ run: { ...cur, liveFindings: [...cur.liveFindings, ev.finding],
            timeline: append({ kind: 'progress', ts, message: `Finding [${ev.finding.severity}/${ev.finding.category}]: ${ev.finding.claim.slice(0, 100)}` }) } })
          break
        case 'completed':
          set({ run: { ...cur, running: false,
            timeline: append({ kind: 'progress', ts, message: `Done · ${ev.report.findings.length} finding(s) · ${(ev.report.durationMs / 1000).toFixed(1)}s` }) } })
          break
        case 'error':
          set({ run: { ...cur, running: false, error: ev.message,
            timeline: append({ kind: 'progress', ts, message: `Error: ${ev.message}` }) } })
          break
        case 'progress':
          set({ run: { ...cur, timeline: append({ kind: 'progress', ts, message: ev.message }) } })
          break
      }
    })

    try {
      // Wrap the flat renderer-side shape into the on-wire AuditRequest:
      //   { scope: { rootNodeIds, maxDepth? }, draftText? }
      // The previous flat shape produced "Cannot read properties of undefined
      // (reading 'rootNodeIds')" inside runAudit's scope unpacking.
      const wireRequest = {
        scope: { rootNodeIds: request.rootNodeIds, maxDepth: request.maxDepth },
        draftText: request.draftText
      }
      const r = await api?.auditRun?.(wireRequest)
      if (r?.success && r.report) {
        // Refresh reports list and select the new audit.
        await get().loadReports()
        set({ selectedAuditId: r.report.id })
        return r.report as AuditReport
      } else {
        set({ run: { ...get().run, running: false, error: r?.error ?? 'Audit failed' } })
        return null
      }
    } catch (err: any) {
      set({ run: { ...get().run, running: false, error: err?.message ?? String(err) } })
      return null
    } finally {
      unsubscribe?.()
    }
  },

  cancelAudit: async () => {
    try {
      await api?.auditCancel?.()
    } catch (err) {
      console.warn('[Audit] cancel failed:', err)
    }
  },

  resolveFinding: async (auditId, findingId, resolution, reason) => {
    try {
      await api?.auditResolveFinding?.(auditId, findingId, resolution, reason)
    } catch (err) {
      console.warn('[Audit] resolveFinding failed:', err)
    }
  }
}))
