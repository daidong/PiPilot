import React from 'react'
import { Sun, Moon, Eraser, Terminal } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
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
      className="no-drag group relative p-1.5 rounded-lg t-text-muted t-bg-hover transition-colors"
    >
      {children}
      <span
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

  return (
    <aside className="w-80 flex flex-col border-r t-border t-bg-base pt-10">
      <div className="px-4 pb-3 flex items-center justify-between">
        <ModelSelector />
        <div className="flex items-center gap-1">
          <ReasoningToggle />
          <ToolbarButton
            onClick={() => (window as any).api.clearSessionMemory()}
            tooltip="Clear session memory"
          >
            <Eraser size={16} />
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
      </div>

      <div className="flex-1 min-h-0">
        {centerView === 'literature' ? <LiteratureSidebar /> : centerView === 'compute' && (window as any).api?.isComputeEnabled?.() ? <ComputeSidebar /> : <EntityTabs />}
      </div>

      <div className="border-t t-border p-4">
        <UserProfile />
      </div>
    </aside>
  )
}
