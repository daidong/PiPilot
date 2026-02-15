import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { TurnReport, StageId, GateStatus } from '@/lib/types'
import {
  STAGES,
  STAGE_LABELS,
  turnGateStatus,
  friendlyStage,
  friendlyAction,
  cleanStageRefs,
  narrativeAction,
  verdictColor,
} from '@/lib/formatters'

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

// Collapsible section wrapper
function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-[11px] font-medium t-text-secondary hover:t-text-primary transition-colors"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {title}
      </button>
      {open && <div className="mt-1.5 pl-4">{children}</div>}
    </div>
  )
}

// Single thinking card per turn
function ThinkingCard({
  turn,
  isLatest,
  isSelected,
  onSelect,
}: {
  turn: TurnReport
  isLatest: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  const gateStatus = turnGateStatus(turn)
  const plan = turn.plannerSpec?.planContract
  const hasPlanData = Boolean(plan)
  const hasExecTrace = Boolean(turn.execution?.executionTrace?.length)
  const hasReview = turn.reviewerSnapshot?.status === 'completed'
  const hasProcessReview = Boolean(turn.reviewerSnapshot?.processReview)

  return (
    <div
      className={`rounded-xl border p-3 ${turn.nonProgress ? 't-card-amber' : 't-border'} ${isSelected ? 'ring-1 ring-teal-500/50' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">Cycle {turn.turnNumber}</span>
          <span className="t-text-secondary">{friendlyStage(turn.turnSpec?.stage)}</span>
          {turn.execution?.action && (
            <span className="t-accent-teal">{narrativeAction(turn.execution.action)}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {gateStatus !== 'none' && (
            <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
              gateStatus === 'pass'
                ? 'border-emerald-500/40 t-accent-emerald'
                : 'border-rose-500/40 t-accent-rose'
            }`}>
              {GATE_LABELS[gateStatus]}
            </span>
          )}
          {turn.nonProgress && (
            <span className="rounded-md border border-amber-500/40 px-1.5 py-0.5 text-[10px] t-accent-amber">
              No Progress
            </span>
          )}
          <button
            onClick={onSelect}
            className={`rounded-md border px-2 py-0.5 text-[10px] ${
              isSelected
                ? 'border-teal-500/60 bg-teal-500/10 t-accent-teal font-medium'
                : 't-border t-hoverable'
            }`}
          >
            {isSelected ? 'Selected' : 'Select'}
          </button>
        </div>
      </div>

      {/* Objective (always visible) */}
      {turn.turnSpec?.objective && (
        <div className="mt-1.5 text-xs">{cleanStageRefs(turn.turnSpec.objective)}</div>
      )}

      {/* Plan Section */}
      {hasPlanData ? (
        <Section title="Plan" defaultOpen={isLatest}>
          {plan!.current_focus && (
            <div className="text-xs">
              <span className="font-medium t-text-secondary">Focus: </span>
              {cleanStageRefs(plan!.current_focus)}
            </div>
          )}
          {plan!.why_now && (
            <div className="mt-1 text-xs">
              <span className="font-medium t-text-secondary">Why now: </span>
              <span className="t-text-secondary">{cleanStageRefs(plan!.why_now)}</span>
            </div>
          )}
          {plan!.tool_plan?.length > 0 && (
            <div className="mt-1.5">
              <div className="text-[11px] font-medium t-text-secondary">Plan steps:</div>
              <ol className="mt-0.5 space-y-0.5 text-[11px] list-none pl-0">
                {plan!.tool_plan.map((step) => (
                  <li key={step.step} className="flex gap-1.5">
                    <span className="shrink-0 t-text-muted">{step.step}.</span>
                    <span>
                      Use <span className="font-medium t-accent-teal">{step.tool}</span> to {step.goal}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {plan!.done_definition && (
            <div className="mt-1 text-xs">
              <span className="font-medium t-text-secondary">Success criteria: </span>
              <span className="t-text-secondary">{cleanStageRefs(plan!.done_definition)}</span>
            </div>
          )}
          {plan!.risk_flags?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {plan!.risk_flags.map((flag, i) => (
                <span key={i} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] t-accent-amber">
                  {flag}
                </span>
              ))}
            </div>
          )}
          {plan!.need_from_user?.required && plan!.need_from_user.request && (
            <div className="mt-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] t-accent-amber">
              Need from you: {plan!.need_from_user.request}
            </div>
          )}
          {turn.plannerSpec?.uncertaintyNote && (
            <div className="mt-1 text-[11px] italic t-text-muted">
              {turn.plannerSpec.uncertaintyNote}
            </div>
          )}
        </Section>
      ) : (
        // Fallback for turns without plannerSpec
        turn.execution?.actionRationale && (
          <div className="mt-1.5 text-xs t-text-secondary">
            {cleanStageRefs(turn.execution.actionRationale)}
          </div>
        )
      )}

      {/* Execution Section */}
      <Section title="Execution" defaultOpen={isLatest && !hasPlanData}>
        {turn.execution?.actionRationale && (
          <div className="text-xs">
            <span className="font-medium t-text-secondary">Decision: </span>
            {cleanStageRefs(turn.execution.actionRationale)}
          </div>
        )}
        {hasExecTrace ? (
          <div className="mt-1.5 space-y-1">
            <div className="text-[11px] font-medium t-text-secondary">Steps taken:</div>
            {turn.execution!.executionTrace!.map((item, i) => (
              <div key={i} className="rounded-lg t-bg-elevated px-2 py-1 text-[11px]">
                <span className="font-medium t-accent-teal">{item.tool}</span>
                <span className="t-text-muted"> — {item.reason}</span>
                {item.result_summary && (
                  <div className="mt-0.5 t-text-secondary truncate">{item.result_summary}</div>
                )}
              </div>
            ))}
          </div>
        ) : (turn.execution?.toolCalls ?? []).length > 0 && (
          <div className="mt-1 text-[11px] t-text-secondary">
            Tool calls: {(turn.execution?.toolCalls ?? []).slice(0, 5).map((tc) => tc.tool).join(', ')}
          </div>
        )}
        {turn.summary && (
          <div className="mt-1.5 text-xs">
            <span className="font-medium t-text-secondary">What was learned: </span>
            {cleanStageRefs(turn.summary)}
          </div>
        )}
      </Section>

      {/* Quality Section (only if reviewer ran) */}
      {hasReview && (
        <Section title="Quality Review" defaultOpen={false}>
          {hasProcessReview && (
            <>
              <div className="flex items-center gap-2">
                <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${verdictColor(turn.reviewerSnapshot!.processReview!.verdict)}`}>
                  {turn.reviewerSnapshot!.processReview!.verdict.toUpperCase()}
                </span>
                <span className="text-[11px] t-text-secondary">
                  {Math.round(turn.reviewerSnapshot!.processReview!.confidence * 100)}% confidence
                </span>
              </div>
              {turn.reviewerSnapshot!.processReview!.critical_issues?.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  <div className="text-[11px] font-medium t-text-secondary">Issues:</div>
                  {turn.reviewerSnapshot!.processReview!.critical_issues.map((issue) => (
                    <div key={issue.id} className="flex items-start gap-1.5 text-[11px]">
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                        issue.severity === 'high'
                          ? 'bg-rose-500/20 t-accent-rose'
                          : issue.severity === 'medium'
                            ? 'bg-amber-500/20 t-accent-amber'
                            : 'bg-slate-500/20 t-text-secondary'
                      }`}>
                        {issue.severity}
                      </span>
                      <span>{issue.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {turn.reviewerSnapshot!.processReview!.fix_plan?.length > 0 && (
                <div className="mt-1.5">
                  <div className="text-[11px] font-medium t-text-secondary">Fix plan:</div>
                  {turn.reviewerSnapshot!.processReview!.fix_plan.map((fix) => (
                    <div key={fix.issue_id} className="text-[11px] t-text-secondary">
                      {fix.issue_id}: {fix.action}
                    </div>
                  ))}
                </div>
              )}
              {turn.reviewerSnapshot!.processReview!.notes_for_user && (
                <div className="mt-1.5 text-[11px]">
                  <span className="font-medium t-text-secondary">Notes for you: </span>
                  {turn.reviewerSnapshot!.processReview!.notes_for_user}
                </div>
              )}
            </>
          )}
          {/* Fallback: legacy reviewer fields */}
          {!hasProcessReview && (
            <div className="text-[11px] t-text-secondary">
              {turn.reviewerSnapshot?.reviewerPasses?.length ?? 0} review passes
              {' · '}{turn.reviewerSnapshot?.consensusBlockers?.length ?? 0} blockers
              {turn.reviewerSnapshot?.notes?.length ? (
                <div className="mt-1">{turn.reviewerSnapshot.notes.join(' · ')}</div>
              ) : null}
            </div>
          )}
          {gateStatus !== 'none' && (
            <div className="mt-1.5 text-[11px]">
              <span className="font-medium t-text-secondary">Gate: </span>
              <span className={gateStatus === 'pass' ? 't-accent-emerald' : 't-accent-rose'}>
                {GATE_LABELS[gateStatus]}
              </span>
            </div>
          )}
        </Section>
      )}

      {/* Next Step Section */}
      {turn.nextStepRationale && (
        <Section title="What Comes Next" defaultOpen={isLatest}>
          <div className="text-xs t-text-secondary">{cleanStageRefs(turn.nextStepRationale)}</div>
        </Section>
      )}

      {/* Metrics Footer */}
      <Section title="Metrics" defaultOpen={false}>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] t-text-muted">
          <span>{(turn.consumedBudgets?.turnTokens ?? 0).toLocaleString()} tokens</span>
          <span>${(turn.consumedBudgets?.turnCostUsd ?? 0).toFixed(3)}</span>
          <span>{turn.assetDiff?.created?.length ?? 0} artifacts</span>
          {turn.consumedBudgets?.wallClockSec != null && (
            <span>{turn.consumedBudgets.wallClockSec.toFixed(1)}s</span>
          )}
          {turn.execution?.tooling?.mode && (
            <span>tooling: {turn.execution.tooling.mode}</span>
          )}
        </div>
      </Section>
    </div>
  )
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
            {filteredTurns.map((turn, idx) => (
              <ThinkingCard
                key={turn.turnNumber}
                turn={turn}
                isLatest={idx === 0}
                isSelected={selectedTurn?.turnNumber === turn.turnNumber}
                onSelect={() => onSelectTurn(selectedTurn?.turnNumber === turn.turnNumber ? null : turn.turnNumber)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
