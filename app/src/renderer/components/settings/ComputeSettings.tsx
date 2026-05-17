import React from 'react'
import type { ComputeSettings as ComputeSettingsShape } from '../../../../../shared-ui/settings-types'

interface Props {
  compute: ComputeSettingsShape
  onChange: (settings: ComputeSettingsShape) => void
}

/**
 * Settings UI surface for compute backends (RFC-008 §7.7). Surfaces
 * the global force-approval override + the Modal cost threshold.
 * Per-backend pickers for AWS/GCP/etc. will be added as those
 * backends land.
 */
export function ComputeSettings({ compute, onChange }: Props) {
  const modalThreshold = compute.backends.modal?.costThresholdUsd ?? 5
  const updateModalThreshold = (v: number) => {
    onChange({
      ...compute,
      backends: {
        ...compute.backends,
        modal: { ...compute.backends.modal, costThresholdUsd: v },
      },
    })
  }
  const toggleForceApproval = (v: boolean) => {
    onChange({ ...compute, requireApprovalForAllBackends: v })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border t-border t-bg-surface/50 p-3">
        <label className="block text-xs font-medium t-text mb-1.5">
          Modal auto-kill threshold (USD)
        </label>
        <input
          type="number"
          min={0.1}
          step={0.5}
          value={modalThreshold}
          onChange={(e) => updateModalThreshold(Math.max(0.1, Number(e.target.value) || 0.1))}
          className="w-32 text-xs px-2.5 py-1.5 rounded-md border t-border t-bg-base t-text font-mono focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        />
        <p className="text-[11px] t-text-muted mt-1">
          Modal runs are stopped when elapsed estimated GPU cost crosses this amount.
        </p>
      </div>

      <div className="rounded-lg border t-border t-bg-surface/50 p-3">
        <label className="flex items-center gap-2 text-xs font-medium t-text cursor-pointer">
          <input
            type="checkbox"
            checked={compute.requireApprovalForAllBackends}
            onChange={(e) => toggleForceApproval(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Require approval for every compute backend
        </label>
        <p className="text-[11px] t-text-muted mt-1">
          When enabled, even local-compute plans must be approved in the Compute tab
          before <code>local_execute</code> runs. Useful on shared machines or
          audit-compliance contexts.
        </p>
      </div>
    </div>
  )
}
