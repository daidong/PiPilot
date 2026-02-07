import React from 'react'
import { Lightbulb } from 'lucide-react'
import { useUIStore, REASONING_MODELS, type ReasoningEffort } from '../../stores/ui-store'

const CYCLE: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'medium',
  medium: 'high',
  high: 'max',
  max: 'low'
}

const COLORS: Record<ReasoningEffort, string> = {
  max: 'text-purple-500',
  high: 'text-red-500',
  medium: 'text-blue-500',
  low: 'text-gray-400'
}

export function ReasoningToggle() {
  const selectedModel = useUIStore((s) => s.selectedModel)
  const reasoningEffort = useUIStore((s) => s.reasoningEffort)
  const setReasoningEffort = useUIStore((s) => s.setReasoningEffort)

  if (!REASONING_MODELS.includes(selectedModel)) return null

  return (
    <button
      onClick={() => setReasoningEffort(CYCLE[reasoningEffort])}
      className="no-drag p-1.5 rounded-lg t-bg-hover transition-colors"
      title={`Reasoning: ${reasoningEffort}`}
    >
      <Lightbulb size={16} className={COLORS[reasoningEffort]} />
    </button>
  )
}
