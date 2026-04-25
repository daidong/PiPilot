import React, { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Crepe } from '@milkdown/crepe'
import { remarkStringifyOptionsCtx } from '@milkdown/core'
import { diagram } from '@milkdown/plugin-diagram'
import { replaceAll } from '@milkdown/utils'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import 'katex/dist/katex.min.css'
import './MilkdownMarkdownEditor.css'
import { resolveMarkdownImageUrl } from '../../utils/markdown-image'

interface MilkdownMarkdownEditorProps {
  editorId: string
  initialMarkdown: string
  /** When set, replaces editor content in-place (preserving scroll position). */
  externalMarkdown?: string
  onChange: (markdown: string) => void
  onFocusChange?: (focused: boolean) => void
  onSaveShortcut?: () => void
  /** Absolute directory the markdown file lives in. Used to resolve
   *  relative image refs (`![](./foo.png)`) to workspace-asset:// URLs
   *  so they actually load in the preview. */
  baseDir?: string
}

function MilkdownInner({
  editorId,
  initialMarkdown,
  externalMarkdown,
  onChange,
  onFocusChange,
  onSaveShortcut,
  baseDir
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
      defaultValue: initialMarkdown,
      features: {
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.LinkTooltip]: false,
      }
    })
    crepeRef.current = crepe

    // Mermaid code fences (```mermaid) render as diagrams.
    crepe.editor.use(diagram)

    // remark-stringify defaults to `***` for thematic breaks; Marp decks
    // use `---` as slide separators and authors universally write them
    // that way. Without this override, every save would rewrite `---` to
    // `***`, which Marp's detection and user muscle memory both depend
    // on. Pinning `rule: '-'` keeps the source stable across round-trips.
    crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        rule: '-'
      }))
    })

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

  // Rewrite <img src> within the editor to workspace-asset:// URLs so
  // relative / absolute disk paths in the markdown actually load. We do
  // this in the DOM (not in the markdown source) so saves preserve the
  // author's original relative paths.
  //
  // Uses a MutationObserver because Crepe/ProseMirror may mount images
  // lazily (code-fence → diagram → embedded image, external content
  // swaps, etc.) — a single initial pass wouldn't catch them all.
  useEffect(() => {
    const host = shellRef.current
    if (!host) return

    const rewriteImg = (img: HTMLImageElement) => {
      const currentSrc = img.getAttribute('src')
      if (!currentSrc) return
      const resolved = resolveMarkdownImageUrl(currentSrc, baseDir)
      if (resolved && resolved !== currentSrc) {
        img.setAttribute('src', resolved)
      }
    }
    const rewriteAllWithin = (el: Element) => {
      if (el instanceof HTMLImageElement) rewriteImg(el)
      el.querySelectorAll('img').forEach((img) => rewriteImg(img as HTMLImageElement))
    }

    rewriteAllWithin(host)

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target instanceof HTMLImageElement) {
          rewriteImg(m.target)
        } else {
          m.addedNodes.forEach((node) => {
            if (node instanceof Element) rewriteAllWithin(node)
          })
        }
      }
    })
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    })

    return () => observer.disconnect()
  }, [baseDir, editorId])

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
