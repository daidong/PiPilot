import React from 'react'
import { useUIStore } from '../../stores/ui-store'

const modes = ['chat', 'cowork', 'code'] as const

export function ModeToggle() {
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)

  return (
    <div className="flex rounded-lg t-bg-toggle p-0.5" role="tablist" aria-label="Interaction mode">
      {modes.map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          onClick={() => setMode(m)}
          className={`no-drag flex-1 px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
            mode === m
              ? 't-bg-toggle-active t-text-toggle-active'
              : 't-text-toggle-inactive hover:t-text'
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  )
}
