import React, { useState, useEffect, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { SegmentedControl } from './SegmentedControl'
import { SUPPORTED_MODELS } from '../../../../../shared-ui/constants'
import type { WikiAgentSpeed } from '../../../../../shared-ui/settings-types'

const api = (window as any).api

interface Props {
  model: string
  speed: WikiAgentSpeed
  onChangeModel: (model: string) => void
  onChangeSpeed: (speed: WikiAgentSpeed) => void
}

const SPEED_OPTIONS: Array<{ label: string; value: WikiAgentSpeed; desc: string }> = [
  { label: 'Slow', value: 'slow', desc: 'Minimal resource usage. Best for subscription plans with tight limits.' },
  { label: 'Medium', value: 'medium', desc: 'Balanced processing. Suitable for most users.' },
  { label: 'Fast', value: 'fast', desc: 'Processes papers quickly when idle. Uses more API calls.' },
]

// Providers ordered with subscription tiers first so users see them as the
// first/natural choice — matches the main ModelSelector's priority.
const PROVIDER_ORDER = [
  'ChatGPT Subscription',
  'Claude Subscription',
  'OpenAI',
  'Anthropic',
]

const MODEL_GROUPS: Array<[string, typeof SUPPORTED_MODELS]> = PROVIDER_ORDER
  .map((p) => [p, SUPPORTED_MODELS.filter((m) => m.provider === p)] as [string, typeof SUPPORTED_MODELS])
  .filter(([, models]) => models.length > 0)

function isSubProvider(providerId: string): boolean {
  return providerId === 'anthropic-sub' || providerId === 'openai-codex'
}

function providerOf(modelId: string): string {
  const i = modelId.indexOf(':')
  return i > 0 ? modelId.slice(0, i) : ''
}

function labelFor(modelId: string): string {
  const m = SUPPORTED_MODELS.find((x) => x.id === modelId)
  if (!m) return modelId
  const suffix = isSubProvider(providerOf(modelId)) ? ' (sub)' : ' (api)'
  return m.label + suffix
}

export function WikiAgentSettings({ model, speed, onChangeModel, onChangeSpeed }: Props) {
  const [status, setStatus] = useState<any>(null)
  const [stats, setStats] = useState<any>(null)
  const [recentLog, setRecentLog] = useState<string[]>([])
  const [autoResolved, setAutoResolved] = useState<string | null>(null)

  // Load status + stats on mount
  useEffect(() => {
    api.wikiGetStatus?.().then((s: any) => setStatus(s)).catch(() => {})
    api.wikiGetStats?.().then((s: any) => setStats(s)).catch(() => {})
    api.wikiGetLog?.().then((l: string[]) => setRecentLog(l || [])).catch(() => {})

    // Listen for live status updates
    const unsub = api.onWikiStatus?.((s: any) => setStatus(s))
    return () => unsub?.()
  }, [])

  // When Auto is selected, show which concrete model will actually run.
  useEffect(() => {
    if (model !== 'auto') { setAutoResolved(null); return }
    let cancelled = false
    api.pickPreferredModel?.()
      .then((m: string | null) => { if (!cancelled) setAutoResolved(m) })
      .catch(() => { if (!cancelled) setAutoResolved(null) })
    return () => { cancelled = true }
  }, [model])

  const enabled = model !== 'none'
  const speedDesc = SPEED_OPTIONS.find(o => o.value === speed)?.desc || ''
  const runningModelLabel = useMemo(() => {
    if (model === 'auto') {
      return autoResolved ? `Auto → ${labelFor(autoResolved)}` : 'Auto (no auth configured)'
    }
    return labelFor(model)
  }, [model, autoResolved])

  return (
    <div className="space-y-6">
      {/* Token cost warning — always visible so users understand the trade-off */}
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2.5">
        <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-500" />
        <div className="space-y-1">
          <p className="text-[11px] font-semibold t-text">Heads up: background token usage</p>
          <p className="text-[11px] t-text-muted leading-relaxed">
            The Paper Wiki runs in the background and sends every new paper through an LLM
            (intro + abstract + full text if available). A typical paper consumes roughly
            <span className="t-text"> 8K–25K input tokens</span> and produces{' '}
            <span className="t-text">2K–4K output tokens</span>, plus concept-page updates.
            Across a full library this can add up to <span className="t-text">several dollars
            per day</span> on API-key billing. <strong>It is disabled by default</strong> —
            enable it below only after you've picked a model you're comfortable paying for, and
            prefer a subscription plan or a smaller/cheaper model for background work.
          </p>
        </div>
      </div>

      {/* Section 1: Configuration */}
      <div>
        <h4 className="text-xs font-semibold t-text mb-1.5">Wiki Agent Model</h4>
        <p className="text-[11px] t-text-muted mb-2.5">
          Select a model to power the background Paper Wiki agent. The wiki accumulates
          LLM-generated summaries of papers across all your projects. A smaller model
          is recommended for background processing. Pick <em>Auto</em> to follow the
          system-wide model priority (subscription before API key).
        </p>
        <select
          value={model}
          onChange={e => onChangeModel(e.target.value)}
          className="w-full px-3 py-1.5 rounded-lg border t-border t-bg-base t-text text-xs"
        >
          <option value="none">None (disabled — default)</option>
          <option value="auto">Auto (match main model priority)</option>
          {MODEL_GROUPS.map(([provider, models]) => (
            <optgroup key={provider} label={provider}>
              {models.map(m => {
                const suffix = isSubProvider(providerOf(m.id)) ? ' (sub)' : ' (api)'
                return <option key={m.id} value={m.id}>{m.label}{suffix}</option>
              })}
            </optgroup>
          ))}
        </select>
        {enabled && (
          <p className="text-[10px] t-text-muted mt-1.5">
            Running: <span className="t-text">{runningModelLabel}</span>
          </p>
        )}
        <p className="text-[10px] t-text-muted mt-1.5 italic">
          Changes take effect after app restart.
        </p>
      </div>

      {enabled && (
        <div>
          <h4 className="text-xs font-semibold t-text mb-1.5">Processing Speed</h4>
          <SegmentedControl
            options={SPEED_OPTIONS}
            value={speed}
            onChange={onChangeSpeed}
          />
          <p className="text-[11px] t-text-muted mt-2">{speedDesc}</p>
        </div>
      )}

      {/* Section 2: Status Dashboard */}
      {enabled && (
        <div className="rounded-lg border t-border t-bg-surface/50 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold t-text">Status</h4>
            {status?.state && status.state !== 'disabled' && (
              <button
                onClick={() => {
                  if (status.state === 'paused') {
                    api.wikiResume?.()
                  } else {
                    api.wikiPause?.()
                  }
                }}
                className="px-2.5 py-1 rounded-md border t-border t-bg-base t-text text-[11px] font-medium hover:t-bg-hover transition-colors"
              >
                {status.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            <span className="t-text-muted">State:</span>
            <span className="t-text flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                status?.state === 'processing' ? 'bg-blue-500' :
                status?.state === 'idle' ? 'bg-green-500' :
                status?.state === 'paused' ? 'bg-yellow-500' :
                'bg-gray-400'
              }`} />
              {status?.state === 'processing'
                ? `Processing (${status?.pending ?? 0} pending)`
                : status?.state ?? 'Disabled'}
            </span>

            {stats && (
              <>
                <span className="t-text-muted">Papers:</span>
                <span className="t-text">
                  {stats.papers} in wiki ({stats.fulltext} fulltext, {stats.abstractOnly} abstract)
                </span>

                <span className="t-text-muted">Concepts:</span>
                <span className="t-text">{stats.concepts} pages</span>
              </>
            )}

            {status?.lastRunAt && (
              <>
                <span className="t-text-muted">Last run:</span>
                <span className="t-text">{formatRelativeTime(status.lastRunAt)}</span>
              </>
            )}
          </div>

          {/* Recent Activity */}
          {recentLog.length > 0 && (
            <div>
              <h5 className="text-[11px] font-medium t-text-muted mb-1">Recent Activity</h5>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {recentLog.slice(0, 10).map((entry, i) => (
                  <p key={i} className="text-[10px] t-text-muted font-mono leading-relaxed truncate">
                    {entry}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!enabled && (
        <div className="rounded-lg border t-border t-bg-surface/50 p-3">
          <p className="text-[11px] t-text-muted">
            The wiki agent is disabled. Select a model above to enable cross-project paper
            memory. Papers from all your projects are accumulated into a searchable local
            memory accessible via <code className="font-mono">wiki_search</code>,{' '}
            <code className="font-mono">wiki_get</code>, <code className="font-mono">wiki_coverage</code>,
            and <code className="font-mono">wiki_source</code> — the wiki is a research memory
            layer, not a fact oracle.
          </p>
        </div>
      )}
    </div>
  )
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  return new Date(isoString).toLocaleDateString()
}
