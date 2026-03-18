import React from 'react'
import { ProgressSteps } from '../right/ProgressSteps'
import { ActivityLog } from '../right/ActivityLog'
import { WorkingFolder } from '../right/WorkingFolder'
import { TokenUsage } from '../right/TokenUsage'

export function RightSidebar() {
  return (
    <aside className="w-80 flex flex-col border-l t-border t-bg-base pt-10">
      <div className="px-4 py-3 border-b t-border">
        <h2 className="text-xs font-semibold t-text-accent-soft uppercase tracking-wider">
          Context
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <TokenUsage />
        <WorkingFolder />
        <ProgressSteps />
        <ActivityLog />
      </div>
    </aside>
  )
}
