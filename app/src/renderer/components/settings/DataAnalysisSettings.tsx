import React from 'react'
import { SegmentedControl } from './SegmentedControl'
import type { DataAnalysisTimeout } from '../../../../../shared-ui/settings-types'

interface Props {
  executionTimeLimit: DataAnalysisTimeout
  onChange: (v: DataAnalysisTimeout) => void
}

export function DataAnalysisSettings({ executionTimeLimit, onChange }: Props) {
  return (
    <div className="space-y-7">
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Execution Time Limit</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Maximum time allowed for Python data analysis scripts to run before timeout.
        </p>
        <SegmentedControl
          options={[
            { label: '1 min', value: 'short' as DataAnalysisTimeout },
            { label: '2 min', value: 'standard' as DataAnalysisTimeout },
            { label: '5 min', value: 'extended' as DataAnalysisTimeout },
            { label: '10 min', value: 'long' as DataAnalysisTimeout },
          ]}
          value={executionTimeLimit}
          onChange={onChange}
        />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">
          {executionTimeLimit === 'short' && 'Quick timeout for simple analyses.'}
          {executionTimeLimit === 'standard' && 'Suitable for most data analysis tasks.'}
          {executionTimeLimit === 'extended' && 'For larger datasets or complex computations.'}
          {executionTimeLimit === 'long' && 'For very large datasets or intensive modeling tasks.'}
        </p>
      </div>
    </div>
  )
}
