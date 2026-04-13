import React, { useState, useEffect } from 'react'
import { ArrowUpCircle, Check, Copy, X } from 'lucide-react'

const api = (window as any).api

interface Props {
  /** Layout variant — compact fits inside a settings pane; welcome
   *  spans full width above the folder gate's two-column grid. */
  variant?: 'compact' | 'welcome'
  className?: string
}

/**
 * Probes the npm registry for a newer research-copilot version and renders
 * a dismissable banner when one is available. Backend handler is cached for
 * the lifetime of the main process, so it's safe to mount this in multiple
 * places — repeat calls hit the cache.
 */
export function UpdateBanner({ variant = 'compact', className = '' }: Props) {
  const [update, setUpdate] = useState<{ latest: string; current: string; hasUpdate: boolean } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.checkForUpdate?.().then((info: { latest: string; current: string; hasUpdate: boolean }) => {
      if (info.hasUpdate) setUpdate(info)
    }).catch(() => {})
  }, [])

  if (!update || dismissed) return null

  const command = 'npm update -g research-copilot'
  const wrapperClass = variant === 'welcome'
    ? `relative rounded-xl border t-border-subtle t-bg-elevated overflow-hidden ${className}`
    : `mb-4 relative rounded-lg border t-border-subtle t-bg-elevated overflow-hidden ${className}`

  return (
    <div className={wrapperClass} role="status" aria-live="polite">
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] t-bg-accent-soft" />
      <div className={variant === 'welcome' ? 'px-4 py-3 flex items-start gap-3' : 'px-3 py-2.5 flex items-start gap-2.5'}>
        <ArrowUpCircle size={variant === 'welcome' ? 16 : 15} className="t-text-accent-soft mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className={variant === 'welcome' ? 'text-sm font-medium t-text' : 'text-xs font-medium t-text'}>
            v{update.latest} available
            <span className="t-text-secondary font-normal ml-1.5">(current: v{update.current})</span>
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <code className={`flex-1 font-mono px-2 py-1 rounded t-bg-surface t-text select-all ${
              variant === 'welcome' ? 'text-[11px]' : 'text-[10px]'
            }`}>
              {command}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(command)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="shrink-0 p-1 rounded t-bg-surface hover:opacity-80 transition-opacity"
              title="Copy command"
              aria-label="Copy npm update command"
            >
              {copied ? <Check size={12} className="t-text-success" /> : <Copy size={12} className="t-text-secondary" />}
            </button>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 p-0.5 rounded hover:t-bg-surface transition-colors t-text-secondary hover:t-text"
          aria-label="Dismiss update notification"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
