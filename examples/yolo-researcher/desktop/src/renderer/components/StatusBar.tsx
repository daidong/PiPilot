import type { DesktopOverview } from '../lib/types'

interface StatusBarProps {
  overview: DesktopOverview | null
  onPickFolder: () => void
  onClose: () => void
  busy: boolean
}

function statusInfo(overview: DesktopOverview | null): { color: string; pulse: boolean; label: string } {
  if (!overview?.projectPath) return { color: 'var(--color-text-muted)', pulse: false, label: 'No project' }
  if (overview.loopRunning) return { color: 'var(--color-accent-teal)', pulse: true, label: 'Running' }
  if (overview.pausedForUserInput) return { color: 'var(--color-accent-amber)', pulse: true, label: 'Paused' }
  if (overview.lastTurn?.partial) return { color: 'var(--color-accent-sky)', pulse: false, label: 'Partial' }
  const lastStatus = overview.lastTurn?.status?.toLowerCase()
  if (lastStatus === 'ask_user' || lastStatus === 'paused') return { color: 'var(--color-accent-amber)', pulse: true, label: 'Paused' }
  if (lastStatus === 'no_delta') return { color: 'var(--color-accent-amber)', pulse: false, label: 'No Delta' }
  if (lastStatus === 'partial') return { color: 'var(--color-accent-sky)', pulse: false, label: 'Partial' }
  if (lastStatus === 'failure' || lastStatus === 'blocked') return { color: 'var(--color-accent-rose)', pulse: false, label: 'Error' }
  return { color: 'var(--color-text-secondary)', pulse: false, label: 'Idle' }
}

export default function StatusBar({ overview, onPickFolder, onClose, busy }: StatusBarProps) {
  const info = statusInfo(overview)
  const hasProject = Boolean(overview?.projectPath)
  const turnCount = overview?.turnCount ?? 0
  const turnNum = overview?.lastTurn ? overview.lastTurn.turnNumber.toString().padStart(4, '0') : null

  return (
    <header
      className="no-drag sticky top-0 z-10 flex shrink-0 items-center border-b px-4 pt-7 pb-3"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)' }}
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        {/* YOLO serif title — V1 signature */}
        <h1 className="text-lg font-semibold whitespace-nowrap" style={{ fontFamily: "'Playfair Display', serif" }}>YOLO</h1>

        {/* State badge with optional spinner */}
        <div
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium"
          style={{
            borderColor: info.pulse ? `${info.color}55` : 'var(--color-border)',
            background: info.pulse ? `${info.color}15` : 'transparent',
            color: info.color
          }}
        >
          {info.pulse && (
            <div
              className="h-3 w-3 rounded-full border-[1.5px] animate-spin-slow"
              style={{ borderColor: info.color, borderTopColor: 'transparent' }}
            />
          )}
          {!info.pulse && (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: info.color }}
            />
          )}
          {info.label}
          {turnNum && (
            <span style={{ color: 'var(--color-text-muted)' }}>turn-{turnNum}</span>
          )}
        </div>

        {/* Budget mini bar — V1 TopBar pattern */}
        {hasProject && (
          <div className="flex items-center gap-3 text-[11px] whitespace-nowrap" style={{ color: 'var(--color-text-secondary)' }}>
            <span>
              <span style={{ color: 'var(--color-text-muted)' }}>Cycles</span>{' '}
              {turnCount}
            </span>
            {overview?.model && (
              <>
                <span style={{ color: 'var(--color-text-muted)' }}>Model</span>{' '}
                <span style={{ color: 'var(--color-accent-soft)' }}>{overview.model}</span>
              </>
            )}
            {overview?.defaultRuntime && (
              <>
                <span style={{ color: 'var(--color-text-muted)' }}>Runtime</span>{' '}
                {overview.defaultRuntime}
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Project path */}
        {overview?.projectPath && (
          <span className="max-w-[260px] truncate text-[11px]" style={{ color: 'var(--color-text-muted)' }} title={overview.projectPath}>
            {overview.projectPath}
          </span>
        )}

        {/* Controls — V1 TopBar button style */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPickFolder}
            disabled={busy}
            className="rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            Open
          </button>
          {hasProject && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              Close
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
