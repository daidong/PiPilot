/**
 * ComputeView — center panel for the Compute tab.
 *
 * Follows LiteratureView patterns: filter bar, expandable rows, coverage footer.
 * Four states in priority: active runs > history > empty.
 */

import React, { useState, useMemo } from 'react'
import {
  Cpu,
  Search,
  ChevronRight,
  ChevronDown,
  RotateCcw,
  X
} from 'lucide-react'
import { useComputeStore, useActiveRuns, useRecentRuns } from '../../stores/compute-store'
import { useUIStore } from '../../stores/ui-store'
import type { ComputeRunView } from '../../stores/compute-store'

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  stalled: 'Stalled',
  completed: 'Completed',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
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
          <p className="text-[13px] t-text font-medium truncate leading-tight font-mono">
            {run.command}
          </p>
          <p className="text-[11px] t-text-muted truncate mt-0.5">
            {run.runId}
            {run.status !== 'running' && run.status !== 'stalled' && (
              <> &middot; {STATUS_LABELS[run.status] ?? run.status}</>
            )}
            {run.stalled && <> &middot; <span className="t-text-accent-soft">stalled — no output for a while</span></>}
            {run.failure && <> &middot; {run.failure.code}</>}
            {run.parentRunId && <> &middot; retry</>}
          </p>
        </div>

        {/* Duration */}
        <span className="shrink-0 text-[11px] t-text-muted tabular-nums w-14 text-right">
          {formatDuration(run.elapsedSeconds)}
        </span>

        {/* Time ago or phase */}
        <span className="shrink-0 text-[11px] t-text-muted w-14 text-right">
          {isActive ? run.currentPhase : (run.startedAt ? timeAgo(run.startedAt) : '--')}
        </span>
      </div>

      {/* Progress section for active runs — always visible (not inside expanded) */}
      {isActive && (
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
      )}

      {/* Expanded detail */}
      {expanded && (
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
