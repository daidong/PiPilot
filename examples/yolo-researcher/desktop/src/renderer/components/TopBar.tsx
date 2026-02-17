import { Play, Pause, Square, Sun, Moon, RotateCcw } from 'lucide-react'
import type { YoloSnapshot, BudgetUsageInfo } from '@/lib/types'
import type { AppTheme } from '@/hooks/useTheme'
import { missionStateLabel, stateTone } from '@/lib/formatters'

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
  theme: AppTheme
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onRestart: () => void
  onToggleTheme: () => void
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
  theme,
  onStart,
  onPause,
  onResume,
  onStop,
  onRestart,
  onToggleTheme,
}: TopBarProps) {
  const rawState = snapshot?.state ?? 'IDLE'
  const isIdle = !snapshot?.sessionId
  const state = isStopping ? 'STOPPING' : (isIdle && isStarting) ? 'STARTING' : rawState
  const isDark = theme === 'dark'

  const showSpinnerBadge = state === 'STARTING' || state === 'STOPPING'
  const missionLabel = missionStateLabel(state)
  const missionToneClass = stateTone(state)

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
            {missionLabel}
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
            onClick={onToggleTheme}
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

      <div className="mt-1 text-[11px] t-text-muted truncate">{projectPath}</div>
    </header>
  )
}
