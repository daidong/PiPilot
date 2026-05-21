import React, { useEffect, useState, useCallback } from 'react'
import { SettingsModal, type SettingsTab } from './components/settings/SettingsModal'
import type { WikiPaperMeta } from '../../../lib/wiki/paper-meta-cache'
import { LeftSidebar } from './components/layout/LeftSidebar'
import { CenterPanel } from './components/layout/CenterPanel'
import { StatusBar } from './components/layout/StatusBar'
import { TerminalPanel } from './components/layout/TerminalPanel'
import { ErrorBoundary } from './components/layout/ErrorBoundary'
import { ImportWizard } from './components/center/ImportWizard'
import { useChatStore } from './stores/chat-store'
import { useSessionStore } from './stores/session-store'
import { useEntityStore } from './stores/entity-store'
import { useImportStore } from './stores/import-store'
import { useEnrichmentStore } from './stores/enrichment-store'
import { useReportStore } from './stores/report-store'
import { useUIStore, applyThemeFromBroadcast, refreshResolvedTheme } from './stores/ui-store'
import type { ThemePref } from './theme-boot'
import { useProgressStore } from './stores/progress-store'
import { useActivityStore } from './stores/activity-store'
import { useToolProgressStore } from './stores/tool-progress-store'
import { useToolEventsStore } from './stores/tool-events-store'
import { useUsageStore, type UsageEvent } from './stores/usage-store'
import { useComputeStore } from './stores/compute-store'
import { useUpdateStore } from './stores/update-store'

const api = (window as any).api

// ─── Folder gate ──────────────────────────────────────────────────────────
//
// Welcome surface shown when no project is open. Deliberately stripped of
// hero imagery, gradient chrome, and centered marketing composition — the
// dialect here matches the Literature tab: left-aligned, dense, keyboard-
// first. Recent projects are the primary affordance; a new-folder picker
// is the secondary one.

interface RecentProjectEntry {
  path: string
  openedAt: string
  pinned?: boolean
}

/** Format an ISO timestamp as a short relative label. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diffMs = Date.now() - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Split a POSIX path into basename + parent. Returns parent without the
 *  trailing slash; both strings may be empty. */
function splitPath(p: string): { name: string; parent: string } {
  const clean = p.replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  if (idx < 0) return { name: clean, parent: '' }
  return { name: clean.slice(idx + 1), parent: clean.slice(0, idx) }
}

/** Small monospaced keyboard-cap chip. Consistent across the gate surface. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">
      {children}
    </kbd>
  )
}

interface ProjectStats {
  papers: number
  notes: number
  data: number
  initialized: boolean
}

function RecentRow({
  entry,
  active,
  confirmRemove,
  stats,
  onActivate,
  onHover,
}: {
  entry: RecentProjectEntry
  active: boolean
  confirmRemove: boolean
  stats?: ProjectStats
  onActivate: () => void
  onHover: () => void
}) {
  const { name, parent } = splitPath(entry.path)
  const totalArtifacts = stats ? stats.papers + stats.notes + stats.data : 0
  return (
    <button
      type="button"
      onClick={onActivate}
      onMouseEnter={onHover}
      className={`group relative w-full text-left flex items-baseline gap-4 py-1.5 pl-4 pr-3 rounded-sm transition-colors ${
        active ? 't-bg-hover' : ''
      }`}
    >
      {/* Left accent bar — matches Literature tab's wiki-row treatment */}
      <span
        aria-hidden
        className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-full transition-colors ${
          active ? 't-bg-accent' : 'bg-transparent group-hover:t-bg-accent-soft'
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[13px] font-medium truncate ${active ? 't-text' : 't-text-secondary group-hover:t-text'}`}>
            {name}
          </span>
          {entry.pinned && (
            <span className="text-[9px] uppercase tracking-wider t-text-muted">pinned</span>
          )}
          {stats && !stats.initialized && (
            <span className="text-[9px] uppercase tracking-wider t-text-muted" title="No .research-pilot directory yet">
              new
            </span>
          )}
        </div>
        {parent && (
          <div className="text-[11px] t-text-muted truncate font-mono mt-0.5">
            {parent}
          </div>
        )}
      </div>
      <div className="shrink-0 flex flex-col items-end gap-0.5 tabular-nums text-[10px] t-text-muted">
        {confirmRemove ? (
          <span className="t-text-error-soft">press ⌫ again</span>
        ) : (
          <>
            {/* Artifact counts — compact, only shown when non-zero */}
            {stats && totalArtifacts > 0 && (
              <div className="flex gap-1.5 t-text-secondary">
                {stats.papers > 0 && <span>{stats.papers}p</span>}
                {stats.notes > 0 && <span>{stats.notes}n</span>}
                {stats.data > 0 && <span>{stats.data}d</span>}
              </div>
            )}
            <span>{relativeTime(entry.openedAt)}</span>
          </>
        )}
      </div>
    </button>
  )
}

// ─── Wiki panel (FolderGate right column) ────────────────────────────────
//
// Cross-project paper wiki summary shown alongside the recent-projects list.
// Reuses the same IPCs that feed the Literature tab's WikiStatusPill and
// wiki paper search: wiki:get-stats, wiki:list-paper-meta, wiki:get-status.
// Has three visual states:
//   1. Loading / unknown → skeletal nothing, quietly
//   2. Wiki disabled (model = 'none')   → teaching empty state + settings link
//   3. Wiki enabled but empty           → teaching empty state
//   4. Wiki populated                   → stats + recent-added + status dot

interface WikiStats { papers: number; concepts: number; fulltext: number; abstractOnly: number }
interface WikiStatusShape {
  state: 'processing' | 'idle' | 'paused' | 'disabled'
  processed: number
  pending: number
  totalInWiki: number
  lastRunAt?: string
}

function WikiPanel({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [stats, setStats] = useState<WikiStats | null>(null)
  const [recentPapers, setRecentPapers] = useState<WikiPaperMeta[]>([])
  const [status, setStatus] = useState<WikiStatusShape | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.wikiGetStats?.().catch(() => null),
      api.wikiListPaperMeta?.().catch(() => null),
      api.wikiGetStatus?.().catch(() => null),
    ]).then(([s, list, st]) => {
      if (cancelled) return
      if (s) setStats(s)
      if (Array.isArray(list)) {
        const sorted = [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        setRecentPapers(sorted.slice(0, 3))
      }
      if (st) setStatus(st)
      setLoaded(true)
    })
    const unsub = api.onWikiStatus?.((s: WikiStatusShape) => setStatus(s))
    return () => { cancelled = true; unsub?.() }
  }, [])

  if (!loaded) return null

  const isDisabled = status?.state === 'disabled'
  const isEmpty = (stats?.papers ?? 0) === 0

  const header = (
    <div className="flex items-baseline justify-between mb-3">
      <span className="text-[10px] uppercase tracking-wider t-text-muted font-medium">
        Paper wiki
      </span>
      {!isEmpty && stats && (
        <span className="text-[10px] t-text-muted tabular-nums">{stats.papers}</span>
      )}
      {isDisabled && (
        <span className="text-[10px] uppercase tracking-wider t-text-muted">off</span>
      )}
    </div>
  )

  // ── Empty: wiki agent disabled ───────────────────────────────────────
  if (isDisabled) {
    return (
      <section aria-labelledby="wiki-panel-heading">
        <h2 id="wiki-panel-heading" className="sr-only">Paper wiki</h2>
        {header}
        <p className="text-[12px] t-text-secondary leading-relaxed">
          Turn the wiki agent on in settings to build a cross-project
          summary of every paper you save. It runs quietly in the
          background.
        </p>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="mt-3 inline-flex items-center gap-1.5 text-[11px] t-text-accent-soft hover:t-text-accent transition-colors"
          >
            Open settings →
          </button>
        )}
      </section>
    )
  }

  // ── Empty: enabled but no papers yet (first-run) ─────────────────────
  if (isEmpty) {
    return (
      <section aria-labelledby="wiki-panel-heading">
        <h2 id="wiki-panel-heading" className="sr-only">Paper wiki</h2>
        {header}
        <p className="text-[12px] t-text-secondary leading-relaxed">
          Your cross-project library. As you save papers in any project,
          the agent summarizes each one here — visible from every project
          afterwards.
        </p>
        <p className="mt-3 text-[11px] t-text-muted leading-relaxed">
          Nothing here yet. Open a project and add your first paper.
        </p>
      </section>
    )
  }

  // ── Populated ────────────────────────────────────────────────────────
  return (
    <section aria-labelledby="wiki-panel-heading">
      <h2 id="wiki-panel-heading" className="sr-only">Paper wiki</h2>
      {header}

      {/* Stats breakdown */}
      <div className="flex items-baseline gap-3 text-[11px] t-text-secondary tabular-nums mb-6">
        {(stats?.fulltext ?? 0) > 0 && (
          <span>
            <span className="t-text font-medium">{stats!.fulltext}</span>{' '}
            <span className="t-text-muted">fulltext</span>
          </span>
        )}
        {(stats?.abstractOnly ?? 0) > 0 && (
          <>
            <span className="t-text-muted opacity-50" aria-hidden>·</span>
            <span>
              <span className="t-text font-medium">{stats!.abstractOnly}</span>{' '}
              <span className="t-text-muted">abstract</span>
            </span>
          </>
        )}
        {(stats?.concepts ?? 0) > 0 && (
          <>
            <span className="t-text-muted opacity-50" aria-hidden>·</span>
            <span>
              <span className="t-text font-medium">{stats!.concepts}</span>{' '}
              <span className="t-text-muted">concepts</span>
            </span>
          </>
        )}
      </div>

      {/* Recently added */}
      {recentPapers.length > 0 && (
        <div className="mb-6">
          <div className="text-[10px] uppercase tracking-wider t-text-muted font-medium mb-2">
            Recently added
          </div>
          <ul className="flex flex-col gap-1.5">
            {recentPapers.map((p) => (
              <li key={p.slug} className="flex items-baseline gap-2">
                <span className="shrink-0 text-[10px] t-text-muted mt-1">·</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] t-text-secondary truncate leading-snug">
                    {p.title}
                  </div>
                  <div className="text-[10px] t-text-muted font-mono truncate">
                    {p.slug}
                    {p.updatedAt && <> · {relativeTime(p.updatedAt)}</>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Status strip */}
      {status && (
        <div className="flex items-center gap-1.5 text-[10px] t-text-muted">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              status.state === 'processing' ? 'bg-blue-500 animate-pulse' :
              status.state === 'paused' ? 'bg-yellow-500' :
              'bg-emerald-500'
            }`}
            aria-hidden
          />
          <span className="capitalize">{status.state}</span>
          {status.lastRunAt && (
            <>
              <span className="opacity-50" aria-hidden>·</span>
              <span>last tick {relativeTime(status.lastRunAt)}</span>
            </>
          )}
        </div>
      )}
    </section>
  )
}

// ─── Tips block (always shown below WikiPanel) ────────────────────────
function TipsBlock() {
  return (
    <section aria-label="Tips">
      <div className="text-[10px] uppercase tracking-wider t-text-muted font-medium mb-2">
        Tips
      </div>
      <ul className="flex flex-col gap-1.5 text-[11px] t-text-secondary">
        <li className="flex items-center gap-2">
          <Kbd>/</Kbd>
          <span className="t-text-muted">or</span>
          <Kbd>⌘K</Kbd>
          <span>open the command palette</span>
        </li>
        <li className="flex items-center gap-2">
          <Kbd>@</Kbd>
          <span>mention a note, paper, or file</span>
        </li>
        <li className="flex items-center gap-2">
          <Kbd>⌘1</Kbd><Kbd>⌘2</Kbd>
          <span>switch between chat and literature</span>
        </li>
      </ul>
    </section>
  )
}

function FolderGate({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const pickFolder = useSessionStore((s) => s.pickFolder)
  const openPath = useSessionStore((s) => s.openPath)

  const [recents, setRecents] = useState<RecentProjectEntry[]>([])
  const [projectStats, setProjectStats] = useState<Record<string, ProjectStats>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  // Load recents once on mount. The main process prunes stale paths server
  // side, so whatever comes back is safe to render.
  useEffect(() => {
    let cancelled = false
    api.listRecentProjects?.().then((list: RecentProjectEntry[] | null) => {
      if (!cancelled && Array.isArray(list)) setRecents(list)
    }).catch(() => { /* leave recents empty */ })
    return () => { cancelled = true }
  }, [])

  // Fetch per-project artifact counts whenever the recents list changes.
  // Pure file system read — no project initialization, no side effects.
  useEffect(() => {
    if (recents.length === 0) {
      setProjectStats({})
      return
    }
    let cancelled = false
    api.projectStatsBatch?.(recents.map((r) => r.path)).then(
      (map: Record<string, ProjectStats> | null) => {
        if (!cancelled && map) setProjectStats(map)
      },
    ).catch(() => { /* keep stats empty */ })
    return () => { cancelled = true }
  }, [recents])

  const handleOpen = useCallback(async (path: string) => {
    if (opening) return
    setOpening(true)
    try {
      await openPath(path)
    } finally {
      setOpening(false)
    }
  }, [openPath, opening])

  const handlePickNew = useCallback(async () => {
    if (opening) return
    setOpening(true)
    try {
      await pickFolder()
    } finally {
      setOpening(false)
    }
  }, [pickFolder, opening])

  const handleRemove = useCallback(async (path: string) => {
    await api.removeRecentProject?.(path)
    setRecents((prev) => {
      const next = prev.filter((e) => e.path !== path)
      setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, next.length - 1)))
      return next
    })
    setConfirmRemove(null)
  }, [])

  // Keyboard navigation — arrow keys move focus through the list, ↵ opens
  // the focused entry, ⌫ twice removes it, ⌘O launches the native picker.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        handlePickNew()
        return
      }
      // Cmd+, is handled globally in App for the settings modal.

      if (e.key === 'ArrowDown') {
        if (recents.length === 0) return
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % recents.length)
        setConfirmRemove(null)
      } else if (e.key === 'ArrowUp') {
        if (recents.length === 0) return
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + recents.length) % recents.length)
        setConfirmRemove(null)
      } else if (e.key === 'Enter') {
        if (recents.length === 0) {
          e.preventDefault()
          handlePickNew()
          return
        }
        const target = recents[activeIndex]
        if (target) {
          e.preventDefault()
          handleOpen(target.path)
        }
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (recents.length === 0) return
        const target = recents[activeIndex]
        if (!target) return
        e.preventDefault()
        if (confirmRemove === target.path) {
          handleRemove(target.path)
        } else {
          setConfirmRemove(target.path)
        }
      } else if (e.key === 'Escape') {
        setConfirmRemove(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [recents, activeIndex, confirmRemove, handleOpen, handlePickNew, handleRemove])

  const hasRecents = recents.length > 0

  return (
    <div className="flex flex-col h-screen w-screen t-bg-base t-text overflow-hidden">
      {/* Draggable macOS title bar strip */}
      <div className="drag-region fixed top-0 left-0 right-0 h-10 z-50" />

      {/* Main content — two-column grid at xl, single column below. Uses
          <main> landmark so the global skip-to-content link has a target. */}
      <main
        id="main-content"
        className="flex-1 overflow-y-auto pt-14 md:pt-20 px-[8vw] pb-6"
      >
        <div className="mx-auto w-full max-w-6xl">
          {/* Wordmark — typography only, no glyph. h1 is the welcome
              surface's primary heading (required for screen-reader nav). */}
          <div className="mb-6 pl-1">
            <h1 className="text-[16px] font-semibold t-text tracking-tight leading-none">
              Research Pilot
            </h1>
            <div className="text-[11px] t-text-muted mt-1.5 leading-none">
              A research workflow, not a chat window.
            </div>
          </div>

          {/* Two-column layout: recents on the left, wiki/tips on the right.
              Collapses to single column on narrow windows. */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_20rem] gap-12 xl:gap-16 items-start">
            {/* ── Left column: recent projects ──────────────────────── */}
            <section aria-labelledby="recents-heading">
              <h2 id="recents-heading" className="sr-only">Recent projects</h2>

              {hasRecents ? (
                <>
                  <div className="flex items-baseline justify-between mb-2 pl-4">
                    <span className="text-[10px] uppercase tracking-wider t-text-muted font-medium">
                      Recent projects
                    </span>
                    <span className="text-[10px] t-text-muted tabular-nums">
                      {recents.length}
                    </span>
                  </div>
                  <div className="flex flex-col mb-6">
                    {recents.map((entry, i) => (
                      <RecentRow
                        key={entry.path}
                        entry={entry}
                        stats={projectStats[entry.path]}
                        active={i === activeIndex}
                        confirmRemove={confirmRemove === entry.path}
                        onActivate={() => handleOpen(entry.path)}
                        onHover={() => {
                          setActiveIndex(i)
                          if (confirmRemove !== entry.path) setConfirmRemove(null)
                        }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="mb-6 pl-4">
                  <div className="flex items-baseline justify-between mb-3">
                    <span className="text-[10px] uppercase tracking-wider t-text-muted font-medium">
                      Recent projects
                    </span>
                    <span className="text-[10px] t-text-muted">—</span>
                  </div>
                  <p className="text-[13px] t-text-secondary leading-relaxed mb-1">
                    No projects yet.
                  </p>
                  <p className="text-[12px] t-text-muted leading-relaxed max-w-md">
                    Pick a folder to begin — we'll create a
                    {' '}
                    <code className="px-1 py-0.5 rounded t-bg-elevated text-[10.5px] font-mono t-text-secondary">.research-pilot</code>
                    {' '}
                    directory beside it for your notes, papers, and data.
                    Everything stays on disk; nothing goes to the cloud.
                  </p>
                </div>
              )}

              {/* New-folder affordance — ghost button, not primary */}
              <div className="pl-4">
                <button
                  onClick={handlePickNew}
                  disabled={opening}
                  className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-md border t-border t-text-secondary hover:t-text hover:t-border-accent-soft text-[12px] transition-colors disabled:opacity-50"
                >
                  {hasRecents ? 'Open another folder…' : 'Choose a folder to begin'}
                  <Kbd>⌘O</Kbd>
                </button>
              </div>
            </section>

            {/* ── Right column: wiki panel + tips ──────────────────── */}
            <aside aria-label="Global status" className="flex flex-col gap-10 xl:pl-4 xl:border-l t-border-subtle">
              <div className="xl:pl-8">
                <WikiPanel onOpenSettings={onOpenSettings} />
              </div>
              <div className="xl:pl-8">
                <TipsBlock />
              </div>
            </aside>
          </div>

          {/* Bottom strip: keyboard hints + settings link */}
          <div className="mt-10 pl-1 flex items-center gap-5 text-[10px] t-text-muted flex-wrap">
            {hasRecents && (
              <>
                <span className="inline-flex items-center gap-1.5"><Kbd>↑↓</Kbd> navigate</span>
                <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
                <span className="inline-flex items-center gap-1.5"><Kbd>⌫</Kbd> remove</span>
              </>
            )}
            <span className="inline-flex items-center gap-1.5"><Kbd>⌘O</Kbd> new folder</span>
            {onOpenSettings && (
              <span className="inline-flex items-center gap-1.5"><Kbd>⌘,</Kbd> settings</span>
            )}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="ml-auto text-[11px] t-text-muted hover:t-text-secondary transition-colors"
              >
                API keys & settings →
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  const appendChunk = useChatStore((s) => s.appendChunk)
  const finalize = useChatStore((s) => s.finalize)
  const initSession = useSessionStore((s) => s.init)
  const hasProject = useSessionStore((s) => s.hasProject)
  const refreshEntities = useEntityStore((s) => s.refreshAll)
  const leftCollapsed = useUIStore((s) => s.leftSidebarCollapsed)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const previewEditorFocused = useUIStore((s) => s.previewEditorFocused)
  const terminalVisible = useUIStore((s) => s.terminalVisible)
  const terminalAlive = useUIStore((s) => s.terminalAlive)
  const theme = useUIStore((s) => s.theme)

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('api-keys')
  const [authChecked, setAuthChecked] = useState(false)

  // On mount: check if any LLM auth is configured, auto-open settings if not
  useEffect(() => {
    api.hasLlmAuth?.().then((hasAuth: boolean) => {
      if (!hasAuth) {
        setSettingsOpen(true)
        setSettingsTab('api-keys')
      }
      setAuthChecked(true)
    }).catch(() => setAuthChecked(true))
  }, [])

  // Apply theme class to html element
  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.classList.add(theme)
  }, [theme])

  // Subscribe to global theme broadcasts so a toggle in any window updates
  // every other open window in lockstep. Listener short-circuits when the
  // store already matches, so the sender's own echo is a no-op.
  useEffect(() => {
    const unsub = api.onThemeChanged?.((next: ThemePref) => {
      applyThemeFromBroadcast(next)
    })
    return () => { unsub?.() }
  }, [])

  // When the preference is 'system', follow OS light/dark changes live —
  // re-resolve without mutating the stored preference. matchMedia fires only
  // on actual OS appearance flips, so this is idle the rest of the time.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (useUIStore.getState().themePref === 'system') refreshResolvedTheme()
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Subscribe to auto-update lifecycle. The pill in the StatusBar reads
  // from the store and only renders when status === 'ready'.
  useEffect(() => {
    const setUpdateState = useUpdateStore.getState().setState
    const unsub = api.onUpdateState?.(setUpdateState)
    useUpdateStore.getState().refresh().catch(() => {})
    return () => { unsub?.() }
  }, [])

  useEffect(() => {
    initSession()
  }, [])

  // Set up IPC listeners only when project is loaded
  useEffect(() => {
    if (!hasProject) return

    refreshEntities()
    useUsageStore.getState().loadPersisted().catch(() => {})

    // Recover real-time state that may have been lost during a renderer remount
    api.getRealtimeSnapshot().then((snapshot: any) => {
      if (snapshot && (snapshot.isStreaming || snapshot.streamingText)) {
        useChatStore.setState({
          streamingText: snapshot.streamingText,
          isStreaming: snapshot.isStreaming,
        })
      }
      if (snapshot && snapshot.progressItems?.length > 0) {
        useProgressStore.setState({ items: snapshot.progressItems })
      }
      if (snapshot && snapshot.activityEvents?.length > 0) {
        // Replay activity events through the store's push method to preserve merge logic
        const store = useActivityStore.getState()
        for (const evt of snapshot.activityEvents) {
          store.push({
            id: evt.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: evt.timestamp || new Date().toISOString(),
            ...evt,
          })
        }
      }
      // Replay tool events for chat-inline card recovery
      if (snapshot && snapshot.toolEvents?.length > 0) {
        const toolStore = useToolEventsStore.getState()
        for (const evt of snapshot.toolEvents) {
          if (evt.type === 'tool-call') {
            toolStore.onToolCall(evt)
          } else if (evt.type === 'tool-result') {
            toolStore.onToolResult(evt)
          }
        }
      }
    })

    // Load chat history from previous session
    api.getCurrentSession().then((session: { sessionId: string }) => {
      useChatStore.getState().loadInitial(session.sessionId)
    })

    // Load project root files into working folder
    api.listRootFiles().then((files: { path: string; name: string }[]) => {
      useUIStore.getState().setWorkingFiles(files.map((f) => f.path))
    })

    const unsub3 = api.onTodoUpdate((item: any) => {
      useProgressStore.getState().upsertItem(item)
    })
    // Progress/todos persist across turns - only clear on explicit reset
    const unsub4 = api.onTodoClear(() => {
      useProgressStore.getState().clear()
    })
    // Activity is per-run - clear on new input
    const unsubActivityClear = api.onActivityClear(() => {
      useActivityStore.getState().clear()
      useToolProgressStore.getState().clearAll()
      useToolEventsStore.getState().clearRun()
      useUsageStore.getState().resetRun()
    })
    const unsubActivity = api.onActivity((event: any) => {
      const enrichedEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ...event
      }
      useActivityStore.getState().push(enrichedEvent)

      // Also feed tool events to the chat-inline store
      if (event.type === 'tool-call') {
        useToolEventsStore.getState().onToolCall(enrichedEvent)
      } else if (event.type === 'tool-result') {
        useToolEventsStore.getState().onToolResult(enrichedEvent)
      }
    })
    const unsubToolProgress = api.onToolProgress((event: any) => {
      useToolProgressStore.getState().reportProgress(event)
      useToolEventsStore.getState().onToolProgress(event)
    })
    const unsubSkillLoaded = api.onSkillLoaded((skillName: string) => {
      useActivityStore.getState().addSkill(skillName)
    })
    const unsubRetryNotice = api.onRetryNotice((event: { attempt: number; nextDelayMs: number }) => {
      useChatStore.getState().setRetryNotice({ attempt: event.attempt, nextDelayMs: event.nextDelayMs })
    })

    // Debounce entity-change bursts: a single agent turn can emit many
    // artifact-create / artifact-update events; coalesce into one refresh.
    let entityRefreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleEntityRefresh = () => {
      if (entityRefreshTimer) clearTimeout(entityRefreshTimer)
      entityRefreshTimer = setTimeout(() => {
        entityRefreshTimer = null
        refreshEntities()
      }, 300)
    }

    const unsub1 = api.onStreamChunk((chunk: string) => appendChunk(chunk))
    const unsub2 = api.onAgentDone((result: any) => {
      finalize(result)

      // Extract file paths from agent response and add to working files
      // Matches both absolute (/foo/bar.txt) and relative (docs/bar.txt) paths
      const text = result.response || ''
      const projectRoot = useSessionStore.getState().projectPath
      const filePathRegex = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+|(?:\/[\w.-]+)+\.\w+)/gm
      let match: RegExpExecArray | null
      while ((match = filePathRegex.exec(text)) !== null) {
        let filePath = match[1]
        // Normalize relative paths to absolute for consistent deduplication
        if (!filePath.startsWith('/') && projectRoot) {
          filePath = projectRoot + '/' + filePath
        }
        useUIStore.getState().addWorkingFile(filePath)
      }

      // Complete usage tracking for this run
      if (result.usage) {
        useUsageStore.getState().completeRun({
          totalTokens: result.usage.tokens?.totalTokens ?? 0,
          totalCost: result.usage.cost?.totalCost ?? 0,
          cacheHitRate: result.usage.cacheHitRate ?? 0,
          callCount: result.usage.callCount ?? 0
        })
      }
    })
    const unsubUsage = api.onUsage((event: UsageEvent) => {
      useUsageStore.getState().recordCall(event)
    })
    const unsub5 = api.onFileCreated((path: string) => {
      useUIStore.getState().addWorkingFile(path)
    })
    const unsub6 = api.onEntityCreated(() => {
      // Fires on both artifact-create and artifact-update; debounced above.
      scheduleEntityRefresh()
    })

    // Compute events — RFC-008 §7.6: single channel dispatched through
    // the store's applyEvent reducer. ComputeEvent is a discriminated
    // union (run-update | run-complete | plan-ready | plan-approved |
    // plan-rejected | cost-killed | availability-changed).
    const unsubComputeEvent = api.onComputeEvent((event: any) => {
      useComputeStore.getState().applyEvent(event)
    })

    // Hydrate persisted runs + pending plans on mount so the Compute
    // tab restores its pre-crash state in a single round trip
    // (amendment A3).
    api?.hydrateCompute?.()
      .then((result: any) => {
        if (Array.isArray(result?.runs)) {
          useComputeStore.getState().hydrateRuns(result.runs)
        }
        if (Array.isArray(result?.pendingPlans)) {
          useComputeStore.getState().hydratePendingPlans(result.pendingPlans)
        }
        if (Array.isArray(result?.backends)) {
          useComputeStore.getState().hydrateBackends(result.backends)
        }
      })
      .catch(() => { /* non-fatal */ })

    return () => {
      if (entityRefreshTimer) clearTimeout(entityRefreshTimer)
      unsub1()
      unsub2()
      unsub3()
      unsub4()
      unsub5()
      unsub6()
      unsubActivity()
      unsubActivityClear()
      unsubToolProgress()
      unsubSkillLoaded()
      unsubRetryNotice()
      unsubUsage()
      unsubComputeEvent()
    }
  }, [hasProject])

  // Listen for menu-triggered Close Project
  useEffect(() => {
    const unsub = api.onProjectClosed(() => {
      useSessionStore.getState().closeProject()
    })
    return unsub
  }, [])

  // Wire BibTeX import progress events into the import store (RFC-006 PR-3).
  // Mounted once at App level so the store updates while the wizard is
  // closed (e.g. user navigated away mid-import) — they can reopen and
  // see the final summary.
  useEffect(() => {
    return useImportStore.getState().subscribeToProgress()
  }, [])

  // Wire enrichment progress + wiki status + report-progress into their
  // respective stores (RFC-007 PR-A/PR-B). The Paper Report button reads
  // from these to derive its six-state label. Mounted at App level so
  // the button stays correct from any view.
  useEffect(() => {
    const unsubEnrich = useEnrichmentStore.getState().subscribeToProgress()
    const unsubWiki = useReportStore.getState().subscribeToWikiStatus()
    const unsubReport = useReportStore.getState().subscribeToReportProgress()
    return () => {
      unsubEnrich()
      unsubWiki()
      unsubReport()
    }
  }, [])

  // Re-hydrate persisted report state whenever the active project
  // changes. report-state.json lives inside `<project>/.research-pilot/`,
  // so opening a different project must drop the prior session's status
  // and load the new one's. Without this, switching projects would
  // leave the button showing 'done' from project A while project B's
  // report doesn't exist.
  const sessionProjectPath = useSessionStore((s) => s.projectPath)
  useEffect(() => {
    if (!sessionProjectPath) {
      // Clear the mirrored state when no project is open. The button
      // will fall back to 'no-papers' since the entity store is empty.
      useReportStore.setState({
        reportStatus: 'idle',
        reportInputHash: undefined,
        reportPath: undefined,
        reportError: undefined,
        generationStep: undefined,
        generationPercent: undefined,
      })
      return
    }
    useReportStore.getState().hydrateFromDisk().catch(() => {})
  }, [sessionProjectPath])

  // Listen for menu-triggered Export Chat and Settings
  useEffect(() => {
    const unsubExport = api.onExportChat(() => {
      api.exportChat()
    })
    const unsubSettings = api.onOpenSettings(() => setSettingsOpen(true))
    return () => {
      unsubExport()
      unsubSettings()
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (previewEditorFocused) return

      // Cmd+1 → Chat, Cmd+2 → Literature, Cmd+3 → Compute
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault()
        useUIStore.getState().setCenterView('chat')
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') {
        e.preventDefault()
        useUIStore.getState().setCenterView('literature')
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') {
        e.preventDefault()
        useUIStore.getState().setCenterView('compute')
      }
      // Cmd+4 → Audit (lineage visualization)
      if ((e.metaKey || e.ctrlKey) && e.key === '4') {
        e.preventDefault()
        useUIStore.getState().setCenterView('audit')
      }
      // Cmd+Shift+K → Close Project
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
        e.preventDefault()
        if (useChatStore.getState().isStreaming) {
          const ok = window.confirm(
            'An agent task is still running. Close project anyway?'
          )
          if (!ok) return
        }
        useSessionStore.getState().closeProject()
      }
      if (e.key === 'Escape' && previewEntity) {
        useUIStore.getState().closePreview()
      }
      // Cmd+Shift+E → Export chat
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        api.exportChat()
      }
      // Ctrl+` or Cmd+` → Toggle terminal
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault()
        useUIStore.getState().toggleTerminal()
      }
      // Cmd+, → Toggle settings (standard macOS Preferences shortcut)
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewEntity, previewEditorFocused])

  // Wait for auth check to complete
  if (!authChecked) {
    return <div className="flex h-screen w-screen t-bg-base t-text items-center justify-center">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />
    </div>
  }

  // Settings modal renders at top level — accessible from any state via Cmd+,
  const settingsModal = (
    <SettingsModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      initialTab={settingsTab}
    />
  )

  // Show folder gate if no project selected
  if (!hasProject) {
    return (
      <>
        <FolderGate onOpenSettings={() => { setSettingsTab('api-keys'); setSettingsOpen(true) }} />
        {settingsModal}
      </>
    )
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen w-screen t-bg-base t-text">
        {/* Skip to main content link (C2: WCAG 2.4.1) */}
        <a href="#main-content" className="skip-link">Skip to content</a>
        {/* Draggable title bar */}
        <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />

        {/* Main content area */}
        <div className="flex flex-1 min-h-0">
          {!leftCollapsed && (
            <LeftSidebar onOpenSettings={() => setSettingsOpen(true)} />
          )}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className={`flex min-h-0 ${terminalVisible ? 'flex-[2]' : 'flex-1'}`}>
              {/* The entity preview is rendered inside CenterPanel's chat view
                  as a drawer bounded by the chat-body zone. See CenterPanel.tsx. */}
              <CenterPanel />
            </div>
            {/* Integrated terminal — stays mounted while alive, hidden when not visible */}
            {terminalAlive && (
              <div
                className="flex-1"
                style={{
                  minHeight: terminalVisible ? 150 : 0,
                  maxHeight: terminalVisible ? '40%' : 0,
                  overflow: 'hidden'
                }}
              >
                <TerminalPanel />
              </div>
            )}
          </div>
        </div>

        {/* Bottom status bar */}
        <StatusBar />

        {/* Settings modal overlay */}
        {settingsModal}

        {/* BibTeX import wizard — visibility driven entirely by
            useImportStore.wizardOpen, so any CTA in the app can
            open it without prop-drilling. */}
        <ImportWizard />
      </div>
    </ErrorBoundary>
  )
}
