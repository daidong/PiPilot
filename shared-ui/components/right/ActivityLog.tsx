import React from 'react'
import { Activity, AlertCircle, CheckCircle2, Loader2, Wrench, Info } from 'lucide-react'
import { useActivityStore, type ActivityEvent } from '../../stores/activity-store'

export function ActivityLog() {
  const events = useActivityStore((s) => s.events)
  const listRef = React.useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new events
  React.useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [events.length])

  return (
    <div>
      <h3 className="text-xs font-semibold t-text-accent-soft uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Activity size={12} />
        Activity
      </h3>

      {events.length === 0 ? (
        <p className="text-xs t-text-muted">No activity yet</p>
      ) : (
        <div ref={listRef} className="space-y-1 max-h-48 overflow-y-auto" role="log" aria-label="Agent activity" aria-live="polite">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}

const EventRow = React.memo(function EventRow({ event }: { event: ActivityEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  return (
    <div className="flex items-start gap-1.5 text-xs py-0.5">
      <span className={`mt-0.5 shrink-0 ${eventColor(event)}`}>
        {eventIcon(event)}
      </span>
      <div className="min-w-0 flex-1">
        <span className={eventTextClass(event)}>
          {event.summary}
        </span>
        {event.error && (
          <p className="t-text-error-soft text-[10px] mt-0.5 truncate" title={event.error}>
            {event.error}
          </p>
        )}
      </div>
      <span className="text-[10px] t-text-muted shrink-0">{time}</span>
    </div>
  )
})

function eventIcon(event: ActivityEvent) {
  if (event.type === 'error') return <AlertCircle size={12} />
  if (event.type === 'system') return <Info size={12} />
  if (event.type === 'tool-call') return <Loader2 size={12} className="animate-spin" />
  if (event.type === 'tool-result' && event.success) return <CheckCircle2 size={12} />
  if (event.type === 'tool-result' && !event.success) return <AlertCircle size={12} />
  return <Wrench size={12} />
}

function eventColor(event: ActivityEvent) {
  if (event.type === 'error') return 't-text-error'
  if (event.type === 'system') return 't-text-accent-soft'
  if (event.type === 'tool-call') return 't-text-accent-soft'
  if (event.type === 'tool-result' && event.success) return 't-text-success'
  if (event.type === 'tool-result' && !event.success) return 't-text-error'
  return 't-text-muted'
}

function eventTextClass(event: ActivityEvent) {
  if (event.type === 'error' || (event.type === 'tool-result' && !event.success)) return 't-text-error-soft'
  if (event.type === 'system') return 't-text-accent-soft'
  if (event.type === 'tool-call') return 't-text'
  return 't-text-secondary'
}
