import React, { useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import { useUpdateStore } from '../../stores/update-store'

/**
 * Tiny pill that appears in the right edge of the StatusBar only when an
 * update has finished downloading. Click → confirm → quitAndInstall.
 *
 * Hidden in every other state (idle, downloading, dismissed-by-user) so the
 * main UI is never disturbed.
 */
export function UpdateReadyPill() {
  const status = useUpdateStore((s) => s.status)
  const version = useUpdateStore((s) => s.version)
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion)
  const restart = useUpdateStore((s) => s.restart)
  const dismiss = useUpdateStore((s) => s.dismiss)

  const [confirming, setConfirming] = useState(false)

  if (status !== 'ready') return null
  if (dismissedVersion === version) return null

  if (confirming) {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap" role="dialog" aria-label="Confirm restart">
        <span className="t-text">Restart now to install v{version}?</span>
        <button
          type="button"
          onClick={() => restart()}
          className="px-1.5 py-0.5 rounded text-[11px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 transition-opacity"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={() => {
            dismiss()
            setConfirming(false)
          }}
          className="px-1.5 py-0.5 rounded text-[11px] t-text-secondary hover:t-text"
        >
          Later
        </button>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded t-bg-accent-soft/15 t-text-accent hover:t-bg-accent-soft/25 transition-colors"
        title={`Update v${version} downloaded — click to restart and install`}
      >
        <ArrowUpCircle size={11} aria-hidden className="shrink-0" />
        <span>Update ready · Restart</span>
      </button>
      <button
        type="button"
        onClick={() => dismiss()}
        className="p-0.5 rounded t-text-muted hover:t-text-secondary"
        aria-label="Hide update notification until next version"
        title="Hide until next version"
      >
        <X size={10} aria-hidden />
      </button>
    </span>
  )
}
