/**
 * ComputeSidebar — left panel for the Compute tab.
 *
 * RFC-008 §7.6: iterates registered backends from `compute-store.backends`
 * instead of hardcoding Local + Modal cards. Each backend's card shows
 * its display name, capabilities badges, availability state, and running
 * count for that backend.
 */

import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Info, Cloud, Cpu, AlertTriangle, CircleAlert, RefreshCw } from 'lucide-react'
import { useComputeStore, type BackendView, type ComputeRunView } from '../../stores/compute-store'

const api = (window as any).api

interface BackendCardProps {
  backend: BackendView
  runningCount: number
  pendingPlanCount: number
}

function backendIcon(id: string) {
  // Cloud-ish backends get the Cloud icon; everything else is a Cpu chip.
  // Cheap heuristic — fine until we get specialized renderers.
  if (id === 'modal' || id.includes('aws') || id.includes('gcp') || id.includes('cloud')) return Cloud
  return Cpu
}

function statusDescriptor(backend: BackendView, runningCount: number) {
  const availability = backend.availability
  if (!availability) {
    return { dot: 'bg-[var(--color-text-muted)]', text: 'Checking…', dim: true }
  }
  if (!availability.available) {
    // Pick the most actionable hint or fall back to the first missing
    // requirement so users see a concrete reason.
    const hint = availability.hints?.[0]
    const missing = availability.missingRequirements?.[0]
    const text = hint ?? missing ?? 'Unavailable'
    const isWarning = availability.missingRequirements?.length === 1
    return {
      dot: isWarning ? 'bg-amber-500' : 'bg-red-500',
      text,
      dim: false,
    }
  }
  if (runningCount > 0) {
    // Active: pulsing accent so the sidebar reads "work in progress".
    return { dot: 'bg-[var(--color-accent)] animate-pulse', text: `${runningCount} running`, dim: false }
  }
  // Idle but healthy. The muted+dim variant we used here before read as
  // "off / unavailable" next to the red/amber failure states, which is
  // why both backends looked broken even when their text said Ready.
  return { dot: 'bg-emerald-500', text: 'Ready', dim: false }
}

function BackendCard({ backend, runningCount, pendingPlanCount }: BackendCardProps) {
  const [showRequirements, setShowRequirements] = useState(false)
  const Icon = backendIcon(backend.id)
  const status = statusDescriptor(backend, runningCount)
  const caps = backend.capabilities
  const missing = backend.availability?.missingRequirements ?? []

  return (
    <div className="mt-1.5 px-3 py-2.5 rounded-lg t-bg-surface border t-border-subtle">
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`}
          style={{ opacity: status.dim ? 0.5 : 1 }}
        />
        <Icon size={13} className="t-text-muted" />
        <span className="text-xs t-text font-medium">{backend.displayName}</span>
        {pendingPlanCount > 0 && (
          <span className="ml-auto px-1.5 py-0.5 rounded text-[9px] bg-[var(--color-accent-soft)]/15 t-text-accent animate-pulse">
            approval
          </span>
        )}
      </div>

      <div className="text-[10px] t-text-muted leading-relaxed">
        <div>{status.text}</div>
        {caps && (
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            {caps.supportsGpu && (
              <span className="px-1 py-px rounded text-[9px] bg-[var(--color-accent-soft)]/10 t-text-accent">GPU</span>
            )}
            {caps.hasCost && (
              <span className="px-1 py-px rounded text-[9px] t-bg-elevated t-text-muted">$$</span>
            )}
            {caps.requiresApproval && (
              <span className="px-1 py-px rounded text-[9px] t-bg-elevated t-text-muted">approval</span>
            )}
          </div>
        )}
      </div>

      {missing.length > 0 && (
        <div className="mt-2 pt-2 border-t t-border-subtle">
          <button
            onClick={() => setShowRequirements(!showRequirements)}
            className="flex items-center gap-1 text-[10px] t-text-muted hover:t-text-secondary transition-colors w-full text-left"
          >
            {showRequirements ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <span>
              {missing.length === 1
                ? '1 requirement missing'
                : `${missing.length} requirements missing`}
            </span>
          </button>
          {showRequirements && (
            <ul className="mt-1.5 ml-3.5 text-[10px] t-text-muted leading-relaxed space-y-1 list-none">
              {missing.map((m, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <CircleAlert size={10} className="shrink-0 mt-px opacity-50" />
                  <span>{m}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export function ComputeSidebar() {
  const backends = useComputeStore((s) => s.backends)
  const runs = useComputeStore((s) => s.runs)
  const pendingPlans = useComputeStore((s) => s.pendingPlans)

  const backendList = Array.from(backends.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  )

  const runningByBackend = new Map<string, number>()
  for (const run of runs.values()) {
    if (run.status === 'running' || run.status === 'stalled' || run.status === 'queued') {
      runningByBackend.set(run.backend, (runningByBackend.get(run.backend) ?? 0) + 1)
    }
  }

  const pendingByBackend = new Map<string, number>()
  for (const plan of pendingPlans.values()) {
    if (!plan.approved && !plan.rejectedAt) {
      pendingByBackend.set(plan.backend, (pendingByBackend.get(plan.backend) ?? 0) + 1)
    }
  }

  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const refresh = async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const result = await api?.refreshComputeAvailability?.()
      if (!result?.success && result?.error) setRefreshError(result.error)
    } catch (err: any) {
      setRefreshError(err?.message || 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-2 pt-2 pb-2">
        <div className="flex items-center justify-between px-3 pb-1.5">
          <p className="text-[10px] t-text-accent-soft uppercase tracking-wider font-medium">
            Compute Target
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Re-probe backend availability"
            title="Re-probe availability (Docker, Modal credentials, …)"
            className="t-text-muted hover:t-text disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        {refreshError && (
          <p className="px-3 pb-1.5 text-[10px] text-red-500">{refreshError}</p>
        )}

        {backendList.length === 0 ? (
          <div className="px-3 py-4 rounded-lg t-bg-surface border t-border-subtle">
            <div className="flex items-start gap-2 t-text-muted">
              <AlertTriangle size={14} className="opacity-40 shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed">
                <div>Compute backends are initializing…</div>
                <div className="mt-1 t-text-muted/70">
                  If this persists, open a project folder or check the chat for an
                  agent-init error (e.g. missing API key).
                </div>
              </div>
            </div>
          </div>
        ) : (
          backendList.map((backend) => (
            <BackendCard
              key={backend.id}
              backend={backend}
              runningCount={runningByBackend.get(backend.id) ?? 0}
              pendingPlanCount={pendingByBackend.get(backend.id) ?? 0}
            />
          ))
        )}
      </div>

      <div className="mx-3 border-t t-border" />

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

// Re-export ComputeRunView for any consumers that destructure from here.
export type { ComputeRunView }
