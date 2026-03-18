import React from 'react'
import { Plus } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'

export function NewTaskButton() {
  const clear = useChatStore((s) => s.clear)
  const setIdle = useUIStore((s) => s.setIdle)

  return (
    <button
      onClick={() => {
        clear()
        setIdle(true)
      }}
      className="no-drag w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm t-text-secondary hover:t-bg-elevated transition-colors"
    >
      <Plus size={16} className="t-text-accent-soft" />
      New task
    </button>
  )
}
