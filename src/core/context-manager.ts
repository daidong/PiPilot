/**
 * ContextManager - 上下文管理器
 *
 * Enhanced with:
 * - Parameter validation
 * - Fuzzy matching for unknown sources
 * - Actionable error responses
 * - Namespace management
 */

import type {
  ContextSource,
  ContextResult,
  CostTier,
  ContextKind
} from '../types/context.js'
import type { Runtime } from '../types/runtime.js'
import type { TraceCollector } from './trace-collector.js'
import type { TokenBudget } from './token-budget.js'
import { Cache, buildCacheKey } from '../utils/cache.js'
import { countTokens, truncateToTokens } from '../utils/tokenizer.js'

/**
 * Validation error details
 */
interface ValidationError {
  field: string
  message: string
  expected?: string
}

/**
 * Validation result
 */
interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/**
 * ContextManager 配置
 */
export interface ContextManagerConfig {
  trace: TraceCollector
  tokenBudget: TokenBudget
  runtime: Runtime
}

/**
 * 缓存条目
 */
interface CacheEntry {
  result: ContextResult
  timestamp: number
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        )
      }
    }
  }

  return matrix[b.length]![a.length]!
}

/**
 * Calculate similarity between two strings (0-1)
 */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshteinDistance(a, b) / maxLen
}

/**
 * 上下文管理器
 */
export class ContextManager {
  private sources = new Map<string, ContextSource>()
  private cache = new Cache<CacheEntry>(5 * 60 * 1000) // 默认 5 分钟 TTL
  private config: ContextManagerConfig | null = null

  /**
   * 设置配置
   */
  configure(config: ContextManagerConfig): void {
    this.config = config
  }

  /**
   * 注册上下文源
   */
  register(source: ContextSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(`Context source already registered: ${source.id}`)
    }
    this.sources.set(source.id, source)
  }

  /**
   * 批量注册上下文源
   */
  registerAll(sources: ContextSource[]): void {
    for (const source of sources) {
      this.register(source)
    }
  }

  /**
   * 取消注册上下文源
   */
  unregister(sourceId: string): boolean {
    return this.sources.delete(sourceId)
  }

  /**
   * 获取上下文源
   */
  getSource(sourceId: string): ContextSource | undefined {
    return this.sources.get(sourceId)
  }

  /**
   * 检查上下文源是否存在
   */
  has(sourceId: string): boolean {
    return this.sources.has(sourceId)
  }

  /**
   * 获取所有上下文源
   */
  getAllSources(): ContextSource[] {
    return Array.from(this.sources.values())
  }

  /**
   * Get all unique namespaces
   */
  getNamespaces(): string[] {
    const namespaces = new Set<string>()
    for (const source of this.sources.values()) {
      namespaces.add(source.namespace)
    }
    return Array.from(namespaces).sort()
  }

  /**
   * Get sources by namespace
   */
  getSourcesByNamespace(namespace: string): ContextSource[] {
    return Array.from(this.sources.values())
      .filter(s => s.namespace === namespace)
  }

  /**
   * Get sources by kind
   */
  getSourcesByKind(kind: ContextKind): ContextSource[] {
    return Array.from(this.sources.values())
      .filter(s => s.kind === kind)
  }

  /**
   * Find similar source IDs (for fuzzy matching on errors)
   */
  findSimilarSources(sourceId: string, limit: number = 3): string[] {
    const allIds = Array.from(this.sources.keys())

    return allIds
      .map(id => ({ id, score: similarity(id, sourceId) }))
      .filter(item => item.score > 0.4) // Threshold for similarity
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.id)
  }

  /**
   * Validate params against source schema
   */
  private validateParams(source: ContextSource, params: unknown): ValidationResult {
    const errors: ValidationError[] = []

    // If no schema defined, skip validation
    if (!source.params || source.params.length === 0) {
      return { valid: true, errors: [] }
    }

    const paramsObj = (params ?? {}) as Record<string, unknown>

    // Check required fields
    for (const schema of source.params) {
      if (schema.required && !(schema.name in paramsObj)) {
        errors.push({
          field: schema.name,
          message: `Missing required field "${schema.name}"`,
          expected: schema.type
        })
      }

      // Check type if field is present
      if (schema.name in paramsObj) {
        const value = paramsObj[schema.name]
        const actualType = Array.isArray(value) ? 'array' : typeof value

        if (actualType !== schema.type && value !== undefined && value !== null) {
          errors.push({
            field: schema.name,
            message: `Field "${schema.name}" has wrong type: expected ${schema.type}, got ${actualType}`,
            expected: schema.type
          })
        }

        // Check enum if defined
        if (schema.enum && !schema.enum.includes(value)) {
          errors.push({
            field: schema.name,
            message: `Field "${schema.name}" has invalid value: expected one of [${schema.enum.join(', ')}]`,
            expected: schema.enum.join(' | ')
          })
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * Create error result for unknown source
   */
  private createUnknownSourceError(sourceId: string): ContextResult {
    const similar = this.findSimilarSources(sourceId)
    const namespaces = this.getNamespaces()

    let rendered = `# Error: Unknown Source\n\nSource "${sourceId}" not found.\n`

    if (similar.length > 0) {
      rendered += `\n## Did you mean?\n${similar.map(s => `- ${s}`).join('\n')}\n`
    }

    rendered += `\n## Available Namespaces\n${namespaces.map(ns => `- ${ns}.*`).join('\n')}\n`
    rendered += `\n## Help\nUse \`ctx.get("ctx.catalog")\` to list all available sources.`

    return {
      success: false,
      error: `Unknown source "${sourceId}"`,
      rendered,
      provenance: { operations: [], durationMs: 0, cached: false },
      coverage: {
        complete: true,
        suggestions: similar.length > 0
          ? [`Try: ctx.get("${similar[0]}")`]
          : ['Use ctx.get("ctx.catalog") to see available sources']
      },
      kindEcho: {
        source: sourceId,
        kind: 'search' as ContextKind, // Default, unknown
        paramsUsed: {}
      }
    }
  }

  /**
   * Create error result for validation failure
   */
  private createValidationError(
    source: ContextSource,
    errors: ValidationError[],
    params: unknown
  ): ContextResult {
    const example = source.examples?.[0]

    let rendered = `# Error: Invalid Parameters for ${source.id}\n\n`
    rendered += `## Problems\n${errors.map(e => `- ${e.field}: ${e.message}`).join('\n')}\n\n`
    rendered += `## Allowed Fields\n`

    if (source.params) {
      for (const p of source.params) {
        rendered += `- ${p.name}${p.required ? ' (required)' : ''}: ${p.type}`
        if (p.description) rendered += ` - ${p.description}`
        if (p.default !== undefined) rendered += ` (default: ${JSON.stringify(p.default)})`
        rendered += '\n'
      }
    }

    if (example) {
      rendered += `\n## Example\n\`\`\`json\nctx.get("${source.id}", ${JSON.stringify(example.params, null, 2)})\n\`\`\`\n`
    }

    rendered += `\n## Help\nUse \`ctx.get("ctx.describe", { id: "${source.id}" })\` for full documentation.`

    return {
      success: false,
      error: errors.map(e => e.message).join('; '),
      rendered,
      provenance: { operations: [], durationMs: 0, cached: false },
      coverage: {
        complete: true,
        suggestions: errors.map(e => `Fix: ${e.message}`)
      },
      kindEcho: {
        source: source.id,
        kind: source.kind,
        paramsUsed: (params ?? {}) as Record<string, unknown>
      }
    }
  }

  /**
   * 获取上下文
   */
  async get<T = unknown>(
    sourceId: string,
    params?: unknown
  ): Promise<ContextResult<T>> {
    if (!this.config) {
      return {
        success: false,
        error: 'ContextManager not configured',
        rendered: '# Error\n\nContextManager not configured. Call configure() first.',
        provenance: { operations: [], durationMs: 0, cached: false },
        coverage: { complete: false }
      }
    }

    // 1. Check source exists
    const source = this.sources.get(sourceId)
    if (!source) {
      return this.createUnknownSourceError(sourceId) as ContextResult<T>
    }

    // 2. Validate params
    const validation = this.validateParams(source, params)
    if (!validation.valid) {
      return this.createValidationError(source, validation.errors, params) as ContextResult<T>
    }

    // 2. 检查缓存
    const cacheKey = buildCacheKey(sourceId, params)
    const cached = this.cache.get(cacheKey)

    if (cached && source.cache) {
      const isValid = Date.now() - cached.timestamp < source.cache.ttlMs

      if (isValid) {
        this.config.trace.record({
          type: 'ctx.cache_hit',
          data: { sourceId }
        })

        return {
          ...cached.result,
          provenance: {
            ...cached.result.provenance,
            cached: true
          }
        } as ContextResult<T>
      }
    }

    // 3. 检查 token 预算
    if (source.costTier === 'expensive') {
      if (!this.config.tokenBudget.canAfford('expensive')) {
        return {
          success: false,
          error: 'Token budget exceeded for expensive operations',
          rendered: '# Error: Token Budget Exceeded\n\nThis operation is expensive and exceeds the current token budget.\n\n## Suggestions\n- Wait for budget to reset\n- Use a cheaper alternative',
          provenance: { operations: [], durationMs: 0, cached: false },
          coverage: {
            complete: false,
            suggestions: ['Wait for budget reset', 'Use cheaper source']
          },
          kindEcho: {
            source: source.id,
            kind: source.kind,
            paramsUsed: (params ?? {}) as Record<string, unknown>
          }
        }
      }
    }

    // 4. 执行获取
    const startTime = Date.now()
    const paramsUsed = (params ?? {}) as Record<string, unknown>

    this.config.trace.record({
      type: 'ctx.fetch_start',
      data: { sourceId, params: paramsUsed }
    })

    let result: ContextResult<T>

    try {
      result = await source.fetch(params, this.config.runtime) as ContextResult<T>
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: errorMessage,
        rendered: `# Error: Fetch Failed\n\n${errorMessage}\n\n## Source\n${source.id} (${source.kind})`,
        provenance: { operations: [], durationMs: Date.now() - startTime, cached: false },
        coverage: {
          complete: false,
          suggestions: ['Check parameters and try again']
        },
        kindEcho: {
          source: source.id,
          kind: source.kind,
          paramsUsed
        }
      }
    }

    // 5. 裁剪 rendered
    if (source.render?.maxTokens && result.rendered) {
      const tokens = countTokens(result.rendered)

      if (tokens > source.render.maxTokens) {
        result.rendered = truncateToTokens(
          result.rendered,
          source.render.maxTokens,
          source.render.truncateStrategy
        )
        result.coverage.complete = false
        result.coverage.limitations = [
          ...(result.coverage.limitations ?? []),
          `Truncated to ${source.render.maxTokens} tokens`
        ]
      }
    }

    // 6. Add kindEcho if not already present
    if (!result.kindEcho) {
      result.kindEcho = {
        source: source.id,
        kind: source.kind,
        paramsUsed
      }
    }

    // 7. 更新缓存和预算
    if (source.cache) {
      this.cache.set(cacheKey, {
        result: result as ContextResult,
        timestamp: Date.now()
      }, source.cache.ttlMs)
    }

    const tokenCount = countTokens(result.rendered)
    this.config.tokenBudget.consume(source.costTier, tokenCount)

    this.config.trace.record({
      type: 'ctx.fetch_complete',
      data: { sourceId, tokens: tokenCount, durationMs: Date.now() - startTime }
    })

    return result
  }

  /**
   * 生成可用上下文源描述
   */
  getAvailableSourcesDescription(): string {
    const descriptions: string[] = []

    for (const source of this.sources.values()) {
      descriptions.push(`- **${source.id}**: ${source.description}`)
    }

    return descriptions.join('\n')
  }

  /**
   * 生成上下文源列表（用于系统提示）
   */
  getSourcesForPrompt(): Array<{
    id: string
    namespace: string
    kind: ContextKind
    shortDescription: string
    costTier: CostTier
  }> {
    return Array.from(this.sources.values()).map(source => ({
      id: source.id,
      namespace: source.namespace,
      kind: source.kind,
      shortDescription: source.shortDescription,
      costTier: source.costTier
    }))
  }

  /**
   * Generate a summary of available sources grouped by namespace
   */
  getSourcesSummary(): string {
    const byNamespace = new Map<string, ContextSource[]>()

    for (const source of this.sources.values()) {
      const list = byNamespace.get(source.namespace) ?? []
      list.push(source)
      byNamespace.set(source.namespace, list)
    }

    const lines: string[] = ['# Available Context Sources', '']

    for (const [ns, sources] of byNamespace.entries()) {
      lines.push(`## ${ns}.*`)
      for (const s of sources) {
        lines.push(`- ${s.id} (${s.kind}): ${s.shortDescription}`)
      }
      lines.push('')
    }

    lines.push('## Help')
    lines.push('- Use `ctx.get("ctx.catalog")` for detailed listing')
    lines.push('- Use `ctx.get("ctx.describe", { id: "..." })` for full documentation')
    lines.push('- Use `ctx.get("ctx.route", { intent: "search", query: "..." })` for routing help')

    return lines.join('\n')
  }

  /**
   * 按事件失效缓存
   */
  invalidateByEvent(event: string): number {
    let count = 0

    for (const source of this.sources.values()) {
      if (source.cache?.invalidateOn?.includes(event)) {
        const pattern = new RegExp(`^${source.id}:`)
        count += this.cache.invalidateByPattern(pattern)
      }
    }

    return count
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): {
    size: number
    sources: number
  } {
    return {
      size: this.cache.size,
      sources: this.sources.size
    }
  }

  /**
   * 清空所有
   */
  clear(): void {
    this.sources.clear()
    this.cache.clear()
  }
}
