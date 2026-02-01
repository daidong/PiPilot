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
      className="no-drag w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-neutral-300 hover:bg-neutral-800 transition-colors"
    >
      <Plus size={16} />
      New task
    </button>
  )
}
