/**
 * ComputeView — center panel for the Compute tab.
 *
 * Follows LiteratureView patterns: filter bar, expandable rows, coverage footer.
 * Four states in priority: active runs > history > empty.
 */

import React, { useEffect, useState, useMemo } from 'react'
import {
  Cpu,
  Cloud,
  Search,
  ChevronRight,
  ChevronDown,
  RotateCcw,
  X
} from 'lucide-react'
import { useComputeStore, useActiveRuns, useRecentRuns, usePendingModalPlan } from '../../stores/compute-store'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import type { ComputeRunView, ModalImageView } from '../../stores/compute-store'

const api = (window as any).api

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '--'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '$--'
  return `$${value.toFixed(digits)}`
}

function formatPlanMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '~--'
  if (minutes < 1) return '<1 min'
  return `~${Math.round(minutes)} min`
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '--'
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) > 0 && Math.abs(value) < 0.01) return value.toExponential(2)
  return value.toFixed(4)
}

function formatCostSummary(run: ComputeRunView): string | null {
  if (run.estimatedCostUsd === undefined) return null
  const cost = formatMoney(run.estimatedCostUsd, 4)
  return run.costThresholdUsd !== undefined
    ? `${cost} of ${formatMoney(run.costThresholdUsd, 2)}`
    : cost
}

function formatList(values?: string[], empty = 'none'): string {
  return values?.length ? values.join(', ') : empty
}

function modalImageSourceLabel(image?: ModalImageView): string {
  if (!image) return '--'
  const source = (image as any).source
  if (source === 'script') return 'Script declared'
  if (source === 'modal_default') return 'Modal default'
  return 'Unknown'
}

function modalImageGpuLabel(image?: ModalImageView): string {
  return image?.gpuType ?? 'CPU'
}

function formatActivityLabel(run: ComputeRunView): string {
  if (run.stalled || run.status === 'stalled') return 'Stalled'
  if (run.status !== 'running') return STATUS_LABELS[run.status] ?? run.status
  if ((run.outputLines > 0 || run.outputBytes > 0) && run.lastOutputAt) return `Output ${timeAgo(run.lastOutputAt)}`
  if (run.outputLines > 0) return `${run.outputLines} lines`
  return 'No output yet'
}

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  stalled: 'Stalled',
  completed: 'Completed',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
  cost_killed: 'Cost killed',
}

// ─── Status indicator (small dot, follows accent system) ─────────────────────

function StatusDot({ status }: { status: string }) {
  const isActive = status === 'running'
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
      isActive ? 'bg-[var(--color-accent)]' : 't-bg-elevated'
    }`} style={isActive ? {} : { opacity: 0.8 }} />
  )
}

// ─── Progress bar (uses accent gradient, same as Literature coverage) ────────

function ProgressBar({ percentage }: { percentage: number }) {
  const value = Math.min(100, Math.max(0, percentage || 0))
  return (
    <div className="h-1 rounded-full t-bg-elevated overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700 t-gradient-accent-h"
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] t-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-[11px] t-text-secondary mt-0.5 break-words ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </div>
  )
}

function ModalDisclosureSection({
  label,
  defaultExpanded = false,
  children,
}: {
  label: string
  defaultExpanded?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultExpanded)
  return (
    <div className="border-t t-border-subtle first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-2 text-[11px] font-medium t-text-secondary hover:t-text"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
      </button>
      {open && <div className="pl-5 pb-3">{children}</div>}
    </div>
  )
}

function ModalRunActiveSummary({ run, hasProgress }: { run: ComputeRunView; hasProgress: boolean }) {
  const cost = formatCostSummary(run)
  return (
    <div className="px-10 pb-2">
      {hasProgress ? (
        <ProgressBar percentage={run.progress!.percentage!} />
      ) : (
        <div className="h-1 rounded-full t-bg-elevated overflow-hidden">
          <div className="h-full w-1/3 rounded-full animate-pulse t-gradient-accent-h opacity-30" />
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2">
        <DetailField label="Phase" value={run.progress?.phase ?? run.currentPhase ?? 'Modal'} />
        <DetailField label="Elapsed" value={formatDuration(run.elapsedSeconds)} />
        <DetailField label="Cost so far" value={cost ?? '--'} />
        <DetailField label="Output" value={`${formatBytes(run.outputBytes)} · ${run.outputLines} lines`} />
        <DetailField label="Last output" value={(run.outputLines > 0 || run.outputBytes > 0) && run.lastOutputAt ? timeAgo(run.lastOutputAt) : 'No output yet'} />
      </div>
      {(hasProgress || run.progress?.currentStep !== undefined || run.progress?.etaSeconds !== undefined) && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {hasProgress && (
            <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-secondary">
              <span className="t-text-muted">Progress</span> {run.progress!.percentage}%
            </span>
          )}
          {run.progress?.currentStep !== undefined && run.progress?.totalSteps !== undefined && (
            <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-secondary">
              <span className="t-text-muted">Step</span> {run.progress.currentStep}/{run.progress.totalSteps}
            </span>
          )}
          {run.progress?.etaSeconds !== undefined && (
            <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-secondary">
              <span className="t-text-muted">ETA</span> {formatDuration(run.progress.etaSeconds)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ModalRunDetails({
  run,
  hasMetrics,
  sendToChat,
}: {
  run: ComputeRunView
  hasMetrics: boolean
  sendToChat: (text: string) => void
}) {
  const gpuLabel = modalImageGpuLabel(run.image)
  const cost = formatCostSummary(run)
  const showFailure = !!run.failure || run.stalled || run.status === 'stalled'

  return (
    <div className="px-10 pb-3">
      <div className="rounded-md border t-border-subtle px-2">
        <ModalDisclosureSection label="Run" defaultExpanded={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <DetailField label="Run ID" value={run.runId} mono />
            <DetailField label="Plan ID" value={run.planId ?? '--'} mono />
            <DetailField label="Command" value={run.command || '--'} mono />
            <DetailField label="Script" value={run.scriptPath ?? '--'} mono />
            <DetailField label="Started" value={formatTimestamp(run.startedAt)} />
            <DetailField label="Timeout" value={run.timeoutMs ? formatDuration(run.timeoutMs / 1000) : '--'} />
            <DetailField label="Stall threshold" value={run.stallThresholdMs ? formatDuration(run.stallThresholdMs / 1000) : '--'} />
            <DetailField label="Retry" value={run.parentRunId ? `Retry of ${run.parentRunId}` : 'Original run'} />
          </div>
        </ModalDisclosureSection>

        <ModalDisclosureSection label="Cost" defaultExpanded={run.status === 'cost_killed'}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <DetailField label="Cost so far" value={cost ?? '--'} />
            <DetailField label="Estimated total" value={run.costEstimate ? formatMoney(run.costEstimate.estimatedTotalUsd, 2) : '--'} />
            <DetailField label="GPU rate" value={run.costEstimate ? `${formatMoney(run.costEstimate.gpuRateUsdPerHour, 2)}/hr` : '--'} />
            <DetailField label="Auto-kill threshold" value={run.costThresholdUsd !== undefined ? formatMoney(run.costThresholdUsd, 2) : '--'} />
          </div>
          {run.costEstimate?.notes && (
            <p className="mt-2 rounded-md t-bg-elevated px-2 py-1.5 text-[11px] t-text-muted leading-relaxed">
              {run.costEstimate.notes}
            </p>
          )}
        </ModalDisclosureSection>

        <ModalDisclosureSection label="Environment">
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <DetailField label="Target" value="Modal" />
              <DetailField label="Image source" value={modalImageSourceLabel(run.image)} />
              <DetailField label="GPU" value={gpuLabel} />
              <DetailField label="Python" value={run.image?.pythonVersion ?? '--'} />
              <DetailField label="Base image" value={run.image?.baseImage ?? '--'} mono />
            </div>
            <DetailField label="Python packages" value={formatList(run.image?.pythonPackages)} />
            <DetailField label="Package installers" value={formatList(run.image?.pythonPackageInstallers)} />
            <DetailField label="System packages" value={formatList(run.image?.systemPackages)} />
            {!!run.image?.envVars?.length && <DetailField label="Environment vars" value={formatList(run.image.envVars)} />}
            {!!run.image?.localDirs?.length && <DetailField label="Local dirs" value={formatList(run.image.localDirs)} />}
            {!!run.image?.localFiles?.length && <DetailField label="Local files" value={formatList(run.image.localFiles)} />}
            {!!run.image?.localPythonSources?.length && <DetailField label="Local Python source" value={formatList(run.image.localPythonSources)} />}
            {!!run.image?.buildCommands?.length && <DetailField label="Build commands" value={formatList(run.image.buildCommands)} />}
            {!!run.image?.buildFunctions?.length && <DetailField label="Build functions" value={formatList(run.image.buildFunctions)} />}
            {run.image?.buildGpuType && <DetailField label="Build GPU" value={run.image.buildGpuType} />}
            {run.image?.runtimeGpuType && <DetailField label="Runtime GPU" value={run.image.runtimeGpuType} />}
            {run.image?.forceBuild && <DetailField label="Force build" value="yes" />}
            {!!run.image?.warnings?.length && (
              <div className="space-y-1">
                {run.image.warnings.map((warning, i) => (
                  <p key={i} className="rounded-md t-bg-elevated px-2 py-1.5 text-[11px] t-text-muted leading-relaxed">
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </div>
        </ModalDisclosureSection>

        <ModalDisclosureSection label="Progress" defaultExpanded={!!run.progress && run.status !== 'running'}>
          {run.progress ? (
            <div className="space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <DetailField label="Phase" value={run.progress.phase ?? run.currentPhase ?? '--'} />
                <DetailField label="Percentage" value={run.progress.percentage !== undefined ? `${run.progress.percentage}%` : '--'} />
                <DetailField
                  label="Step"
                  value={run.progress.currentStep !== undefined && run.progress.totalSteps !== undefined
                    ? `${run.progress.currentStep}/${run.progress.totalSteps}`
                    : '--'}
                />
                <DetailField label="ETA" value={run.progress.etaSeconds !== undefined ? formatDuration(run.progress.etaSeconds) : '--'} />
              </div>
              {hasMetrics && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                  {Object.entries(run.progress.metrics!).map(([key, val]) => (
                    <DetailField key={key} label={key} value={formatMetricValue(val)} mono />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] t-text-muted">No structured progress has been reported yet.</p>
          )}
        </ModalDisclosureSection>

        <ModalDisclosureSection label="Logs" defaultExpanded={!!run.failure}>
          {run.outputTail ? (
            <pre className="p-2 rounded t-bg-elevated text-[10px] t-text-secondary font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {run.outputTail.slice(-2048)}
            </pre>
          ) : (
            <p className="text-[11px] t-text-muted">No logs captured yet.</p>
          )}
        </ModalDisclosureSection>

        {showFailure && (
          <ModalDisclosureSection label="Failure" defaultExpanded>
            <div className="text-xs t-text-secondary leading-relaxed space-y-2">
              {run.failure ? (
                <>
                  <p className="font-medium">{run.failure.code}: {run.failure.message}</p>
                  {run.failure.suggestions.length > 0 && (
                    <ul className="space-y-0.5">
                      {run.failure.suggestions.map((s, i) => (
                        <li key={i} className="flex items-start gap-1.5 t-text-muted">
                          <span className="shrink-0 mt-1.5 w-1 h-1 rounded-full t-bg-elevated" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="font-medium">No output has been captured within the stall threshold.</p>
              )}
              {(run.failure?.retryable || run.stalled) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    sendToChat(`Modal compute run ${run.runId} needs attention. Please review the output and fix the code, then retry.`)
                  }}
                  className="text-[10px] t-text-accent hover:underline"
                >
                  Fix & retry in chat
                </button>
              )}
            </div>
          </ModalDisclosureSection>
        )}
      </div>
    </div>
  )
}

// ─── Run row (expandable, follows PaperRow pattern) ──────────────────────────

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: ComputeRunView
  expanded: boolean
  onToggle: () => void
}) {
  const isActive = run.status === 'running' || run.status === 'stalled'
  const hasProgress = run.progress?.percentage !== undefined
  const setCenterView = useUIStore((s) => s.setCenterView)

  const sendToChat = (text: string) => {
    setCenterView('chat')
    setTimeout(() => {
      const inputEl = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
      if (inputEl) {
        inputEl.value = text
        inputEl.focus()
        inputEl.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, 100)
  }

  const hasMetrics = run.progress?.metrics && Object.keys(run.progress.metrics).length > 0
  const isModal = run.target === 'modal'
  const modalGpuLabel = modalImageGpuLabel(run.image)
  const modalCost = formatCostSummary(run)
  const primaryText = isModal ? (run.taskDescription?.trim() || run.command) : run.command

  return (
    <div className="border-b t-border last:border-b-0">
      {/* Compact row */}
      <div
        className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-accent-soft)]/5 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <button
          type="button"
          aria-label={expanded ? 'Collapse run details' : 'Expand run details'}
          aria-expanded={expanded}
          className="shrink-0 t-text-muted"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <StatusDot status={run.status} />

        {/* Command + meta */}
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] t-text font-medium truncate leading-tight ${isModal ? '' : 'font-mono'}`}>
            {primaryText}
          </p>
          {isModal ? (
            <p className="text-[11px] t-text-muted truncate mt-0.5">
              Modal
              {modalGpuLabel !== 'Modal' && <> &middot; {modalGpuLabel}</>}
              <> &middot; {STATUS_LABELS[run.status] ?? run.status}</>
              {modalCost && <> &middot; {modalCost}</>}
              {run.failure && <> &middot; {run.failure.code}</>}
            </p>
          ) : (
            <p className="text-[11px] t-text-muted truncate mt-0.5">
              {run.runId}
              {run.status !== 'running' && run.status !== 'stalled' && (
                <> &middot; {STATUS_LABELS[run.status] ?? run.status}</>
              )}
              {run.stalled && <> &middot; <span className="t-text-accent-soft">stalled — no output for a while</span></>}
              {run.failure && <> &middot; {run.failure.code}</>}
              {run.parentRunId && <> &middot; retry</>}
            </p>
          )}
        </div>

        {/* Duration */}
        <span className="shrink-0 text-[11px] t-text-muted tabular-nums w-14 text-right">
          {formatDuration(run.elapsedSeconds)}
        </span>

        {/* Time ago or phase */}
        <span className={`shrink-0 text-[11px] t-text-muted text-right ${isModal ? 'w-24' : 'w-14'}`}>
          {isModal ? formatActivityLabel(run) : isActive ? run.currentPhase : (run.startedAt ? timeAgo(run.startedAt) : '--')}
        </span>
      </div>

      {/* Progress section for active runs — always visible (not inside expanded) */}
      {isActive && (
        isModal ? (
          <ModalRunActiveSummary run={run} hasProgress={hasProgress} />
        ) : (
          <div className="px-10 pb-1.5">
            {/* Progress bar: determinate if we have percentage, indeterminate pulse if not */}
            {hasProgress ? (
              <ProgressBar percentage={run.progress!.percentage!} />
            ) : (
              <div className="h-1 rounded-full t-bg-elevated overflow-hidden">
                <div className="h-full w-1/3 rounded-full animate-pulse t-gradient-accent-h opacity-30" />
              </div>
            )}
            <div className="flex items-center gap-3 mt-1 text-[10px] t-text-muted">
              {hasProgress && <span>{run.progress!.percentage}%</span>}
              {run.progress?.currentStep !== undefined && run.progress?.totalSteps !== undefined && (
                <span>Step {run.progress.currentStep}/{run.progress.totalSteps}</span>
              )}
              {run.progress?.phase && <span>{run.progress.phase}</span>}
              {run.progress?.etaSeconds !== undefined && (
                <span>ETA {formatDuration(run.progress.etaSeconds)}</span>
              )}
              {run.startedAt && <span>started {timeAgo(run.startedAt)}</span>}
              {run.outputLines > 0 && <span>{run.outputLines} lines</span>}
            </div>
            {/* Key metrics shown inline for active runs (most important data) */}
            {hasMetrics && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {Object.entries(run.progress!.metrics!).map(([key, val]) => (
                  <span key={key} className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-secondary font-mono">
                    <span className="t-text-muted">{key}</span> {typeof val === 'number' ? (val < 0.01 ? val.toExponential(2) : val.toFixed(4)) : val}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {/* Expanded detail */}
      {expanded && (
        isModal ? (
          <ModalRunDetails run={run} hasMetrics={!!hasMetrics} sendToChat={sendToChat} />
        ) : (
        <div className="px-10 pb-3 space-y-2">
          {/* Metadata chips */}
          <div className="flex flex-wrap gap-1.5">
            <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
              {run.sandbox}
            </span>
            <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
              {run.weight}
            </span>
            <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
              {formatBytes(run.outputBytes)} &middot; {run.outputLines} lines
            </span>
            {run.exitCode !== undefined && (
              <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                exit {run.exitCode}
              </span>
            )}
            {run.target === 'modal' && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                <Cloud size={10} /> Modal
              </span>
            )}
            {run.estimatedCostUsd !== undefined && (
              <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                est. ${run.estimatedCostUsd.toFixed(4)}
              </span>
            )}
            {run.startedAt && !isActive && (
              <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                started {timeAgo(run.startedAt)}
              </span>
            )}
          </div>

          {/* Metrics for non-active runs (active runs show them inline above) */}
          {!isActive && hasMetrics && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(run.progress!.metrics!).map(([key, val]) => (
                <span key={key} className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-secondary font-mono">
                  <span className="t-text-muted">{key}</span> {typeof val === 'number' ? (val < 0.01 ? val.toExponential(2) : val.toFixed(4)) : val}
                </span>
              ))}
            </div>
          )}

          {/* Failure detail */}
          {run.failure && (
            <div className="text-xs t-text-secondary leading-relaxed">
              <p className="font-medium">{run.failure.code}: {run.failure.message}</p>
              {run.failure.suggestions.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {run.failure.suggestions.map((s, i) => (
                    <li key={i} className="flex items-start gap-1.5 t-text-muted">
                      <span className="shrink-0 mt-1.5 w-1 h-1 rounded-full t-bg-elevated" />
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Retry lineage */}
          {run.parentRunId && (
            <div className="flex items-center gap-1.5 text-[10px] t-text-muted">
              <RotateCcw size={10} />
              Retry of {run.parentRunId}
            </div>
          )}

          {/* Output tail */}
          {run.outputTail && (
            <pre className="p-2 rounded t-bg-elevated text-[10px] t-text-secondary font-mono overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {run.outputTail.slice(-2048)}
            </pre>
          )}

          {/* Actions */}
          {run.failure?.retryable && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                sendToChat(`Compute run ${run.runId} failed with ${run.failure!.code}. Please review the error and fix the code, then retry.`)
              }}
              className="text-[10px] t-text-accent hover:underline"
            >
              Fix & retry in chat
            </button>
          )}
        </div>
        )
      )}
    </div>
  )
}

// ─── Filter bar ──────────────────────────────────────────────────────────────

function FilterBar({
  search,
  onSearchChange,
}: {
  search: string
  onSearchChange: (v: string) => void
}) {
  return (
    <div className="px-4 py-2 border-b t-border">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 t-text-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search runs by command or ID..."
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border t-border t-bg-surface t-text focus:outline-none focus:border-[var(--color-accent-soft)]"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 t-text-muted hover:t-text"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

type ModalApprovalSection = 'script' | 'environment' | 'cost'

function ApprovalSection({
  id,
  label,
  expanded,
  onToggle,
  children,
}: {
  id: ModalApprovalSection
  label: string
  expanded: boolean
  onToggle: (id: ModalApprovalSection) => void
  children: React.ReactNode
}) {
  return (
    <div className="border-t t-border-subtle first:border-t-0">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 py-2 text-[11px] font-medium t-text-secondary hover:t-text"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
      </button>
      {expanded && (
        <div className="pl-5 pb-3">
          {children}
        </div>
      )}
    </div>
  )
}

function ModalApprovalCard() {
  const plan = usePendingModalPlan()
  const clearModalPendingPlan = useComputeStore((s) => s.clearModalPendingPlan)
  const sendChat = useChatStore((s) => s.send)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const setCenterView = useUIStore((s) => s.setCenterView)
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [showRejectEditor, setShowRejectEditor] = useState(false)
  const [rejectionComments, setRejectionComments] = useState('')
  const [rejectionError, setRejectionError] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<ModalApprovalSection | null>(null)
  const [scriptContent, setScriptContent] = useState<string | null>(null)
  const [scriptError, setScriptError] = useState<string | null>(null)
  const [loadingScript, setLoadingScript] = useState(false)
  const [costThresholdUsd, setCostThresholdUsd] = useState(5)

  useEffect(() => {
    let cancelled = false
    api.loadSettings?.()
      .then((settings: any) => {
        const threshold = settings?.modalCompute?.costThresholdUsd
        if (!cancelled && typeof threshold === 'number' && Number.isFinite(threshold)) {
          setCostThresholdUsd(threshold)
        }
      })
      .catch(() => { /* default threshold is fine for display */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setExpandedSection(null)
    setScriptContent(null)
    setScriptError(null)
    setLoadingScript(false)
    setShowRejectEditor(false)
    setRejectionComments('')
    setRejectionError(null)
  }, [plan?.planId])

  if (!plan) return null

  const approve = async () => {
    setApproving(true)
    try {
      const result = await api.approveModalPlan?.()
      if (result?.success) {
        clearModalPendingPlan()
        setCenterView('chat')
        await sendChat('compute plan approved')
      }
    } finally {
      setApproving(false)
    }
  }

  const submitRejection = async () => {
    const comments = rejectionComments.trim()
    if (!comments) {
      setRejectionError('Rejection comments are required.')
      return
    }
    if (isStreaming) {
      setRejectionError('Wait for the current copilot response to finish before rejecting this plan.')
      return
    }
    setRejecting(true)
    setRejectionError(null)
    let result: { success: boolean; error?: string } | undefined
    try {
      result = await api.rejectModalPlan?.(comments)
    } catch (err: any) {
      setRejecting(false)
      setRejectionError(err?.message || 'Failed to reject Modal plan.')
      return
    }
    if (!result?.success) {
      setRejecting(false)
      setRejectionError(result?.error || 'Failed to reject Modal plan.')
      return
    }
    clearModalPendingPlan()
    setCenterView('chat')
    await sendChat(`compute plan rejected. Rejection comments: ${comments}`)
  }

  const loadScript = () => {
    if (scriptContent !== null || scriptError || loadingScript) return
    setLoadingScript(true)
    api.readFile(plan.scriptPath)
      .then((result: { success: boolean; content?: string; error?: string }) => {
        if (result?.success) {
          setScriptContent(result.content ?? '')
          setScriptError(null)
        } else {
          setScriptError(result?.error || 'Could not read script file.')
        }
      })
      .catch((err: any) => {
        setScriptError(err?.message || 'Could not read script file.')
      })
      .finally(() => setLoadingScript(false))
  }

  const toggleSection = (section: ModalApprovalSection) => {
    const next = expandedSection === section ? null : section
    setExpandedSection(next)
    if (next === 'script') loadScript()
  }

  const gpuLabel = modalImageGpuLabel(plan.image)
  const durationLabel = formatPlanMinutes(plan.costEstimate.expectedDurationMinutes)
  const estimatedCostLabel = formatMoney(plan.costEstimate.estimatedTotalUsd, 2)
  const rateLabel = formatMoney(plan.costEstimate.gpuRateUsdPerHour, 2)
  const taskText = plan.taskDescription?.trim() || plan.command
  const pythonPackages = formatList(plan.image.pythonPackages)
  const packageInstallers = formatList(plan.image.pythonPackageInstallers)
  const systemPackages = formatList(plan.image.systemPackages)
  const durationReasoning = plan.taskProfile?.durationReasoning?.trim()

  return (
    <div className="px-4 py-3 border-b t-border t-bg-surface">
      <div className="rounded-lg border t-border-subtle p-3 space-y-3">
        <div className="flex items-start gap-3">
          <Cloud size={16} className="t-text-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <p className="text-xs font-semibold t-text">Modal compute plan</p>
              <p className="text-[12px] t-text-secondary leading-relaxed mt-1 line-clamp-2">
                {taskText}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[10px] t-text-muted uppercase tracking-wide">GPU</div>
                <div className="text-xs font-medium t-text mt-0.5 truncate">{gpuLabel}</div>
              </div>
              <div>
                <div className="text-[10px] t-text-muted uppercase tracking-wide">Duration</div>
                <div className="text-xs font-medium t-text mt-0.5 truncate">{durationLabel}</div>
              </div>
              <div>
                <div className="text-[10px] t-text-muted uppercase tracking-wide">Est. cost</div>
                <div className="text-xs font-medium t-text mt-0.5 truncate">{estimatedCostLabel}</div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={approve}
              disabled={approving || rejecting}
              className="px-3 py-1.5 rounded-md text-white text-[11px] font-medium bg-[var(--color-accent)] disabled:opacity-50"
            >
              {approving ? 'Approving...' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRejectEditor(true)
                setRejectionError(null)
              }}
              disabled={approving || rejecting}
              className="px-2.5 py-1.5 rounded-md border t-border text-[11px] t-text-secondary hover:t-text disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>

        <div className="rounded-md border t-border-subtle px-2">
          <ApprovalSection id="script" label="Script" expanded={expandedSection === 'script'} onToggle={toggleSection}>
            <div className="space-y-2">
              <p className="text-[11px] font-mono t-text-secondary break-all">{plan.command}</p>
              <p className="text-[10px] t-text-muted break-all">{plan.scriptPath}</p>
              {loadingScript && (
                <p className="text-[11px] t-text-muted">Loading script...</p>
              )}
              {scriptError && (
                <p className="text-[11px] text-red-500">{scriptError}</p>
              )}
              {!loadingScript && !scriptError && scriptContent !== null && (
                scriptContent.trim() ? (
                  <pre className="p-2 rounded t-bg-elevated text-[10px] t-text-secondary font-mono overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                    {scriptContent}
                  </pre>
                ) : (
                  <p className="text-[11px] t-text-muted">Script file is empty.</p>
                )
              )}
            </div>
          </ApprovalSection>

          <ApprovalSection id="environment" label="Environment" expanded={expandedSection === 'environment'} onToggle={toggleSection}>
            <div className="space-y-2 text-[11px] t-text-secondary leading-relaxed">
              <p className="font-medium t-text">
                Python {plan.image.pythonVersion || 'unknown'} &middot; {gpuLabel}
              </p>
              <p><span className="t-text-muted">Image source:</span> {modalImageSourceLabel(plan.image)}</p>
              <p><span className="t-text-muted">Python packages:</span> {pythonPackages}</p>
              <p><span className="t-text-muted">Package installers:</span> {packageInstallers}</p>
              <p><span className="t-text-muted">System packages:</span> {systemPackages}</p>
              {!!plan.image.envVars?.length && <p><span className="t-text-muted">Environment vars:</span> {formatList(plan.image.envVars)}</p>}
              {!!plan.image.localDirs?.length && <p><span className="t-text-muted">Local dirs:</span> {formatList(plan.image.localDirs)}</p>}
              {!!plan.image.localFiles?.length && <p><span className="t-text-muted">Local files:</span> {formatList(plan.image.localFiles)}</p>}
              {!!plan.image.localPythonSources?.length && <p><span className="t-text-muted">Local Python source:</span> {formatList(plan.image.localPythonSources)}</p>}
              {!!plan.image.buildCommands?.length && <p><span className="t-text-muted">Build commands:</span> {formatList(plan.image.buildCommands)}</p>}
              {!!plan.image.buildFunctions?.length && <p><span className="t-text-muted">Build functions:</span> {formatList(plan.image.buildFunctions)}</p>}
              {plan.image.runtimeGpuType && <p><span className="t-text-muted">Runtime GPU:</span> {plan.image.runtimeGpuType}</p>}
              {plan.image.buildGpuType && <p><span className="t-text-muted">Build GPU:</span> {plan.image.buildGpuType}</p>}
              {plan.image.forceBuild && <p><span className="t-text-muted">Force build:</span> yes</p>}
              {!!plan.image.warnings?.length && (
                <div className="space-y-1">
                  {plan.image.warnings.map((warning, i) => (
                    <p key={i} className="rounded-md t-bg-elevated px-2 py-1.5 t-text-muted">
                      {warning}
                    </p>
                  ))}
                </div>
              )}
              {plan.image.reasoning && (
                <blockquote className="border-l-2 t-border-subtle pl-3 py-1 italic t-text-muted">
                  {plan.image.reasoning}
                </blockquote>
              )}
              <p className="text-[10px] t-text-muted break-all">{plan.image.baseImage}</p>
            </div>
          </ApprovalSection>

          <ApprovalSection id="cost" label="Cost" expanded={expandedSection === 'cost'} onToggle={toggleSection}>
            <div className="space-y-2 text-[11px] t-text-secondary leading-relaxed">
              <p className="font-mono t-text">
                {rateLabel}/hr x {durationLabel} ~= {estimatedCostLabel}
              </p>
              {durationReasoning && (
                <blockquote className="border-l-2 t-border-subtle pl-3 py-1 italic t-text-muted">
                  {durationReasoning}
                </blockquote>
              )}
              <p><span className="t-text-muted">Auto-kill threshold:</span> {formatMoney(costThresholdUsd, 2)}</p>
              {plan.costEstimate.notes && (
                <p className="rounded-md t-bg-elevated px-2 py-1.5 t-text-muted">
                  {plan.costEstimate.notes}
                </p>
              )}
            </div>
          </ApprovalSection>
        </div>

        {showRejectEditor && (
          <div className="rounded-md border t-border-subtle p-2.5 space-y-2">
            <label className="block text-[11px] font-medium t-text" htmlFor={`reject-modal-plan-${plan.planId}`}>
              Rejection comments
            </label>
            <textarea
              id={`reject-modal-plan-${plan.planId}`}
              value={rejectionComments}
              onChange={(e) => {
                setRejectionComments(e.target.value)
                if (rejectionError) setRejectionError(null)
              }}
              rows={3}
              placeholder="Tell the copilot what needs to change before this plan can run."
              className="w-full resize-y rounded-md border t-border t-bg-base t-text text-[12px] px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
            {rejectionError && (
              <p className="text-[11px] text-red-500">{rejectionError}</p>
            )}
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setShowRejectEditor(false)
                  setRejectionError(null)
                }}
                disabled={rejecting}
                className="px-2.5 py-1.5 rounded-md border t-border text-[11px] t-text-secondary hover:t-text disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitRejection}
                disabled={rejecting || isStreaming}
                className="px-3 py-1.5 rounded-md text-white text-[11px] font-medium bg-red-500 disabled:opacity-50"
              >
                {rejecting ? 'Rejecting...' : 'Submit rejection'}
              </button>
            </div>
            {isStreaming && (
              <p className="text-[10px] t-text-muted">
                Wait for the current copilot response to finish before submitting this rejection.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Coverage footer ─────────────────────────────────────────────────────────

function CoverageBar({ runs }: { runs: ComputeRunView[] }) {
  const completed = runs.filter(r => r.status === 'completed').length
  const failed = runs.filter(r => ['failed', 'timed_out'].includes(r.status)).length
  const total = runs.length
  const successRate = total > 0 ? completed / total : 0

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t t-border t-bg-surface text-[11px] t-text-muted">
      <span>{total} runs</span>
      {completed > 0 && <span>{completed} completed</span>}
      {failed > 0 && <span>{failed} failed</span>}
      {total > 0 && (
        <>
          <div className="flex-1 max-w-48">
            <div className="h-1.5 rounded-full t-bg-elevated overflow-hidden">
              <div
                className="h-full rounded-full t-gradient-accent-h"
                style={{ width: `${successRate * 100}%` }}
              />
            </div>
          </div>
          <span>{Math.round(successRate * 100)}% success</span>
        </>
      )}
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  const environment = useComputeStore((s) => s.environment)
  const setCenterView = useUIStore((s) => s.setCenterView)

  const goToChat = (text: string) => {
    setCenterView('chat')
    setTimeout(() => {
      const inputEl = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
      if (inputEl) {
        inputEl.value = text
        inputEl.focus()
        inputEl.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, 100)
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <Cpu size={32} className="t-text-muted mb-3 opacity-30" />
      <p className="text-sm t-text font-medium mb-1">
        Your compute environment is ready
      </p>
      <p className="text-xs t-text-muted max-w-sm leading-relaxed mb-4">
        Ask the agent to run scripts, train models, or process data.
        Code executes in a sandboxed environment with progress tracking and failure analysis.
      </p>

      {environment && (
        <div className="px-4 py-2.5 rounded-lg t-bg-elevated text-[11px] t-text-secondary mb-5">
          {environment.gpu || `${environment.os} ${environment.arch}`} &middot; {Math.round(environment.totalMemoryMb / 1024)} GB
          {environment.mlxAvailable && <> &middot; <span className="t-text-accent">MLX</span></>}
          {environment.sandbox === 'docker' && <> &middot; Docker</>}
        </div>
      )}

      <div className="space-y-1.5 w-full max-w-sm">
        {[
          'Train a model on my dataset',
          'Run my analysis script',
          'Process and clean this data',
        ].map((prompt) => (
          <button
            key={prompt}
            onClick={() => goToChat(prompt)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border t-border-subtle hover:bg-[var(--color-accent-soft)]/5 transition-colors text-left"
          >
            <span className="text-xs t-text-secondary">"{prompt}"</span>
            <ChevronRight size={12} className="t-text-muted" />
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ComputeView() {
  const activeRuns = useActiveRuns()
  const recentRuns = useRecentRuns()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const allRuns = useMemo(() => [...activeRuns, ...recentRuns], [activeRuns, recentRuns])
  const pendingPlan = usePendingModalPlan()

  const filtered = useMemo(() => {
    if (!search.trim()) return allRuns
    const q = search.toLowerCase()
    return allRuns.filter(
      (r) => r.command.toLowerCase().includes(q) || r.runId.toLowerCase().includes(q)
    )
  }, [allRuns, search])

  const isEmpty = allRuns.length === 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {pendingPlan && <ModalApprovalCard />}
      {!isEmpty && <FilterBar search={search} onSearchChange={setSearch} />}

      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <Cpu size={32} className="t-text-muted mb-3 opacity-40" />
            <p className="text-sm t-text-muted">No runs match your search.</p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="flex items-center gap-3 px-3 py-1.5 border-b t-border t-bg-surface">
              <div className="w-5" />
              <div className="w-1.5" />
              <div className="flex-1 text-[10px] uppercase tracking-wider font-medium t-text-muted">
                Command
              </div>
              <span className="w-14 text-right text-[10px] uppercase tracking-wider font-medium t-text-muted">
                Duration
              </span>
              <span className="w-14 text-right text-[10px] uppercase tracking-wider font-medium t-text-muted">
                Phase
              </span>
            </div>

            {/* Rows */}
            {filtered.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                expanded={expandedId === run.runId}
                onToggle={() => setExpandedId(expandedId === run.runId ? null : run.runId)}
              />
            ))}
          </>
        )}
      </div>

      {!isEmpty && <CoverageBar runs={allRuns} />}
    </div>
  )
}
