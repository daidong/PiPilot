import React, { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { useUIStore } from '../../stores/ui-store'

// Layout overrides so CodeMirror grows with its content and the panel
// scrolls — matches how Milkdown's ProseMirror is wired in this drawer.
// Without these, CodeMirror would scroll internally and the outer panel
// scroll memory (which keys "raw mode" position) wouldn't track edits.
const layoutTheme = EditorView.theme({
  '&': { height: 'auto', backgroundColor: 'transparent', fontSize: '13px' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  '.cm-content': { minHeight: '240px', padding: '12px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: 'none' },
  '&.cm-focused': { outline: 'none' }
})

interface SourceMarkdownEditorProps {
  editorId: string
  initialMarkdown: string
  /** When set, replaces editor content in-place (preserving scroll position). */
  externalMarkdown?: string
  onChange: (markdown: string) => void
  onFocusChange?: (focused: boolean) => void
  onSaveShortcut?: () => void
}

export function SourceMarkdownEditor({
  editorId,
  initialMarkdown,
  externalMarkdown,
  onChange,
  onFocusChange,
  onSaveShortcut
}: SourceMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onFocusChangeRef = useRef(onFocusChange)
  const onSaveShortcutRef = useRef(onSaveShortcut)
  const isExternalUpdateRef = useRef(false)
  const lastExternalMarkdownRef = useRef<string | undefined>(undefined)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onFocusChangeRef.current = onFocusChange }, [onFocusChange])
  useEffect(() => { onSaveShortcutRef.current = onSaveShortcut }, [onSaveShortcut])

  const theme = useUIStore((s) => s.theme)

  // Mount the editor once per editorId. Recreating only on editorId change
  // mirrors how Milkdown is keyed in the parent — switching notes (or
  // reload-keyed external updates) tears down the old view; mid-life
  // content swaps go through the externalMarkdown effect below.
  useEffect(() => {
    if (!hostRef.current) return

    const themeExt = theme === 'dark' ? oneDark : EditorView.theme({}, { dark: false })

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialMarkdown,
        extensions: [
          basicSetup,
          markdown(),
          layoutTheme,
          themeCompartment.current.of(themeExt),
          // Soft-wrap so long currency-laden lines don't force horizontal
          // scrolling — research notes are prose-shaped, not code-shaped.
          EditorView.lineWrapping,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveShortcutRef.current?.()
                return true
              }
            }
          ]),
          EditorView.updateListener.of((update) => {
            if (update.focusChanged) {
              onFocusChangeRef.current?.(update.view.hasFocus)
            }
            if (update.docChanged) {
              if (isExternalUpdateRef.current) return
              const next = update.state.doc.toString()
              onChangeRef.current(next)
            }
          })
        ]
      })
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorId])

  // Live theme swap without recreating the editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const themeExt = theme === 'dark' ? oneDark : EditorView.theme({}, { dark: false })
    view.dispatch({ effects: themeCompartment.current.reconfigure(themeExt) })
  }, [theme])

  // External content replacement (e.g. agent rewrite of the underlying note).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (externalMarkdown === undefined) return
    if (externalMarkdown === lastExternalMarkdownRef.current) return
    lastExternalMarkdownRef.current = externalMarkdown

    const current = view.state.doc.toString()
    if (current === externalMarkdown) return

    try {
      isExternalUpdateRef.current = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: externalMarkdown }
      })
    } finally {
      isExternalUpdateRef.current = false
    }
  }, [externalMarkdown])

  return (
    <div
      ref={hostRef}
      className="entity-preview-source-shell no-drag"
    />
  )
}
