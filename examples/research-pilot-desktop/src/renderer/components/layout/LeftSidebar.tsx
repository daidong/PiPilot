import React from 'react'
import { Sun, Moon, Eraser } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { EntityTabs } from '../left/EntityTabs'
import { UserProfile } from '../left/UserProfile'
import { ModelSelector } from '../left/ModelSelector'
import { ReasoningToggle } from '../left/ReasoningToggle'

export function LeftSidebar() {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  return (
    <aside className="w-72 flex flex-col border-r t-border t-bg-base pt-10">
      <div className="px-4 pb-3 flex items-center justify-between">
        <ModelSelector />
        <div className="flex items-center gap-1">
          <ReasoningToggle />
          <button
            onClick={() => (window as any).api.clearSessionMemory()}
            className="no-drag p-1.5 rounded-lg t-text-muted t-bg-hover transition-colors"
            title="Clear session memory"
          >
            <Eraser size={16} />
          </button>
          <button
            onClick={toggleTheme}
            className="no-drag p-1.5 rounded-lg t-text-muted t-bg-hover transition-colors"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <EntityTabs />
      </div>

      <div className="border-t t-border p-4">
        <UserProfile />
      </div>
    </aside>
  )
}
