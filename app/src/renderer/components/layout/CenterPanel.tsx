import React from 'react'
import { MessageSquare, BookOpen, Cpu, Network } from 'lucide-react'
import { useUIStore, type CenterView } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { useEntityStore } from '../../stores/entity-store'
import { useActiveRunCount, usePendingPlanCount } from '../../stores/compute-store'
import { HeroIdle } from '../center/HeroIdle'
import { ChatMessages } from '../center/ChatMessages'
import { ChatInput } from '../center/ChatInput'
import { LiteratureView } from '../center/LiteratureView'
import { ComputeView } from '../center/ComputeView'
import { AuditView } from '../center/audit/AuditView'
import { EntityPreviewPanel } from './EntityPreviewPanel'

const viewTabs: { key: CenterView; label: string; icon: React.ElementType; shortcut: string }[] = [
  { key: 'chat', label: 'Chat', icon: MessageSquare, shortcut: '⌘1' },
  { key: 'literature', label: 'Literature', icon: BookOpen, shortcut: '⌘2' },
  { key: 'compute', label: 'Compute', icon: Cpu, shortcut: '⌘3' },
  { key: 'audit', label: 'Audit', icon: Network, shortcut: '⌘4' },
]

function ViewSwitcher() {
  const centerView = useUIStore((s) => s.centerView)
  const setCenterView = useUIStore((s) => s.setCenterView)
  const paperCount = useEntityStore((s) => s.papers.length)
  const activeComputeRuns = useActiveRunCount()
  const pendingComputePlans = usePendingPlanCount()

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
            {/* Pending-plan badge — warning-toned so it reads as "needs your
                attention" and stays visually distinct from the running-count
                badge above. Pulses gently to catch the eye when the user is
                in a non-Compute view. */}
            {key === 'compute' && pendingComputePlans > 0 && (
              <span
                aria-label={`${pendingComputePlans} pending ${pendingComputePlans === 1 ? 'plan' : 'plans'}`}
                className="px-1.5 py-px text-[10px] rounded-full tabular-nums bg-amber-500/15 text-amber-500 animate-pulse"
              >
                {pendingComputePlans}
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
  const previewEntity = useUIStore((s) => s.previewEntity)
  const drawerWidth = useUIStore((s) => s.drawerWidth)
  const showHero = isIdle && messages.length === 0

  // State-preservation strategy: every view stays mounted at all times and
  // we toggle visibility with the HTML `hidden` attribute (equivalent to
  // display:none). The React tree never tears down, so every useState /
  // useRef / scroll position / textarea draft survives ⌘1/⌘2/⌘3 switches.
  // The drawer lives inside the chat <main>, so its editor state survives
  // too — switching away and back returns you to the exact same place.
  const drawerOpen = !!previewEntity
  const rightGutter = drawerOpen ? drawerWidth : 0

  // The entire chat column — tabs, messages, input — shrinks in lockstep
  // when the drawer opens. Keeps the view-tabs' bottom border from running
  // past the drawer's left edge and creates a single clean vertical divider
  // between chat and drawer that spans the full height of <main>.
  const columnShiftStyle = { paddingRight: `${rightGutter}px` }
  const columnShiftClass = 'transition-[padding] duration-500 ease-[cubic-bezier(0.32,0.72,0.24,1)]'

  return (
    <>
      {/* Chat view — always mounted so scroll position, the ChatInput
          draft, and the drawer's editor state persist across view
          switches. The id="main-content" skip-link anchor follows the
          currently-visible view. */}
      <main
        id={centerView === 'chat' ? 'main-content' : undefined}
        hidden={centerView !== 'chat'}
        className="flex-1 flex flex-col min-w-0 relative overflow-hidden"
      >
        <div className={columnShiftClass} style={columnShiftStyle}>
          <ViewSwitcher />
        </div>

        <div className="flex-1 min-h-0">
          {showHero ? (
            <div
              className={`h-full flex items-center justify-center ${columnShiftClass}`}
              style={columnShiftStyle}
            >
              <HeroIdle />
            </div>
          ) : (
            <div
              className={`h-full pl-6 pt-4 pb-2 ${columnShiftClass}`}
              style={{ paddingRight: `${24 + rightGutter}px` }}
            >
              <div className="mx-auto h-full" style={{ maxWidth: '64rem' }}>
                <ChatMessages />
              </div>
            </div>
          )}
        </div>

        <div
          className={`pl-6 pb-5 ${columnShiftClass}`}
          style={{ paddingRight: `${24 + rightGutter}px` }}
        >
          <div className="mx-auto" style={{ maxWidth: '64rem' }}>
            <ChatInput />
          </div>
        </div>

        {/* Drawer — spans full main height so its border-l runs uninterrupted
            from the top of the view-tabs to the bottom of the input row. */}
        {drawerOpen && <EntityPreviewPanel />}
      </main>

      {/* Literature view — always mounted; its filter/scroll/selection
          state persists when the user flips away and back. */}
      <main
        id={centerView === 'literature' ? 'main-content' : undefined}
        hidden={centerView !== 'literature'}
        className="flex-1 flex flex-col min-w-0"
      >
        <ViewSwitcher />
        <LiteratureView />
      </main>

      {/* Compute view — always mounted for the same reason. */}
      <main
        id={centerView === 'compute' ? 'main-content' : undefined}
        hidden={centerView !== 'compute'}
        className="flex-1 flex flex-col min-w-0"
      >
        <ViewSwitcher />
        <ComputeView />
      </main>

      {/* Audit view — provenance visualization. Always mounted so the
          force layout doesn't re-cook when the user flips back. */}
      <main
        id={centerView === 'audit' ? 'main-content' : undefined}
        hidden={centerView !== 'audit'}
        className="flex-1 flex flex-col min-w-0"
      >
        <ViewSwitcher />
        <AuditView />
      </main>
    </>
  )
}
