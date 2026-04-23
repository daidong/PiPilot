import React from 'react'
import { SegmentedControl } from './SegmentedControl'
import type { DiagramReviewProvider } from '../../../../../shared-ui/settings-types'

interface Props {
  reviewProvider: DiagramReviewProvider
  onChangeReviewProvider: (v: DiagramReviewProvider) => void
}

export function DiagramSettings({ reviewProvider, onChangeReviewProvider }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-xs font-semibold t-text mb-1.5">Generation Provider</h4>
        <p className="text-[11px] t-text-muted">
          Diagram images are generated via OpenAI <code className="font-mono">gpt-image-2</code> and require <code className="font-mono">OPENAI_API_KEY</code>.
          Claude cannot generate images, so this is fixed for now.
        </p>
      </div>

      <div>
        <h4 className="text-xs font-semibold t-text mb-1.5">Review Provider</h4>
        <p className="text-[11px] t-text-muted mb-2.5">
          Which model evaluates each draft and decides whether to accept, edit, or regenerate.
        </p>
        <SegmentedControl
          options={[
            { label: 'Auto', value: 'auto' as DiagramReviewProvider },
            { label: 'OpenAI', value: 'openai' as DiagramReviewProvider },
            { label: 'Anthropic', value: 'anthropic' as DiagramReviewProvider },
          ]}
          value={reviewProvider}
          onChange={onChangeReviewProvider}
        />
        <p className="text-[10px] t-text-muted mt-1.5">
          {reviewProvider === 'auto' && 'Prefer heterogeneous review (Anthropic when available, so the generator does not grade its own family).'}
          {reviewProvider === 'openai' && 'GPT-4o vision with JSON-schema output. Requires OPENAI_API_KEY.'}
          {reviewProvider === 'anthropic' && 'Claude Opus vision with tool-use constrained output. Requires ANTHROPIC_API_KEY.'}
        </p>
        <p className="text-[10px] t-text-muted mt-2 leading-relaxed">
          Score thresholds are calibrated per reviewer and are not directly comparable across providers.
          An 8.0 from OpenAI and an 8.0 from Claude represent similar quality targets, but the underlying
          numbers are not interchangeable.
        </p>
      </div>
    </div>
  )
}
