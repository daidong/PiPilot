import type { ReactNode } from 'react'

export type TabId = 'evidence' | 'activity' | 'terminal'

interface MainTabsProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  children: ReactNode
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'evidence', label: 'Evidence' },
  { id: 'activity', label: 'Activity' },
  { id: 'terminal', label: 'Terminal' }
]

export default function MainTabs({ activeTab, onTabChange, children }: MainTabsProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 gap-1 border-b px-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)' }}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className="relative px-4 py-2.5 text-[12px] font-medium transition-colors"
              style={{
                color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)'
              }}
            >
              {tab.label}
              {isActive && (
                <span
                  className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                  style={{ background: 'var(--color-accent)' }}
                />
              )}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-hidden" style={{ background: 'var(--color-bg-base)' }}>
        {children}
      </div>
    </div>
  )
}
