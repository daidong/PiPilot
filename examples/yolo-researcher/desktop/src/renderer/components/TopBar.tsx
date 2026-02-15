import React, { useState } from 'react'
import { Play, Pause, Square, CheckCircle2, AlertTriangle, Minus, Sun, Moon } from 'lucide-react'
import type { YoloSnapshot, StageId, StageGateInfo, BudgetUsageInfo } from '@/lib/types'
import { STAGES, STAGE_LABELS, stateTone, friendlyState } from '@/lib/formatters'

interface TopBarProps {
  projectPath: string
  snapshot: YoloSnapshot | null
  stageGates: Record<StageId, StageGateInfo>
  budgetUsage: BudgetUsageInfo
  budgetCaps: { maxTurns: number; maxTokens: number; maxCostUsd: number }
  canPause: boolean
  canResume: boolean
  canStop: boolean
  isStarting: boolean
  isStopping: boolean
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

export function TopBar({
  projectPath,
  snapshot,
  stageGates,
  budgetUsage,
  budgetCaps,
  canPause,
  canResume,
  canStop,
  isStarting,
  isStopping,
  onStart,
  onPause,
  onResume,
  onStop,
}: TopBarProps) {
  const rawState = snapshot?.state ?? 'IDLE'
  const isIdle = !snapshot?.sessionId
  const state = isStopping ? 'STOPPING' : (isIdle && isStarting) ? 'STARTING' : rawState

  const [isDark, setIsDark] = useState(
    () => document.documentElement.classList.contains('dark')
  )

  function toggleTheme() {
    const next = isDark ? 'light' : 'dark'
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.classList.add(next)
    localStorage.setItem('yolo-theme', next)
    setIsDark(!isDark)
  }

  const showSpinnerBadge = state === 'STARTING' || state === 'STOPPING'

  return (
    <header className="no-drag sticky top-0 z-10 border-b t-border t-bg-surface px-4 pt-8 pb-3">
      <div className="flex items-center gap-4">
        {/* Title + state */}
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-semibold whitespace-nowrap" style={{ fontFamily: "'Playfair Display', serif" }}>YOLO</h1>
          <div className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium flex items-center gap-1.5 ${
            state === 'STARTING' ? 'border-teal-500/40 t-accent-teal'
            : state === 'STOPPING' ? 'border-rose-500/40 t-accent-rose'
            : stateTone(snapshot?.state)
          }`}>
            {showSpinnerBadge && (
              <div className={`h-3 w-3 animate-spin rounded-full border-[1.5px] ${
                state === 'STOPPING' ? 'border-rose-500 border-t-transparent' : 'border-teal-500 border-t-transparent'
              }`} />
            )}
            {friendlyState(state)}
          </div>
        </div>

        {/* Stage pipeline — compact */}
        <div className="flex items-center gap-1">
          {STAGES.map((stage, index) => {
            const info = stageGates[stage]
            const isCurrent = snapshot?.activeStage === stage
            return (
              <React.Fragment key={stage}>
                <div
                  title={STAGE_LABELS[stage]}
                  className={`flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] ${
                    isCurrent ? 'bg-teal-500/15 t-accent-teal font-medium' : 't-text-muted'
                  }`}
                >
                  {info.status === 'pass' && <CheckCircle2 size={10} className="text-emerald-500" />}
                  {info.status === 'fail' && <AlertTriangle size={10} className="text-rose-500" />}
                  {info.status === 'none' && <Minus size={10} className="opacity-40" />}
                  {STAGE_LABELS[stage]}
                </div>
                {index < STAGES.length - 1 && <span className="text-[10px] t-text-muted opacity-30">›</span>}
              </React.Fragment>
            )
          })}
        </div>

        {/* Budget mini bar */}
        <div className="flex items-center gap-3 text-[11px] t-text-secondary whitespace-nowrap">
          <span>
            <span className="t-text-muted">Cycles</span>{' '}
            {snapshot?.budgetUsed?.turns ?? 0} / {budgetCaps.maxTurns}
          </span>
          <span>
            <span className="t-text-muted">Cost</span>{' '}
            ${(snapshot?.budgetUsed?.costUsd ?? 0).toFixed(2)} / ${budgetCaps.maxCostUsd}
          </span>
        </div>

        {/* Controls */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="rounded-lg border t-border px-2.5 py-1.5 text-xs t-text-secondary t-hoverable"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>

          {isIdle ? (
            <button className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 flex items-center gap-1.5" onClick={onStart} disabled={isStarting}>
              {isStarting ? (
                <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-white border-t-transparent" />
              ) : (
                <Play size={12} />
              )}
              {isStarting ? 'Starting...' : 'Start'}
            </button>
          ) : (
            <>
              <button className="rounded-lg border t-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40" onClick={onPause} disabled={!canPause || isStopping} title="Pause">
                <Pause size={12} />
              </button>
              <button className="rounded-lg border t-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40" onClick={onResume} disabled={!canResume || isStopping} title="Resume">
                <Play size={12} />
              </button>
              <button
                className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-medium t-accent-rose disabled:opacity-40 flex items-center gap-1"
                onClick={onStop}
                disabled={!canStop || isStopping}
                title={isStopping ? 'Stopping after current turn finishes...' : 'Stop'}
              >
                {isStopping ? (
                  <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-rose-500 border-t-transparent" />
                ) : (
                  <Square size={12} />
                )}
                {isStopping ? 'Stopping...' : ''}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-1 text-[11px] t-text-muted truncate">{projectPath}</div>
    </header>
  )
}
