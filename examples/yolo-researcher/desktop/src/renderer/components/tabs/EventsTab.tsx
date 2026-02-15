import type { EventRecord } from '@/lib/types'

interface EventsTabProps {
  events: EventRecord[]
}

export function EventsTab({ events }: EventsTabProps) {
  return (
    <div>
      <div className="space-y-1 text-[11px] t-text-secondary">
        {events.length === 0 ? (
          <div className="t-text-muted">No events yet.</div>
        ) : events.map((event, index) => (
          <div key={`${event.at}-${index}`} className="border-b t-border-subtle pb-1">
            <div className="t-text-muted">{new Date(event.at).toLocaleTimeString()}</div>
            <div className="font-medium">{event.type}</div>
            <div>{event.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
