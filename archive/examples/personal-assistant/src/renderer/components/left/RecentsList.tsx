import React from 'react'
import { MessageSquare } from 'lucide-react'

// Placeholder — no session persistence yet; shows current session only
export function RecentsList() {
  return (
    <div className="space-y-1 pt-2">
      <h3 className="px-2 text-xs font-semibold t-text-muted uppercase tracking-wider mb-2">
        Recent
      </h3>
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md t-bg-elevated/50 text-sm t-text-secondary">
        <MessageSquare size={14} className="t-text-muted shrink-0" />
        <span className="truncate">Current session</span>
      </div>
    </div>
  )
}
