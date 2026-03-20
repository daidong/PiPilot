import React from 'react'
import { StickyNote, BarChart3, FileText, FolderOpen } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'

const actions = [
  { icon: StickyNote, label: 'Create note', prompt: 'Help me create a research note about ' },
  { icon: BarChart3, label: 'Crunch data', prompt: 'Analyze the data in ' },
  { icon: FileText, label: 'Draft outline', prompt: 'Draft a research outline for ' },
  { icon: FolderOpen, label: 'Organize files', prompt: 'Help me organize my research files in ' }
]

export function ActionGrid() {
  const send = useChatStore((s) => s.send)
  const setIdle = useUIStore((s) => s.setIdle)

  return (
    <div className="grid grid-cols-2 gap-3 w-full">
      {actions.map(({ icon: Icon, label, prompt }) => (
        <button
          key={label}
          onClick={() => {
            setIdle(false)
            send(prompt)
          }}
          className="flex items-center gap-3 px-4 py-3 rounded-xl border t-border t-bg-surface/50 hover:t-bg-elevated text-sm t-text-secondary hover:t-text transition-colors text-left"
        >
          <Icon size={18} className="t-text-accent-soft shrink-0" />
          {label}
        </button>
      ))}
    </div>
  )
}
