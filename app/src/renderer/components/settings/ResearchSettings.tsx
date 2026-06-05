import React from 'react'
import { SegmentedControl } from './SegmentedControl'
import type { ResearchIntensity, WebSearchDepth, AutoSaveSensitivity, SubTaskModelTier } from '../../../../../shared-ui/settings-types'

interface Props {
  researchIntensity: ResearchIntensity
  webSearchDepth: WebSearchDepth
  autoSaveSensitivity: AutoSaveSensitivity
  subTaskModelTier: SubTaskModelTier
  onChangeIntensity: (v: ResearchIntensity) => void
  onChangeWebDepth: (v: WebSearchDepth) => void
  onChangeAutoSave: (v: AutoSaveSensitivity) => void
  onChangeSubTaskModelTier: (v: SubTaskModelTier) => void
}

export function ResearchSettings({
  researchIntensity, webSearchDepth, autoSaveSensitivity, subTaskModelTier,
  onChangeIntensity, onChangeWebDepth, onChangeAutoSave, onChangeSubTaskModelTier,
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
    </div>
  )
}
