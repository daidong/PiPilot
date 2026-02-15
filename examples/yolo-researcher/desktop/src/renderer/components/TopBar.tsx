import { useState } from 'react'
import { Play, Pause, Square, Sun, Moon, RotateCcw } from 'lucide-react'
import type { YoloSnapshot, BudgetUsageInfo } from '@/lib/types'
import { stateTone, friendlyState } from '@/lib/formatters'

interface TopBarProps {
  projectPath: string
  snapshot: YoloSnapshot | null
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
  onRestart: () => void
}

export function TopBar({
  projectPath,
  snapshot,
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
  onRestart,
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
  const missionStateLabel = (
    state === 'STARTING' ? 'Starting'
    : state === 'STOPPING' ? 'Stopping'
    : state === 'PLANNING' || state === 'EXECUTING' || state === 'TURN_COMPLETE' ? 'Running'
    : state === 'WAITING_FOR_USER' ? 'Need Your Input'
    : state === 'WAITING_EXTERNAL' ? 'Need External Input'
    : state === 'IDLE' ? 'Ready'
    : friendlyState(state)
  )
  const missionToneClass = (
    state === 'STARTING'
      ? 'border-teal-500/40 t-accent-teal'
      : state === 'STOPPING'
        ? 'border-rose-500/40 t-accent-rose'
        : state === 'PLANNING' || state === 'EXECUTING' || state === 'TURN_COMPLETE'
          ? 'border-teal-500/40 t-accent-teal'
          : state === 'WAITING_FOR_USER' || state === 'WAITING_EXTERNAL'
            ? 'border-amber-500/40 t-accent-amber'
            : stateTone(snapshot?.state)
  )

  return (
    <header className="no-drag sticky top-0 z-10 border-b t-border t-bg-surface px-4 pt-8 pb-3">
      <div className="flex items-center gap-4">
        {/* Title + state */}
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-semibold whitespace-nowrap" style={{ fontFamily: "'Playfair Display', serif" }}>YOLO</h1>
          <div className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium flex items-center gap-1.5 ${missionToneClass}`}>
            {showSpinnerBadge && (
              <div className={`h-3 w-3 animate-spin rounded-full border-[1.5px] ${
                state === 'STOPPING' ? 'border-rose-500 border-t-transparent' : 'border-teal-500 border-t-transparent'
              }`} />
            )}
            {missionStateLabel}
          </div>
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
          <span>
            <span className="t-text-muted">Usage</span>{' '}
            {(budgetUsage.maxRatio * 100).toFixed(0)}%
          </span>
        </div>

        {/* Controls */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="rounded-lg border t-border px-2.5 py-1.5 text-xs t-text-secondary t-hoverable"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>

          {/* Restart project */}
          <button
            onClick={onRestart}
            disabled={isStarting || isStopping}
            className="rounded-lg border t-border px-2.5 py-1.5 text-xs t-text-secondary t-hoverable disabled:opacity-40 flex items-center gap-1"
            aria-label="Restart project"
          >
            <RotateCcw size={12} /> Restart
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
              <button
                className="rounded-lg border t-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 flex items-center gap-1"
                onClick={onPause}
                disabled={!canPause || isStopping}
                aria-label="Pause research"
              >
                <Pause size={12} /> Pause
              </button>
              <button
                className="rounded-lg border t-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 flex items-center gap-1"
                onClick={onResume}
                disabled={!canResume || isStopping}
                aria-label="Resume research"
              >
                <Play size={12} /> Resume
              </button>
              <button
                className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-medium t-accent-rose disabled:opacity-40 flex items-center gap-1"
                onClick={onStop}
                disabled={!canStop || isStopping}
                aria-label={isStopping ? 'Stopping after current turn finishes' : 'Stop research'}
              >
                {isStopping ? (
                  <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-rose-500 border-t-transparent" />
                ) : (
                  <Square size={12} />
                )}
                {isStopping ? 'Stopping...' : 'Stop'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Budget progress bar */}
      {!isIdle && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-neutral-500/20 overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${
              budgetUsage.maxRatio >= 0.95 ? 'bg-rose-500'
              : budgetUsage.maxRatio >= 0.8 ? 'bg-amber-500'
              : 'bg-teal-500'
            }`} style={{ width: `${Math.min(100, budgetUsage.maxRatio * 100)}%` }} />
          </div>
          <span className="text-[11px] t-text-muted">{Math.round(budgetUsage.maxRatio * 100)}%</span>
        </div>
      )}

      <div className="mt-1 text-[11px] t-text-muted truncate">{projectPath}</div>
    </header>
  )
}
