import { useYoloSession } from '@/hooks/useYoloSession'
import { friendlyQuestion, friendlyQuestionContext } from '@/lib/formatters'
import { FolderGate } from '@/components/FolderGate'
import { TopBar } from '@/components/TopBar'
import { HeroSection } from '@/components/HeroSection'
import { DetailTabs } from '@/components/DetailTabs'
import { CheckpointModal } from '@/components/CheckpointModal'

export default function App() {
  const session = useYoloSession()
  const { projectPath, snapshot, actions, actionError, actionNotice, isCheckpointModal, quickOptions } = session

  if (!projectPath) return <FolderGate onPick={actions.pickFolder} />

  return (
    <div className="flex h-screen w-screen flex-col t-text">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-20" />

      {/* Zone 1: Persistent top bar — fixed height */}
      <TopBar
        projectPath={projectPath}
        snapshot={snapshot}
        stageGates={session.stageGates}
        budgetUsage={session.budgetUsage}
        budgetCaps={session.budgetCaps}
        canPause={session.canPause}
        canResume={session.canResume}
        canStop={session.canStop}
        isStarting={session.isStarting}
        isStopping={session.isStopping}
        onStart={actions.startYolo}
        onPause={actions.pauseYolo}
        onResume={actions.resumeYolo}
        onStop={actions.stopYolo}
      />

      {/* Zone 2: Hero (shrink-to-fit, never expands beyond content) */}
      <div className="shrink-0 px-4 pt-4">
        {actionError && (
          <div className="mb-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs t-accent-rose">
            {actionError}
          </div>
        )}
        {actionNotice && (
          <div className="mb-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs t-accent-emerald">
            {actionNotice}
          </div>
        )}
        <HeroSection
          snapshot={snapshot}
          goal={session.goal}
          selectedPhase={session.selectedPhase}
          activeTurn={session.activeTurn}
          failureInfo={session.failureInfo}
          completeCoverageSummary={session.completeCoverageSummary}
          totalCreatedAssets={session.totalCreatedAssets}
          quickOptions={quickOptions}
          isStarting={session.isStarting}
          pendingWaitTask={session.pendingWaitTask}
          isCheckpointModal={isCheckpointModal}
          onGoalChange={actions.setGoal}
          onPhaseChange={actions.setSelectedPhase}
          onStart={actions.startYolo}
          onResume={actions.resumeYolo}
          onRestart={actions.startYolo}
          onRestoreCheckpoint={actions.restoreFromCheckpoint}
          onQuickReply={actions.submitQuickReply}
          onSubmitReply={actions.submitReply}
          onExportSummary={actions.exportSummary}
          onExportClaimTable={actions.exportClaimEvidenceTable}
          onExportAssets={actions.exportAssetInventory}
          onExportFinalBundle={actions.exportFinalBundle}
          onOpenEvidence={() => actions.setActiveTab('evidence')}
          onOpenSystem={() => actions.setActiveTab('system')}
        />
      </div>

      {/* Zone 3: Tabbed detail views — fills remaining space, scrolls internally */}
      <div className="min-h-0 flex-1 p-4 pt-4">
        <DetailTabs session={session} />
      </div>

      {/* Checkpoint decision modal overlay */}
      {isCheckpointModal && (
        <CheckpointModal
          question={friendlyQuestion(snapshot?.pendingQuestion?.question ?? '')}
          context={friendlyQuestionContext(snapshot?.pendingQuestion?.context)}
          quickOptions={quickOptions}
          onQuickReply={actions.submitQuickReply}
          onSubmit={actions.submitReply}
        />
      )}
    </div>
  )
}
