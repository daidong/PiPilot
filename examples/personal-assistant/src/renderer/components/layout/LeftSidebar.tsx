import React, { useEffect, useRef, useState } from 'react'
import { Sun, Moon, Eraser, Bell } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useNotificationStore } from '../../stores/notification-store'
import { EntityTabs } from '../left/EntityTabs'
import { UserProfile } from '../left/UserProfile'
import { ModelSelector } from '../left/ModelSelector'
import { ReasoningToggle } from '../left/ReasoningToggle'
import { WorkspaceTree } from '../left/WorkspaceTree'

export function LeftSidebar() {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const unreadCount = useNotificationStore((s) => s.unreadCount)
  const [bottomRatio, setBottomRatio] = useState(0.36)
  const draggingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!draggingRef.current || !rootRef.current) return
      const rect = rootRef.current.getBoundingClientRect()
      const y = event.clientY - rect.top
      const ratio = 1 - (y / rect.height)
      setBottomRatio(Math.min(0.7, Math.max(0.2, ratio)))
    }

    const onMouseUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const topHeight = `${(1 - bottomRatio) * 100}%`
  const bottomHeight = `${bottomRatio * 100}%`

  return (
    <aside className="w-80 flex flex-col border-r t-border t-bg-base pt-10">
      <div className="px-4 pb-3 flex items-center justify-between">
        <ModelSelector />
        <div className="flex items-center gap-1">
          <ReasoningToggle />
          <button
            onClick={() => {
              useNotificationStore.getState().load()
              useUIStore.getState().setLeftTab('notifications')
            }}
            className={`no-drag p-1.5 rounded-lg t-bg-hover transition-colors relative ${
              unreadCount > 0 ? 't-text-accent-soft' : 't-text-muted'
            }`}
            title="Notifications"
          >
            <Bell size={16} />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full t-bg-accent" />
            )}
          </button>
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

      <div ref={rootRef} className="flex-1 min-h-0 flex flex-col">
        <div style={{ height: topHeight }} className="min-h-[220px] overflow-hidden">
          <EntityTabs />
        </div>

        <div
          className="h-1.5 cursor-row-resize t-bg-hover border-y t-border"
          onMouseDown={() => {
            draggingRef.current = true
            document.body.style.cursor = 'row-resize'
            document.body.style.userSelect = 'none'
          }}
          title="Resize memory/files split"
        />

        <div style={{ height: bottomHeight }} className="min-h-[170px] overflow-hidden">
          <WorkspaceTree />
        </div>
      </div>

      <div className="border-t t-border p-4">
        <UserProfile />
      </div>
    </aside>
  )
}
