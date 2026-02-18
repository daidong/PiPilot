import { useRef, useEffect, useState } from 'react'
import type { ActivityItem } from '../lib/types'

interface ActivityViewProps {
  activities: ActivityItem[]
}

const TYPE_CONFIG: Record<string, { label: string; cardClass: string; accentClass: string; dotColor: string }> = {
  turn_started:    { label: 'Turn started',    cardClass: 't-card-teal',    accentClass: 't-accent-teal',    dotColor: 'var(--color-accent-teal)' },
  turn_completed:  { label: 'Turn completed',  cardClass: 't-card-emerald', accentClass: 't-accent-emerald', dotColor: 'var(--color-accent-emerald)' },
  tool_call:       { label: 'Tool call',       cardClass: 't-card-sky',     accentClass: 't-accent-sky',     dotColor: 'var(--color-accent-sky)' },
  tool_result:     { label: 'Tool result',     cardClass: 't-card-sky',     accentClass: 't-accent-teal',    dotColor: 'var(--color-accent-teal)' },
  terminal_start:  { label: 'Terminal start',  cardClass: 't-card-teal',    accentClass: 't-accent-teal',    dotColor: 'var(--color-accent-teal)' },
  terminal_end:    { label: 'Terminal end',    cardClass: 't-card-emerald', accentClass: 't-accent-emerald', dotColor: 'var(--color-accent-emerald)' },
  terminal_error:  { label: 'Terminal error',  cardClass: 't-card-rose',    accentClass: 't-accent-rose',    dotColor: 'var(--color-accent-rose)' },
  loop_progress:   { label: 'Loop progress',   cardClass: 't-card-sky',     accentClass: 't-accent-sky',     dotColor: 'var(--color-accent-sky)' },
  loop_stopped:    { label: 'Loop stopped',     cardClass: 't-card-amber',   accentClass: 't-accent-amber',   dotColor: 'var(--color-accent-amber)' },
  loop_paused:     { label: 'Loop paused',      cardClass: 't-card-amber',   accentClass: 't-accent-amber',   dotColor: 'var(--color-accent-amber)' },
  loop_error:      { label: 'Loop error',       cardClass: 't-card-rose',    accentClass: 't-accent-rose',    dotColor: 'var(--color-accent-rose)' },
  session_started: { label: 'Session started',  cardClass: 't-card-teal',    accentClass: 't-accent-violet',  dotColor: 'var(--color-accent-violet)' },
  user_input_submitted: { label: 'User input',  cardClass: 't-card-amber',   accentClass: 't-accent-amber',   dotColor: 'var(--color-accent-amber)' }
}

function getConfig(type: string) {
  return TYPE_CONFIG[type] || { label: type.replace(/_/g, ' '), cardClass: '', accentClass: 't-text-muted', dotColor: 'var(--color-text-muted)' }
}

function clock(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function ActivityView({ activities }: ActivityViewProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = 0
    }
  }, [activities.length, autoScroll])

  // Derive current phase from latest activity
  const latestType = activities[0]?.type
  const isActivePhase = latestType === 'turn_started' || latestType === 'loop_progress'
  const phaseLabel = isActivePhase
    ? (latestType === 'turn_started' ? 'Executing turn...' : 'Loop running...')
    : 'Agent Activity'

  return (
    <div className="flex h-full flex-col p-4">
      {/* Header with phase indicator — V1 ActivityFeed pattern */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${isActivePhase ? 'animate-status-pulse' : ''}`}
            style={{ background: isActivePhase ? 'var(--color-accent-teal)' : 'var(--color-text-muted)' }}
          />
          <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            {phaseLabel}
          </h3>
          {isActivePhase && (
            <span className="text-[11px] animate-status-pulse" style={{ color: 'var(--color-text-muted)' }}>...</span>
          )}
          <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            {activities.length} events
          </span>
        </div>
        <label className="flex items-center gap-2 text-[11px] cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-teal-500"
          />
          Auto-scroll
        </label>
      </div>

      <div ref={listRef} className="flex-1 space-y-2 overflow-auto">
        {activities.length === 0 && (
          <div
            className="flex h-40 items-center justify-center rounded-lg border text-xs"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)', color: 'var(--color-text-muted)' }}
          >
            No activity yet. Events will appear here when agents start working.
          </div>
        )}
        {activities.map((item) => {
          const cfg = getConfig(item.type)
          return (
            <div
              key={item.id}
              className={`rounded-lg border p-3 ${cfg.cardClass}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ background: cfg.dotColor }}
                />
                <span className={`text-[11px] font-semibold ${cfg.accentClass}`}>
                  {cfg.label}
                </span>
                <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                  {clock(item.timestamp)}
                </span>
              </div>
              <p className="mt-1.5 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{item.summary}</p>
              {item.detail && (
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{item.detail}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
