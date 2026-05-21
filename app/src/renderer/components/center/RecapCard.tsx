import { RotateCcw, X } from 'lucide-react'
import { useRecapStore } from '../../stores/recap-store'

/**
 * The "welcome back" recap card. Visually distinct from chat bubbles — an
 * accent-bordered, elevated panel rather than a left/right message — so it
 * reads as a system briefing, not as something the agent "said". Rendered
 * trailing the message list; surfaced on project reopen or when the user
 * returns after being idle. Carries plain-prose did/next only (no stats, no
 * file lists) — its whole job is to cut re-orientation cost.
 */
export function RecapCard() {
  const recap = useRecapStore((s) => s.latest)
  const visible = useRecapStore((s) => s.visible)
  const dismiss = useRecapStore((s) => s.dismiss)

  if (!visible || !recap || (!recap.did && !recap.next)) return null

  return (
    <div className="my-5 px-2">
      <div
        className="relative rounded-xl border-l-2 t-bg-elevated px-4 py-3"
        style={{ borderColor: 'var(--color-accent-soft)' }}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-1.5 mb-1.5">
          <RotateCcw size={13} className="t-text-accent-soft" />
          <span className="text-[11px] font-medium uppercase tracking-wide t-text-accent-soft">
            Welcome back
          </span>
          <button
            onClick={dismiss}
            className="ml-auto t-text-muted hover:t-text opacity-60 hover:opacity-100 transition-opacity"
            title="Dismiss recap"
            aria-label="Dismiss recap"
          >
            <X size={13} />
          </button>
        </div>

        {recap.did && (
          <p className="text-sm t-text leading-relaxed">{recap.did}</p>
        )}
        {recap.next && (
          <p className="text-sm t-text-muted leading-relaxed mt-1.5">
            <span className="font-medium t-text">Next: </span>
            {recap.next}
          </p>
        )}
      </div>
    </div>
  )
}
