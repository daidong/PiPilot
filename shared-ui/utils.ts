// Mirrors lib/models.ts:inferProviderFromModelId — kept inline because
// shared-ui can't import from lib (cross-rootDir). Sync when updating either.
const BARE_MODEL_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['gemini-', 'google'],
  ['deepseek-', 'deepseek'],
]

function inferProviderFromModelId(modelId: string): string | null {
  for (const [prefix, provider] of BARE_MODEL_PREFIXES) {
    if (modelId.startsWith(prefix)) return provider
  }
  return null
}

/**
 * Parse a composite model key like 'openai:gpt-5.4' into provider + modelId.
 * Falls back to inferring provider from model name for backward compatibility.
 */
export function parseModelKey(key: string): { provider: string; modelId: string } {
  const i = key.indexOf(':')
  if (i > 0) return { provider: key.slice(0, i), modelId: key.slice(i + 1) }
  // Legacy fallback: `openai` matches the historical default for unknown ids.
  return { provider: inferProviderFromModelId(key) ?? 'openai', modelId: key }
}

/**
 * Build a composite model key from provider + modelId.
 */
export function buildModelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}
