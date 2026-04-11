import React, { useState, useEffect } from 'react'
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

// Group models by provider
const MODEL_GROUPS = (() => {
  const groups = new Map<string, typeof SUPPORTED_MODELS>()
  for (const m of SUPPORTED_MODELS) {
    const list = groups.get(m.provider) || []
    list.push(m)
    groups.set(m.provider, list)
  }
  return groups
})()

export function WikiAgentSettings({ model, speed, onChangeModel, onChangeSpeed }: Props) {
  const [status, setStatus] = useState<any>(null)
  const [stats, setStats] = useState<any>(null)
  const [recentLog, setRecentLog] = useState<string[]>([])

  // Load status + stats on mount
  useEffect(() => {
    api.wikiGetStatus?.().then((s: any) => setStatus(s)).catch(() => {})
    api.wikiGetStats?.().then((s: any) => setStats(s)).catch(() => {})
    api.wikiGetLog?.().then((l: string[]) => setRecentLog(l || [])).catch(() => {})

    // Listen for live status updates
    const unsub = api.onWikiStatus?.((s: any) => setStatus(s))
    return () => unsub?.()
  }, [])

  const enabled = model !== 'none'
  const speedDesc = SPEED_OPTIONS.find(o => o.value === speed)?.desc || ''

  return (
    <div className="space-y-6">
      {/* Section 1: Configuration */}
      <div>
        <h4 className="text-xs font-semibold t-text mb-1.5">Wiki Agent Model</h4>
        <p className="text-[11px] t-text-muted mb-2.5">
          Select a model to power the background Paper Wiki agent. The wiki accumulates
          LLM-generated summaries of papers across all your projects. A smaller model
          is recommended for background processing.
        </p>
        <select
          value={model}
          onChange={e => onChangeModel(e.target.value)}
          className="w-full px-3 py-1.5 rounded-lg border t-border t-bg-base t-text text-xs"
        >
          <option value="none">None (disabled)</option>
          {Array.from(MODEL_GROUPS.entries()).map(([provider, models]) => (
            <optgroup key={provider} label={provider}>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
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
          <h4 className="text-xs font-semibold t-text">Status</h4>

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
            knowledge. Papers from all your projects will be synthesized into interlinked
            wiki pages, accessible via the <code className="font-mono">wiki_lookup</code> tool.
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
