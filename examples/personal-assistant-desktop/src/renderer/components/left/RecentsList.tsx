import React from 'react'
import { MessageSquare } from 'lucide-react'

// Placeholder — no session persistence yet; shows current session only
export function RecentsList() {
  return (
    <div className="space-y-1 pt-2">
      <h3 className="px-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
        Recent
      </h3>
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-neutral-800/50 text-sm text-neutral-300">
        <MessageSquare size={14} className="text-neutral-500 shrink-0" />
        <span className="truncate">Current session</span>
      </div>
    </div>
  )
}
