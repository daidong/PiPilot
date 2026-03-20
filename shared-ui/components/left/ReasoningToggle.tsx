import React from 'react'
import { Lightbulb } from 'lucide-react'
import { REASONING_MODELS } from '../../constants'
import type { ReasoningEffort } from '../../types'

const CYCLE: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'medium',
  medium: 'high',
  high: 'max',
  max: 'low'
}

const COLORS: Record<ReasoningEffort, string> = {
  max: 't-text-accent',
  high: 't-text-error',
  medium: 't-text-info',
  low: 't-text-muted'
}

interface Props {
  selectedModel: string
  reasoningEffort: ReasoningEffort
  onChangeEffort: (effort: ReasoningEffort) => void
}

export function ReasoningToggle({ selectedModel, reasoningEffort, onChangeEffort }: Props) {
  if (!REASONING_MODELS.includes(selectedModel)) return null

  return (
    <button
      onClick={() => onChangeEffort(CYCLE[reasoningEffort])}
      className="no-drag p-1.5 rounded-lg t-bg-hover transition-colors"
      title={`Reasoning: ${reasoningEffort}`}
    >
      <Lightbulb size={16} className={COLORS[reasoningEffort]} />
    </button>
  )
}
