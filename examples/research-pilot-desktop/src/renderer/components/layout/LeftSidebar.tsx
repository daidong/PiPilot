import React from 'react'
import { Sun, Moon } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { EntityTabs } from '../left/EntityTabs'
import { UserProfile } from '../left/UserProfile'
import { ModelSelector } from '../left/ModelSelector'

export function LeftSidebar() {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  return (
    <aside className="w-72 flex flex-col border-r t-border t-bg-base pt-10">
      <div className="px-4 pb-3 flex items-center justify-between">
        <ModelSelector />
        <button
          onClick={toggleTheme}
          className="no-drag p-1.5 rounded-lg t-text-muted t-bg-hover transition-colors"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
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
