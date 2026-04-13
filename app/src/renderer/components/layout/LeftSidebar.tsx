import React, { useCallback, useRef } from 'react'
import { Sun, Moon, RotateCcw, Terminal } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { EntityTabs } from '../left/EntityTabs'
import { LiteratureSidebar } from '../left/LiteratureSidebar'
import { ComputeSidebar } from '../left/ComputeSidebar'
import { UserProfile } from '../left/UserProfile'
import { ModelSelector } from '../left/ModelSelector'
import { ReasoningToggle } from '../left/ReasoningToggle'

/** Toolbar icon button with fast CSS tooltip (200ms delay instead of OS default ~800ms) */
function ToolbarButton({ onClick, tooltip, children }: {
  onClick: () => void
  tooltip: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={tooltip}
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

export function LeftSidebar() {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const centerView = useUIStore((s) => s.centerView)
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

  return (
    // Narrow windows (≤1279px) get w-80 (320px) so the center panel keeps
    // room to breathe; wider windows (≥1280px) get w-[22rem] (352px) so the
    // toolbar has comfortable slack. Below ~1024px the ModelSelector label
    // is the first thing to truncate — see ModelSelector for the shrink
    // pattern introduced in commit 95312df.
    <aside className="w-80 xl:w-[22rem] flex flex-col border-r t-border t-bg-base pt-10">
      <nav aria-label="Sidebar tools" className="px-4 pb-3 flex items-center justify-between">
        <ModelSelector />
        <div className="flex items-center gap-1">
          <ReasoningToggle />
          <ToolbarButton
            onClick={handleResetContext}
            tooltip="Reset AI context"
          >
            <RotateCcw size={16} />
          </ToolbarButton>
          <ToolbarButton
            onClick={toggleTheme}
            tooltip={`${theme === 'dark' ? 'Light' : 'Dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </ToolbarButton>
          <ToolbarButton
            onClick={() => useUIStore.getState().toggleTerminal()}
            tooltip="Terminal  ⌘`"
          >
            <Terminal size={16} />
          </ToolbarButton>
        </div>
      </nav>

      <div className="flex-1 min-h-0">
        {centerView === 'literature' ? <LiteratureSidebar /> : centerView === 'compute' && (window as any).api?.isComputeEnabled?.() ? <ComputeSidebar /> : <EntityTabs />}
      </div>

      <div className="border-t t-border p-4">
        <UserProfile />
      </div>
    </aside>
  )
}
