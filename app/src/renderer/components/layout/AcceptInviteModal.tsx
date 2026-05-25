import React, { useEffect, useState } from 'react'
import { Users, FolderOpen, Loader2, AlertTriangle, CheckCircle2, Mail, RefreshCw } from 'lucide-react'
import type { SharingPreflight, RepoInvitation } from '../../../preload/index'
import { useSessionStore } from '../../stores/session-store'

const api = (window as any).api

/**
 * RFC-013 §13 / §7.1 — the Join flow. Lives on the welcome surface because a
 * member joins BEFORE any project is open (clone into a fresh folder). On
 * success, opens the cloned project through the normal session path.
 */
export function AcceptInviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const openPath = useSessionStore((s) => s.openPath)
  const [repo, setRepo] = useState('')
  const [dest, setDest] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [preflight, setPreflight] = useState<SharingPreflight | null>(null)
  const [invitations, setInvitations] = useState<RepoInvitation[]>([])
  const [invitationId, setInvitationId] = useState<number | undefined>(undefined)
  const [loadingInvites, setLoadingInvites] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadInvites = async () => {
    setLoadingInvites(true)
    try {
      const list = await api?.sharingListInvitations?.()
      if (Array.isArray(list)) setInvitations(list)
    } catch { /* best-effort */ } finally {
      setLoadingInvites(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    api?.sharingPreflight?.().then((p: SharingPreflight) => {
      setPreflight(p)
      if (p?.ready) void loadInvites()
    }).catch(() => {})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const ready = !!preflight?.ready

  const pickInvitation = (inv: RepoInvitation) => {
    setRepo(inv.repo)
    setInvitationId(inv.id)
    setError(null)
  }

  const pickDest = async () => {
    const folder = await api?.sharingPickDestFolder?.()
    if (folder) setDest(folder)
  }

  const onJoin = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api?.sharingAcceptInvite?.({ repo: repo.trim(), destFolder: dest.trim(), displayName: displayName.trim() || 'Me', invitationId })
      if (!res?.ok || !res.projectPath) {
        setError(res?.error ?? 'Could not join the project.')
        return
      }
      // Open the freshly cloned project through the normal flow.
      await openPath(res.projectPath)
      onClose()
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/50" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div role="dialog" aria-label="Join shared project" className="relative w-full max-w-md rounded-xl border t-border t-bg-surface shadow-2xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-[14px] font-semibold t-text">
          <Users size={16} className="t-text-accent" /> Join a shared project
        </div>

        {/* Preflight: gh installed + authenticated */}
        <div className="rounded-lg border t-border t-bg-base p-2.5 text-[11px]">
          {preflight ? (
            ready ? (
              <span className="inline-flex items-center gap-1.5 t-text-success">
                <CheckCircle2 size={13} /> GitHub CLI installed & authenticated{preflight.login ? ` (@${preflight.login})` : ''}
              </span>
            ) : (
              <div className="space-y-1">
                <span className="inline-flex items-center gap-1.5 t-text-warning">
                  <AlertTriangle size={13} /> Setup needed:
                </span>
                <ul className="list-disc pl-5 t-text-secondary space-y-0.5 font-mono">
                  {preflight.remediation.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )
          ) : (
            <span className="t-text-muted">Checking GitHub CLI…</span>
          )}
        </div>

        {/* Pending invitations (so the invitee needn't be told the slug). GitHub
            sends the email; this lets them act on it here. Already-accepted repos
            won't appear — use manual entry below for those. */}
        {ready && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] t-text-secondary inline-flex items-center gap-1.5">
                <Mail size={12} /> Your pending invitations
              </span>
              <button type="button" onClick={loadInvites} className="p-0.5 rounded t-text-muted hover:t-text" title="Refresh" aria-label="Refresh invitations">
                <RefreshCw size={12} className={loadingInvites ? 'animate-spin' : ''} />
              </button>
            </div>
            {invitations.length > 0 ? (
              <ul className="space-y-1">
                {invitations.map((inv) => (
                  <li key={inv.id}>
                    <button
                      type="button"
                      onClick={() => pickInvitation(inv)}
                      className={`w-full text-left px-2 py-1.5 rounded border text-[12px] transition-colors ${invitationId === inv.id ? 't-border-accent-soft t-bg-accent/10' : 't-border t-bg-base hover:t-bg-hover'}`}
                    >
                      <span className="font-mono t-text">{inv.repo}</span>
                      {inv.inviter && <span className="t-text-muted"> · invited by @{inv.inviter}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] t-text-muted">
                {loadingInvites ? 'Checking…' : 'None pending. If you already accepted on GitHub, enter the repository below.'}
              </p>
            )}
          </div>
        )}

        <label className="block space-y-1">
          <span className="text-[11px] t-text-secondary">Repository (owner/name)</span>
          <input
            value={repo}
            onChange={(e) => { setRepo(e.target.value); setInvitationId(undefined) }}
            placeholder="DIR-LAB/qec-2026"
            className="w-full px-2 py-1.5 rounded border t-border t-bg-base text-[12px] t-text font-mono"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] t-text-secondary">Destination folder (must be empty or not yet exist)</span>
          <div className="flex items-center gap-2">
            <input
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="~/research/qec"
              className="flex-1 px-2 py-1.5 rounded border t-border t-bg-base text-[12px] t-text font-mono"
            />
            <button type="button" onClick={pickDest} className="inline-flex items-center gap-1 px-2 py-1.5 rounded border t-border text-[11px] t-text-secondary hover:t-text">
              <FolderOpen size={13} /> Browse
            </button>
          </div>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] t-text-secondary">Your display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Alice Chen"
            className="w-full px-2 py-1.5 rounded border t-border t-bg-base text-[12px] t-text"
          />
        </label>

        {error && <div className="text-[11px] t-text-error">{error}</div>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded text-[12px] t-text-secondary hover:t-text disabled:opacity-40">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !ready || !repo.trim() || !dest.trim()}
            onClick={onJoin}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}
            {busy ? 'Cloning…' : 'Clone & join →'}
          </button>
        </div>
      </div>
    </div>
  )
}
