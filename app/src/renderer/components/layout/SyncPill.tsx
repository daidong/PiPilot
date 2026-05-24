import React, { useEffect } from 'react'
import { RefreshCw, ArrowDownCircle, ArrowUpCircle, Check, AlertTriangle, Loader2, Ban } from 'lucide-react'
import { useSharingStore } from '../../stores/sharing-store'
import { useSessionStore } from '../../stores/session-store'

/**
 * RFC-013 §13 — the only frequently-used sharing control. Lives in the right
 * edge of the StatusBar next to UpdateReadyPill; the pill IS the button (click →
 * Sync, like the update pill's click → restart). Hidden entirely when the
 * project isn't shared, so the bar is undisturbed for solo projects.
 *
 * Lifecycle is co-located here because StatusBar is the one always-mounted
 * consumer while a project is open: refresh status on project change, then poll
 * the remote (detect-only, §14) on a slow interval.
 */
const POLL_INTERVAL_MS = 90_000

export function SyncPill() {
  const projectPath = useSessionStore((s) => s.projectPath)
  const status = useSharingStore((s) => s.status)
  const syncing = useSharingStore((s) => s.syncing)
  const updatesAvailable = useSharingStore((s) => s.updatesAvailable)
  const conflict = useSharingStore((s) => s.conflict)
  const accessRevoked = useSharingStore((s) => s.accessRevoked)
  const lastError = useSharingStore((s) => s.lastError)
  const sync = useSharingStore((s) => s.sync)
  const refresh = useSharingStore((s) => s.refresh)
  const poll = useSharingStore((s) => s.poll)

  useEffect(() => {
    if (!projectPath) return
    void (async () => {
      await refresh()
      await poll()
    })()
    const id = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [projectPath, refresh, poll])

  if (!status?.shared) return null

  const sy = status.sync
  const behind = (sy?.behind ?? 0) > 0 || updatesAvailable
  const ahead = (sy?.ahead ?? 0) > 0 || !!sy?.uncommitted

  let icon = <Check size={11} aria-hidden className="shrink-0" />
  let label = 'Synced'
  let tone = 't-text-success'
  let title = 'Up to date — click to sync'

  if (syncing) {
    icon = <Loader2 size={11} aria-hidden className="shrink-0 animate-spin" />
    label = 'Syncing…'
    tone = 't-text-secondary'
    title = 'Syncing with the shared repository'
  } else if (accessRevoked) {
    icon = <Ban size={11} aria-hidden className="shrink-0" />
    label = 'No access'
    tone = 't-text-error'
    title = 'You no longer have access to this shared repository. Your local files are intact; syncing is disabled. See Settings → Sharing.'
  } else if (conflict) {
    icon = <AlertTriangle size={11} aria-hidden className="shrink-0" />
    label = 'Conflict'
    tone = 't-text-error'
    title = `Co-edited file conflict: ${conflict.files.join(', ') || 'resolve and re-sync'}`
  } else if (behind && ahead) {
    icon = <RefreshCw size={11} aria-hidden className="shrink-0" />
    label = 'Sync'
    tone = 't-text-accent'
    title = `${sy?.ahead ?? 0} to push · updates available — click to sync`
  } else if (behind) {
    icon = <ArrowDownCircle size={11} aria-hidden className="shrink-0" />
    label = 'Updates'
    tone = 't-text-accent'
    title = 'Updates available — click to sync'
  } else if (ahead) {
    icon = <ArrowUpCircle size={11} aria-hidden className="shrink-0" />
    label = sy?.ahead ? `${sy.ahead} to push` : 'Changes'
    tone = 't-text-warning'
    title = 'You have local changes — click to sync'
  }

  return (
    <button
      type="button"
      onClick={() => { if (!syncing) void sync() }}
      disabled={syncing}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded t-bg-hover/40 hover:t-bg-hover transition-colors whitespace-nowrap ${tone}`}
      title={lastError ? `Last sync error: ${lastError}` : title}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
