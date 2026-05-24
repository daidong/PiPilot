import React, { useEffect, useState } from 'react'
import { Users, GitBranch, AlertTriangle, ExternalLink, Loader2, UserPlus, MoreHorizontal, ShieldCheck, Trash2, Ban } from 'lucide-react'
import { useSharingStore } from '../../stores/sharing-store'

/**
 * RFC-013 §13.1 — the "Sharing" tab: the single home for everything
 * sharing-related. Unshared ⇒ a Share-project entry point. Shared ⇒ project
 * status + member roster + invite/remove/promote. Specific actions are inline
 * forms here rather than separate modal components (keeps surface area small).
 */
export function SharingSettings() {
  const status = useSharingStore((s) => s.status)
  const preflight = useSharingStore((s) => s.preflight)
  const refresh = useSharingStore((s) => s.refresh)
  const checkPreflight = useSharingStore((s) => s.checkPreflight)

  useEffect(() => {
    void refresh()
    void checkPreflight()
  }, [refresh, checkPreflight])

  if (!status) {
    return (
      <section aria-labelledby="sharing-heading" className="text-[12px] t-text-secondary">
        <h2 id="sharing-heading" className="sr-only">Sharing</h2>
        No project is open. Sharing is project-scoped.
      </section>
    )
  }

  return (
    <section aria-labelledby="sharing-heading" className="space-y-5">
      <h2 id="sharing-heading" className="sr-only">Sharing</h2>
      {preflight && !preflight.ready && <PreflightGate />}
      {status.shared ? <SharedView /> : <UnsharedView ready={!!preflight?.ready} />}
    </section>
  )
}

// ── Preflight remediation ─────────────────────────────────────────────────────

function PreflightGate() {
  const preflight = useSharingStore((s) => s.preflight)
  const checkPreflight = useSharingStore((s) => s.checkPreflight)
  if (!preflight) return null
  return (
    <div className="rounded-lg border t-border t-bg-surface p-3 space-y-2">
      <div className="flex items-center gap-2 text-[12px] font-medium t-text">
        <AlertTriangle size={14} className="t-text-warning shrink-0" />
        Setup needed before sharing
      </div>
      <ul className="text-[11px] t-text-secondary space-y-1 list-disc pl-5">
        {preflight.remediation.map((r, i) => (
          <li key={i} className="font-mono">{r}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => checkPreflight()}
        className="text-[11px] t-text-accent-soft hover:t-text-accent transition-colors"
      >
        Re-check →
      </button>
    </div>
  )
}

// ── Unshared: share-project entry ─────────────────────────────────────────────

function UnsharedView({ ready }: { ready: boolean }) {
  const status = useSharingStore((s) => s.status)
  const share = useSharingStore((s) => s.share)
  const [open, setOpen] = useState(false)
  const [repoName, setRepoName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [invites, setInvites] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Seed sensible defaults from the project name + existing identity.
    if (status?.name && !repoName) setRepoName(slug(status.name))
    if (status?.me?.displayName && !displayName) setDisplayName(status.me.displayName)
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  const onShare = async () => {
    setBusy(true)
    setError(null)
    const result = await share({
      repoName: repoName.trim(),
      displayName: displayName.trim() || 'Me',
      invites: invites.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    })
    setBusy(false)
    if (!result?.ok) {
      setError(result?.error ?? 'Share failed.')
      return
    }
    if (result.inviteErrors.length > 0) {
      setError(`Shared, but some invites failed: ${result.inviteErrors.map((e) => `${e.login} (${e.error})`).join('; ')}`)
    }
    setOpen(false)
  }

  // RFC-013: a folder that's already a git repo can't be shared (we'd risk the
  // user's own history). Block here and explain.
  const blocked = status?.canShare === false

  if (!open) {
    return (
      <div className="space-y-3">
        <div className="text-[12px] t-text-secondary">
          <span className="font-medium t-text">Not shared yet.</span> This project is local only.
        </div>
        {blocked && (
          <div className="rounded-lg border t-border t-bg-surface p-3 flex items-start gap-2">
            <AlertTriangle size={14} className="t-text-warning shrink-0 mt-0.5" />
            <div className="text-[11px] t-text-secondary leading-relaxed">
              {status?.shareBlockedReason ??
                'This folder is already a Git repository. Sharing manages its own repo — use a fresh, non-Git folder.'}
            </div>
          </div>
        )}
        <button
          type="button"
          disabled={!ready || blocked}
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          title={blocked ? 'This folder is already a Git repository' : ready ? 'Create a private GitHub repo and share' : 'Complete setup above first'}
        >
          <Users size={14} /> Share project…
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border t-border t-bg-surface p-4 space-y-3">
      <div className="text-[12px] font-medium t-text">Share project</div>
      <p className="text-[11px] t-text-muted">Creates a private GitHub repo via the GitHub CLI. You'll be the Lead.</p>
      <Field label="Repository name">
        <input
          value={repoName}
          onChange={(e) => setRepoName(e.target.value)}
          placeholder="my-project (or org/my-project)"
          className="w-full px-2 py-1.5 rounded border t-border t-bg-base text-[12px] t-text font-mono"
        />
      </Field>
      <Field label="Your display name">
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Prof. Dai"
          className="w-full px-2 py-1.5 rounded border t-border t-bg-base text-[12px] t-text"
        />
      </Field>
      <Field label="Invite (GitHub usernames, space/comma separated)">
        <input
          value={invites}
          onChange={(e) => setInvites(e.target.value)}
          placeholder="alice-gh  bob-gh"
          className="w-full px-2 py-1.5 rounded border t-border t-bg-base text-[12px] t-text font-mono"
        />
      </Field>
      <p className="text-[11px] t-text-muted leading-relaxed">
        Invitees get a GitHub email, then join from Research Pilot's
        <span className="t-text-secondary"> "Accept an invitation"</span> screen (on the welcome page) — it lists
        their pending invites and clones into a fresh folder.
      </p>
      {error && <div className="text-[11px] t-text-error">{error}</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded text-[12px] t-text-secondary hover:t-text">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !repoName.trim()}
          onClick={onShare}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}
          {busy ? 'Creating…' : 'Create & invite →'}
        </button>
      </div>
    </div>
  )
}

// ── Shared: status + roster ───────────────────────────────────────────────────

function SharedView() {
  const status = useSharingStore((s) => s.status)!
  const invite = useSharingStore((s) => s.invite)
  const removeMember = useSharingStore((s) => s.removeMember)
  const promoteMember = useSharingStore((s) => s.promoteMember)
  const accessRevoked = useSharingStore((s) => s.accessRevoked)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteLogin, setInviteLogin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isLead = status.myRole === 'lead'
  const sync = status.sync

  const onInvite = async () => {
    setBusy(true)
    setError(null)
    const r = await invite(inviteLogin.trim())
    setBusy(false)
    if (!r?.ok) { setError(r?.error ?? 'Invite failed.'); return }
    setInviteLogin('')
    setInviteOpen(false)
  }

  return (
    <div className="space-y-4">
      {accessRevoked && (
        <div className="rounded-lg border t-border t-bg-surface p-3 flex items-start gap-2">
          <Ban size={15} className="t-text-error shrink-0 mt-0.5" />
          <div className="text-[11px] t-text-secondary leading-relaxed">
            <span className="font-medium t-text-error">You no longer have access to this shared repository.</span>{' '}
            It may have been removed by the project Lead, or deleted. Your local files are intact and still
            editable — syncing is just disabled. If you were re-invited, accept it on GitHub and click Sync again.
          </div>
        </div>
      )}
      <dl className="text-[12px] space-y-1.5">
        <Row label="Project">{status.name ?? '—'}</Row>
        <Row label="Repo">
          {status.repoUrl ? (
            <button
              type="button"
              onClick={() => status.repoUrl && window.open(status.repoUrl, '_blank')}
              className="inline-flex items-center gap-1 t-text-accent hover:underline font-mono"
            >
              {status.repo} <ExternalLink size={11} />
            </button>
          ) : (
            <span className="font-mono t-text-secondary">{status.repo}</span>
          )}
          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] t-bg-hover t-text-muted">private</span>
        </Row>
        {status.lead && <Row label="Created by">{status.lead.displayName} (Lead)</Row>}
        <Row label="Sync">
          {sync ? <SyncSummary ahead={sync.ahead} behind={sync.behind} uncommitted={sync.uncommitted} hasUpstream={sync.hasUpstream} /> : '—'}
        </Row>
      </dl>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] uppercase tracking-wider t-text-muted font-medium flex items-center gap-1.5">
            <Users size={12} /> Members
          </span>
          {isLead && (
            <button
              type="button"
              onClick={() => setInviteOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] t-text-accent-soft hover:t-text-accent transition-colors"
            >
              <UserPlus size={12} /> Invite…
            </button>
          )}
        </div>

        {inviteOpen && (
          <div className="mb-2 flex items-center gap-2">
            <input
              value={inviteLogin}
              onChange={(e) => setInviteLogin(e.target.value)}
              placeholder="github-username"
              className="flex-1 px-2 py-1 rounded border t-border t-bg-base text-[12px] t-text font-mono"
            />
            <button
              type="button"
              disabled={busy || !inviteLogin.trim()}
              onClick={onInvite}
              className="px-2.5 py-1 rounded text-[11px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-40"
            >
              {busy ? '…' : 'Add'}
            </button>
          </div>
        )}
        {error && <div className="mb-2 text-[11px] t-text-error">{error}</div>}

        <ul className="space-y-1">
          {status.members.map((m, i) => (
            <MemberRow
              key={m.actorId ?? m.githubLogin ?? i}
              displayName={m.displayName}
              login={m.githubLogin}
              role={m.role}
              isMe={!!status.me && m.actorId === status.me.id}
              canManage={isLead && m.role !== 'lead'}
              onRemove={m.githubLogin ? () => removeMember(m.githubLogin!) : undefined}
              onPromote={m.githubLogin ? () => promoteMember(m.githubLogin!) : undefined}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

function MemberRow({
  displayName, login, role, isMe, canManage, onRemove, onPromote,
}: {
  displayName: string
  login?: string
  role: 'lead' | 'member'
  isMe: boolean
  canManage: boolean
  onRemove?: () => void
  onPromote?: () => void
}) {
  const [menu, setMenu] = useState(false)
  return (
    <li className="flex items-center justify-between px-2 py-1.5 rounded t-bg-hover/40 text-[12px]">
      <span className="flex items-center gap-2 min-w-0">
        <span className="t-text truncate">{displayName}</span>
        {login && <span className="t-text-muted font-mono text-[10px] truncate">@{login}</span>}
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${role === 'lead' ? 't-bg-accent/15 t-text-accent' : 't-bg-hover t-text-muted'}`}>
          {role}
        </span>
        {isMe && <span className="text-[10px] t-text-muted">you</span>}
      </span>
      {canManage && (onRemove || onPromote) && (
        <div className="relative">
          <button type="button" onClick={() => setMenu((v) => !v)} className="p-1 rounded t-text-muted hover:t-text" aria-label="Member actions">
            <MoreHorizontal size={14} />
          </button>
          {menu && (
            <div className="absolute right-0 top-full mt-1 min-w-[150px] rounded-lg border t-border t-bg-surface shadow-xl z-10 py-1" onMouseLeave={() => setMenu(false)}>
              {onPromote && (
                <button type="button" onClick={() => { onPromote(); setMenu(false) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] t-text t-bg-hover">
                  <ShieldCheck size={13} className="t-text-muted" /> Make co-Lead
                </button>
              )}
              {onRemove && (
                <button type="button" onClick={() => { onRemove(); setMenu(false) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] t-text-error t-bg-hover">
                  <Trash2 size={13} /> Remove
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function SyncSummary({ ahead, behind, uncommitted, hasUpstream }: { ahead: number; behind: number; uncommitted: boolean; hasUpstream: boolean }) {
  if (!hasUpstream) return <span className="t-text-muted">not pushed yet</span>
  const parts: string[] = []
  if (uncommitted) parts.push('uncommitted changes')
  if (ahead > 0) parts.push(`${ahead} to push`)
  if (behind > 0) parts.push(`${behind} to pull`)
  if (parts.length === 0) return <span className="inline-flex items-center gap-1 t-text-success"><GitBranch size={11} /> up to date</span>
  return <span className="t-text-warning">{parts.join(' · ')}</span>
}

// ── small helpers ──────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] t-text-secondary">{label}</span>
      {children}
    </label>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-20 shrink-0 t-text-muted">{label}</dt>
      <dd className="t-text">{children}</dd>
    </div>
  )
}

function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project'
}
