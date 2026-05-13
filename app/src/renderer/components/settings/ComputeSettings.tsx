import React from 'react'
import type { ModalComputeSettings } from '../../../../../shared-ui/settings-types'

interface Props {
  modalCompute: ModalComputeSettings
  onChange: (settings: ModalComputeSettings) => void
}

export function ComputeSettings({ modalCompute, onChange }: Props) {
  return (
    <div className="rounded-lg border t-border t-bg-surface/50 p-3">
      <label className="block text-xs font-medium t-text mb-1.5">
        Auto-kill threshold (USD)
      </label>
      <input
        type="number"
        min={0.1}
        step={0.5}
        value={modalCompute.costThresholdUsd}
        onChange={(e) => onChange({ costThresholdUsd: Math.max(0.1, Number(e.target.value) || 0.1) })}
        className="w-32 text-xs px-2.5 py-1.5 rounded-md border t-border t-bg-base t-text font-mono focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />
      <p className="text-[11px] t-text-muted mt-1">
        Modal runs are stopped when elapsed estimated GPU cost crosses this amount.
      </p>
    </div>
  )
}
