import { Check, X as XIcon, Minus } from 'lucide-react'
import type { TabId } from '@/lib/types'
import type { YoloSessionReturn } from '@/hooks/useYoloSession'
import { STAGES, STAGE_LABELS } from '@/lib/formatters'
import { TimelineTab } from './tabs/TimelineTab'
import { BranchesTab } from './tabs/BranchesTab'
import { AssetsTab } from './tabs/AssetsTab'
import { EvidenceTab } from './tabs/EvidenceTab'
import { SystemTab } from './tabs/SystemTab'
import { EventsTab } from './tabs/EventsTab'
import { PapersTab } from './tabs/PapersTab'

const PRIMARY_TABS: { id: TabId; label: string }[] = [
  { id: 'timeline', label: 'Thinking' },
  { id: 'assets', label: 'Assets' },
  { id: 'system', label: 'System' },
  { id: 'events', label: 'Events' },
]

const SECONDARY_TABS: { id: TabId; label: string }[] = [
  { id: 'branches', label: 'Branches' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'papers', label: 'Papers' },
]

interface DetailTabsProps {
  session: YoloSessionReturn
}

export function DetailTabs({ session }: DetailTabsProps) {
  const { activeTab, actions } = session

  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl border t-border t-bg-surface">
      {/* Tab bar */}
      <div className="shrink-0 border-b t-border px-4 pt-3 pb-2">
        {/* Stage gates pipeline */}
        <div className="mb-2 flex flex-wrap items-center gap-1">
          {STAGES.map((stage) => {
            const info = session.stageGates[stage]
            return (
              <div
                key={stage}
                className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                  info.status === 'pass'
                    ? 'border-emerald-500/40 t-accent-emerald'
                    : info.status === 'fail'
                      ? 'border-rose-500/40 t-accent-rose'
                      : 't-border t-text-muted'
                }`}
                title={`${STAGE_LABELS[stage]}: ${info.status}`}
              >
                {info.status === 'pass' ? (
                  <Check size={11} />
                ) : info.status === 'fail' ? (
                  <XIcon size={11} />
                ) : (
                  <Minus size={11} />
                )}
                <span>{STAGE_LABELS[stage]}</span>
              </div>
            )
          })}
        </div>

        {/* Flat tab row */}
        <div className="flex items-center gap-1">
          {PRIMARY_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => actions.setActiveTab(tab.id)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-teal-500/60 bg-teal-500/10 t-accent-teal'
                  : 't-border t-text-secondary t-hoverable'
              }`}
            >
              {tab.label}
            </button>
          ))}
          <div className="mx-1 h-4 w-px bg-neutral-500/20" />
          {SECONDARY_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => actions.setActiveTab(tab.id)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-teal-500/60 bg-teal-500/10 t-accent-teal'
                  : 't-border t-text-muted t-hoverable'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content — scrollable */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {activeTab === 'timeline' && (
          <TimelineTab
            filteredTurns={session.filteredTurns}
            selectedTurn={session.selectedTurn}
            timelineStageFilter={session.timelineStageFilter}
            timelineGateFilter={session.timelineGateFilter}
            timelineProgressFilter={session.timelineProgressFilter}
            onStageFilterChange={actions.setTimelineStageFilter}
            onGateFilterChange={actions.setTimelineGateFilter}
            onProgressFilterChange={actions.setTimelineProgressFilter}
            onSelectTurn={actions.setSelectedTurnNumber}
          />
        )}
        {activeTab === 'branches' && (
          <BranchesTab
            branchSnapshot={session.branchSnapshot}
            onRecordOverride={actions.recordOverrideDecision}
          />
        )}
        {activeTab === 'assets' && (
          <AssetsTab
            assetRecords={session.assetRecords}
            onExportInventory={actions.exportAssetInventory}
          />
        )}
        {activeTab === 'evidence' && (
          <EvidenceTab
            evidenceGraph={session.evidenceGraph}
            selectedGraphNodeId={session.selectedGraphNodeId}
            selectedGraphNode={session.selectedGraphNode}
            selectedGraphAsset={session.selectedGraphAsset}
            showSupersedesEdges={session.showSupersedesEdges}
            latestClaimEvidenceTable={session.latestClaimEvidenceTable}
            matrixRows={session.matrixRows}
            onSelectGraphNode={actions.setSelectedGraphNodeId}
            onToggleSupersedesEdges={actions.setShowSupersedesEdges}
            onExportClaimEvidenceTable={actions.exportClaimEvidenceTable}
          />
        )}
        {activeTab === 'system' && (
          <SystemTab
            snapshot={session.snapshot}
            turnReports={session.turnReports}
            rawEvents={session.rawEvents}
            queuedInputs={session.queuedInputs}
            waitTasks={session.waitTasks}
            waitValidation={session.waitValidation}
            pendingWaitTask={session.pendingWaitTask}
            budgetCaps={session.budgetCaps}
            budgetUsage={session.budgetUsage}
            budgetAlert={session.budgetAlert}
            budgetTrend={session.budgetTrend}
            governanceSummary={session.governanceSummary}
            maintenanceAlerts={session.maintenanceAlerts}
            queueOpen={session.queueOpen}
            selectedPhase={session.selectedPhase}
            onQueueOpenChange={actions.setQueueOpen}
            actions={{
              setQueuePriority: actions.setQueuePriority,
              moveQueueItem: actions.moveQueueItem,
              removeQueueItem: actions.removeQueueItem,
              requestWaitExternal: actions.requestWaitExternal,
              requestFullTextWait: actions.requestFullTextWait,
              resolveWaitTask: actions.resolveWaitTask,
              validateWaitTask: actions.validateWaitTask,
              cancelWaitTask: actions.cancelWaitTask,
              addIngressFiles: actions.addIngressFiles,
              requestResourceExtension: actions.requestResourceExtension,
              resolveResourceExtension: actions.resolveResourceExtension,
            }}
          />
        )}
        {activeTab === 'events' && (
          <EventsTab events={session.events} />
        )}
        {activeTab === 'papers' && (
          <PapersTab
            papers={session.papers}
            reviews={session.reviews}
            onRefresh={actions.refreshPapers}
            onReadReview={actions.readReview}
          />
        )}
      </div>
    </section>
  )
}
