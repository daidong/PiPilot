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
    // Bottom hairline gives the nav a real anchor — without it, the tabs
    // float in a gray area between the drag region and the content.
    <nav
      aria-label="View switcher"
      className="flex items-stretch gap-1 px-4 pt-10 border-b t-border"
    >
      {viewTabs.map(({ key, label, icon: Icon, shortcut }) => {
        const isActive = centerView === key
        return (
          <button
            key={key}
            onClick={() => setCenterView(key)}
            aria-current={isActive ? 'page' : undefined}
            title={`${label} (${shortcut})`}
            className={`no-drag relative group flex items-center gap-2 px-3 pt-1.5 pb-2 text-[13px] font-medium transition-colors ${
              isActive ? 't-text' : 't-text-muted hover:t-text-secondary'
            }`}
          >
            <Icon size={14} className={isActive ? 't-text-accent' : ''} />
            <span>{label}</span>

            {/* Count chips — kept compact but legible */}
            {key === 'literature' && paperCount > 0 && (
              <span
                className={`px-1.5 py-px text-[10px] rounded-full tabular-nums ${
                  isActive ? 't-bg-accent/15 t-text-accent' : 't-bg-elevated t-text-muted'
                }`}
              >
                {paperCount}
              </span>
            )}
            {key === 'compute' && activeComputeRuns > 0 && (
              <span className="px-1.5 py-px text-[10px] rounded-full tabular-nums t-bg-accent/15 t-text-accent">
                {activeComputeRuns}
              </span>
            )}

            {/* Shortcut chip — real kbd affordance, not a faded hint */}
            <kbd
              className={`inline-flex items-center px-1 py-0 rounded border text-[9.5px] font-mono leading-[1.4] transition-colors ${
                isActive
                  ? 't-border-accent-soft t-text-accent-soft bg-transparent'
                  : 't-border-subtle t-bg-elevated t-text-muted group-hover:t-text-secondary'
              }`}
            >
              {shortcut}
            </kbd>

            {/* Active-state bottom indicator — 2px accent bar overlapping the
                nav's own bottom hairline. Replaces the old bg-tint which was
                too quiet to read as "this tab is selected." */}
            <span
              aria-hidden
              className={`pointer-events-none absolute left-0 right-0 -bottom-px h-[2px] transition-colors ${
                isActive ? 't-bg-accent' : 'bg-transparent'
              }`}
            />
          </button>
        )
      })}
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
          <div className="mx-auto h-full" style={{ maxWidth: '64rem' }}>
            <ChatMessages />
          </div>
        </div>
      )}

      <div className="px-6 pb-5">
        <div className="mx-auto" style={{ maxWidth: '64rem' }}>
          <ChatInput />
        </div>
      </div>
    </main>
  )
}
