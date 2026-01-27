import React from 'react'
import { Loader2 } from 'lucide-react'

export function ProgressCard() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl t-bg-surface border t-border">
      <Loader2 size={16} className="text-orange-400 animate-spin" />
      <span className="text-sm t-text-secondary">Thinking...</span>
      <div className="flex-1 h-1 rounded-full t-bg-elevated overflow-hidden">
        <div className="h-full bg-orange-500/60 rounded-full animate-pulse w-2/3" />
      </div>
    </div>
  )
}
