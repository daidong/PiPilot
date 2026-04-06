/**
 * ComputeSidebar — left panel for the Compute tab.
 *
 * Shows compute target environment. Follows LiteratureSidebar patterns.
 */

import React, { useState } from 'react'
import { Monitor, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useComputeStore, useActiveRunCount } from '../../stores/compute-store'

function ResourceBar({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] t-text-muted w-11 text-right shrink-0">{label}</span>
      <div className="flex-1 h-1 rounded-full t-bg-elevated overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${clamped > 85 ? '' : 't-gradient-accent-h'}`}
          style={{
            width: `${clamped}%`,
            ...(clamped > 85 ? { background: 'var(--color-text-muted)', opacity: 0.6 } : { opacity: 0.5 }),
          }}
        />
      </div>
      <span className="text-[10px] t-text-muted tabular-nums w-7 shrink-0">{clamped}%</span>
    </div>
  )
}

function SandboxExplanation({ environment }: { environment: NonNullable<ReturnType<typeof useComputeStore.getState>['environment']> }) {
  const [expanded, setExpanded] = useState(false)
  const isDocker = environment.sandbox === 'docker'
  const isMac = environment.os === 'darwin'
  const hasMLX = environment.mlxAvailable

  // Determine the explanation based on detected environment
  let explanation: string
  if (isDocker && isMac) {
    explanation = 'Docker available. Note: Docker on macOS lacks GPU passthrough. Switch to Process sandbox for MLX/Metal GPU access if needed.'
  } else if (isDocker) {
    explanation = 'Docker available. Runs execute in isolated containers with resource limits.'
  } else if (isMac && hasMLX) {
    explanation = 'Process sandbox uses Python virtual environments with process-group isolation. Direct MLX/Metal GPU access for ML training.'
  } else if (isMac) {
    explanation = 'Process sandbox uses Python virtual environments. Install Docker for stronger container-based isolation.'
  } else {
    explanation = 'Process sandbox uses Python virtual environments with process-group isolation.'
  }

  return (
    <div className="mt-2 pt-2 border-t t-border-subtle">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] t-text-muted hover:t-text-secondary transition-colors w-full text-left"
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>Sandbox: <span className="t-text-secondary">{isDocker ? 'Docker' : 'Process (venv)'}</span></span>
      </button>
      {expanded && (
        <p className="mt-1.5 ml-3.5 text-[10px] t-text-muted leading-relaxed">
          {explanation}
        </p>
      )}
    </div>
  )
}

export function ComputeSidebar() {
  const environment = useComputeStore((s) => s.environment)
  const activeCount = useActiveRunCount()

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Target section */}
      <div className="px-2 pt-2 pb-2">
        <p className="text-[10px] t-text-accent-soft uppercase tracking-wider px-3 pb-1.5 font-medium">
          Compute Target
        </p>

        {environment ? (
          <div className="px-3 py-2.5 rounded-lg t-bg-surface border t-border-subtle">
            {/* Header */}
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                activeCount > 0
                  ? 'bg-[var(--color-accent)]'
                  : 'bg-[var(--color-text-muted)]'
              }`} style={{ opacity: activeCount > 0 ? 1 : 0.5 }} />
              <span className="text-xs t-text font-medium">Local Machine</span>
            </div>

            {/* Specs */}
            <div className="text-[10px] t-text-muted leading-relaxed space-y-0.5">
              <div>{environment.gpu || `${environment.os} ${environment.arch}`} &middot; {Math.round(environment.totalMemoryMb / 1024)} GB</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span>Python</span>
                {environment.mlxAvailable && (
                  <span className="px-1 py-px rounded text-[9px] bg-[var(--color-accent-soft)]/10 t-text-accent">MLX</span>
                )}
                {environment.sandbox === 'docker' && (
                  <span className="px-1 py-px rounded text-[9px] t-bg-elevated t-text-muted">Docker</span>
                )}
              </div>
            </div>

            {/* Resource bars */}
            {(environment.freeMemoryMb !== undefined || environment.freeDiskMb !== undefined) && (
              <div className="mt-2.5 space-y-1.5">
                {environment.freeMemoryMb !== undefined && (
                  <ResourceBar
                    label="Memory"
                    percent={Math.round((1 - environment.freeMemoryMb / environment.totalMemoryMb) * 100)}
                  />
                )}
              </div>
            )}

            {/* Sandbox explanation */}
            <SandboxExplanation environment={environment} />

            {/* Status */}
            <div className="mt-2 pt-2 border-t t-border-subtle text-[10px] t-text-muted">
              {activeCount > 0 ? (
                <span>{activeCount} running</span>
              ) : (
                <span>Ready</span>
              )}
            </div>
          </div>
        ) : (
          <div className="px-3 py-4 rounded-lg t-bg-surface border t-border-subtle">
            <div className="flex items-center gap-2 t-text-muted">
              <Monitor size={14} className="opacity-40" />
              <span className="text-[11px]">Detecting environment...</span>
            </div>
          </div>
        )}

        {/* Future target placeholder */}
        <div className="mt-1.5 px-3 py-2 rounded-lg border border-dashed t-border-subtle cursor-default">
          <span className="text-[10px] t-text-muted opacity-60">+ Add remote target</span>
        </div>
      </div>

      <div className="mx-3 border-t t-border" />

      {/* Info area */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="flex items-start gap-2 text-[10px] t-text-muted leading-relaxed">
          <Info size={12} className="shrink-0 mt-0.5 opacity-40" />
          <p>
            Ask the agent to run scripts, train models, or process data.
            Code executes in a sandboxed environment with progress tracking and failure analysis.
          </p>
        </div>
      </div>
    </div>
  )
}
