import React from 'react'
import { useUIStore } from '../../stores/ui-store'

const modes = ['chat', 'cowork', 'code'] as const

export function ModeToggle() {
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)

  return (
    <div className="flex rounded-lg bg-neutral-900 p-0.5">
      {modes.map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`no-drag flex-1 px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
            mode === m
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:text-neutral-200'
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  )
}
