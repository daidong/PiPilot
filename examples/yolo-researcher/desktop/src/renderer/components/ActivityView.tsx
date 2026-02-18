import { useRef, useEffect, useState } from 'react'
import type { ActivityItem } from '../lib/types'

interface ActivityViewProps {
  activities: ActivityItem[]
}

type ActivityTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const TYPE_CONFIG: Record<string, { label: string; tone: ActivityTone }> = {
  turn_started: { label: 'Turn started', tone: 'info' },
  turn_completed: { label: 'Turn completed', tone: 'success' },
  tool_call: { label: 'Tool call', tone: 'info' },
  tool_result: { label: 'Tool result', tone: 'info' },
  terminal_start: { label: 'Terminal start', tone: 'info' },
  terminal_end: { label: 'Terminal end', tone: 'success' },
  terminal_error: { label: 'Terminal error', tone: 'danger' },
  loop_progress: { label: 'Loop progress', tone: 'info' },
  loop_stopped: { label: 'Loop stopped', tone: 'warning' },
  loop_paused: { label: 'Loop paused', tone: 'warning' },
  loop_error: { label: 'Loop error', tone: 'danger' },
  session_started: { label: 'Session started', tone: 'info' },
  user_input_submitted: { label: 'User input', tone: 'warning' }
}

function getConfig(type: string) {
  return TYPE_CONFIG[type] || { label: type.replace(/_/g, ' '), tone: 'neutral' as const }
}

function toneClass(tone: ActivityTone): string {
  return `t-status-${tone}`
}

function dotClass(tone: ActivityTone): string {
  return `t-dot-${tone}`
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
            className={`inline-block h-2 w-2 rounded-full ${isActivePhase ? 't-dot-info animate-status-pulse' : 't-dot-neutral'}`}
          />
          <h3 className="t-text-muted text-[11px] font-semibold uppercase tracking-wider">
            {phaseLabel}
          </h3>
          {isActivePhase && (
            <span className="t-text-muted text-[11px] animate-status-pulse">...</span>
          )}
          <span className="t-text-muted text-[10px]">
            {activities.length} events
          </span>
        </div>
        <label className="t-text-muted flex cursor-pointer items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="t-checkbox-accent h-3.5 w-3.5 rounded"
          />
          Auto-scroll
        </label>
      </div>

      <div ref={listRef} className="flex-1 space-y-2 overflow-auto">
        {activities.length === 0 && (
          <div
            className="t-bg-surface t-border t-text-muted flex h-40 items-center justify-center rounded-lg border text-xs"
          >
            No activity yet. Events will appear here when agents start working.
          </div>
        )}
        {activities.map((item) => {
          const cfg = getConfig(item.type)
          return (
            <div
              key={item.id}
              className="t-bg-elevated t-border-subtle rounded-lg border p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full shrink-0 ${dotClass(cfg.tone)}`}
                />
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneClass(cfg.tone)}`}>
                  {cfg.label}
                </span>
                <span className="t-text-muted text-[10px]">
                  {clock(item.timestamp)}
                </span>
              </div>
              <p className="t-text-secondary mt-1.5 text-xs">{item.summary}</p>
              {item.detail && (
                <p className="t-text-muted mt-0.5 text-[11px]">{item.detail}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
