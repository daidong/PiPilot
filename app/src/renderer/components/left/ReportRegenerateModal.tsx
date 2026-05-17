/**
 * Confirm modal for the Paper Report "regenerate" affordance
 * (RFC-007 PR-C).
 *
 * Lives in its own tiny component because:
 *   - The action is destructive (overwrites the existing
 *     rp-paper-pack-report.md / .html on disk)
 *   - Generation is expensive (~30s + LLM tokens)
 *   - The trigger is a small ↻ icon next to the "Open Paper Report"
 *     button — easy to fat-finger
 *
 * Native `window.confirm()` would be ugly in Electron and skip the
 * app's theming. The modal here matches the SettingsModal dialect
 * (overlay + centered panel + focus trap + Escape to close) at
 * minimum cost.
 */

import React, { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function ReportRegenerateModal({ open, onCancel, onConfirm }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Move focus into the dialog on open, restore on close.
  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      // Focus the safer (Cancel) button by default — destructive
      // confirms shouldn't be one-keystroke away.
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      const cancel = focusables.find((el) => el.dataset.action === 'cancel')
      ;(cancel ?? focusables[0] ?? panel).focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (trigger && document.contains(trigger)) trigger.focus?.()
    }
  }, [open])

  // Escape closes; Tab trap inside.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!active || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="regen-modal-title"
        aria-describedby="regen-modal-body"
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-xl border t-border t-bg-surface shadow-xl overflow-hidden outline-none"
      >
        <div className="px-6 pt-5 pb-2">
          <h2 id="regen-modal-title" className="text-[14px] font-semibold t-text">
            Regenerate Paper Report?
          </h2>
        </div>
        <div className="px-6 pb-4">
          <p id="regen-modal-body" className="text-[12px] t-text-secondary leading-relaxed">
            This overwrites the existing <code className="px-1 py-0.5 rounded t-bg-elevated text-[11px] font-mono">rp-paper-pack-report.md</code> and
            <code className="px-1 py-0.5 rounded t-bg-elevated text-[11px] font-mono ml-1">.html</code> files at the project root,
            and re-runs the synthesis LLM call (~30s).
          </p>
          <p className="mt-2 text-[11px] t-text-muted leading-relaxed">
            Only worth doing if your library or wiki extractions have changed since the last run.
          </p>
        </div>
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button
            type="button"
            ref={confirmRef}
            data-action="cancel"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg t-text-muted text-[12px] font-medium hover:t-text hover:t-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-lg border t-border t-bg-elevated t-text text-[12px] font-medium hover:t-bg-hover transition-colors"
          >
            Regenerate
          </button>
        </div>
      </div>
    </div>
  )
}
