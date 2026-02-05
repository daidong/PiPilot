import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown, Check, Cpu } from 'lucide-react'
import { useUIStore, SUPPORTED_MODELS, type ModelOption } from '../../stores/ui-store'

// Group models by provider
const providers = [...new Set(SUPPORTED_MODELS.map((m) => m.provider))]
const groupedModels: Record<string, ModelOption[]> = {}
for (const p of providers) {
  groupedModels[p] = SUPPORTED_MODELS.filter((m) => m.provider === p)
}

export function ModelSelector() {
  const selectedModel = useUIStore((s) => s.selectedModel)
  const setModel = useUIStore((s) => s.setModel)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const current = SUPPORTED_MODELS.find((m) => m.id === selectedModel)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="no-drag flex items-center gap-1.5 px-2 py-1.5 rounded-lg t-text-secondary text-xs font-medium t-bg-hover transition-colors"
        title="Select model"
      >
        <Cpu size={14} />
        <span className="truncate max-w-[100px]">{current?.label || selectedModel}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl z-50">
          {providers.map((provider) => (
            <div key={provider}>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider t-text-muted sticky top-0 t-bg-surface">
                {provider}
              </div>
              {groupedModels[provider].map((model) => (
                <button
                  key={model.id}
                  onClick={() => {
                    setModel(model.id)
                    setOpen(false)
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors t-bg-hover ${
                    model.id === selectedModel ? 't-text' : 't-text-secondary'
                  }`}
                >
                  <span className="w-4 shrink-0">
                    {model.id === selectedModel && <Check size={14} className="text-teal-400" />}
                  </span>
                  <span className="truncate">{model.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
