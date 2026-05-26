import React, { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { MergeView } from '@codemirror/merge'
import { useUIStore } from '../../stores/ui-store'

interface Props {
  /** Document on the left pane. `null` is rendered as the literal "(deleted)". */
  leftDoc: string | null
  /** Document on the right pane. */
  rightDoc: string | null
  /** Heading shown above the left pane. */
  leftLabel: string
  /** Heading shown above the right pane. */
  rightLabel: string
  /** File path — used only to pick a language (markdown for .md, plain text otherwise). */
  path: string
  /**
   * Collapse runs of unchanged lines longer than this many lines (default 6).
   * Pass Infinity to disable collapsing. The visible margin is always 3 lines.
   */
  collapseAfterUnchanged?: number
}

/**
 * Read-only side-by-side diff view backed by `@codemirror/merge`'s MergeView.
 * Used by ConflictResolveModal for both the main Mine vs Theirs view and the
 * post-merge Mine vs AI-merged review pane.
 *
 * Why a wrapper component:
 * - Bridges the imperative MergeView lifecycle (new / destroy) with React.
 * - Hot-swaps the theme when the app theme changes, without rebuilding.
 * - Falls back to a clean message when one side is a deletion (null doc).
 */
export function ConflictDiffView({
  leftDoc,
  rightDoc,
  leftLabel,
  rightLabel,
  path,
  collapseAfterUnchanged = 6,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<MergeView | null>(null)
  const themeCompartmentA = useRef(new Compartment())
  const themeCompartmentB = useRef(new Compartment())
  const theme = useUIStore((s) => s.theme)

  // Construct/destroy the MergeView whenever the inputs the constructor needs
  // change. We don't include `theme` here — it's reconfigured live below to
  // avoid resetting scroll position on every theme flip.
  useEffect(() => {
    if (!hostRef.current) return
    // If either side was deleted, MergeView would just show one side blank.
    // We render an explanatory message instead — handled at render time.
    if (leftDoc == null || rightDoc == null) return

    const isMarkdown = /\.(md|mdx|markdown)$/i.test(path)
    const langExt = isMarkdown ? markdown() : []
    const initialThemeExt = theme === 'dark' ? oneDark : EditorView.theme({}, { dark: false })

    const commonExtensions = [
      basicSetup,
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      // Read-only — but we keep the cursor visible so users can scroll-track.
    ]

    const view = new MergeView({
      a: {
        doc: leftDoc,
        extensions: [
          ...commonExtensions,
          langExt,
          themeCompartmentA.current.of(initialThemeExt),
        ],
      },
      b: {
        doc: rightDoc,
        extensions: [
          ...commonExtensions,
          langExt,
          themeCompartmentB.current.of(initialThemeExt),
        ],
      },
      parent: hostRef.current,
      // Hide the revert-arrow controls — this is a read-only review surface.
      revertControls: undefined,
      highlightChanges: true,
      gutter: true,
      orientation: 'a-b',
      collapseUnchanged:
        Number.isFinite(collapseAfterUnchanged)
          ? { margin: 3, minSize: collapseAfterUnchanged }
          : undefined,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftDoc, rightDoc, path, collapseAfterUnchanged])

  // Live theme swap without recreating the view (preserves scroll).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const ext = theme === 'dark' ? oneDark : EditorView.theme({}, { dark: false })
    view.a.dispatch({ effects: themeCompartmentA.current.reconfigure(ext) })
    view.b.dispatch({ effects: themeCompartmentB.current.reconfigure(ext) })
  }, [theme])

  // Deletion fallback — when one side dropped the file, MergeView is misleading.
  if (leftDoc == null || rightDoc == null) {
    return (
      <div className="flex-1 flex flex-col min-h-0 border t-border rounded overflow-hidden">
        <div className="grid grid-cols-2 border-b t-border shrink-0">
          <PaneHeader label={leftLabel} />
          <PaneHeader label={rightLabel} className="border-l t-border" />
        </div>
        <div className="grid grid-cols-2 flex-1 min-h-0">
          <DeletionOrContent doc={leftDoc} />
          <DeletionOrContent doc={rightDoc} className="border-l t-border" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 border t-border rounded overflow-hidden">
      <div className="grid grid-cols-2 border-b t-border shrink-0">
        <PaneHeader label={leftLabel} />
        <PaneHeader label={rightLabel} className="border-l t-border" />
      </div>
      {/* MergeView host. min-h-0 + flex-1 are critical so CodeMirror gets a
          definite height inside our flex column. */}
      <div ref={hostRef} className="flex-1 min-h-0 overflow-auto cm-merge-host" />
    </div>
  )
}

function PaneHeader({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div
      className={`px-3 py-1.5 text-[10px] uppercase tracking-wider t-text-muted t-bg-base ${className}`}
    >
      {label}
    </div>
  )
}

function DeletionOrContent({
  doc,
  className = '',
}: {
  doc: string | null
  className?: string
}) {
  return (
    <pre
      className={`px-3 py-2 text-[10.5px] font-mono whitespace-pre-wrap break-words overflow-auto t-text-secondary ${className}`}
    >
      {doc == null ? '(deleted on this side)' : doc || '(empty)'}
    </pre>
  )
}
