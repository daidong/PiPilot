// ---------------------------------------------------------------------------
// Unified app settings — stored in ~/.research-copilot/config.json
// ---------------------------------------------------------------------------

// ── Research settings ───────────────────────────────────────────────────────

export type ResearchIntensity = 'low' | 'medium' | 'high'
export type WebSearchDepth = 'quick' | 'standard' | 'thorough'
export type AutoSaveSensitivity = 'conservative' | 'balanced' | 'aggressive'

export interface ResearchSettings {
  researchIntensity: ResearchIntensity
  webSearchDepth: WebSearchDepth
  autoSaveSensitivity: AutoSaveSensitivity
}

// ── Data analysis settings ──────────────────────────────────────────────────

export type DataAnalysisTimeout = 'short' | 'standard' | 'extended' | 'long'

export interface DataAnalysisSettings {
  executionTimeLimit: DataAnalysisTimeout
}

// ── Wiki agent settings ────────────────────────────────────────────────────

export type WikiAgentSpeed = 'slow' | 'medium' | 'fast'

export interface WikiAgentSettings {
  /** Model ID (e.g., 'anthropic:claude-opus-4-7'). 'none' = disabled. */
  model: string
  /** Processing speed preset */
  speed: WikiAgentSpeed
}

export interface WikiPacingConfig {
  papersPerCycle: number
  cycleCooldownMs: number
  interCallDelayMs: number
  idleScanIntervalMs: number
  startupDelayMs: number
}

export function resolveWikiPacing(speed: WikiAgentSpeed): WikiPacingConfig {
  switch (speed) {
    case 'slow':   return { papersPerCycle: 1, cycleCooldownMs: 600_000, interCallDelayMs: 8_000, idleScanIntervalMs: 120_000, startupDelayMs: 60_000 }
    case 'medium': return { papersPerCycle: 2, cycleCooldownMs: 300_000, interCallDelayMs: 5_000, idleScanIntervalMs: 120_000, startupDelayMs: 60_000 }
    case 'fast':   return { papersPerCycle: 3, cycleCooldownMs: 120_000, interCallDelayMs: 3_000, idleScanIntervalMs: 120_000, startupDelayMs: 60_000 }
  }
}

// ── Diagram generation settings ─────────────────────────────────────────────

/**
 * Image generation for generate_diagram currently has one backend (OpenAI
 * gpt-image-2). Review can use either GPT-4o or Claude; `auto` prefers
 * heterogeneous review (Anthropic when both keys are present, so the
 * generator does not grade its own family).
 */
export type DiagramReviewProvider = 'auto' | 'openai' | 'anthropic'

export interface DiagramSettings {
  reviewProvider: DiagramReviewProvider
}

// ── Compute settings (RFC-008 §7.7) ────────────────────────────────────────
//
// Replaces the PR #62 `modalCompute` top-level field. Per-backend
// settings live under `compute.backends[id]`; global compute behavior
// (force-approval override) lives at the top of `compute`.

export interface BackendSettings {
  /** Per-backend cost-kill threshold in USD. Honored only by backends with capabilities.hasCost. */
  costThresholdUsd?: number
  /** Backend-specific extras (forward-compat for AWS account, GCP project, etc.). */
  [extra: string]: unknown
}

export interface ComputeSettings {
  /**
   * Backend ids that the registry should register at coordinator
   * construction. Empty array = no backends registered (compute
   * effectively off even when ENABLE_LOCAL_COMPUTE=1).
   */
  enabledBackends: string[]
  /** Default backend id pre-selected in the UI. */
  defaultBackend: string
  /**
   * Global override: every plan goes through the approval gate
   * regardless of the backend's capabilities.requiresApproval. Used
   * by shared-lab / audit-compliance setups.
   */
  requireApprovalForAllBackends: boolean
  /** Per-backend bag. Modal lives at `backends.modal`. */
  backends: Record<string, BackendSettings>
}

// ── Combined ────────────────────────────────────────────────────────────────

export interface AppSettings {
  research: ResearchSettings
  dataAnalysis: DataAnalysisSettings
  wikiAgent: WikiAgentSettings
  diagram: DiagramSettings
  compute: ComputeSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  research: {
    researchIntensity: 'medium',
    webSearchDepth: 'standard',
    autoSaveSensitivity: 'balanced',
  },
  dataAnalysis: {
    executionTimeLimit: 'standard',
  },
  wikiAgent: {
    model: 'none',
    speed: 'medium',
  },
  diagram: {
    reviewProvider: 'auto',
  },
  compute: {
    enabledBackends: ['local', 'modal', 'aws-ec2'],
    defaultBackend: 'local',
    requireApprovalForAllBackends: false,
    backends: {
      modal: { costThresholdUsd: 5.00 },
      'aws-ec2': { costThresholdUsd: 5.00, region: 'us-east-1' },
    },
  },
}

// ── Resolved numeric types (consumed by tools via ResearchToolContext) ───────

export interface ResolvedResearchIntensity {
  perSourceLimit: number
  reviewCap: number
  sleepMs: number
}

export interface ResolvedWebSearch {
  defaultSearchCount: number
  maxSearchCount: number
  defaultFetchMaxChars: number
  defaultFetchTimeoutMs: number
}

export interface ResolvedSettings {
  researchIntensity: ResolvedResearchIntensity
  webSearch: ResolvedWebSearch
  dataAnalysis: { timeoutMs: number }
  autoSaveThreshold: number
  diagram: { reviewProvider: DiagramReviewProvider }
  compute: {
    enabledBackends: string[]
    defaultBackend: string
    requireApprovalForAllBackends: boolean
    backends: Record<string, BackendSettings>
  }
}

// ── Resolver functions ──────────────────────────────────────────────────────

export function resolveResearchIntensity(level: ResearchIntensity): ResolvedResearchIntensity {
  switch (level) {
    case 'low':    return { perSourceLimit: 5,  reviewCap: 10, sleepMs: 1000 }
    case 'medium': return { perSourceLimit: 10, reviewCap: 25, sleepMs: 500 }
    case 'high':   return { perSourceLimit: 20, reviewCap: 50, sleepMs: 300 }
  }
}

export function resolveWebSearchDepth(level: WebSearchDepth): ResolvedWebSearch {
  switch (level) {
    case 'quick':    return { defaultSearchCount: 3,  maxSearchCount: 5,  defaultFetchMaxChars: 20_000,  defaultFetchTimeoutMs: 15_000 }
    case 'standard': return { defaultSearchCount: 5,  maxSearchCount: 10, defaultFetchMaxChars: 50_000,  defaultFetchTimeoutMs: 30_000 }
    case 'thorough': return { defaultSearchCount: 10, maxSearchCount: 20, defaultFetchMaxChars: 100_000, defaultFetchTimeoutMs: 45_000 }
  }
}

export function resolveAutoSaveThreshold(level: AutoSaveSensitivity): number {
  switch (level) {
    case 'conservative': return 9
    case 'balanced':     return 7
    case 'aggressive':   return 5
  }
}

export function resolveDataAnalysisTimeout(level: DataAnalysisTimeout): number {
  switch (level) {
    case 'short':    return 60_000
    case 'standard': return 120_000
    case 'extended': return 300_000
    case 'long':     return 600_000
  }
}

/** Resolve friendly AppSettings into numeric values for tool runtime. */
export function resolveSettings(settings: AppSettings): ResolvedSettings {
  return {
    researchIntensity: resolveResearchIntensity(settings.research.researchIntensity),
    webSearch: resolveWebSearchDepth(settings.research.webSearchDepth),
    dataAnalysis: { timeoutMs: resolveDataAnalysisTimeout(settings.dataAnalysis.executionTimeLimit) },
    autoSaveThreshold: resolveAutoSaveThreshold(settings.research.autoSaveSensitivity),
    diagram: { reviewProvider: settings.diagram?.reviewProvider ?? 'auto' },
    compute: settings.compute ?? DEFAULT_SETTINGS.compute,
  }
}
