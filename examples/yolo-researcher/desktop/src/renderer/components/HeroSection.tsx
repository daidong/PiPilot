import type { FailureInfo, InteractionContext, TurnReport, YoloSnapshot } from '@/lib/types'
import { cleanStageRefs, friendlyAction, friendlyState } from '@/lib/formatters'
import { AlertTriangle, ArrowRight } from 'lucide-react'

interface HeroSectionProps {
  snapshot: YoloSnapshot | null
  goal: string
  selectedPhase: 'P0' | 'P1' | 'P2' | 'P3'
  activeTurn: TurnReport | null
  failureInfo: FailureInfo | null
  isStarting: boolean
  drawerInteraction: InteractionContext | null
  totalCreatedAssets: number
  onGoalChange: (goal: string) => void
  onPhaseChange: (phase: 'P0' | 'P1' | 'P2' | 'P3') => void
  onStart: () => void
  onResume: () => void
  onRestart: () => void
  onRestoreCheckpoint: () => void
  onOpenDrawer: () => void
}

function hasBlockingNeed(snapshot: YoloSnapshot | null, drawerInteraction: InteractionContext | null): boolean {
  return drawerInteraction !== null
}

export function HeroSection({
  snapshot,
  goal,
  selectedPhase,
  activeTurn,
  failureInfo,
  isStarting,
  drawerInteraction,
  totalCreatedAssets,
  onGoalChange,
  onPhaseChange,
  onStart,
  onResume,
  onRestart,
  onRestoreCheckpoint,
  onOpenDrawer,
}: HeroSectionProps) {
  const state = snapshot?.state
  const displayState = state === 'WAITING_FOR_USER' ? 'Running (waiting for your input)' : friendlyState(state)
  const latestExecution = activeTurn?.execution
  const hasNeed = hasBlockingNeed(snapshot, drawerInteraction)

  const isIdle = !snapshot?.sessionId || state === 'IDLE'
  if (isIdle) {
    return (
      <section className="rounded-2xl border t-border t-bg-surface p-5">
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wide t-text-secondary">Mission Board</div>
          <div className="text-sm font-medium">Define your research objective and start</div>
        </div>
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
          {isStarting ? 'Starting...' : 'Start Research'}
        </button>
      </section>
    )
  }

  // COMPLETE state: show concrete summary
  if (state === 'COMPLETE') {
    const totalCycles = snapshot?.currentTurn ?? 0
    const totalCost = snapshot?.budgetUsed?.costUsd ?? 0
    return (
      <section className="rounded-2xl border t-border t-bg-surface p-4">
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wide t-text-secondary">Mission Board</div>
          <div className="text-sm font-medium t-accent-emerald">
            Run complete · {totalCycles} cycles · {totalCreatedAssets} artifacts · ${totalCost.toFixed(2)} spent
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <article className="rounded-xl border t-card-emerald p-3">
            <div className="text-[11px] uppercase tracking-wide t-text-secondary">Summary</div>
            <div className="mt-2 text-xs line-clamp-4">
              {activeTurn?.summary
                ? cleanStageRefs(activeTurn.summary)
                : 'Research complete.'}
            </div>
          </article>
          <article className="rounded-xl border t-card-teal p-3">
            <div className="text-[11px] uppercase tracking-wide t-text-secondary">Final Metrics</div>
            <div className="mt-2 text-xs t-text-secondary">
              <div>{totalCycles} research cycles completed</div>
              <div>{totalCreatedAssets} total artifacts created</div>
              <div>${totalCost.toFixed(2)} total cost</div>
              <div>{(snapshot?.budgetUsed?.tokens ?? 0).toLocaleString()} tokens consumed</div>
            </div>
          </article>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-2xl border t-border t-bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide t-text-secondary">Mission Board</div>
          <div className="text-sm font-medium">
            {hasNeed ? 'Current Focus · Need From You · Latest Insight' : 'Current Focus · Latest Insight'}
          </div>
        </div>
        <div className={`rounded-md border px-2 py-1 text-[11px] ${hasNeed ? 'border-amber-500/40 t-accent-amber' : 'border-emerald-500/40 t-accent-emerald'}`}>
          {hasNeed ? 'Action Needed' : 'No Blocker'}
        </div>
      </div>

      <div className={`grid gap-3 ${hasNeed ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        {/* Current Focus */}
        <article className="rounded-xl border t-card-teal p-3">
          <div className="text-[11px] uppercase tracking-wide t-text-secondary">Current Focus</div>
          <div className="mt-1 text-sm font-medium">{displayState}</div>
          <div className="mt-1 text-xs t-text-secondary">Cycle {snapshot?.currentTurn ?? 0}</div>
          {activeTurn?.turnSpec?.objective && (
            <div className="mt-2 text-xs line-clamp-3">{cleanStageRefs(activeTurn.turnSpec.objective)}</div>
          )}
          {latestExecution?.action && (
            <div className="mt-2 text-[11px] t-accent-teal">
              {friendlyAction(latestExecution.action)}
            </div>
          )}
          {latestExecution?.actionRationale && (
            <div className="mt-1 text-[11px] t-text-secondary line-clamp-3">
              {cleanStageRefs(latestExecution.actionRationale)}
            </div>
          )}
          {(state === 'PAUSED' || state === 'STOPPED') && (
            <button
              onClick={onResume}
              className="mt-3 rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
            >
              Resume
            </button>
          )}
        </article>

        {/* Need From You — compact trigger card that opens the drawer */}
        {hasNeed && drawerInteraction && (
          <article
            className="rounded-xl border t-card-amber p-3 cursor-pointer hover:bg-amber-500/10 transition-colors group"
            onClick={onOpenDrawer}
          >
            <div className="text-[11px] uppercase tracking-wide t-text-secondary">Need From You</div>
            <div className="mt-1.5 flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 t-accent-amber" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{drawerInteraction.title}</div>
                <div className="mt-1 text-[11px] t-text-secondary">
                  {drawerInteraction.kind === 'experiment_request' && 'Experiment data needed to continue research.'}
                  {drawerInteraction.kind === 'fulltext_upload' && 'Full-text document needed to continue.'}
                  {drawerInteraction.kind === 'gate_blocker' && 'A gate blocker requires your scope decision.'}
                  {drawerInteraction.kind === 'checkpoint_decision' && 'A research checkpoint requires your decision.'}
                  {drawerInteraction.kind === 'resource_extension' && 'The system is requesting additional budget.'}
                  {drawerInteraction.kind === 'general_question' && 'The research agent has a question for you.'}
                  {drawerInteraction.kind === 'failure_recovery' && 'The session encountered a failure and needs recovery.'}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1 text-[11px] t-accent-teal group-hover:underline">
              Click to review and respond <ArrowRight size={10} />
            </div>
          </article>
        )}

        {/* Latest Insight */}
        <article className="rounded-xl border t-card-emerald p-3">
          <div className="text-[11px] uppercase tracking-wide t-text-secondary">Latest Insight</div>
          <div className="mt-2 text-xs line-clamp-4">
            {activeTurn?.summary
              ? cleanStageRefs(activeTurn.summary)
              : 'No insight yet. The first successful cycle will appear here.'}
          </div>
          {activeTurn && (
            <div className="mt-2 text-[11px] t-text-secondary">
              {activeTurn.assetDiff?.created?.length ?? 0} artifacts
              {' · '}{(activeTurn.consumedBudgets?.turnTokens ?? 0).toLocaleString()} tokens
              {' · '}${(activeTurn.consumedBudgets?.turnCostUsd ?? 0).toFixed(3)}
            </div>
          )}
        </article>
      </div>
    </section>
  )
}
