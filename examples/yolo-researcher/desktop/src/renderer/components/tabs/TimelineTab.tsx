import type { TurnReport, StageId, GateStatus } from '@/lib/types'
import { STAGES, STAGE_LABELS, turnGateStatus, friendlyStage, friendlyAction, cleanStageRefs } from '@/lib/formatters'

interface TimelineTabProps {
  filteredTurns: TurnReport[]
  selectedTurn: TurnReport | null
  timelineStageFilter: 'ALL' | StageId
  timelineGateFilter: 'ALL' | GateStatus
  timelineProgressFilter: 'ALL' | 'PROGRESS' | 'NON_PROGRESS'
  onStageFilterChange: (value: 'ALL' | StageId) => void
  onGateFilterChange: (value: 'ALL' | GateStatus) => void
  onProgressFilterChange: (value: 'ALL' | 'PROGRESS' | 'NON_PROGRESS') => void
  onSelectTurn: (turnNumber: number | null) => void
}

const GATE_LABELS: Record<GateStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  none: 'Not Evaluated',
}

export function TimelineTab({
  filteredTurns,
  selectedTurn,
  timelineStageFilter,
  timelineGateFilter,
  timelineProgressFilter,
  onStageFilterChange,
  onGateFilterChange,
  onProgressFilterChange,
  onSelectTurn,
}: TimelineTabProps) {
  return (
    <div className="flex flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="t-text-secondary">Stage</label>
        <select
          value={timelineStageFilter}
          onChange={(e) => onStageFilterChange(e.target.value as 'ALL' | StageId)}
          className="rounded-md border t-border bg-transparent px-2 py-1"
        >
          <option value="ALL">All Stages</option>
          {STAGES.map((stage) => (
            <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>
          ))}
        </select>
        <label className="ml-2 t-text-secondary">Quality Gate</label>
        <select
          value={timelineGateFilter}
          onChange={(e) => onGateFilterChange(e.target.value as 'ALL' | GateStatus)}
          className="rounded-md border t-border bg-transparent px-2 py-1"
        >
          <option value="ALL">All</option>
          <option value="pass">Passed</option>
          <option value="fail">Failed</option>
          <option value="none">Not Evaluated</option>
        </select>
        <label className="ml-2 t-text-secondary">Progress</label>
        <select
          value={timelineProgressFilter}
          onChange={(e) => onProgressFilterChange(e.target.value as 'ALL' | 'PROGRESS' | 'NON_PROGRESS')}
          className="rounded-md border t-border bg-transparent px-2 py-1"
        >
          <option value="ALL">All</option>
          <option value="PROGRESS">Made Progress</option>
          <option value="NON_PROGRESS">No Progress</option>
        </select>
      </div>

      <div>
        {filteredTurns.length === 0 ? (
          <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">No research cycles yet.</div>
        ) : (
          <div className="space-y-2">
            {filteredTurns.map((turn) => (
              <div
                key={turn.turnNumber}
                className={`rounded-xl border p-3 ${turn.nonProgress ? 't-card-amber' : 't-border'} ${selectedTurn?.turnNumber === turn.turnNumber ? 'ring-1 ring-teal-500/50' : ''}`}
              >
                <div className="flex items-center justify-between text-xs t-text-secondary">
                  <span>Cycle {turn.turnNumber}</span>
                  <span>{friendlyStage(turn.turnSpec?.stage)}</span>
                </div>
                <div className="mt-1 text-sm font-medium">{cleanStageRefs(turn.turnSpec?.objective ?? '')}</div>
                <div className="mt-1 text-xs t-text-secondary">{cleanStageRefs(turn.summary ?? '')}</div>
                {turn.execution?.action && (
                  <div className="mt-1 text-[11px] t-accent-teal">
                    {friendlyAction(turn.execution.action)}
                  </div>
                )}
                <div className="mt-2 text-[11px] t-text-muted">
                  {turn.assetDiff?.created?.length ?? 0} new artifacts · {(turn.consumedBudgets?.turnTokens ?? 0).toLocaleString()} tokens · ${turn.consumedBudgets?.turnCostUsd?.toFixed?.(3) ?? '0.000'}
                </div>
                {turn.nonProgress && (
                  <div className="mt-1 text-[11px] t-accent-amber">No new progress this cycle</div>
                )}
                <div className="mt-2">
                  <button
                    onClick={() => onSelectTurn(selectedTurn?.turnNumber === turn.turnNumber ? null : turn.turnNumber)}
                    className={`rounded-md border px-2 py-1 text-[11px] ${
                      selectedTurn?.turnNumber === turn.turnNumber
                        ? 'border-teal-500/60 bg-teal-500/10 t-accent-teal font-medium'
                        : 't-border t-hoverable'
                    }`}
                  >
                    {selectedTurn?.turnNumber === turn.turnNumber ? 'Inspecting' : 'Inspect'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 rounded-xl border t-border p-3 text-xs">
        <div className="mb-1 font-medium">Cycle Details</div>
        {!selectedTurn ? (
          <div className="t-text-muted">Select a research cycle to inspect.</div>
        ) : (
          <div className="space-y-1 t-text-secondary">
            <div>Cycle {selectedTurn.turnNumber} · {friendlyStage(selectedTurn.turnSpec?.stage)}</div>
            <div>Objective: {cleanStageRefs(selectedTurn.turnSpec?.objective ?? '')}</div>
            <div>Quality Gate: {GATE_LABELS[turnGateStatus(selectedTurn)]}</div>
            <div>Artifacts created: {selectedTurn.assetDiff?.created?.length ?? 0}</div>
            <div>Tokens used: {(selectedTurn.consumedBudgets?.turnTokens ?? 0).toLocaleString()}</div>
            <div>Cost: ${(selectedTurn.consumedBudgets?.turnCostUsd ?? 0).toFixed(3)}</div>
            <div>Progress: {selectedTurn.nonProgress ? 'No new progress' : 'Made progress'}</div>
            <div>Main action: {friendlyAction(selectedTurn.execution?.action) || 'n/a'}</div>
            <div>Action rationale: {cleanStageRefs(selectedTurn.execution?.actionRationale ?? 'n/a')}</div>
            <div>
              Tooling mode: {selectedTurn.execution?.tooling?.mode ?? 'unknown'}
              {selectedTurn.execution?.tooling?.degradeReason
                ? ` (${selectedTurn.execution.tooling.degradeReason})`
                : ''}
            </div>
            <div>
              Tool calls:
              {(selectedTurn.execution?.toolCalls ?? []).length > 0
                ? ` ${(selectedTurn.execution?.toolCalls ?? [])
                    .slice(0, 5)
                    .map((item) => item.tool)
                    .join(', ')}`
                : ' none'}
            </div>
            <div>
              Quality Review: {selectedTurn.reviewerSnapshot?.status === 'completed' ? 'Completed' : selectedTurn.reviewerSnapshot?.status ?? 'Not run'}
              {selectedTurn.reviewerSnapshot?.status === 'completed'
                ? ` · ${selectedTurn.reviewerSnapshot?.reviewerPasses?.length ?? 0} passes`
                : ''}
              {selectedTurn.reviewerSnapshot?.status === 'completed'
                ? ` · ${selectedTurn.reviewerSnapshot?.consensusBlockers?.length ?? 0} blockers`
                : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
