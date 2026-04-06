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
      className="no-drag group relative p-1.5 rounded-lg t-bg-hover transition-colors"
    >
      <Lightbulb size={16} className={COLORS[reasoningEffort]} />
      <span
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-0.5 rounded text-[10px] t-bg-elevated t-text-secondary border t-border shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 z-50"
        style={{ transition: 'opacity 0.15s ease', transitionDelay: '0.2s' }}
      >
        Reasoning: {reasoningEffort}
      </span>
    </button>
  )
}
