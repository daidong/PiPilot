/**
 * BibTeX Import Wizard (RFC-006 PR-4).
 *
 * A three-step modal flow driven by `useImportStore`:
 *
 *   step 'source'   ← status === 'idle'
 *     User picks a .bib file via native dialog. Status flips to
 *     'running' and the wizard advances automatically.
 *
 *   step 'progress' ← status === 'running'
 *     Live counters drip in from the `import:progress` event stream.
 *     Total / processed / per-status breakdown. Cancel button is
 *     deliberately absent: the importer runs in the main process and
 *     completes in milliseconds-to-seconds for any reasonable .bib —
 *     adding a cancel surface would require plumbing AbortSignal
 *     through bibtex.ts and is out of scope.
 *
 *   step 'done'     ← status === 'done' OR status === 'error'
 *     Summary screen. Three follow-ups:
 *       1. "Run enrichment" — fires enrichAllPapers(importedPaperIds),
 *          then closes the wizard. Off when no papers were imported.
 *       2. "View library" — switches centerView('literature') +
 *          refreshAll + closes.
 *       3. "Import another" — resets the store and returns to step
 *          'source'.
 *
 * Visual dialect: muted neutrals, accent-soft on hover, left-aligned,
 * two-line rows. No icons inside content rows — only the `X` close
 * affordance in the header, matching SettingsModal.
 */

import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useImportStore } from '../../stores/import-store'
import { useEntityStore } from '../../stores/entity-store'
import { useUIStore } from '../../stores/ui-store'
import { useEnrichmentStore } from '../../stores/enrichment-store'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getVisibleFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null)
}

/**
 * Right-trim a long absolute path for compact display. Keeps the
 * filename and the immediate parent directory. Used by the progress
 * and summary screens so very long paths don't blow up the layout.
 */
function shortPath(p?: string): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return p
  return `…/${parts.slice(-2).join('/')}`
}

export function ImportWizard() {
  const open = useImportStore((s) => s.wizardOpen)
  const status = useImportStore((s) => s.status)
  const counts = useImportStore((s) => s.counts)
  const result = useImportStore((s) => s.result)
  const error = useImportStore((s) => s.error)
  const sourcePath = useImportStore((s) => s.sourcePath)
  const startFromPicker = useImportStore((s) => s.startFromPicker)
  const reset = useImportStore((s) => s.reset)
  const closeAndReset = useImportStore((s) => s.closeAndReset)

  const panelRef = useRef<HTMLDivElement>(null)

  // ── Refresh the Papers list once an import finishes ─────────────────
  // The importer writes paper artifacts directly to disk; the entity
  // store has no idea unless we tell it. Refresh whenever status flips
  // to 'done' (even when nothing was added — merges may have filled
  // missing fields on existing papers, which the UI should reflect).
  //
  // Also: auto-switch the center view to Library so the user sees the
  // papers landing, and fire enrichment in the background. RFC-007 §5
  // — the Paper Report button can't enable until enrichment + wiki
  // catch up, so we kick off the long chain immediately rather than
  // waiting for the user to click a separate button.
  useEffect(() => {
    if (status !== 'done') return
    let cancelled = false

    useEntityStore.getState().refreshAll().then(() => {
      if (cancelled) return
      // Auto-trigger enrichment for the just-imported papers. The
      // enrichment-store guards against double-runs; calling it while
      // an existing run is in flight is a no-op.
      if (result && result.importedPaperIds.length > 0) {
        useEnrichmentStore.getState().enrichAll(result.importedPaperIds).catch(() => {})
      }
      // Switch the background view so closing the wizard lands the
      // user in Literature.
      useUIStore.getState().setCenterView('literature')
    }).catch(() => {})

    return () => { cancelled = true }
  }, [status, result])

  // ── A11y: focus management + Escape + Tab trap ──────────────────────
  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const focusable = getVisibleFocusable(panel)
      const first = focusable[0] ?? panel
      first.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (trigger && document.contains(trigger)) trigger.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Block Escape mid-import — refusing to lose the result is
        // less annoying than refusing to lose 30 seconds of work.
        if (status === 'running') {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        e.preventDefault()
        e.stopPropagation()
        closeAndReset()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = getVisibleFocusable(panel)
      if (focusable.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!active || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [open, status, closeAndReset])

  if (!open) return null

  // Determine the current visual step from status. (Wizard state is
  // *derived* from import status, not a separate variable — there's
  // exactly one source of truth.)
  const step: 'source' | 'progress' | 'done' =
    status === 'idle' ? 'source'
    : status === 'running' ? 'progress'
    : 'done'  // 'done' OR 'error' — branch on error below

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-wizard-title"
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-xl border t-border t-bg-surface shadow-xl flex flex-col overflow-hidden outline-none"
      >
        {/* Header — title + close. Close is disabled mid-import. */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b t-border">
          <h2 id="import-wizard-title" className="text-[14px] font-semibold t-text">
            Build paper memory from BibTeX
          </h2>
          <button
            onClick={() => closeAndReset()}
            disabled={status === 'running'}
            aria-label="Close import wizard"
            className="p-1.5 rounded-lg t-text-muted hover:t-text hover:t-bg-hover transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — one of three sub-views */}
        <div className="px-6 py-5">
          {step === 'source' && <SourceStep onPick={startFromPicker} />}
          {step === 'progress' && <ProgressStep counts={counts} sourcePath={sourcePath} />}
          {step === 'done' && (
            error
              ? <ErrorStep error={error} onRetry={() => { reset() }} />
              : <DoneStep
                  result={result!}
                  sourcePath={sourcePath}
                  onOpenLibrary={() => {
                    // The done-state effect above already switches view +
                    // refreshes; this is the "close the wizard now" CTA.
                    closeAndReset()
                  }}
                  onImportAnother={() => reset()}
                />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Step views ──────────────────────────────────────────────────────────

function SourceStep({ onPick }: { onPick: () => Promise<void> }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] t-text-secondary leading-relaxed">
        Select a <code className="px-1 py-0.5 rounded t-bg-elevated text-[11.5px] font-mono t-text-secondary">.bib</code> file
        exported from Zotero, EndNote, Mendeley, or any reference manager.
      </p>
      <p className="text-[12px] t-text-muted leading-relaxed">
        We&apos;ll add the entries to your library, skipping anything we already have.
        Duplicates are detected by DOI, citation key, or title&nbsp;+&nbsp;year.
      </p>

      <button
        type="button"
        onClick={() => { void onPick() }}
        className="self-start mt-2 px-4 py-2 rounded-lg border t-border t-bg-elevated t-text text-[13px] font-medium hover:t-bg-hover transition-colors"
      >
        Choose .bib file…
      </button>

      <p className="mt-2 text-[11px] t-text-muted leading-relaxed">
        After import, we can fill in missing metadata (DOI, abstract, citation count)
        from CrossRef and Semantic Scholar — you&apos;ll get the option on the next screen.
      </p>
    </div>
  )
}

function ProgressStep({
  counts,
  sourcePath,
}: {
  counts: { total: number; processed: number; added: number; merged: number; mergedNoChange: number; duplicateInFile: number; failed: number; lastCiteKey?: string }
  sourcePath?: string
}) {
  const pct = counts.total > 0 ? Math.min(100, Math.round((counts.processed / counts.total) * 100)) : 0

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[13px] t-text-secondary mb-1">Importing…</p>
        {sourcePath && (
          <p className="text-[11px] t-text-muted font-mono truncate" title={sourcePath}>
            {shortPath(sourcePath)}
          </p>
        )}
      </div>

      {/* Progress bar — matches WikiStatusPill's progress treatment */}
      <div className="w-full h-1 rounded-full t-bg-elevated overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Counter grid — fixed-width tabular numerals so the layout
          doesn't jitter as numbers climb. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
        <CounterRow label="Processed" value={counts.processed} total={counts.total} />
        <CounterRow label="Added" value={counts.added} />
        <CounterRow label="Merged" value={counts.merged} />
        <CounterRow label="Unchanged" value={counts.mergedNoChange} />
        <CounterRow label="Duplicates" value={counts.duplicateInFile} muted />
        <CounterRow label="Failed" value={counts.failed} muted={counts.failed === 0} />
      </dl>

      {counts.lastCiteKey && (
        <p className="text-[11px] t-text-muted font-mono truncate">
          Last: <span className="t-text-secondary">{counts.lastCiteKey}</span>
        </p>
      )}
    </div>
  )
}

function CounterRow({ label, value, total, muted }: { label: string; value: number; total?: number; muted?: boolean }) {
  return (
    <>
      <dt className={`text-[11px] uppercase tracking-wider ${muted ? 't-text-muted' : 't-text-muted'}`}>
        {label}
      </dt>
      <dd className={`text-[13px] tabular-nums text-right ${muted ? 't-text-muted' : 't-text-secondary'}`}>
        {value}{total != null ? <span className="t-text-muted"> / {total}</span> : null}
      </dd>
    </>
  )
}

function DoneStep({
  result,
  sourcePath,
  onOpenLibrary,
  onImportAnother,
}: {
  result: import('../../../preload/index').BibImportResult
  sourcePath?: string
  onOpenLibrary: () => void
  onImportAnother: () => void
}) {
  const [failuresOpen, setFailuresOpen] = useState(false)
  const enrichmentTotal = useEnrichmentStore((s) => s.progress?.total)
  const enrichmentProcessed = useEnrichmentStore((s) => s.progress?.processed)
  const enrichmentRunning = useEnrichmentStore((s) => s.status === 'running')

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[13px] t-text mb-1">Import complete.</p>
        {sourcePath && (
          <p className="text-[11px] t-text-muted font-mono truncate" title={sourcePath}>
            {shortPath(sourcePath)}
          </p>
        )}
      </div>

      {/* Summary counts. Always show added / merged; show failures/dupes
          only when non-zero to keep the summary tight. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
        <CounterRow label="Added" value={result.added} />
        <CounterRow label="Merged" value={result.merged} />
        {result.mergedNoChange > 0 && (
          <CounterRow label="Already present" value={result.mergedNoChange} muted />
        )}
        {result.duplicateInFile > 0 && (
          <CounterRow label="Duplicates in file" value={result.duplicateInFile} muted />
        )}
        {result.failed > 0 && (
          <CounterRow label="Failed" value={result.failed} />
        )}
      </dl>

      {/* Failure detail — collapsed by default; surfaces parser errors,
          missing titles, etc. Renders as a left-aligned monospace list,
          truncated to 8 entries for safety. */}
      {result.failureDetails.length > 0 && (
        <div className="border-t t-border pt-3">
          <button
            type="button"
            onClick={() => setFailuresOpen(o => !o)}
            className="text-[11px] t-text-secondary hover:t-text transition-colors"
          >
            {failuresOpen ? '▾' : '▸'} {result.failureDetails.length} entr{result.failureDetails.length === 1 ? 'y' : 'ies'} need attention
          </button>
          {failuresOpen && (
            <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto text-[11px] font-mono">
              {result.failureDetails.slice(0, 8).map((f, i) => (
                <li key={i} className="flex gap-2">
                  <span className="t-text-muted shrink-0">{f.citeKey}</span>
                  <span className="t-text-secondary truncate" title={f.reason}>{f.reason}</span>
                </li>
              ))}
              {result.failureDetails.length > 8 && (
                <li className="t-text-muted">… and {result.failureDetails.length - 8} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* Background-task hint — RFC-007 §5: enrichment auto-fires after
          import; wiki processing follows. The Paper Report button in the
          left sidebar will progress through its states as the pipeline
          catches up. Surface a tight one-liner here so users know the
          work is already happening. */}
      {result.importedPaperIds.length > 0 && (
        <div className="border-t t-border pt-3 text-[11px] t-text-muted leading-relaxed">
          {enrichmentRunning && enrichmentTotal != null ? (
            <p>
              Enriching {enrichmentProcessed ?? 0}/{enrichmentTotal} papers in the background.
              Paper Wiki + Paper Report will become available when ready.
            </p>
          ) : (
            <p>
              Enrichment + Paper Wiki processing started in the background.
              Watch the <strong>Paper Report</strong> button in the left
              sidebar — it&apos;ll progress through stages and turn green
              when synthesis is ready.
            </p>
          )}
        </div>
      )}

      {/* Actions — left-aligned ghost buttons. */}
      <div className="flex flex-wrap gap-2 mt-2">
        <button
          type="button"
          onClick={onOpenLibrary}
          className="px-3 py-1.5 rounded-lg border t-border t-bg-elevated t-text text-[12px] font-medium hover:t-bg-hover transition-colors"
        >
          View library
        </button>
        <button
          type="button"
          onClick={onImportAnother}
          className="px-3 py-1.5 rounded-lg t-text-muted text-[12px] font-medium hover:t-text hover:t-bg-hover transition-colors"
        >
          Import another
        </button>
      </div>
    </div>
  )
}

function ErrorStep({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] t-text-secondary mb-1">Import failed.</p>
      <p className="text-[12px] t-text leading-relaxed">{error}</p>
      <p className="text-[11px] t-text-muted leading-relaxed">
        No changes were made to your library. Fix the file (or pick a different one)
        and try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="self-start mt-2 px-3 py-1.5 rounded-lg border t-border t-bg-elevated t-text text-[12px] font-medium hover:t-bg-hover transition-colors"
      >
        Try again
      </button>
    </div>
  )
}
