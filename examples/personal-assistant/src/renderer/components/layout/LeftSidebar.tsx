import React from 'react'
import { Sun, Moon, Eraser, Bell } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useNotificationStore } from '../../stores/notification-store'
import { EntityTabs } from '../left/EntityTabs'
import { UserProfile } from '../left/UserProfile'
import { ModelSelector } from '../left/ModelSelector'

export function LeftSidebar() {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const unreadCount = useNotificationStore((s) => s.unreadCount)

  return (
    <aside className="w-72 flex flex-col border-r t-border t-bg-base pt-10">
      <div className="px-4 pb-3 flex items-center justify-between">
        <ModelSelector />
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              className="no-drag p-1.5 rounded-lg t-text-muted t-bg-hover transition-colors"
              title="Notifications"
            >
              <Bell size={16} />
            </button>
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-medium rounded-full bg-blue-500 text-white">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </div>
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
