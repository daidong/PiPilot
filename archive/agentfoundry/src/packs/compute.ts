/**
 * compute - Compute capability pack (cost-sensitive)
 *
 * Features:
 * - Requires explicit enablement
 * - Token quota control
 * - Cost monitoring
 *
 * Migration to Skills:
 * - useSkills defaults to true for lazy-loaded skills
 * - Set useSkills: false to use legacy promptFragment (backward compatibility)
 * - Skills reduce initial token usage by ~350 tokens (94% on first load)
 * - Skills load automatically when llm-* tools are first used
 */

import { definePack } from '../factories/define-pack.js'
import { defineGuardPolicy, defineMutatePolicy, defineAuditPolicy } from '../factories/define-policy.js'
import type { Pack } from '../types/pack.js'
import type { Policy } from '../types/policy.js'
import { llmCall, llmExpand, llmFilter } from '../tools/index.js'
import { llmComputeSkill } from '../skills/builtin/index.js'

/**
 * Compute Pack configuration options
 */
export interface ComputePackOptions {
  /**
   * Maximum tokens per call
   * Default: 4000
   */
  maxTokensPerCall?: number

  /**
   * Session total token quota
   * Default: 100000
   */
  sessionTokenQuota?: number

  /**
   * Allowed model list (if restriction is needed)
   */
  allowModels?: string[]

  /**
   * Whether JSON mode is allowed
   * Default: true
   */
  allowJsonMode?: boolean

  /**
   * Temperature limit range
   */
  temperatureRange?: {
    min: number
    max: number
  }

  /**
   * Whether approval is required
   * Default: false
   */
  requireApproval?: boolean

  /**
   * Use Skills instead of promptFragment for token optimization
   * When true, uses lazy-loaded llmComputeSkill instead of inline promptFragment
   * @default true
   */
  useSkills?: boolean
}

/**
 * Session token usage tracker
 */
const sessionTokenUsage = new Map<string, number>()

/**
 * Get session token usage
 */
export function getSessionTokenUsage(sessionId: string): number {
  return sessionTokenUsage.get(sessionId) ?? 0
}

/**
 * Reset session token usage
 */
export function resetSessionTokenUsage(sessionId: string): void {
  sessionTokenUsage.delete(sessionId)
}

/**
 * Create a token limit policy (Mutate)
 */
function createMaxTokensPolicy(maxTokens: number): Policy {
  return defineMutatePolicy({
    id: 'compute:max-tokens',
    description: 'Limit the maximum tokens per single call',
    priority: 50,
    match: (ctx) => ctx.tool === 'llm-call',
    transforms: [
      { op: 'clamp', path: 'maxTokens', max: maxTokens }
    ]
  })
}

/**
 * Create a session quota policy
 */
function createQuotaPolicy(quota: number): Policy {
  return defineGuardPolicy({
    id: 'compute:session-quota',
    description: 'Limit the total session token quota',
    priority: 10,
    match: (ctx) => ctx.tool === 'llm-call',
    decide: (ctx) => {
      const used = sessionTokenUsage.get(ctx.sessionId) ?? 0
      const requested = (ctx.input as { maxTokens?: number })?.maxTokens ?? 1000

      if (used + requested > quota) {
        return {
          action: 'deny',
          reason: `Token quota exhausted: ${used}/${quota}, requested ${requested}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * Create a temperature limit policy
 */
function createTemperaturePolicy(range: { min: number; max: number }): Policy {
  return defineMutatePolicy({
    id: 'compute:temperature-limit',
    description: 'Limit the temperature parameter range',
    priority: 50,
    match: (ctx) => ctx.tool === 'llm-call',
    transforms: [
      { op: 'clamp', path: 'temperature', min: range.min, max: range.max }
    ]
  })
}

/**
 * Create a JSON mode disable policy
 */
function createNoJsonModePolicy(): Policy {
  return defineMutatePolicy({
    id: 'compute:no-json-mode',
    description: 'Disable JSON mode',
    priority: 50,
    match: (ctx) => ctx.tool === 'llm-call',
    transforms: [
      { op: 'set', path: 'jsonMode', value: false }
    ]
  })
}

/**
 * Create an approval policy
 */
function createApprovalPolicy(): Policy {
  return defineGuardPolicy({
    id: 'compute:approval',
    description: 'Require approval for LLM calls',
    priority: 20,
    match: (ctx) => ctx.tool === 'llm-call',
    decide: (ctx) => {
      const input = ctx.input as { prompt?: string; maxTokens?: number }
      const promptPreview = (input.prompt ?? '').slice(0, 100)
      return {
        action: 'require_approval',
        message: `LLM call approval:\nPrompt: ${promptPreview}...\nMax tokens: ${input.maxTokens ?? 1000}`,
        timeout: 60000
      }
    }
  })
}

/**
 * Create an LLM audit policy
 */
function createLlmAuditPolicy(): Policy {
  return defineAuditPolicy({
    id: 'compute:audit',
    description: 'Audit all LLM calls',
    priority: 100,
    match: (ctx) => ctx.tool === 'llm-call',
    record: (ctx) => {
      const input = ctx.input as {
        prompt?: string
        systemPrompt?: string
        maxTokens?: number
        temperature?: number
        jsonMode?: boolean
      }

      // Update token usage (in the observe phase, result may contain actual usage)
      const result = ctx.result as { data?: { usage?: { totalTokens?: number } } } | undefined
      const tokensUsed = result?.data?.usage?.totalTokens ?? input.maxTokens ?? 1000

      const currentUsage = sessionTokenUsage.get(ctx.sessionId) ?? 0
      sessionTokenUsage.set(ctx.sessionId, currentUsage + tokensUsed)

      return {
        tool: ctx.tool,
        promptLength: input.prompt?.length ?? 0,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        jsonMode: input.jsonMode,
        tokensUsed,
        sessionTotalTokens: currentUsage + tokensUsed,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        step: ctx.step,
        timestamp: new Date().toISOString()
      }
    }
  })
}

/**
 * Compute Pack - Compute capability pack
 *
 * Included tools:
 * - llm-call: LLM sub-call
 *
 * Default policies:
 * - Per-call token limit
 * - Session token quota
 * - Audit all calls
 */
export function compute(options: ComputePackOptions = {}): Pack {
  const {
    maxTokensPerCall = 4000,
    sessionTokenQuota = 100000,
    temperatureRange,
    allowJsonMode = true,
    requireApproval = false,
    useSkills = true
  } = options

  const policies: Policy[] = []

  // Token limit policy
  policies.push(createMaxTokensPolicy(maxTokensPerCall))

  // Session quota policy
  policies.push(createQuotaPolicy(sessionTokenQuota))

  // Temperature limit policy
  if (temperatureRange) {
    policies.push(createTemperaturePolicy(temperatureRange))
  }

  // JSON mode disable policy
  if (!allowJsonMode) {
    policies.push(createNoJsonModePolicy())
  }

  // Approval policy
  if (requireApproval) {
    policies.push(createApprovalPolicy())
  }

  // Audit policy
  policies.push(createLlmAuditPolicy())

  // Build pack with either skills (new) or promptFragment (legacy)
  if (useSkills) {
    // New Skills-based approach: lazy loading for token optimization
    // Only ~60 tokens loaded initially vs ~400 tokens with promptFragment
    return definePack({
      id: 'compute',
      description: 'Compute capability pack: llm-call, llm-expand, llm-filter (requires explicit enablement)',

      tools: [llmCall as any, llmExpand as any, llmFilter as any],

      policies,

      skills: [llmComputeSkill],
      skillLoadingConfig: {
        lazy: ['llm-compute-skill'] // Loads when llm-* tools are first used
      },

      // Note: promptFragment omitted - skills replace it
      // Runtime quota info can be added to skill via runtime configuration

      onDestroy: async (_runtime) => {
        // Clean up session token usage records
      }
    })
  }

  // Legacy promptFragment approach (for backward compatibility)
  return definePack({
    id: 'compute',
    description: 'Compute capability pack: llm-call, llm-expand, llm-filter (requires explicit enablement)',

    tools: [llmCall as any, llmExpand as any, llmFilter as any],

    policies,

    promptFragment: `
## LLM Compute Capabilities

### llm-call Tool
Perform raw LLM sub-calls for:
- Custom prompt tasks
- Text classification
- Summary generation
- Structured data extraction

### llm-expand Tool
Text expansion, generating multiple variants:
- style: "search" - Search query optimization (default)
- style: "synonyms" - Synonym generation
- style: "rephrase" - Multi-perspective rephrasing
- domain: Domain hint (e.g., "academic", "technical")

### llm-filter Tool
Relevance filtering, scoring and filtering lists:
- Scores each item 0-10 against the query
- minScore: Minimum score threshold (default 5)
- maxItems: Maximum number of results (default 10)
- Returns sorted high-relevance items

### Quota Limits
- Per call: Up to ${maxTokensPerCall} tokens
- Session quota: ${sessionTokenQuota} tokens
${temperatureRange ? `- Temperature range: ${temperatureRange.min} - ${temperatureRange.max}` : ''}
${!allowJsonMode ? '- JSON mode is disabled' : ''}

### Best Practices
1. Prefer llm-expand/llm-filter over custom prompts
2. Set reasonable maxTokens to avoid waste
3. Break complex tasks into multiple smaller calls
4. llm-filter is ideal for filtering search results
    `.trim(),

    onDestroy: async (_runtime) => {
      // Clean up session token usage records
      // Note: additional cleanup logic can be added here
    }
  })
}

/**
 * Alias: computePack
 */
export const computePack = compute

/**
 * Preset: Economy mode (low quota)
 */
export function computeEconomy(): Pack {
  return compute({
    maxTokensPerCall: 1000,
    sessionTokenQuota: 10000,
    temperatureRange: { min: 0, max: 0.7 }
  })
}

/**
 * Preset: Standard mode
 */
export function computeStandard(): Pack {
  return compute({
    maxTokensPerCall: 4000,
    sessionTokenQuota: 100000
  })
}

/**
 * Preset: Premium mode (high quota)
 */
export function computePremium(): Pack {
  return compute({
    maxTokensPerCall: 8000,
    sessionTokenQuota: 500000
  })
}

/**
 * Preset: Approval mode
 */
export function computeWithApproval(): Pack {
  return compute({
    maxTokensPerCall: 4000,
    sessionTokenQuota: 100000,
    requireApproval: true
  })
}
