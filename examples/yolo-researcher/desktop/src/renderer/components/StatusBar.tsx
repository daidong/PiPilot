import type { DesktopOverview, UsageSnapshot } from '../lib/types'

interface StatusBarProps {
  overview: DesktopOverview | null
  usage: UsageSnapshot
  onPickFolder: () => void
  onClose: () => void
  busy: boolean
}

type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatCost(value: number): string {
  if (value <= 0) return '$0.0000'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function statusInfo(overview: DesktopOverview | null): { tone: StatusTone; pulse: boolean; label: string } {
  if (!overview?.projectPath) return { tone: 'neutral', pulse: false, label: 'No project' }
  if (overview.loopRunning) return { tone: 'info', pulse: true, label: 'Running' }
  if (overview.pausedForUserInput) return { tone: 'warning', pulse: true, label: 'Pause' }
  if (overview.lastTurn?.partial) return { tone: 'info', pulse: false, label: 'Partial' }
  const lastStatus = overview.lastTurn?.status?.toLowerCase()
  if (lastStatus === 'ask_user' || lastStatus === 'paused') return { tone: 'warning', pulse: true, label: 'Pause' }
  if (lastStatus === 'no_delta') return { tone: 'warning', pulse: false, label: 'No Delta' }
  if (lastStatus === 'partial') return { tone: 'info', pulse: false, label: 'Partial' }
  if (lastStatus === 'failure' || lastStatus === 'blocked') return { tone: 'danger', pulse: false, label: 'Error' }
  return { tone: 'warning', pulse: false, label: 'Pause' }
}

function dotClassForTone(tone: StatusTone): string {
  return `t-dot-${tone}`
}

export default function StatusBar({ overview, usage, onPickFolder, onClose, busy }: StatusBarProps) {
  const info = statusInfo(overview)
  const hasProject = Boolean(overview?.projectPath)
  const turnCount = overview?.turnCount ?? 0
  const turnNum = overview?.lastTurn ? overview.lastTurn.turnNumber.toString().padStart(4, '0') : null
  const cacheHitRate = usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : 0

  return (
    <header
      className="no-drag t-bg-surface t-border sticky top-0 z-10 flex shrink-0 items-center border-b px-4 pt-7 pb-3"
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        {/* YOLO serif title — V1 signature */}
        <h1 className="t-font-brand text-lg font-semibold whitespace-nowrap">YOLO</h1>

        {/* State badge with optional spinner */}
        <div
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${info.pulse ? `t-status-${info.tone}` : 't-btn-neutral'}`}
        >
          {info.pulse && (
            <div className="h-3 w-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin-slow" />
          )}
          {!info.pulse && (
            <span className={`inline-block h-2 w-2 rounded-full ${dotClassForTone(info.tone)}`} />
          )}
          {info.label}
          {turnNum && (
            <span className="t-text-muted">turn-{turnNum}</span>
          )}
        </div>

        {/* Budget mini bar — V1 TopBar pattern */}
        {hasProject && (
          <div className="t-text-secondary flex items-center gap-3 text-[11px] whitespace-nowrap">
            <span>
              <span className="t-text-muted">Tokens</span>{' '}
              <span className="t-text-info">{formatTokens(usage.totalTokens)}</span>
            </span>
            <span>
              <span className="t-text-muted">Cost</span>{' '}
              <span className="t-text-info">{formatCost(usage.totalCost)}</span>
            </span>
            <span>
              <span className="t-text-muted">Cached</span>{' '}
              <span className="t-text-info">{Math.round(cacheHitRate * 100)}%</span>
            </span>
            <span>
              <span className="t-text-muted">Cycles</span>{' '}
              {turnCount}
            </span>
            {overview?.model && (
              <>
                <span className="t-text-muted">Model</span>{' '}
                <span className="t-text-info">{overview.model}</span>
              </>
            )}
            {overview?.defaultRuntime && (
              <>
                <span className="t-text-muted">Runtime</span>{' '}
                {overview.defaultRuntime}
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Project path */}
        {overview?.projectPath && (
          <span className="t-text-muted max-w-[260px] truncate text-[11px]" title={overview.projectPath}>
            {overview.projectPath}
          </span>
        )}

        {/* Controls — V1 TopBar button style */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPickFolder}
            disabled={busy}
            className="t-btn-neutral rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
          >
            Open
          </button>
          {hasProject && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="t-btn-neutral rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
