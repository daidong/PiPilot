import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { useYoloSession } from '@/hooks/useYoloSession'
import { useTheme } from '@/hooks/useTheme'
import { FolderGate } from '@/components/FolderGate'
import { TopBar } from '@/components/TopBar'
import { HeroSection } from '@/components/HeroSection'
import { DetailTabs } from '@/components/DetailTabs'
import { WorkspaceFolder } from '@/components/WorkspaceFolder'
import { ActivityFeed } from '@/components/ActivityFeed'
import { ExecutionConsole } from '@/components/ExecutionConsole'
import { InteractionDrawer } from '@/components/InteractionDrawer'
import { ChatInput } from '@/components/ChatInput'

export default function App() {
  const session = useYoloSession()
  const { theme, toggleTheme } = useTheme()
  const { projectPath, snapshot, actions, actionError, actionNotice, totalCreatedAssets } = session
  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useRef<HTMLDivElement>(null)

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportOpen) return
    function handleClick(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [exportOpen])

  if (!projectPath) return <FolderGate onPick={actions.pickFolder} />

  const drawerIsOpen = session.drawerOpen && session.drawerInteraction !== null

  return (
    <div className="flex h-screen w-screen flex-col t-text">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-20" />

      {/* Zone 1: Persistent top bar — fixed, never scrolls */}
      <TopBar
        projectPath={projectPath}
        snapshot={snapshot}
        budgetUsage={session.budgetUsage}
        budgetCaps={session.budgetCaps}
        canPause={session.canPause}
        canResume={session.canResume}
        canStop={session.canStop}
        isStarting={session.isStarting}
        isStopping={session.isStopping}
        theme={theme}
        onStart={actions.startYolo}
        onPause={actions.pauseYolo}
        onResume={actions.resumeYolo}
        onStop={actions.stopYolo}
        onRestart={actions.restartYolo}
        onToggleTheme={toggleTheme}
      />

      {/* Main content area — shrinks when drawer is open */}
      <div className={`min-h-0 flex-1 overflow-y-auto transition-all duration-300 ${drawerIsOpen ? 'mr-[420px]' : ''}`}>
        {/* Zone 2: Hero */}
        <div className="px-4 pt-4">
          {actionError && (
            <div className="mb-3 rounded-xl border t-card-rose px-3 py-2 text-xs t-accent-rose">
              {actionError}
            </div>
          )}
          {actionNotice && (
            <div className="mb-3 rounded-xl border t-card-emerald px-3 py-2 text-xs t-accent-emerald">
              {actionNotice}
            </div>
          )}
          <HeroSection
            snapshot={snapshot}
            goal={session.goal}
            activeTurn={session.activeTurn}
            isStarting={session.isStarting}
            drawerInteraction={session.drawerInteraction}
            totalCreatedAssets={totalCreatedAssets}
            researchMd={session.researchMd}
            researchMdLoaded={session.researchMdLoaded}
            onGoalChange={actions.setGoal}
            onSaveGoalToResearchMd={actions.saveGoalToResearchMd}
            onStart={actions.startYolo}
            onResume={actions.resumeYolo}
            onOpenDrawer={actions.openDrawer}
          />
        </div>

        {/* Zone 2b: Live execution panel */}
        {(session.activityFeed.length > 0 || session.executionCommands.length > 0) && (
          <div className="px-4 pt-3">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <div className="min-h-0">
                <ActivityFeed items={session.activityFeed} />
              </div>
              <div className="min-h-0">
                <ExecutionConsole commands={session.executionCommands} />
              </div>
            </div>
          </div>
        )}

        {/* Chat input — lets users inject thoughts at any time */}
        {snapshot?.sessionId && (
          <div className="px-4 pt-3">
            <ChatInput
              onSend={(text, priority) => actions.yoloEnqueueInput(text, priority)}
              disabled={!snapshot?.sessionId}
              placeholder={
                session.activeTurn?.plannerSpec?.planContract?.current_focus
                  ? `Share thoughts about: ${session.activeTurn.plannerSpec.planContract.current_focus.slice(0, 60)}...`
                  : 'Send a message to the research agent...'
              }
            />
          </div>
        )}

        {/* MANAGEMENT BOARD */}
        <div className="px-4 pt-3">
          {/* Section header with Export dropdown */}
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wide t-text-secondary">
              Management Board
            </div>
            <div ref={exportRef} className="relative">
              <button
                onClick={() => setExportOpen((v) => !v)}
                className="flex items-center gap-1 rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable"
              >
                Export <ChevronDown size={10} />
              </button>
              {exportOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-[160px] rounded-lg border t-border t-bg-surface shadow-lg py-1">
                  <button
                    onClick={() => { actions.exportSummary(); setExportOpen(false) }}
                    className="block w-full text-left px-3 py-1.5 text-[11px] t-hoverable"
                  >
                    Export Summary
                  </button>
                  <button
                    onClick={() => { actions.exportFinalBundle(); setExportOpen(false) }}
                    className="block w-full text-left px-3 py-1.5 text-[11px] t-hoverable"
                  >
                    Export Final Bundle
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Two-column grid: DetailTabs left, WorkspaceFolder right */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" style={{ minHeight: '480px' }}>
            <div className="min-h-0">
              <DetailTabs session={session} />
            </div>
            <div className="min-h-0">
              <WorkspaceFolder projectPath={projectPath} />
            </div>
          </div>
        </div>

        {/* Bottom padding */}
        <div className="h-4" />
      </div>

      {/* InteractionDrawer — unified right-side panel */}
      <InteractionDrawer
        open={session.drawerOpen}
        interaction={session.drawerInteraction}
        chatHistory={session.drawerChat}
        chatLoading={session.drawerChatLoading}
        onClose={actions.closeDrawer}
        onSendChat={actions.sendDrawerChat}
        onAction={actions.executeDrawerAction}
      />
    </div>
  )
}
