import React, { useState, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useToolEventsStore, type ToolEvent } from '../../stores/tool-events-store'
import { ToolUseCard } from './ToolUseCard'

/** How many completed tools to show before collapsing older ones */
const VISIBLE_COMPLETED = 3

interface ToolUseStreamProps {
  /** Optional pre-supplied events (for history replay). If omitted, reads from live store. */
  events?: ToolEvent[]
}

export function ToolUseStream({ events: propEvents }: ToolUseStreamProps) {
  const liveEvents = useToolEventsStore((s) => s.currentRunEvents)
  const events = propEvents ?? liveEvents
  const [showAll, setShowAll] = useState(false)

  // Split events: running tools always visible, completed tools may be collapsed
  const { running, completed } = useMemo(() => {
    const running: ToolEvent[] = []
    const completed: ToolEvent[] = []
    for (const e of events) {
      if (e.status === 'running') running.push(e)
      else completed.push(e)
    }
    return { running, completed }
  }, [events])

  if (events.length === 0) return null

  // Determine which completed events to show
  const hiddenCount = showAll ? 0 : Math.max(0, completed.length - VISIBLE_COMPLETED)
  const visibleCompleted = showAll ? completed : completed.slice(-VISIBLE_COMPLETED)

  return (
    <div className="my-2 max-w-[80%]">
      {/* Collapsed completed tools summary */}
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="flex items-center gap-1.5 px-2 py-1 mb-1 text-[10px] t-text-muted hover:t-text-accent-soft transition-colors rounded"
        >
          <ChevronRight size={10} />
          <span>{hiddenCount} more tool {hiddenCount === 1 ? 'call' : 'calls'}</span>
        </button>
      )}

      {/* Visible completed tools — compact inline style */}
      {visibleCompleted.length > 0 && (
        <div className="space-y-0">
          {visibleCompleted.map((event) => (
            <ToolUseCard key={event.id} event={event} compact />
          ))}
        </div>
      )}

      {/* Running tools — full card style */}
      {running.length > 0 && (
        <div className="space-y-1 mt-1">
          {running.map((event) => (
            <ToolUseCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}
