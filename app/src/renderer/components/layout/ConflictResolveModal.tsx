import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  GitMerge,
  Sparkles,
  Loader2,
  X,
  FileWarning,
  Circle,
  CheckCircle2,
  Bug,
} from 'lucide-react'
import type { ConflictFile, ConflictResolution } from '../../../preload/index'
import { useSharingStore } from '../../stores/sharing-store'
import { ConflictDiffView } from './ConflictDiffView'
import { AiMergeProgress } from './AiMergeProgress'

type Choice =
  | { mode: 'mine' }
  | { mode: 'theirs' }
  | { mode: 'merged'; content: string }

/**
 * RFC-013 §9 Layer 2 — the two-version resolution card.
 *
 * v2 redesign (2026-05-26): file list lives in a left sidebar, the active
 * file's diff (Mine vs Theirs side-by-side via @codemirror/merge) fills the
 * main area, and a post-merge review pane shows what the AI actually
 * changed. Never surfaces raw git conflict markers. Binary files: pick-one
 * only. ESC, backdrop click, or "Later" dismisses without applying.
 *
 * Debug entry: Cmd+Shift+D injects canned fixtures (see
 * debug-conflict-fixtures.ts). When debug mode is on, the "slow merge sim"
 * toggle in the header makes AI merge stall 4 s with deterministic output —
 * useful for exercising the progress UI without burning tokens.
 */
export function ConflictResolveModal() {
  const conflict = useSharingStore((s) => s.conflict)
  const files = useSharingStore((s) => s.conflictFiles)
  const loading = useSharingStore((s) => s.conflictLoading)
  const resolving = useSharingStore((s) => s.resolving)
  const lastError = useSharingStore((s) => s.lastError)
  const debugMode = useSharingStore((s) => s.debugMode)
  const slowMergeSim = useSharingStore((s) => s.slowMergeSim)
  const setSlowMergeSim = useSharingStore((s) => s.setSlowMergeSim)
  const loadConflictDetails = useSharingStore((s) => s.loadConflictDetails)
  const aiMerge = useSharingStore((s) => s.aiMerge)
  const resolveConflict = useSharingStore((s) => s.resolveConflict)
  const dismissConflict = useSharingStore((s) => s.dismissConflict)

  // Per-file resolution choice (local — only flushed to backend on Apply).
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  // Paths whose AI merge is in flight (Set so future parallelism is easy).
  const [aiBusy, setAiBusy] = useState<Set<string>>(new Set())
  // Paths whose in-flight AI merge has been cancelled — when the promise
  // eventually resolves we drop the result instead of applying it. The model
  // request itself keeps running upstream; this is purely UI dismissal.
  const cancelledRef = useRef<Set<string>>(new Set())
  // Active file in the sidebar.
  const [activePath, setActivePath] = useState<string | null>(null)

  // Reset local state every time a fresh conflict shows up, then fetch details.
  useEffect(() => {
    if (conflict) {
      setChoices({})
      setAiBusy(new Set())
      setActivePath(null)
      void loadConflictDetails()
    }
  }, [conflict, loadConflictDetails])

  // Auto-select first file once the list is populated.
  useEffect(() => {
    if (!activePath && files.length > 0) setActivePath(files[0].path)
  }, [files, activePath])

  // ESC dismisses (when not mid-apply, to avoid leaving a half-applied state).
  useEffect(() => {
    if (!conflict) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !resolving) {
        e.preventDefault()
        dismissConflict()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [conflict, resolving, dismissConflict])

  const active = useMemo(
    () => files.find((f) => f.path === activePath) ?? null,
    [files, activePath],
  )

  const allResolved = files.length > 0 && files.every((f) => choices[f.path])
  const resolvedCount = files.filter((f) => choices[f.path]).length

  if (!conflict) return null

  const setChoice = (path: string, c: Choice) =>
    setChoices((prev) => ({ ...prev, [path]: c }))

  const runAiMerge = async (file: ConflictFile) => {
    cancelledRef.current.delete(file.path) // reset any prior cancel flag
    setAiBusy((prev) => {
      const next = new Set(prev)
      next.add(file.path)
      return next
    })
    try {
      const res = await aiMerge(file)
      if (cancelledRef.current.has(file.path)) return // user cancelled — drop silently
      if (res?.ok && typeof res.content === 'string') {
        setChoice(file.path, { mode: 'merged', content: res.content })
      }
    } finally {
      setAiBusy((prev) => {
        const next = new Set(prev)
        next.delete(file.path)
        return next
      })
    }
  }

  const cancelAiMerge = (path: string) => {
    cancelledRef.current.add(path)
    setAiBusy((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }

  const apply = async () => {
    const resolutions: ConflictResolution[] = files.map((f) => {
      const c = choices[f.path]
      if (c.mode === 'merged') return { path: f.path, mode: 'merged', content: c.content }
      return { path: f.path, mode: c.mode }
    })
    await resolveConflict(resolutions)
  }

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve sync conflicts"
    >
      {/* Backdrop — click to dismiss (unless mid-apply). */}
      <div
        className="absolute inset-0 bg-black/55"
        aria-hidden="true"
        onClick={() => {
          if (!resolving) dismissConflict()
        }}
      />

      {/* Dialog — 90vw × 85vh, big enough for a real diff. */}
      <div className="relative w-[90vw] h-[85vh] max-w-[1400px] flex flex-col rounded-xl border t-border t-bg-surface shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b t-border shrink-0">
          <GitMerge size={16} className="t-text-warning shrink-0" />
          <div className="text-[14px] font-semibold t-text">
            Resolve {files.length === 1 ? '1 conflict' : `${files.length} conflicts`}
          </div>
          <div className="text-[11px] t-text-muted">
            You and a collaborator changed the same file{files.length === 1 ? '' : 's'}.
          </div>
          <div className="flex-1" />
          {debugMode && (
            <label className="flex items-center gap-1.5 text-[10.5px] t-text-muted cursor-pointer select-none px-2 py-1 rounded border t-border-subtle">
              <Bug size={11} className="t-text-warning" />
              <span>slow merge sim</span>
              <input
                type="checkbox"
                checked={slowMergeSim}
                onChange={(e) => setSlowMergeSim(e.target.checked)}
                style={{ accentColor: 'var(--color-accent)' }}
                className="cursor-pointer"
              />
            </label>
          )}
          <button
            type="button"
            onClick={() => !resolving && dismissConflict()}
            disabled={resolving}
            className="p-1 rounded hover:t-bg-hover t-text-secondary hover:t-text disabled:opacity-40"
            aria-label="Close (ESC)"
            title="Close (ESC)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body: sidebar | main */}
        <div className="flex-1 flex min-h-0">
          {/* Sidebar */}
          <aside className="w-[300px] shrink-0 flex flex-col border-r t-border min-h-0">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider t-text-muted shrink-0">
              Files ({resolvedCount}/{files.length})
            </div>

            <div className="flex-1 overflow-y-auto px-1 py-1 min-h-0">
              {loading && (
                <div className="flex items-center gap-2 px-3 py-2 t-text-muted text-[12px]">
                  <Loader2 size={13} className="animate-spin" /> Reading versions…
                </div>
              )}
              {!loading &&
                files.map((f) => (
                  <FileListRow
                    key={f.path}
                    file={f}
                    isActive={activePath === f.path}
                    choice={choices[f.path]}
                    aiMerging={aiBusy.has(f.path)}
                    onClick={() => setActivePath(f.path)}
                  />
                ))}
            </div>

            {/* Per-file resolution controls (mounted only when there's an active file) */}
            {active && (
              <div className="border-t t-border shrink-0">
                <ResolutionControls
                  file={active}
                  choice={choices[active.path]}
                  aiMerging={aiBusy.has(active.path)}
                  onChoose={(c) => setChoice(active.path, c)}
                  onAiMerge={() => runAiMerge(active)}
                />
              </div>
            )}
          </aside>

          {/* Main area — diff view goes here in Task 4. */}
          <main className="flex-1 flex flex-col min-w-0 min-h-0">
            {active ? (
              <ActiveFilePane
                file={active}
                choice={choices[active.path]}
                aiMerging={aiBusy.has(active.path)}
                onCancelAiMerge={() => cancelAiMerge(active.path)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center t-text-muted text-[12px]">
                Select a file from the list to view changes.
              </div>
            )}
          </main>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3 border-t t-border shrink-0">
          <button
            type="button"
            onClick={dismissConflict}
            disabled={resolving}
            className="px-3 py-1.5 rounded text-[12px] t-text-secondary hover:t-text disabled:opacity-40"
          >
            Later
          </button>
          {lastError && (
            <div className="text-[11px] t-text-error truncate" role="alert">
              {lastError}
            </div>
          )}
          <div className="flex-1" />
          <div className="text-[11px] t-text-muted">
            {allResolved ? (
              <span className="t-text-success inline-flex items-center gap-1">
                <CheckCircle2 size={12} /> All files resolved
              </span>
            ) : (
              <>
                {resolvedCount} of {files.length} resolved
              </>
            )}
          </div>
          <button
            type="button"
            disabled={!allResolved || resolving}
            onClick={apply}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-40 transition-opacity"
            title={!allResolved ? 'Pick a resolution for every file first' : undefined}
          >
            {resolving ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />}
            {resolving ? 'Applying…' : 'Apply & sync →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Sidebar row
// ──────────────────────────────────────────────────────────────────────────

interface FileListRowProps {
  file: ConflictFile
  isActive: boolean
  choice: Choice | undefined
  aiMerging: boolean
  onClick: () => void
}

function FileListRow({ file, isActive, choice, aiMerging, onClick }: FileListRowProps) {
  const basename = file.path.slice(file.path.lastIndexOf('/') + 1)
  const dirname = file.path.slice(0, file.path.lastIndexOf('/'))

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-[11.5px] min-w-0 ${
        isActive ? 't-bg-hover t-text' : 'hover:t-bg-hover t-text-secondary'
      }`}
      title={file.path}
    >
      <StatusDot choice={choice} aiMerging={aiMerging} isBinary={file.isBinary} />
      <div className="flex-1 min-w-0">
        <div className="font-mono truncate t-text">{basename}</div>
        {dirname && (
          <div className="text-[10px] t-text-muted font-mono truncate">{dirname}/</div>
        )}
      </div>
      {file.isBinary && (
        <FileWarning size={11} className="t-text-muted shrink-0" aria-label="binary" />
      )}
    </button>
  )
}

function StatusDot({
  choice,
  aiMerging,
  isBinary,
}: {
  choice: Choice | undefined
  aiMerging: boolean
  isBinary: boolean
}) {
  if (aiMerging) return <Loader2 size={12} className="animate-spin t-text-accent shrink-0" />
  if (choice?.mode === 'merged')
    return <Sparkles size={12} className="t-text-accent shrink-0" />
  if (choice) return <CheckCircle2 size={12} className="t-text-success shrink-0" />
  if (isBinary) return <Circle size={12} className="t-text-muted shrink-0" />
  return <Circle size={12} className="t-text-muted shrink-0" />
}

// ──────────────────────────────────────────────────────────────────────────
// Resolution controls (in the sidebar footer)
// ──────────────────────────────────────────────────────────────────────────

interface ResolutionControlsProps {
  file: ConflictFile
  choice: Choice | undefined
  aiMerging: boolean
  onChoose: (c: Choice) => void
  onAiMerge: () => void
}

function ResolutionControls({ file, choice, aiMerging, onChoose, onAiMerge }: ResolutionControlsProps) {
  const hasMerged = choice?.mode === 'merged'

  return (
    <div className="px-3 py-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider t-text-muted">Resolution</div>
      <ChoiceRadio
        label="Keep mine"
        selected={choice?.mode === 'mine'}
        onClick={() => onChoose({ mode: 'mine' })}
      />
      <ChoiceRadio
        label="Keep theirs"
        selected={choice?.mode === 'theirs'}
        onClick={() => onChoose({ mode: 'theirs' })}
      />
      {!file.isBinary && (
        <ChoiceRadio
          label="AI merged"
          selected={choice?.mode === 'merged'}
          disabled={!hasMerged}
          onClick={() => hasMerged && choice?.mode === 'merged' && onChoose(choice)}
          accent
        />
      )}

      {!file.isBinary && (
        <button
          type="button"
          onClick={onAiMerge}
          disabled={aiMerging}
          className="w-full mt-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11.5px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-50"
        >
          {aiMerging ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Merging with AI…
            </>
          ) : (
            <>
              <Sparkles size={12} />
              {hasMerged ? 'Re-merge with AI' : 'Merge with AI'}
            </>
          )}
        </button>
      )}
      {file.isBinary && (
        <div className="text-[10.5px] t-text-muted">
          Binary file — pick one side; AI merge isn't available.
        </div>
      )}
    </div>
  )
}

function ChoiceRadio({
  label,
  selected,
  disabled,
  onClick,
  accent,
}: {
  label: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-2 px-2 py-1 rounded text-[11.5px] border ${
        selected
          ? accent
            ? 't-border-accent t-bg-hover t-text'
            : 't-border-accent t-bg-hover t-text'
          : 't-border-subtle t-text-secondary hover:t-text hover:t-bg-hover'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
          selected ? 't-bg-accent' : 'border t-border-subtle'
        }`}
      />
      <span>{label}</span>
    </button>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Active file pane — Task 3 placeholder. Task 4 swaps the diff body for a
// CodeMirror MergeView. Task 5 adds the post-merge review pane below.
// ──────────────────────────────────────────────────────────────────────────

interface ActiveFilePaneProps {
  file: ConflictFile
  choice: Choice | undefined
  aiMerging: boolean
  onCancelAiMerge: () => void
}

function ActiveFilePane({ file, choice, aiMerging, onCancelAiMerge }: ActiveFilePaneProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Path breadcrumb */}
      <div className="px-4 py-2 border-b t-border shrink-0 flex items-center gap-2 text-[11.5px] font-mono t-text">
        <span className="t-text-muted truncate" title={file.path}>
          {file.path}
        </span>
        {file.isBinary && (
          <span className="px-1.5 py-0.5 rounded text-[10px] t-bg-hover t-text-muted shrink-0">
            binary
          </span>
        )}
      </div>

      {/* AI merge progress strip — sits ABOVE the diff so the diff stays
          visible as context while merging. */}
      {aiMerging && <AiMergeProgress onCancel={onCancelAiMerge} />}

      {/* Diff body — Mine vs Theirs, side-by-side via @codemirror/merge */}
      <div className="flex-1 min-h-0 flex p-3">
        {file.isBinary ? (
          <div className="flex-1 flex items-center justify-center t-text-muted text-[12px]">
            Binary file — content can't be diffed. Pick a side from the sidebar.
          </div>
        ) : (
          <ConflictDiffView
            leftDoc={file.mine}
            rightDoc={file.theirs}
            leftLabel="Mine"
            rightLabel="Theirs"
            path={file.path}
          />
        )}
      </div>

      {/* Post-merge review pane — Mine vs AI-merged side-by-side, so the user
          can see exactly what the AI changed before they commit to it. */}
      {choice?.mode === 'merged' && !file.isBinary && (
        <div className="border-t t-border shrink-0 flex flex-col" style={{ height: '38%' }}>
          <div className="px-4 py-2 text-[10px] uppercase tracking-wider t-text-muted shrink-0 flex items-center gap-2">
            <Sparkles size={11} className="t-text-accent" />
            AI-merged review — what changed from your version
          </div>
          <div className="flex-1 min-h-0 flex px-3 pb-3">
            <ConflictDiffView
              leftDoc={file.mine}
              rightDoc={choice.content}
              leftLabel="Mine"
              rightLabel="AI-merged"
              path={file.path}
              collapseAfterUnchanged={4}
            />
          </div>
        </div>
      )}
    </div>
  )
}

