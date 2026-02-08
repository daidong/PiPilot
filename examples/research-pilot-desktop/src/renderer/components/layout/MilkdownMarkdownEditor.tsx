import React, { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Crepe } from '@milkdown/crepe'
import { diagram } from '@milkdown/plugin-diagram'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import 'katex/dist/katex.min.css'
import './MilkdownMarkdownEditor.css'

interface MilkdownMarkdownEditorProps {
  editorId: string
  initialMarkdown: string
  onChange: (markdown: string) => void
  onFocusChange?: (focused: boolean) => void
  onSaveShortcut?: () => void
}

function MilkdownInner({
  editorId,
  initialMarkdown,
  onChange,
  onFocusChange,
  onSaveShortcut
}: MilkdownMarkdownEditorProps) {
  const onChangeRef = useRef(onChange)
  const onFocusChangeRef = useRef(onFocusChange)
  const onSaveShortcutRef = useRef(onSaveShortcut)
  const createdAtRef = useRef<number>(Date.now())
  const hasSeenFirstUpdateRef = useRef(false)
  const userInteractedRef = useRef(false)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onFocusChangeRef.current = onFocusChange
  }, [onFocusChange])

  useEffect(() => {
    onSaveShortcutRef.current = onSaveShortcut
  }, [onSaveShortcut])

  useEffect(() => {
    createdAtRef.current = Date.now()
    hasSeenFirstUpdateRef.current = false
    userInteractedRef.current = false
  }, [editorId])

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdown
    })

    // Mermaid code fences (```mermaid) render as diagrams.
    crepe.editor.use(diagram)
    crepe.setReadonly(false)

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (!hasSeenFirstUpdateRef.current) {
          hasSeenFirstUpdateRef.current = true
          const elapsedMs = Date.now() - createdAtRef.current
          // Ignore the initial normalization update emitted during editor boot.
          if (!userInteractedRef.current && elapsedMs < 1200) return
        }
        onChangeRef.current(markdown)
      })
      listener.focus(() => onFocusChangeRef.current?.(true))
      listener.blur(() => onFocusChangeRef.current?.(false))
    })

    return crepe
  }, [editorId])

  useEffect(() => {
    return () => onFocusChangeRef.current?.(false)
  }, [])

  const onKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    userInteractedRef.current = true
    const isMeta = e.metaKey || e.ctrlKey
    const lower = e.key.toLowerCase()

    if (isMeta && lower === 's') {
      e.preventDefault()
      e.stopPropagation()
      onSaveShortcutRef.current?.()
      return
    }

    // Block global app shortcuts while editing in Milkdown.
    if (
      lower === 'escape'
      || (isMeta && lower === 'n')
      || (isMeta && e.shiftKey && lower === 'k')
    ) {
      e.stopPropagation()
    }
  }

  return (
    <div
      className="entity-preview-milkdown-shell no-drag"
      onKeyDownCapture={onKeyDownCapture}
      onMouseDownCapture={() => {
        userInteractedRef.current = true
        onFocusChangeRef.current?.(true)
      }}
      onPasteCapture={() => {
        userInteractedRef.current = true
      }}
      onFocusCapture={() => onFocusChangeRef.current?.(true)}
    >
      <Milkdown />
    </div>
  )
}

export function MilkdownMarkdownEditor(props: MilkdownMarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} />
    </MilkdownProvider>
  )
}
