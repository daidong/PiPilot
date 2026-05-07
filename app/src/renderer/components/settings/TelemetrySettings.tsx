import React, { useEffect, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'

const api = (window as any).api

interface ProjectConfig {
  projectId: string
  tracingMode: 'enabled' | 'disabled'
  bufferCapacity: number
  storageFootprintBytes: number
  /** Bytes accumulated this UTC day, not yet flushed to disk. */
  inFlightBytes?: number
  /** Bytes already flushed to trace-storage-stats.jsonl (prior days + prior shutdowns). */
  persistedBytes?: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Project-scoped Telemetry settings panel (spec §10.2 + P0 gate UI mockup).
 *
 * Two affordances only — keeps surface area small:
 *   1. tracingMode toggle (enable/disable telemetry for this project)
 *   2. Storage footprint readout (informational; helps users gauge growth)
 *
 * The panel intentionally has no retention picker — v0.5+ removed retention
 * configurability. Project deletion is the only purge mechanism.
 */
export function TelemetrySettings() {
  const [cfg, setCfg] = useState<ProjectConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // `silent=true` is used by the manual Refresh button — it skips the
  // top-level `loading` spinner so the UI doesn't full-page-flash on
  // user-initiated refreshes.
  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)
    try {
      // silent=true means a user-initiated Refresh — bypass the main-side
      // 60s footprint cache so the click feels responsive and accurate.
      const result = await api.telemetryGetProjectConfig?.(silent)
      if (!result) {
        setError('No project is open. Telemetry settings are project-scoped.')
        setCfg(null)
      } else if ('error' in result) {
        setError(result.error)
        setCfg(null)
      } else {
        setCfg(result as ProjectConfig)
        setLastFetchedAt(new Date())
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load telemetry config.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    // Load once on mount. The footprint walk runs through a 60s TTL cache
    // on the main side, so the manual Refresh button is the only path that
    // can trigger a fresh walk — auto-polling was removed (was wasting
    // disk I/O on an idle panel; users open Settings and read, not stare).
    void load()
  }, [])

  const handleToggle = async () => {
    if (!cfg) return
    setSaving(true)
    const next = cfg.tracingMode === 'enabled' ? 'disabled' : 'enabled'
    try {
      const r = await api.telemetrySetTracingMode?.(next)
      if (r?.success) {
        setCfg({ ...cfg, tracingMode: next })
      } else {
        setError(r?.error ?? 'Failed to update tracingMode.')
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="t-text-muted text-sm">Loading…</div>
  }
  if (error) {
    return (
      <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
        <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="text-sm t-text">{error}</div>
      </div>
    )
  }
  if (!cfg) return null

  // Soft warning at 5 GB — informational, not a hard limit (§5.6 / §13.1).
  const footprintWarn = cfg.storageFootprintBytes > 5 * 1024 * 1024 * 1024

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <h3 className="text-sm font-semibold t-text mb-1">Trace recording</h3>
            <p className="text-xs t-text-muted max-w-prose">
              Records LLM calls, tool calls, and agent turns to{' '}
              <code className="font-mono text-[11px]">.research-pilot/traces/</code>{' '}
              for debugging and post-hoc analysis. Data stays local and is never
              transmitted. Secret/token scrubbing always runs.
            </p>
          </div>
          <button
            onClick={handleToggle}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              cfg.tracingMode === 'enabled'
                ? 'bg-blue-600'
                : 'bg-gray-300 dark:bg-gray-600'
            } ${saving ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
            aria-pressed={cfg.tracingMode === 'enabled'}
            aria-label="Toggle telemetry"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                cfg.tracingMode === 'enabled' ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="text-xs t-text-muted">
          Status:{' '}
          <span className={cfg.tracingMode === 'enabled' ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-gray-500 dark:text-gray-400'}>
            {cfg.tracingMode === 'enabled' ? 'enabled' : 'disabled'}
          </span>
          {' · '}
          Buffer capacity: {cfg.bufferCapacity} spans
        </div>
      </section>

      <section className="border-t pt-4 t-border">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold t-text flex items-center gap-2">
            <Activity size={14} /> Storage footprint
          </h3>
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-xs t-text-muted hover:t-text disabled:opacity-50 transition-colors"
            aria-label="Refresh storage footprint"
            title="Refresh"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-mono t-text">{formatBytes(cfg.storageFootprintBytes)}</span>
          <span className="text-xs t-text-muted">
            approximate
            {typeof cfg.inFlightBytes === 'number' && cfg.inFlightBytes > 0 && (
              <> · {formatBytes(cfg.inFlightBytes)} in current session</>
            )}
            {lastFetchedAt && (
              <> · updated {lastFetchedAt.toLocaleTimeString()}</>
            )}
          </span>
        </div>
        {footprintWarn && (
          <div className="mt-3 flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-xs">
            <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
            <span className="t-text">
              Trace data has grown beyond 5 GB. Per spec §5.6, totals are tractable on modern SSDs but
              you may want to archive or delete the project if disk space is tight.
            </span>
          </div>
        )}
        <p className="mt-2 text-xs t-text-muted max-w-prose">
          Trace files live under{' '}
          <code className="font-mono text-[11px]">.research-pilot/</code>{' '}
          and are retained forever. Project deletion is the only way to purge.
        </p>
      </section>

      <section className="border-t pt-4 t-border">
        <div className="text-xs t-text-muted">
          Project ID: <code className="font-mono text-[11px]">{cfg.projectId}</code>
        </div>
      </section>
    </div>
  )
}
