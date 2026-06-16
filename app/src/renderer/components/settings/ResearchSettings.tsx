import React from 'react'
import { SegmentedControl } from './SegmentedControl'
import { SUPPORTED_MODELS } from '../../../../../shared-ui/constants'
import type { ResearchIntensity, WebSearchDepth, AutoSaveSensitivity, SubTaskModelTier } from '../../../../../shared-ui/settings-types'

interface Props {
  researchIntensity: ResearchIntensity
  webSearchDepth: WebSearchDepth
  autoSaveSensitivity: AutoSaveSensitivity
  subTaskModelTier: SubTaskModelTier
  auditModel: string
  auditVisionModel: string
  auditConcurrency: number
  onChangeIntensity: (v: ResearchIntensity) => void
  onChangeWebDepth: (v: WebSearchDepth) => void
  onChangeAutoSave: (v: AutoSaveSensitivity) => void
  onChangeSubTaskModelTier: (v: SubTaskModelTier) => void
  onChangeAuditModel: (v: string) => void
  onChangeAuditVisionModel: (v: string) => void
  onChangeAuditConcurrency: (v: number) => void
}

// Curated cheap/fast tier for audit (§6.1): claim extraction + prune
// adjudication are short structured calls that small non-flagship models handle
// well and far cheaper. These ids are the internal "light tier" (hidden from the
// main model selector) but are exactly what audit wants. Strongly recommended
// over a reasoning flagship, which is slow and burns tokens on every node.
const AUDIT_SMALL_MODELS: Array<{ id: string; label: string; vision: boolean }> = [
  // API-key tiers
  { id: 'openai:gpt-5.4-mini', label: 'GPT-5.4 Mini (API)', vision: true },
  { id: 'openai:gpt-5.4-nano', label: 'GPT-5.4 Nano (API)', vision: false },
  { id: 'anthropic:claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (API)', vision: true },
  // Subscription tiers (ChatGPT has no nano; Claude small = Haiku)
  { id: 'openai-codex:gpt-5.4-mini', label: 'GPT-5.4 Mini (ChatGPT sub)', vision: true },
  { id: 'anthropic-sub:claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Claude sub)', vision: true },
]

// Audit model picker (audit-pipeline.md §6.1/§10). 'main' = follow the main
// agent model. Lists the recommended cheap tier first, then the full flagship
// registry; the text-only DeepSeek provider is excluded from the vision slot.
function AuditModelSelect({ value, onChange, visionOnly }: {
  value: string
  onChange: (v: string) => void
  visionOnly?: boolean
}) {
  const models = SUPPORTED_MODELS.filter(m => !visionOnly || m.provider !== 'DeepSeek')
  const providers = [...new Set(models.map(m => m.provider))]
  const small = AUDIT_SMALL_MODELS.filter(m => !visionOnly || m.vision)
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full px-2 py-1.5 rounded-md border t-border-subtle t-bg-elevated t-text text-[12px]"
    >
      <option value="main">Same as main model</option>
      <optgroup label="Small / fast (recommended for audit)">
        {small.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </optgroup>
      {providers.map(p => (
        <optgroup key={p} label={p}>
          {models.filter(m => m.provider === p).map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function ResearchSettings({
  researchIntensity, webSearchDepth, autoSaveSensitivity, subTaskModelTier, auditModel, auditVisionModel, auditConcurrency,
  onChangeIntensity, onChangeWebDepth, onChangeAutoSave, onChangeSubTaskModelTier, onChangeAuditModel, onChangeAuditVisionModel, onChangeAuditConcurrency,
}: Props) {
  return (
    <div className="space-y-7">
      {/* Literature Search Intensity */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Literature Search Intensity</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Controls how many papers are fetched per source and how thoroughly results are reviewed.
        </p>
        <SegmentedControl
          options={[
            { label: 'Low', value: 'low' as ResearchIntensity },
            { label: 'Medium', value: 'medium' as ResearchIntensity },
            { label: 'High', value: 'high' as ResearchIntensity },
          ]}
          value={researchIntensity}
          onChange={onChangeIntensity}
        />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">
          {researchIntensity === 'low' && 'Faster searches, fewer papers. Good for quick checks.'}
          {researchIntensity === 'medium' && 'Balanced coverage. Suitable for most research tasks.'}
          {researchIntensity === 'high' && 'Thorough searches with more papers per source. Best for comprehensive reviews.'}
        </p>
      </div>

      {/* Web Search Depth */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Web Search Depth</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Controls the number of results and how much content is fetched from each page.
        </p>
        <SegmentedControl
          options={[
            { label: 'Quick', value: 'quick' as WebSearchDepth },
            { label: 'Standard', value: 'standard' as WebSearchDepth },
            { label: 'Thorough', value: 'thorough' as WebSearchDepth },
          ]}
          value={webSearchDepth}
          onChange={onChangeWebDepth}
        />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">
          {webSearchDepth === 'quick' && 'Fewer results, smaller page fetches. Good for simple lookups.'}
          {webSearchDepth === 'standard' && 'Balanced results. Suitable for most searches.'}
          {webSearchDepth === 'thorough' && 'More results and larger page fetches. Best for deep research.'}
        </p>
      </div>

      {/* Auto-Save Sensitivity */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Auto-Save Sensitivity</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          How aggressively papers are auto-saved to your library based on relevance scores.
        </p>
        <SegmentedControl
          options={[
            { label: 'Conservative', value: 'conservative' as AutoSaveSensitivity },
            { label: 'Balanced', value: 'balanced' as AutoSaveSensitivity },
            { label: 'Aggressive', value: 'aggressive' as AutoSaveSensitivity },
          ]}
          value={autoSaveSensitivity}
          onChange={onChangeAutoSave}
        />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">
          {autoSaveSensitivity === 'conservative' && 'Only saves highly relevant papers. Keeps your library focused.'}
          {autoSaveSensitivity === 'balanced' && 'Saves papers with good relevance. A sensible default.'}
          {autoSaveSensitivity === 'aggressive' && 'Saves more papers for broader coverage. May include tangential results.'}
        </p>
      </div>

      {/* Sub-Task Model Tier */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Sub-Task Model</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Which model runs internal helper steps — literature relevance review, compute task-profiling
          and risk checks, and diagram review. Your chat and its summaries always use your selected model.
        </p>
        <SegmentedControl
          options={[
            { label: 'Light (cheaper)', value: 'light' as SubTaskModelTier },
            { label: 'Flagship', value: 'flagship' as SubTaskModelTier },
          ]}
          value={subTaskModelTier}
          onChange={onChangeSubTaskModelTier}
        />
        <p className="text-[11px] t-text-muted mt-2 leading-relaxed">
          {subTaskModelTier === 'light' && 'Routes these single-shot helper calls to a fast, low-cost model. Recommended — they are classification/extraction steps that gain nothing from the flagship model.'}
          {subTaskModelTier === 'flagship' && 'Runs every helper step on your main model. Higher cost and latency; use to A/B the quality difference.'}
        </p>
      </div>

      {/* Audit Model (§6.1) */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Audit Model</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Model for the process-faithfulness audit's text calls — claim extraction and prune
          adjudication. These are short, structured calls; a cheap small tier handles them well.
        </p>
        <AuditModelSelect value={auditModel} onChange={onChangeAuditModel} />
      </div>

      {/* Audit Vision Model (§6.1) */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Audit Vision Model</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          Model for audit escalation — verifying unresolved visual/semantic claims against recorded
          figures. Must be vision-capable, or the figure check silently fails.
        </p>
        <AuditModelSelect value={auditVisionModel} onChange={onChangeAuditVisionModel} visionOnly />
      </div>

      {/* Audit concurrency (§ Audit trace batch) */}
      <div>
        <h4 className="text-sm font-semibold t-text mb-2">Audit Concurrency</h4>
        <p className="text-[12px] t-text-muted mb-3 leading-relaxed">
          How many per-node audits run in parallel during “Audit trace”. Higher is faster but
          uses more API calls at once (watch rate limits).
        </p>
        <select
          value={String(auditConcurrency)}
          onChange={e => onChangeAuditConcurrency(Number(e.target.value))}
          className="w-full px-2 py-1.5 rounded-md border t-border-subtle t-bg-elevated t-text text-[12px]"
        >
          {[1, 2, 3, 5, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </div>
  )
}
