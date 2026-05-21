import React, { useCallback, useEffect, useRef } from 'react'
import { RotateCcw, Terminal, Settings, MoreHorizontal } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { EntityTabs } from '../left/EntityTabs'
import { LiteratureSidebar } from '../left/LiteratureSidebar'
import { ComputeSidebar } from '../left/ComputeSidebar'
import { UserProfile } from '../left/UserProfile'
import { ModelSelector } from '../left/ModelSelector'
import { ReasoningToggle } from '../left/ReasoningToggle'

/** Toolbar icon button with fast CSS tooltip (200ms delay instead of OS default ~800ms) */
function ToolbarButton({ onClick, tooltip, children, ariaExpanded }: {
  onClick: () => void
  tooltip: string
  children: React.ReactNode
  ariaExpanded?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={tooltip}
      aria-expanded={ariaExpanded}
      className="no-drag group relative p-2.5 rounded-lg t-text-muted t-bg-hover transition-colors"
    >
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-0.5 rounded text-[10px] t-bg-elevated t-text-secondary border t-border shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 z-50"
        style={{ transition: 'opacity 0.15s ease', transitionDelay: '0.2s' }}
      >
        {tooltip}
      </span>
    </button>
  )
}

// Low-frequency toolbar actions (reset context, terminal) live behind a
// single kebab. Keeping them out of the primary row preserves breathing
// room for the ModelSelector at narrow sidebar widths and matches the
// design principle "top bar configures this conversation; everything else
// is one click away." (Theme switching lives in Settings → Appearance.)
function OverflowMenu({
  onResetContext,
  onToggleTerminal,
}: {
  onResetContext: () => void
  onToggleTerminal: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [open])

  const run = (fn: () => void) => () => {
    fn()
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <ToolbarButton
        onClick={() => setOpen((v) => !v)}
        tooltip="More"
        ariaExpanded={open}
      >
        <MoreHorizontal size={16} />
      </ToolbarButton>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 min-w-[180px] rounded-lg border t-border t-bg-surface shadow-xl z-50 py-1"
        >
          <button
            role="menuitem"
            onClick={run(onResetContext)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs t-text t-bg-hover transition-colors"
          >
            <RotateCcw size={14} className="t-text-muted" />
            Reset AI context
          </button>
          <button
            role="menuitem"
            onClick={run(onToggleTerminal)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs t-text t-bg-hover transition-colors"
          >
            <span className="flex items-center gap-2">
              <Terminal size={14} className="t-text-muted" />
              Terminal
            </span>
            <span className="t-text-muted font-mono text-[10px]">⌘`</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function LeftSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const centerView = useUIStore((s) => s.centerView)
  const leftSidebarWidth = useUIStore((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useUIStore((s) => s.setLeftSidebarWidth)
  const noContextShownRef = useRef(false)

  const handleResetContext = useCallback(async () => {
    const messages = useChatStore.getState().messages
    const hasContext = messages.some(m => m.role === 'user' || m.role === 'assistant')

    if (!hasContext) {
      // No context yet — show one-time hint (don't repeat on multiple clicks)
      if (!noContextShownRef.current) {
        noContextShownRef.current = true
        useChatStore.getState().insertContextReset()
        // Replace the last inserted message content with the "no context" hint
        useChatStore.setState((s) => {
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'system') {
            msgs[msgs.length - 1] = { ...last, content: 'No context to reset yet.' }
          }
          return { messages: msgs }
        })
      }
      return
    }

    // Reset the agent-side LLM context
    await (window as any).api.clearSessionMemory()
    // Insert a visual divider in the chat
    useChatStore.getState().insertContextReset()
    // Reset the no-context guard so it works again after a real reset
    noContextShownRef.current = false
  }, [])

  // Drag-to-resize the sidebar's right edge. Mirrors the EntityPreviewPanel
  // pattern: capture start cursor X + width on mousedown, update width on
  // mousemove, release on mouseup. Clamping lives in the store so we don't
  // duplicate bounds here.
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const handleEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    dragStateRef.current = { startX: e.clientX, startWidth: leftSidebarWidth }
    document.body.style.cursor = 'ew-resize'
    e.preventDefault()
  }, [leftSidebarWidth])
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragStateRef.current) return
      const dx = e.clientX - dragStateRef.current.startX
      setLeftSidebarWidth(dragStateRef.current.startWidth + dx)
    }
    const onUp = () => {
      if (dragStateRef.current) document.body.style.cursor = ''
      dragStateRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setLeftSidebarWidth])

  // Double-click the edge to reset to default.
  const handleEdgeDoubleClick = useCallback(() => {
    setLeftSidebarWidth(320)
  }, [setLeftSidebarWidth])

  return (
    <aside
      className="relative flex flex-col border-r t-border t-bg-base pt-10 shrink-0"
      style={{ width: `${leftSidebarWidth}px` }}
    >
      <nav aria-label="Sidebar tools" className="px-4 pb-3 flex items-center justify-between gap-2">
        <ModelSelector />
        <div className="flex items-center gap-1">
          <ReasoningToggle />
          <OverflowMenu
            onResetContext={handleResetContext}
            onToggleTerminal={() => useUIStore.getState().toggleTerminal()}
          />
        </div>
      </nav>

      <div className="flex-1 min-h-0 overflow-hidden">
        {(() => {
          const showLit = centerView === 'literature'
          const showCompute = centerView === 'compute'
          const showEntity = !showLit && !showCompute
          return (
            <>
              <div className={`h-full ${showLit ? '' : 'hidden'}`} aria-hidden={!showLit} inert={!showLit}>
                <LiteratureSidebar />
              </div>
              <div className={`h-full ${showCompute ? '' : 'hidden'}`} aria-hidden={!showCompute} inert={!showCompute}>
                <ComputeSidebar />
              </div>
              <div className={`h-full ${showEntity ? '' : 'hidden'}`} aria-hidden={!showEntity} inert={!showEntity}>
                <EntityTabs />
              </div>
            </>
          )
        })()}
      </div>

      <div className="border-t t-border p-4 flex items-center justify-between">
        <UserProfile />
        <ToolbarButton onClick={onOpenSettings} tooltip="Settings  ⌘,">
          <Settings size={16} />
        </ToolbarButton>
      </div>

      {/* Right-edge resize handle. 6px hit area, 2px visible stripe on
          hover. Double-click resets to default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (drag to resize, double-click to reset)"
        tabIndex={-1}
        className="absolute right-0 top-0 bottom-0 w-[6px] cursor-ew-resize group z-[6]"
        style={{ marginRight: -3 }}
        onMouseDown={handleEdgeMouseDown}
        onDoubleClick={handleEdgeDoubleClick}
      >
        <div className="absolute right-[3px] top-1/2 -translate-y-1/2 w-[2px] h-9 rounded bg-transparent group-hover:t-bg-accent transition-colors" />
      </div>
    </aside>
  )
}
