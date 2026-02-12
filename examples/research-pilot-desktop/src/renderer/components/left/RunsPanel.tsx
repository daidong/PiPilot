import React from 'react'
import { Activity } from 'lucide-react'
import { ContextDebugView } from './ContextDebugView'

export function RunsPanel() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b t-border">
        <Activity size={13} className="text-cyan-400" />
        <span className="text-xs font-semibold t-text">Debug</span>
      </div>

      <div className="px-3 py-2 overflow-y-auto min-h-0 flex-1 space-y-4">
        <ContextDebugView />
      </div>
    </div>
  )
}
