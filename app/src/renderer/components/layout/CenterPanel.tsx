import React from 'react'
import { MessageSquare, BookOpen, Cpu } from 'lucide-react'
import { useUIStore, type CenterView } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { useEntityStore } from '../../stores/entity-store'
import { useActiveRunCount } from '../../stores/compute-store'
import { HeroIdle } from '../center/HeroIdle'
import { ChatMessages } from '../center/ChatMessages'
import { ChatInput } from '../center/ChatInput'
import { LiteratureView } from '../center/LiteratureView'
import { ComputeView } from '../center/ComputeView'

const api = (window as any).api
const computeEnabled = api?.isComputeEnabled?.() ?? false

const viewTabs: { key: CenterView; label: string; icon: React.ElementType; shortcut: string }[] = [
  { key: 'chat', label: 'Chat', icon: MessageSquare, shortcut: '⌘1' },
  { key: 'literature', label: 'Literature', icon: BookOpen, shortcut: '⌘2' },
  ...(computeEnabled ? [{ key: 'compute' as CenterView, label: 'Compute', icon: Cpu, shortcut: '⌘3' }] : [])
]

function ViewSwitcher() {
  const centerView = useUIStore((s) => s.centerView)
  const setCenterView = useUIStore((s) => s.setCenterView)
  const paperCount = useEntityStore((s) => s.papers.length)
  const activeComputeRuns = useActiveRunCount()

  return (
    <nav aria-label="View switcher" className="flex items-center gap-0.5 px-4 pt-10 pb-1">
      {viewTabs.map(({ key, label, icon: Icon, shortcut }) => (
        <button
          key={key}
          onClick={() => setCenterView(key)}
          className={`no-drag flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            centerView === key
              ? 't-text-accent bg-[var(--color-accent-soft)]/10'
              : 't-text-muted hover:t-text-secondary hover:t-bg-hover'
          }`}
          title={`${label} (${shortcut})`}
        >
          <Icon size={13} />
          {label}
          {key === 'literature' && paperCount > 0 && (
            <span className="ml-0.5 px-1 py-px text-[9px] rounded-full t-bg-elevated t-text-muted tabular-nums">
              {paperCount}
            </span>
          )}
          {key === 'compute' && activeComputeRuns > 0 && (
            <span className="ml-0.5 px-1 py-px text-[9px] rounded-full bg-[var(--color-accent-soft)]/10 t-text-accent tabular-nums">
              {activeComputeRuns}
            </span>
          )}
          <span className="text-[9px] t-text-muted opacity-40 ml-0.5">{shortcut}</span>
        </button>
      ))}
    </nav>
  )
}

export function CenterPanel() {
  const centerView = useUIStore((s) => s.centerView)
  const isIdle = useUIStore((s) => s.isIdle)
  const messages = useChatStore((s) => s.messages)
  const showHero = isIdle && messages.length === 0

  if (centerView === 'literature') {
    return (
      <main id="main-content" className="flex-1 flex flex-col min-w-0">
        <ViewSwitcher />
        <LiteratureView />
      </main>
    )
  }

  if (centerView === 'compute') {
    return (
      <main id="main-content" className="flex-1 flex flex-col min-w-0">
        <ViewSwitcher />
        <ComputeView />
      </main>
    )
  }

  // Chat view
  return (
    <main id="main-content" className="flex-1 flex flex-col min-w-0">
      <ViewSwitcher />

      {showHero ? (
        <div className="flex-1 flex items-center justify-center">
          <HeroIdle />
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-6 pt-4 pb-2">
          <div className="mx-auto h-full" style={{ maxWidth: '48rem' }}>
            <ChatMessages />
          </div>
        </div>
      )}

      <div className="px-6 pb-5">
        <div className="mx-auto" style={{ maxWidth: '48rem' }}>
          <ChatInput />
        </div>
      </div>
    </main>
  )
}
