/**
 * Tool Recommender - Tool Recommendation Engine
 *
 * Recommends tools and MCP servers based on agent descriptions
 * using multi-signal scoring with human-readable reasons.
 */

import {
  getPackCatalog,
  scorePacksByQuery,
  formatToolCatalogForLLM,
  type PackCatalogEntry
} from './tool-catalog.js'

import {
  getMCPCatalog,
  scoreMCPByQuery,
  formatMCPCatalogForLLM,
  collectEnvVars,
  hasParameterizedConfig,
  type MCPServerEntry
} from './mcp-catalog.js'

import type { ScoredRecommendation } from './scorer.js'
import type { LLMClient } from '../agent/agent-loop.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Tool recommendation with scoring info
 */
export interface ToolRecommendation {
  name: string
  reason: string
  confidence: number  // 0-1
  riskLevel: 'safe' | 'elevated' | 'high'
  providedBy: string
  matchReasons?: string[]
}

/**
 * MCP server recommendation with scoring info
 */
export interface MCPRecommendation {
  name: string
  package: string
  reason: string
  confidence: number
  riskLevel: 'safe' | 'elevated' | 'high'
  envVars?: string[]
  installCommand: string
  matchReasons?: string[]
  requiresParameters?: boolean
}

/**
 * Pack recommendation with scoring info
 */
export interface PackRecommendation {
  name: string
  reason: string
  confidence: number
  riskLevel: 'safe' | 'elevated' | 'high'
  tools: string[]
  matchReasons?: string[]
}

/**
 * Complete recommendation result
 */
export interface RecommendationResult {
  /** Recommended Packs */
  packs: PackRecommendation[]

  /** Recommended MCP servers */
  mcpServers: MCPRecommendation[]

  /** Required environment variables */
  requiredEnvVars: Record<string, string>

  /** Warning messages */
  warnings: string[]

  /** Understood requirements */
  understoodRequirements: string[]
}

/**
 * Recommender configuration
 */
export interface RecommenderConfig {
  /** Maximum recommendations per category */
  maxRecommendations?: number

  /** Minimum confidence threshold */
  minConfidence?: number

  /** Include high-risk tools */
  includeHighRisk?: boolean

  /** Include MCP servers */
  includeMCP?: boolean
}

const DEFAULT_CONFIG: Required<RecommenderConfig> = {
  maxRecommendations: 10,
  minConfidence: 0.3,
  includeHighRisk: false,
  includeMCP: true
}

// ============================================================================
// Recommender Class
// ============================================================================

/**
 * Tool Recommender
 */
export class ToolRecommender {
  private config: Required<RecommenderConfig>

  constructor(
    private llmClient?: LLMClient,
    config?: RecommenderConfig
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Recommend tools based on description
   */
  async recommend(description: string): Promise<RecommendationResult> {
    // Step 1: Score-based matching
    const scoredPacks = scorePacksByQuery(description, {
      minScore: this.config.minConfidence,
      limit: this.config.maxRecommendations
    })

    const scoredMCP = this.config.includeMCP
      ? scoreMCPByQuery(description, {
          minScore: this.config.minConfidence,
          limit: this.config.maxRecommendations
        })
      : []

    // Step 2: If LLM client available, enhance with LLM analysis
    if (this.llmClient) {
      return this.llmRecommend(description, scoredPacks, scoredMCP)
    }

    // Step 3: Score-based only recommendation
    return this.scoringOnlyRecommend(description, scoredPacks, scoredMCP)
  }

  /**
   * Score-based recommendation (no LLM)
   */
  private scoringOnlyRecommend(
    _description: string,
    scoredPacks: ScoredRecommendation<PackCatalogEntry>[],
    scoredMCP: ScoredRecommendation<MCPServerEntry>[]
  ): RecommendationResult {
    // Always include safe pack
    const packs: PackRecommendation[] = [{
      name: 'safe',
      reason: 'Basic file operations (always recommended)',
      confidence: 1.0,
      riskLevel: 'safe',
      tools: ['read', 'write', 'edit', 'glob', 'grep', 'ctx-get'],
      matchReasons: ['Core operations for any agent']
    }]

    // Add scored packs
    for (const scored of scoredPacks) {
      if (scored.entry.name === 'safe') continue
      if (!this.config.includeHighRisk && scored.entry.riskLevel === 'high') continue

      packs.push({
        name: scored.entry.name,
        reason: scored.reasons[0] || scored.entry.description,
        confidence: scored.score,
        riskLevel: scored.entry.riskLevel,
        tools: scored.entry.tools,
        matchReasons: scored.reasons
      })
    }

    // MCP recommendations
    const mcpServers: MCPRecommendation[] = []
    for (const scored of scoredMCP) {
      if (!this.config.includeHighRisk && scored.entry.riskLevel === 'high') continue

      mcpServers.push({
        name: scored.entry.name,
        package: scored.entry.package,
        reason: scored.reasons[0] || scored.entry.description,
        confidence: scored.score,
        riskLevel: scored.entry.riskLevel,
        envVars: scored.entry.envVars,
        installCommand: scored.entry.installCommand,
        matchReasons: scored.reasons,
        requiresParameters: hasParameterizedConfig(scored.entry)
      })
    }

    // Collect environment variables
    const recommendedServers = scoredMCP
      .filter(s => mcpServers.some(r => r.name === s.entry.name))
      .map(s => s.entry)
    const requiredEnvVars = collectEnvVars(recommendedServers)

    // Generate warnings
    const warnings: string[] = []
    if (mcpServers.some(s => s.requiresParameters)) {
      warnings.push('Some MCP servers require configuration (e.g., filesystem directories)')
    }
    if (mcpServers.some(s => s.riskLevel === 'high')) {
      warnings.push('High-risk MCP servers recommended - review carefully')
    }
    if (packs.some(p => p.riskLevel === 'high')) {
      warnings.push('High-risk packs recommended - review carefully')
    }

    return {
      packs: packs.slice(0, this.config.maxRecommendations),
      mcpServers: mcpServers.slice(0, this.config.maxRecommendations),
      requiredEnvVars,
      warnings,
      understoodRequirements: ['Based on keyword scoring (LLM analysis not used)']
    }
  }

  /**
   * LLM-enhanced recommendation
   */
  private async llmRecommend(
    description: string,
    scoredPacks: ScoredRecommendation<PackCatalogEntry>[],
    scoredMCP: ScoredRecommendation<MCPServerEntry>[]
  ): Promise<RecommendationResult> {
    const prompt = this.buildRecommendationPrompt(description)

    try {
      const response = await this.llmClient!.generate({
        system: RECOMMENDER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2000
      })

      return this.parseRecommendation(response.text, description, scoredPacks, scoredMCP)
    } catch (error) {
      // LLM failed, fallback to scoring
      console.warn('[Recommender] LLM call failed, using scoring:', error)
      return this.scoringOnlyRecommend(description, scoredPacks, scoredMCP)
    }
  }

  /**
   * Build recommendation prompt
   */
  private buildRecommendationPrompt(description: string): string {
    return `
Please analyze the following agent description and recommend appropriate tools and MCP servers.

## Agent Description
${description}

## Available Packs
${formatToolCatalogForLLM()}

## Available MCP Servers
${formatMCPCatalogForLLM()}

## Requirements
1. Analyze the description and list understood requirements
2. Recommend necessary Packs (prefer built-in tools)
3. Recommend useful MCP servers (if built-in tools are insufficient)
4. Explain the reason for each recommendation
5. List any security warnings

Return as JSON:
{
  "understoodRequirements": ["requirement1", "requirement2"],
  "packs": [
    {"name": "pack-name", "reason": "recommendation reason", "confidence": 0.9}
  ],
  "mcpServers": [
    {"name": "server-name", "reason": "recommendation reason", "confidence": 0.8}
  ],
  "warnings": ["warning message"]
}
`
  }

  /**
   * Parse LLM response
   */
  private parseRecommendation(
    text: string,
    description: string,
    scoredPacks: ScoredRecommendation<PackCatalogEntry>[],
    scoredMCP: ScoredRecommendation<MCPServerEntry>[]
  ): RecommendationResult {
    const packCatalog = getPackCatalog()
    const mcpCatalog = getMCPCatalog()

    try {
      // Try to extract JSON
      let jsonText = text
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
      if (jsonMatch && jsonMatch[1]) {
        jsonText = jsonMatch[1]
      }

      const parsed = JSON.parse(jsonText) as {
        understoodRequirements?: string[]
        packs?: Array<{ name: string; reason: string; confidence: number }>
        mcpServers?: Array<{ name: string; reason: string; confidence: number }>
        warnings?: string[]
      }

      // Convert to full recommendation result
      const packs: PackRecommendation[] = []
      for (const rec of parsed.packs || []) {
        const pack = packCatalog.find(p => p.name === rec.name)
        if (pack && rec.confidence >= this.config.minConfidence) {
          if (!this.config.includeHighRisk && pack.riskLevel === 'high') continue

          // Merge with scoring reasons if available
          const scored = scoredPacks.find(s => s.entry.name === rec.name)

          packs.push({
            name: rec.name,
            reason: rec.reason,
            confidence: rec.confidence,
            riskLevel: pack.riskLevel,
            tools: pack.tools,
            matchReasons: scored?.reasons
          })
        }
      }

      // Ensure safe pack is always present
      if (!packs.some(p => p.name === 'safe')) {
        const safePack = packCatalog.find(p => p.name === 'safe')!
        packs.unshift({
          name: 'safe',
          reason: 'Basic file operations (always recommended)',
          confidence: 1.0,
          riskLevel: 'safe',
          tools: safePack.tools,
          matchReasons: ['Core operations for any agent']
        })
      }

      const mcpServers: MCPRecommendation[] = []
      for (const rec of parsed.mcpServers || []) {
        const server = mcpCatalog.find(s => s.name === rec.name)
        if (server && rec.confidence >= this.config.minConfidence) {
          if (!this.config.includeHighRisk && server.riskLevel === 'high') continue

          // Merge with scoring reasons if available
          const scored = scoredMCP.find(s => s.entry.name === rec.name)

          mcpServers.push({
            name: rec.name,
            package: server.package,
            reason: rec.reason,
            confidence: rec.confidence,
            riskLevel: server.riskLevel,
            envVars: server.envVars,
            installCommand: server.installCommand,
            matchReasons: scored?.reasons,
            requiresParameters: hasParameterizedConfig(server)
          })
        }
      }

      // Collect environment variables
      const recommendedServers = mcpCatalog.filter(s =>
        mcpServers.some(r => r.name === s.name)
      )
      const requiredEnvVars = collectEnvVars(recommendedServers)

      // Merge warnings
      const warnings = [...(parsed.warnings || [])]
      if (mcpServers.some(s => s.requiresParameters)) {
        warnings.push('Some MCP servers require configuration (e.g., filesystem directories)')
      }

      return {
        packs: packs.slice(0, this.config.maxRecommendations),
        mcpServers: mcpServers.slice(0, this.config.maxRecommendations),
        requiredEnvVars,
        warnings,
        understoodRequirements: parsed.understoodRequirements || []
      }
    } catch (error) {
      // Parse failed, use scoring
      console.warn('[Recommender] Failed to parse LLM response:', error)
      return this.scoringOnlyRecommend(description, scoredPacks, scoredMCP)
    }
  }

  /**
   * Refine recommendation based on user feedback
   */
  async refineWithFeedback(
    current: RecommendationResult,
    feedback: string
  ): Promise<RecommendationResult> {
    if (!this.llmClient) {
      // No LLM, can't refine
      return current
    }

    const prompt = `
Current recommended configuration:

Packs:
${current.packs.map(p => `- ${p.name}: ${p.reason}`).join('\n')}

MCP Servers:
${current.mcpServers.map(s => `- ${s.name}: ${s.reason}`).join('\n')}

User feedback:
${feedback}

## Available Packs
${formatToolCatalogForLLM()}

## Available MCP Servers
${formatMCPCatalogForLLM()}

Please adjust recommendations based on user feedback. Return JSON:
{
  "understoodRequirements": ["updated requirements"],
  "packs": [{"name": "pack-name", "reason": "reason", "confidence": 0.9}],
  "mcpServers": [{"name": "server-name", "reason": "reason", "confidence": 0.8}],
  "warnings": ["warning message"],
  "changes": "explanation of changes"
}
`

    try {
      const response = await this.llmClient.generate({
        system: RECOMMENDER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2000
      })

      // Re-score for merging
      const scoredPacks = scorePacksByQuery(feedback)
      const scoredMCP = this.config.includeMCP ? scoreMCPByQuery(feedback) : []

      return this.parseRecommendation(response.text, feedback, scoredPacks, scoredMCP)
    } catch (error) {
      console.warn('[Recommender] Feedback refinement failed:', error)
      return current
    }
  }
}

// ============================================================================
// System Prompt
// ============================================================================

const RECOMMENDER_SYSTEM_PROMPT = `
You are the Agent Foundry tool recommendation assistant. Your task is to recommend appropriate tools and MCP servers based on user agent descriptions.

Principles:
1. Least privilege - Only recommend necessary tools, don't over-recommend
2. Security first - High-risk tools (exec) need clear justification
3. Built-in first - Prefer built-in Packs, MCP as supplement
4. Explain clearly - Each recommendation should have a specific reason

Notes:
- safe pack contains basic file operations, almost all agents need it
- compute pack contains LLM tools, suitable for text processing scenarios
- network pack contains HTTP requests, suitable for API calls
- exec pack contains bash, only recommend when commands are needed
- web pack contains Brave Search + fetch, suitable for web search and page retrieval (requires BRAVE_API_KEY)

MCP Servers:
- Only recommend when built-in tools are insufficient
- Note required environment variables
- Prefer high-popularity (⭐) servers
`

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a recommender instance
 */
export function createRecommender(
  llmClient?: LLMClient,
  config?: RecommenderConfig
): ToolRecommender {
  return new ToolRecommender(llmClient, config)
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export {
  getPackCatalog,
  scorePacksByQuery,
  scoreToolsByQuery
} from './tool-catalog.js'

export {
  getMCPCatalog,
  scoreMCPByQuery
} from './mcp-catalog.js'
