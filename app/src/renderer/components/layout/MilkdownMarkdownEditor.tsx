import React, { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Crepe } from '@milkdown/crepe'
import { diagram } from '@milkdown/plugin-diagram'
import { replaceAll } from '@milkdown/utils'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import 'katex/dist/katex.min.css'
import './MilkdownMarkdownEditor.css'

interface MilkdownMarkdownEditorProps {
  editorId: string
  initialMarkdown: string
  /** When set, replaces editor content in-place (preserving scroll position). */
  externalMarkdown?: string
  onChange: (markdown: string) => void
  onFocusChange?: (focused: boolean) => void
  onSaveShortcut?: () => void
}

function MilkdownInner({
  editorId,
  initialMarkdown,
  externalMarkdown,
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
  const crepeRef = useRef<Crepe | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  // Flag to suppress onChange during programmatic content replacement
  const isExternalUpdateRef = useRef(false)
  // Track what was last applied externally to avoid duplicate updates
  const lastExternalMarkdownRef = useRef<string | undefined>(undefined)

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
    lastExternalMarkdownRef.current = undefined
  }, [editorId])

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdown
    })
    crepeRef.current = crepe

    // Mermaid code fences (```mermaid) render as diagrams.
    crepe.editor.use(diagram)
    crepe.setReadonly(false)

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        // Skip onChange during programmatic external updates
        if (isExternalUpdateRef.current) return

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

  // In-place content replacement when externalMarkdown changes
  useEffect(() => {
    if (
      externalMarkdown === undefined ||
      externalMarkdown === lastExternalMarkdownRef.current ||
      !crepeRef.current
    ) return

    lastExternalMarkdownRef.current = externalMarkdown

    // Find the scrollable ancestor to preserve scroll position
    const scrollable = shellRef.current?.closest('.overflow-y-auto') as HTMLElement | null
    const scrollTop = scrollable?.scrollTop ?? 0

    try {
      isExternalUpdateRef.current = true
      crepeRef.current.editor.action(replaceAll(externalMarkdown))
    } catch {
      // Editor might not be ready yet — ignore
    } finally {
      isExternalUpdateRef.current = false
    }

    // Restore scroll position after the DOM updates
    if (scrollable) {
      requestAnimationFrame(() => {
        scrollable.scrollTop = scrollTop
      })
    }
  }, [externalMarkdown])

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
      ref={shellRef}
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
