import React from 'react'
import { Loader2 } from 'lucide-react'
import { useActivityStore } from '../../stores/activity-store'

export function ProgressCard() {
  const events = useActivityStore((s) => s.events)
  // Find the latest tool-call (in-progress activity) or fall back to the last event
  const latest = [...events].reverse().find(e => e.type === 'tool-call') || events[events.length - 1]
  const activity = latest?.summary || ''

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl t-bg-surface border t-border">
      <Loader2 size={16} className="text-orange-400 animate-spin shrink-0" />
      <span className="text-sm t-text-secondary whitespace-nowrap">Thinking...</span>
      {activity && (
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <div className="flex-1 h-px t-border border-t" />
          <span className="text-xs t-text-muted whitespace-nowrap truncate max-w-[60%]">{activity}</span>
          <div className="flex-1 h-px t-border border-t" />
        </div>
      )}
      {!activity && (
        <div className="flex-1 h-1 rounded-full t-bg-elevated overflow-hidden">
          <div className="h-full bg-orange-500/60 rounded-full animate-pulse w-2/3" />
        </div>
      )}
    </div>
  )
}
