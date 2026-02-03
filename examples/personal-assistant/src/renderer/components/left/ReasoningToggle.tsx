import React from 'react'
import { Lightbulb } from 'lucide-react'
import { useUIStore, GPT5_REASONING_MODELS, type ReasoningEffort } from '../../stores/ui-store'

const CYCLE: Record<ReasoningEffort, ReasoningEffort> = {
  medium: 'high',
  high: 'low',
  low: 'medium'
}

const COLORS: Record<ReasoningEffort, string> = {
  high: 'text-red-500',
  medium: 'text-blue-500',
  low: 'text-gray-400'
}

export function ReasoningToggle() {
  const selectedModel = useUIStore((s) => s.selectedModel)
  const reasoningEffort = useUIStore((s) => s.reasoningEffort)
  const setReasoningEffort = useUIStore((s) => s.setReasoningEffort)

  if (!GPT5_REASONING_MODELS.includes(selectedModel)) return null

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
