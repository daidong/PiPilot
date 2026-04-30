/**
 * Adversarial auditor — entrypoint.
 *
 * RFC §4: prosecutor-posture isolated agent. Reads the project + provenance
 * graph, returns one AuditReport. NEVER writes project state.
 *
 * Isolation guarantees:
 *   - Brand-new pi-mono Agent (no coordinator history, no memory)
 *   - Restricted tools: read/grep/find/ls/bash + provenance navigation +
 *     submit_audit_report. NO write/edit/artifact-create/artifact-update.
 *   - Different model from coordinator by default (Sonnet vs Opus, mini vs flagship).
 *
 * The auditor's only output is the AuditReport returned from runAudit().
 */

import { Agent } from '@mariozechner/pi-agent-core'
import { getModel as getPiModel } from '@mariozechner/pi-ai'
import { ProvenanceGraph } from '../provenance/index.js'
import { getAuditorModel, type ModelTierKey } from '../models.js'
import { buildAuditorSystemPrompt, buildScopeSummary } from './prompt.js'
import { createAuditorTools, type ReportSink } from './tools.js'
import { newAuditId, writeAuditReport } from './store.js'
import type { AuditEvent, AuditReport, AuditRequest, AuditTimelineItem, Finding } from './types.js'
import type { ResearchToolContext } from '../tools/types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAuditOptions {
  projectPath: string
  /** Coordinator's provider key — used to pick the auditor model when no override. */
  coordinatorProvider: ModelTierKey
  /** API key resolver (same shape as coordinator's). */
  getApiKey: (provider: string) => Promise<string>
  /** Optional: research-tools context so auditor can use web_fetch for citation grounding. */
  researchCtx?: ResearchToolContext
  /** Optional: stream events as the audit progresses. */
  onEvent?: (ev: AuditEvent) => void
  /** Optional: enable debug logging. */
  debug?: boolean
  /**
   * Hard turn safeguard. Defaults to 200. Real audits on a paper-sized scope
   * routinely run 50–120 turns (read draft + 26 sources + bash spot-checks
   * + citation grounding). The cap exists only to catch genuine runaway
   * loops, not to stop deep audits — RFC §1 explicitly says no token cap.
   * Override with care.
   */
  maxTurns?: number
  /**
   * Optional abort signal. When triggered, aborts the underlying pi-mono
   * Agent. The function returns whatever partial state was captured.
   */
  abortSignal?: AbortSignal
}

/**
 * Run an audit. Returns the persisted AuditReport.
 *
 * On success: report is written to .research-pilot/audit-reports/{id}.json.
 * On error: throws; partial reports are NOT persisted.
 */
export async function runAudit(req: AuditRequest, opts: RunAuditOptions): Promise<AuditReport> {
  const startTs = Date.now()
  const auditId = newAuditId()

  // ── 1. Pick the model ────────────────────────────────────────────────
  const provider = opts.coordinatorProvider
  const piProvider = provider === 'anthropic-sub' ? 'anthropic' : provider
  const modelId = req.modelOverride ?? getAuditorModel(provider)
  if (!modelId) {
    throw new Error(`No auditor model available for provider "${provider}". Set audit.modelOverride in settings.`)
  }
  const fullModelId = `${provider}:${modelId}`
  const piModel = getPiModel(piProvider as any, modelId as any)
  if (!piModel) {
    throw new Error(`Failed to resolve auditor model "${fullModelId}".`)
  }

  // ── 2. Load the provenance graph + compute scope ─────────────────────
  const graph = await ProvenanceGraph.load(opts.projectPath)
  const subgraph = graph.getUpstreamCone(req.scope.rootNodeIds, req.scope.maxDepth ?? undefined)
  const scopeNodeCount = subgraph.nodes.length
  if (scopeNodeCount === 0) {
    throw new Error(`Empty audit scope: no nodes reachable from ${req.scope.rootNodeIds.length} root id(s).`)
  }
  const scopeSummary = buildScopeSummary(subgraph.nodes)

  // ── 3. Set up the report sink + tools ────────────────────────────────
  const findings: Finding[] = []
  // Persisted narrative of the run. Every event that contributes to the
  // user-readable procedure (reasoning, tool, progress, finding) is appended
  // here in addition to being forwarded via onEvent. Unbounded by design —
  // the procedure must be as reviewable as the verdict.
  const timeline: AuditTimelineItem[] = []
  const emit = (ev: AuditEvent): void => {
    const ts = new Date().toISOString()
    switch (ev.type) {
      case 'reasoning':
        timeline.push({ kind: 'reasoning', ts, text: ev.text })
        break
      case 'tool-call':
        timeline.push({ kind: 'tool', ts, name: ev.name, args: ev.args, argsPreview: ev.argsPreview })
        break
      case 'progress':
        timeline.push({ kind: 'progress', ts, message: ev.message })
        break
      case 'finding':
        timeline.push({
          kind: 'finding', ts,
          findingId: ev.finding.id,
          severity: ev.finding.severity,
          category: ev.finding.category,
          claim: ev.finding.claim
        })
        break
      // 'started', 'completed', 'error' do not enter the timeline:
      // 'started' is implicit by createdAt, 'completed' contains the report
      // itself (would be circular), and 'error' is captured as a warning.
    }
    opts.onEvent?.(ev)
  }
  const sink: ReportSink = {
    report: null,
    onFinding: (f) => {
      findings.push(f)
      emit({ type: 'finding', finding: f })
    }
  }
  const tools = createAuditorTools({
    projectPath: opts.projectPath,
    graph,
    sink,
    researchCtx: opts.researchCtx
  })

  // ── 4. Build the prompt ──────────────────────────────────────────────
  const systemPrompt = buildAuditorSystemPrompt({
    projectPath: opts.projectPath,
    scope: req.scope,
    scopeNodeCount,
    draftPreview: req.draftText,
    scopeSummary
  })
  const focusHint = req.focus?.length ? `\n\nFocus categories: ${req.focus.join(', ')}` : ''
  const starter = `Begin your audit. Walk the upstream cone, verify claims, and submit the report via \`submit_audit_report\` when done.${focusHint}`

  // ── 5. Construct the isolated Agent ──────────────────────────────────
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: piModel,
      tools,
      thinkingLevel: 'high'
    },
    sessionId: `audit-${auditId}`,
    getApiKey: () => opts.getApiKey(piProvider)
  })

  emit({ type: 'started', auditId, model: fullModelId, scopeNodeCount })

  // ── 6. Run ───────────────────────────────────────────────────────────
  const usage: AuditReport['usage'] = {}
  const maxTurns = opts.maxTurns ?? 200
  let toolTurnCount = 0
  let aborted = false
  const warnings: string[] = []

  // Abort wiring: external AbortSignal OR exceeded turn count → call agent.abort().
  if (opts.abortSignal?.aborted) {
    throw new Error('Audit aborted before start.')
  }
  const onExternalAbort = () => {
    aborted = true
    warnings.push('Audit aborted by user.')
    try { (agent as any).abort?.() } catch { /* ignore */ }
  }
  opts.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })

  // Reasoning buffer — accumulates assistant text deltas across a turn,
  // flushed as a single 'reasoning' event when a tool fires or the turn ends.
  // This is what makes the activity feed legible ("here's what the auditor
  // is THINKING") instead of just dumping tool calls.
  let reasoningBuf = ''
  const flushReasoning = () => {
    const t = reasoningBuf.trim()
    if (t.length > 0) emit({ type: 'reasoning', text: t })
    reasoningBuf = ''
  }

  try {
    // Subscribe to capture usage, surface reasoning + tool calls, enforce turn safeguard.
    agent.subscribe((event: any) => {
      // Capture token usage at turn boundaries. Coerce every field through
      // Number() — pi-mono's usage objects sometimes ship strings (cost
      // especially), which would later break `cost.toFixed()` in the UI.
      if (event?.type === 'turn_end' && event?.message?.usage) {
        const u = event.message.usage
        const num = (v: unknown): number => {
          const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
          return Number.isFinite(n) ? n : 0
        }
        usage.inputTokens       = (usage.inputTokens       ?? 0) + num(u.input       ?? u.inputTokens)
        usage.outputTokens      = (usage.outputTokens      ?? 0) + num(u.output      ?? u.outputTokens)
        usage.cacheReadTokens   = (usage.cacheReadTokens   ?? 0) + num(u.cacheRead   ?? u.cacheReadTokens)
        usage.cacheCreateTokens = (usage.cacheCreateTokens ?? 0) + num(u.cacheCreate ?? u.cacheCreateTokens)
        usage.cost              = (usage.cost              ?? 0) + num(u.cost)
      }

      // Buffer auditor's natural-language output. pi-mono emits text deltas
      // via assistantMessageEvent.text_delta and (for Claude extended thinking)
      // thinking_delta. We treat both as reasoning content.
      if (event?.type === 'message_update') {
        const ame = event.assistantMessageEvent
        if (ame && typeof ame === 'object') {
          const t = (ame as { type?: string }).type
          const delta = (ame as { delta?: unknown }).delta
          if ((t === 'text_delta' || t === 'thinking_delta') && typeof delta === 'string') {
            reasoningBuf += delta
          }
        }
      }
      if (event?.type === 'turn_end') {
        flushReasoning()
      }

      // Tool call — flush reasoning first so the paragraph appears BEFORE
      // the action it leads to. Then emit a structured tool-call with full
      // args (renderer humanizes per tool).
      if (event?.type === 'tool_execution_start') {
        flushReasoning()
        toolTurnCount++
        const argsObj = (event.args && typeof event.args === 'object')
          ? (event.args as Record<string, unknown>)
          : undefined
        const argsPreview = argsObj ? JSON.stringify(argsObj).slice(0, 120) : undefined
        emit({
          type: 'tool-call',
          name: event.toolName,
          args: argsObj,
          argsPreview
        })
        if (toolTurnCount > maxTurns && !aborted) {
          aborted = true
          warnings.push(`Audit aborted: exceeded maxTurns=${maxTurns} without submitting a report.`)
          emit({ type: 'progress', message: `safeguard: aborting after ${toolTurnCount} tool turns` })
          try { (agent as any).abort?.() } catch { /* ignore */ }
        }
      }
    })

    await agent.prompt(starter)
    flushReasoning()

    // Common failure mode: the model decides it's "done" and emits a
    // closing assistant message *without* calling submit_audit_report.
    // The right move is a single, blunt reminder — not throwing away the
    // run. If the auditor produced reasoning + tool calls, those have
    // already been streamed to the user; what we need is the verdict.
    if (!sink.report && !aborted) {
      emit({ type: 'progress', message: 'No report submitted yet — reminding the auditor to call submit_audit_report.' })
      const reminder =
        'You ended the previous turn without calling `submit_audit_report`. ' +
        'That tool is your ONLY output channel — without it the user gets nothing. ' +
        'Submit the report NOW based on what you have already gathered. ' +
        'A short summary with explicit "could not verify because …" notes is acceptable; ' +
        'an empty array of findings is acceptable. Do not continue exploring. ' +
        'Call submit_audit_report exactly once and stop.'
      try {
        await agent.prompt(reminder)
        flushReasoning()
      } catch (err) {
        // Reminder itself failed — record and fall through to stub-report path.
        warnings.push(`submit-reminder failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!aborted) {
      emit({ type: 'error', message: msg })
      throw err
    }
    // Aborted — fall through to persist whatever the auditor managed to capture.
    warnings.push(`Underlying agent error after abort: ${msg}`)
  } finally {
    opts.abortSignal?.removeEventListener('abort', onExternalAbort)
  }

  // ── 7. Build + persist the report ────────────────────────────────────
  // If aborted, persist a partial-report stub so the user can see what the
  // auditor did before the cap fired. Otherwise require a real submission.
  let reportSummary: string
  let reportFindings: Finding[]
  let allWarnings = warnings.slice()
  if (sink.report) {
    reportSummary = sink.report.summary
    reportFindings = sink.report.findings
    if (sink.report.warnings) allWarnings = [...allWarnings, ...sink.report.warnings]
  } else if (aborted) {
    reportSummary = `Audit aborted before completion (after ${toolTurnCount} tool turns). No final report submitted; live findings preserved below if any.`
    reportFindings = findings
  } else {
    // The auditor finished both the initial prompt AND the reminder without
    // calling submit_audit_report. Rather than throw away the run (which
    // discards a fully-recorded timeline + any streamed live findings), we
    // persist a stub. The user gets to see *what* the auditor did via the
    // History tab even when the verdict was never delivered.
    reportSummary = `Auditor finished without calling submit_audit_report (${toolTurnCount} tool turns). The procedure was recorded — see History — but no verdict was submitted. Re-running the audit may yield a report.`
    reportFindings = findings
    allWarnings.push('Auditor never called submit_audit_report. Stub report persisted so the run is not lost.')
  }

  const report: AuditReport = {
    id: auditId,
    createdAt: new Date(startTs).toISOString(),
    scope: req.scope,
    draftPreview: req.draftText?.slice(0, 500),
    model: fullModelId,
    scopeNodeCount,
    summary: reportSummary,
    findings: reportFindings,
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    durationMs: Date.now() - startTs,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    timeline
  }
  await writeAuditReport(opts.projectPath, report)
  emit({ type: 'completed', report })
  return report
}
