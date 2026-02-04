/**
 * Cost Calculator - Token cost calculation with cache discounts
 *
 * Calculates costs based on model pricing and cache utilization
 */

import type { DetailedTokenUsage, TokenCost, ProviderID } from './provider.types.js'
import { getModel } from './models.js'

/**
 * Cache discount rates by provider
 * These represent the percentage of normal price charged for cached tokens
 */
const CACHE_DISCOUNTS: Record<ProviderID, number> = {
  anthropic: 0.1,   // 90% discount for cached reads
  openai: 0.5,      // 50% discount for cached reads
  google: 0.25,     // 75% discount for Gemini context caching
  deepseek: 0.5     // 50% discount estimate
}

/**
 * Cache creation cost multiplier by provider
 * Some providers charge extra for writing to cache
 */
const CACHE_CREATION_MULTIPLIERS: Record<ProviderID, number> = {
  anthropic: 1.25,  // 25% premium for cache creation
  openai: 1.0,      // No premium
  google: 1.0,      // No premium
  deepseek: 1.0     // No premium
}

/**
 * Calculate cost for a single LLM call
 *
 * @param modelId - The model identifier
 * @param usage - Detailed token usage including cache info
 * @returns Cost breakdown
 */
export function calculateCost(modelId: string, usage: DetailedTokenUsage): TokenCost {
  const model = getModel(modelId)

  // Default to zero costs if model not found or no pricing info
  if (!model?.cost) {
    return {
      promptCost: 0,
      completionCost: 0,
      cachedReadCost: 0,
      cacheCreationCost: 0,
      totalCost: 0,
      modelId
    }
  }

  const provider = model.providerID
  const inputPricePerMillion = model.cost.input
  const outputPricePerMillion = model.cost.output

  // Get cache discount and creation multiplier for this provider
  const cacheDiscount = CACHE_DISCOUNTS[provider] ?? 0.5
  const cacheCreationMultiplier = CACHE_CREATION_MULTIPLIERS[provider] ?? 1.0

  // Extract cache token counts (default to 0)
  const cacheCreationTokens = usage.cacheCreationInputTokens ?? 0
  const cacheReadTokens = usage.cacheReadInputTokens ?? 0

  // Calculate non-cached prompt tokens
  // Total prompt = cached read + cached creation + regular (uncached)
  // Regular = total prompt - cached read - cached creation
  const regularPromptTokens = Math.max(0, usage.promptTokens - cacheReadTokens - cacheCreationTokens)

  // Calculate costs (price is per million tokens)
  const promptCost = (regularPromptTokens / 1_000_000) * inputPricePerMillion
  const completionCost = (usage.completionTokens / 1_000_000) * outputPricePerMillion
  const cachedReadCost = (cacheReadTokens / 1_000_000) * inputPricePerMillion * cacheDiscount
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * inputPricePerMillion * cacheCreationMultiplier

  const totalCost = promptCost + completionCost + cachedReadCost + cacheCreationCost

  return {
    promptCost,
    completionCost,
    cachedReadCost,
    cacheCreationCost,
    totalCost,
    modelId
  }
}

/**
 * Aggregate multiple cost records into a single summary
 *
 * @param costs - Array of cost records to aggregate
 * @returns Aggregated cost breakdown
 */
export function aggregateCosts(costs: TokenCost[]): TokenCost {
  if (costs.length === 0) {
    return {
      promptCost: 0,
      completionCost: 0,
      cachedReadCost: 0,
      cacheCreationCost: 0,
      totalCost: 0,
      modelId: ''
    }
  }

  // Use the most recent model ID
  const modelId = costs[costs.length - 1]?.modelId ?? ''

  return {
    promptCost: costs.reduce((sum, c) => sum + c.promptCost, 0),
    completionCost: costs.reduce((sum, c) => sum + c.completionCost, 0),
    cachedReadCost: costs.reduce((sum, c) => sum + c.cachedReadCost, 0),
    cacheCreationCost: costs.reduce((sum, c) => sum + c.cacheCreationCost, 0),
    totalCost: costs.reduce((sum, c) => sum + c.totalCost, 0),
    modelId
  }
}

/**
 * Aggregate multiple token usage records
 *
 * @param usages - Array of token usage records
 * @returns Aggregated usage
 */
export function aggregateUsage(usages: DetailedTokenUsage[]): DetailedTokenUsage {
  return {
    promptTokens: usages.reduce((sum, u) => sum + u.promptTokens, 0),
    completionTokens: usages.reduce((sum, u) => sum + u.completionTokens, 0),
    totalTokens: usages.reduce((sum, u) => sum + u.totalTokens, 0),
    cacheCreationInputTokens: usages.reduce((sum, u) => sum + (u.cacheCreationInputTokens ?? 0), 0),
    cacheReadInputTokens: usages.reduce((sum, u) => sum + (u.cacheReadInputTokens ?? 0), 0),
    reasoningTokens: usages.reduce((sum, u) => sum + (u.reasoningTokens ?? 0), 0)
  }
}

/**
 * Calculate cache hit rate from usage
 *
 * @param usage - Token usage
 * @returns Cache hit rate (0-1)
 */
export function calculateCacheHitRate(usage: DetailedTokenUsage): number {
  if (usage.promptTokens === 0) return 0
  const cacheReadTokens = usage.cacheReadInputTokens ?? 0
  return cacheReadTokens / usage.promptTokens
}

/**
 * Format cost as human-readable string
 *
 * @param cost - Cost in USD
 * @returns Formatted string like "$0.0012"
 */
export function formatCost(cost: number): string {
  if (cost < 0.0001) return '$0.0000'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/**
 * Format token count as human-readable string
 *
 * @param tokens - Token count
 * @returns Formatted string like "1.2K" or "150"
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return tokens.toString()
}
