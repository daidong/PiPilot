import React, { useEffect, useState } from 'react'
import { GitMerge, Sparkles, Loader2, Check, FileWarning, ChevronDown, ChevronRight } from 'lucide-react'
import type { ConflictFile, ConflictResolution } from '../../../preload/index'
import { useSharingStore } from '../../stores/sharing-store'

type Choice =
  | { mode: 'mine' }
  | { mode: 'theirs' }
  | { mode: 'merged'; content: string }

/**
 * RFC-013 §9 Layer 2 — the two-version resolution card. Never shows raw git
 * conflict markers. For text files: AI-merge (recommended) / keep mine / keep
 * theirs. For binary files: pick-one only. Opens whenever a sync hit a
 * co-edited-file clash; applies all resolutions as a single merge commit.
 */
export function ConflictResolveModal() {
  const conflict = useSharingStore((s) => s.conflict)
  const files = useSharingStore((s) => s.conflictFiles)
  const loading = useSharingStore((s) => s.conflictLoading)
  const resolving = useSharingStore((s) => s.resolving)
  const lastError = useSharingStore((s) => s.lastError)
  const loadConflictDetails = useSharingStore((s) => s.loadConflictDetails)
  const aiMerge = useSharingStore((s) => s.aiMerge)
  const resolveConflict = useSharingStore((s) => s.resolveConflict)
  const dismissConflict = useSharingStore((s) => s.dismissConflict)

  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [aiBusy, setAiBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (conflict) {
      setChoices({})
      void loadConflictDetails()
    }
  }, [conflict, loadConflictDetails])

  if (!conflict) return null

  const setChoice = (path: string, c: Choice) => setChoices((prev) => ({ ...prev, [path]: c }))

  const runAiMerge = async (file: ConflictFile) => {
    setAiBusy(file.path)
    try {
      const res = await aiMerge(file)
      if (res?.ok && typeof res.content === 'string') {
        setChoice(file.path, { mode: 'merged', content: res.content })
        setExpanded((e) => ({ ...e, [file.path]: true }))
      }
    } finally {
      setAiBusy(null)
    }
  }

  const allResolved = files.length > 0 && files.every((f) => choices[f.path])

  const apply = async () => {
    const resolutions: ConflictResolution[] = files.map((f) => {
      const c = choices[f.path]
      if (c.mode === 'merged') return { path: f.path, mode: 'merged', content: c.content }
      return { path: f.path, mode: c.mode }
    })
    await resolveConflict(resolutions)
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
      <div role="dialog" aria-label="Resolve sync conflicts" className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border t-border t-bg-surface shadow-2xl">
        <div className="flex items-center gap-2 px-5 py-4 border-b t-border">
          <GitMerge size={16} className="t-text-warning" />
          <div className="text-[14px] font-semibold t-text">Two versions need your confirmation</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
          <p className="text-[12px] t-text-secondary">
            You and a collaborator changed the same {files.length === 1 ? 'file' : `${files.length} files`}.
            Pick how to resolve each — for text, let the AI reconcile both, or keep one side.
          </p>

          {loading && (
            <div className="flex items-center gap-2 t-text-muted text-[12px] py-4">
              <Loader2 size={14} className="animate-spin" /> Reading both versions…
            </div>
          )}

          {!loading && files.map((f) => {
            const choice = choices[f.path]
            const isOpen = expanded[f.path]
            return (
              <div key={f.path} className="rounded-lg border t-border t-bg-base">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [f.path]: !e[f.path] }))}
                    className="flex items-center gap-1.5 min-w-0 text-[12px] t-text font-mono truncate"
                  >
                    {isOpen ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
                    <span className="truncate">{f.path}</span>
                    {f.isBinary && (
                      <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] t-bg-hover t-text-muted shrink-0">
                        <FileWarning size={10} /> binary
                      </span>
                    )}
                  </button>
                  {choice && (
                    <span className="inline-flex items-center gap-1 text-[11px] t-text-success shrink-0">
                      <Check size={12} />
                      {choice.mode === 'mine' ? 'keep mine' : choice.mode === 'theirs' ? 'keep theirs' : 'AI-merged'}
                    </span>
                  )}
                </div>

                {isOpen && (
                  <div className="px-3 pb-2 space-y-2">
                    {choice?.mode === 'merged' ? (
                      <label className="block space-y-1">
                        <span className="text-[10px] uppercase tracking-wider t-text-muted">AI-merged (editable)</span>
                        <textarea
                          value={choice.content}
                          onChange={(e) => setChoice(f.path, { mode: 'merged', content: e.target.value })}
                          className="w-full h-40 px-2 py-1.5 rounded border t-border t-bg-surface text-[11px] t-text font-mono resize-y"
                        />
                      </label>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <VersionBlock label="Mine" text={f.mine} binary={f.isBinary} />
                        <VersionBlock label="Theirs" text={f.theirs} binary={f.isBinary} />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2 px-3 py-2 border-t t-border-subtle">
                  {!f.isBinary && (
                    <button
                      type="button"
                      disabled={aiBusy === f.path}
                      onClick={() => runAiMerge(f)}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-50"
                    >
                      {aiBusy === f.path ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                      {choice?.mode === 'merged' ? 'Re-merge with AI' : 'Merge with AI'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setChoice(f.path, { mode: 'mine' })}
                    className={`px-2 py-1 rounded text-[11px] border t-border ${choice?.mode === 'mine' ? 't-bg-hover t-text' : 't-text-secondary hover:t-text'}`}
                  >
                    Keep mine
                  </button>
                  <button
                    type="button"
                    onClick={() => setChoice(f.path, { mode: 'theirs' })}
                    className={`px-2 py-1 rounded text-[11px] border t-border ${choice?.mode === 'theirs' ? 't-bg-hover t-text' : 't-text-secondary hover:t-text'}`}
                  >
                    Keep theirs
                  </button>
                </div>
              </div>
            )
          })}

          {lastError && <div className="text-[11px] t-text-error">{lastError}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t t-border">
          <button type="button" onClick={dismissConflict} disabled={resolving} className="px-3 py-1.5 rounded text-[12px] t-text-secondary hover:t-text disabled:opacity-40">
            Later
          </button>
          <button
            type="button"
            disabled={!allResolved || resolving}
            onClick={apply}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium t-bg-accent t-text-on-accent hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {resolving ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />}
            {resolving ? 'Applying…' : 'Apply & sync →'}
          </button>
        </div>
      </div>
    </div>
  )
}

function VersionBlock({ label, text, binary }: { label: string; text: string | null; binary: boolean }) {
  return (
    <div className="space-y-1 min-w-0">
      <span className="text-[10px] uppercase tracking-wider t-text-muted">{label}</span>
      <pre className="h-32 overflow-auto px-2 py-1.5 rounded border t-border t-bg-surface text-[10.5px] t-text-secondary whitespace-pre-wrap break-words">
        {binary ? '(binary file)' : text == null ? '(deleted)' : text || '(empty)'}
      </pre>
    </div>
  )
}
