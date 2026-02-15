import type { YoloSnapshot, TurnReport, CoverageSummary, FailureInfo, ExternalWaitTask } from '@/lib/types'
import { friendlyState, friendlyQuestion, friendlyQuestionContext, cleanStageRefs, friendlyErrorReason, friendlyErrorCategory } from '@/lib/formatters'
import { QuestionPanel } from './QuestionPanel'

interface HeroSectionProps {
  snapshot: YoloSnapshot | null
  goal: string
  selectedPhase: 'P0' | 'P1' | 'P2' | 'P3'
  activeTurn: TurnReport | null
  failureInfo: FailureInfo | null
  completeCoverageSummary: CoverageSummary
  totalCreatedAssets: number
  quickOptions: string[]
  isStarting: boolean
  pendingWaitTask: ExternalWaitTask | null
  isCheckpointModal: boolean
  onGoalChange: (goal: string) => void
  onPhaseChange: (phase: 'P0' | 'P1' | 'P2' | 'P3') => void
  onStart: () => void
  onResume: () => void
  onRestart: () => void
  onRestoreCheckpoint: () => void
  onQuickReply: (text: string) => void
  onSubmitReply: (text: string) => void
  onExportSummary: () => void
  onExportClaimTable: () => void
  onExportAssets: () => void
  onExportFinalBundle: () => void
  onOpenEvidence: () => void
  onOpenSystem: () => void
}

export function HeroSection({
  snapshot,
  goal,
  selectedPhase,
  activeTurn,
  failureInfo,
  completeCoverageSummary,
  totalCreatedAssets,
  quickOptions,
  isStarting,
  pendingWaitTask,
  isCheckpointModal,
  onGoalChange,
  onPhaseChange,
  onStart,
  onResume,
  onRestart,
  onRestoreCheckpoint,
  onQuickReply,
  onSubmitReply,
  onExportSummary,
  onExportClaimTable,
  onExportAssets,
  onExportFinalBundle,
  onOpenEvidence,
  onOpenSystem,
}: HeroSectionProps) {
  const state = snapshot?.state

  // Show launching card whenever isStarting is true (regardless of snapshot state)
  if (isStarting) {
    return (
      <section className="rounded-2xl border border-teal-500/40 bg-teal-500/5 p-5">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
          <div>
            <div className="text-sm font-medium">Launching Research Session...</div>
            <div className="mt-0.5 text-xs t-text-secondary">Initializing planner and preparing first cycle</div>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-teal-500/10 px-3 py-2 text-xs t-text-secondary">
          <span className="font-medium t-accent-teal">Goal:</span> {goal}
        </div>
      </section>
    )
  }

  // IDLE — goal form
  if (!snapshot?.sessionId || state === 'IDLE') {
    return (
      <section className="rounded-2xl border t-border t-bg-surface p-5">
        <label className="mb-2 block text-xs uppercase tracking-wide t-text-secondary">Research Goal</label>
        <textarea
          value={goal}
          onChange={(e) => onGoalChange(e.target.value)}
          rows={3}
          className="mb-3 w-full resize-none rounded-xl border t-border bg-transparent p-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        />
        <button
          className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 hover:bg-teal-400 transition-colors"
          onClick={onStart}
          disabled={isStarting}
        >
          Start Research
        </button>
      </section>
    )
  }

  // RUNNING (EXECUTING / PLANNING / TURN_COMPLETE)
  if (state === 'EXECUTING' || state === 'PLANNING' || state === 'TURN_COMPLETE') {
    return (
      <section className="rounded-2xl border border-teal-500/30 bg-teal-500/5 p-5">
        {activeTurn ? (
          <>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
              <div className="text-xs t-text-secondary">
                {state === 'PLANNING' ? 'Planning next cycle...' : state === 'TURN_COMPLETE' ? 'Cycle complete — preparing next...' : 'Researching'}
              </div>
            </div>
            <div className="mt-2 text-sm font-medium">{cleanStageRefs(activeTurn.turnSpec?.objective ?? '')}</div>
            {activeTurn.summary && (
              <div className="mt-1 text-xs t-text-secondary">{cleanStageRefs(activeTurn.summary)}</div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
            <div>
              <div className="text-sm font-medium">Planning first cycle...</div>
              <div className="mt-0.5 text-xs t-text-secondary">The planner is deciding what to investigate first</div>
            </div>
          </div>
        )}
      </section>
    )
  }

  // WAITING_FOR_USER (non-modal questions shown inline)
  if (state === 'WAITING_FOR_USER' && !isCheckpointModal) {
    return (
      <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
        <QuestionPanel
          question={friendlyQuestion(snapshot.pendingQuestion?.question ?? '')}
          context={friendlyQuestionContext(snapshot.pendingQuestion?.context)}
          quickOptions={quickOptions}
          onQuickReply={onQuickReply}
          onSubmit={onSubmitReply}
        />
      </section>
    )
  }

  // WAITING_FOR_USER with checkpoint modal — show a brief note (modal handles the interaction)
  if (state === 'WAITING_FOR_USER' && isCheckpointModal) {
    return (
      <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
        <div className="text-sm font-medium t-accent-amber">Checkpoint Decision Required</div>
        <div className="mt-1 text-xs t-text-secondary">
          A checkpoint decision dialog is open. Please respond in the modal overlay.
        </div>
      </section>
    )
  }

  // WAITING_EXTERNAL
  if (state === 'WAITING_EXTERNAL') {
    return (
      <section className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-5">
        <div className="text-sm font-medium t-accent-sky">Waiting for External Input</div>
        <div className="mt-1 text-xs">{pendingWaitTask?.title ?? 'Pending external task'}</div>
        <div className="mt-1 text-xs t-text-secondary">{pendingWaitTask?.completionRule}</div>
        <button
          onClick={onOpenSystem}
          className="mt-3 rounded-md border border-sky-400/40 px-3 py-1.5 text-xs t-accent-sky hover:bg-sky-500/10"
        >
          Manage in System tab
        </button>
      </section>
    )
  }

  // PAUSED
  if (state === 'PAUSED') {
    return (
      <section className="rounded-2xl border border-slate-500/30 bg-slate-500/5 p-5">
        <div className="text-sm font-medium">Session Paused</div>
        <div className="mt-1 text-xs t-text-secondary">
          Execution paused. Resume continues from next planning boundary.
        </div>
        <button
          onClick={onResume}
          className="mt-3 rounded-lg border t-border px-3 py-1.5 text-xs font-medium t-hoverable"
        >
          Resume
        </button>
      </section>
    )
  }

  // COMPLETE
  if (state === 'COMPLETE') {
    return (
      <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5">
        <div className="text-sm font-medium t-accent-emerald">Research Complete</div>
        <div className="mt-1 text-xs t-text-secondary">{activeTurn?.summary ?? 'Session reached COMPLETE.'}</div>
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs t-accent-emerald">
          <div>
            primary {completeCoverageSummary.coveredPrimary}/{completeCoverageSummary.assertedPrimary}
            {' · '}
            ratio {(completeCoverageSummary.primaryRatio ?? 0).toFixed(2)}
            {' · '}
            {completeCoverageSummary.primaryPass ? 'pass' : 'fail'}
          </div>
          <div className="mt-0.5">
            secondary {completeCoverageSummary.coveredSecondary}/{completeCoverageSummary.assertedSecondary}
            {' · '}
            ratio {(completeCoverageSummary.secondaryRatio ?? 0).toFixed(2)}
            {' · '}
            {completeCoverageSummary.secondaryPass ? 'pass' : 'fail'}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={onOpenEvidence} className="rounded-md border border-emerald-400/40 px-2 py-1 text-[11px] t-accent-emerald hover:bg-emerald-500/20">
            Open Evidence Map
          </button>
          <button onClick={onExportFinalBundle} className="rounded-md border border-emerald-400/40 px-2 py-1 text-[11px] t-accent-emerald hover:bg-emerald-500/20">
            Export Final Bundle
          </button>
          <button onClick={onExportSummary} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Summary
          </button>
          <button onClick={onExportClaimTable} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Claim Table
          </button>
          <button onClick={onExportAssets} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Assets
          </button>
          <button onClick={onRestart} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Restart New Run
          </button>
        </div>
      </section>
    )
  }

  // FAILED
  if (state === 'FAILED') {
    return (
      <section className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5">
        <div className="text-sm font-medium t-accent-rose">Run Failed</div>
        <div className="mt-1 text-xs t-text-secondary">{cleanStageRefs(activeTurn?.summary ?? 'The research session encountered an error.')}</div>
        {failureInfo && (
          <div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] t-accent-rose">
            <div className="font-medium">{friendlyErrorCategory(failureInfo.category)}</div>
            <div className="mt-0.5">{friendlyErrorReason(failureInfo.reason)}</div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={onOpenSystem} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Inspect Diagnostics
          </button>
          {selectedPhase !== 'P0' && (
            <button onClick={onRestoreCheckpoint} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
              Restore Checkpoint
            </button>
          )}
          <button onClick={onRestart} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Restart New Run
          </button>
          <button onClick={onExportSummary} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Summary
          </button>
        </div>
      </section>
    )
  }

  // STOPPED
  if (state === 'STOPPED') {
    return (
      <section className="rounded-2xl border border-slate-500/30 bg-slate-500/5 p-5">
        <div className="text-sm font-medium">Run Stopped</div>
        <div className="mt-1 text-xs t-text-secondary">Session was stopped by user. You can resume from the last durable boundary.</div>
        <div className="mt-2 rounded-lg border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-[11px]">
          cycles: {snapshot.budgetUsed.turns} · artifacts: {totalCreatedAssets} · tokens: {snapshot.budgetUsed.tokens.toLocaleString()} · cost: ${snapshot.budgetUsed.costUsd.toFixed(3)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={onResume} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Resume Session
          </button>
          {selectedPhase !== 'P0' && (
            <button onClick={onRestoreCheckpoint} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
              Restore Checkpoint
            </button>
          )}
          <button onClick={onRestart} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Restart New Run
          </button>
          <button onClick={onExportSummary} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Summary
          </button>
          <button onClick={onExportClaimTable} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Claim Table
          </button>
          <button onClick={onExportAssets} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Assets
          </button>
          <button onClick={onExportFinalBundle} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
            Export Final Bundle
          </button>
        </div>
      </section>
    )
  }

  // CRASHED or unknown fallback
  return (
    <section className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5">
      <div className="text-sm font-medium t-accent-rose">Session State: {friendlyState(state)}</div>
      <div className="mt-1 text-xs t-text-secondary">{activeTurn?.summary ?? 'Unexpected state.'}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={onRestart} className="rounded-md border t-border-action px-2 py-1 text-[11px] t-hoverable">
          Restart New Run
        </button>
      </div>
    </section>
  )
}
