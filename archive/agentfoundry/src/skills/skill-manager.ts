/**
 * Skill Manager
 *
 * Manages skill lifecycle, lazy loading, and content caching.
 * Integrates with PromptCompiler to provide progressive disclosure.
 */

import type {
  Skill,
  SkillState,
  LoadedSkillContent,
  SkillLoadingStrategy,
  SkillManagerEvents,
  SkillRegistrationOptions,
  SkillTelemetryConfig,
  SkillTelemetryMode,
  SkillTelemetrySink,
  SkillTokenSavings
} from '../types/skill.js'
import { EventBus } from '../core/event-bus.js'
import type { TraceCollector } from '../core/trace-collector.js'

/**
 * Options for SkillManager initialization
 */
export interface SkillManagerOptions {
  /**
   * Event bus for emitting skill events
   */
  eventBus?: EventBus

  /**
   * Trace collector for structured telemetry events
   */
  trace?: TraceCollector

  /**
   * Enable debug logging
   */
  debug?: boolean

  /**
   * Maximum number of fully loaded skills to keep in memory
   * Older skills will be downgraded to summary-loaded state
   * @default 10
   */
  maxFullyLoadedSkills?: number

  /**
   * Time in ms after which unused fully-loaded skills are downgraded
   * @default 300000 (5 minutes)
   */
  skillTTL?: number

  /**
   * Skill lifecycle telemetry
   */
  skillTelemetry?: SkillTelemetryConfig
}

/**
 * SkillManager handles skill registration, loading, and lifecycle management
 */
export class SkillManager {
  private skills: Map<string, Skill> = new Map()
  private loadedContent: Map<string, LoadedSkillContent> = new Map()
  private toolToSkillMap: Map<string, string[]> = new Map()
  private approvalBySkillId: Map<string, boolean> = new Map()
  private eventBus?: EventBus
  private trace?: TraceCollector
  private debug: boolean
  private maxFullyLoadedSkills: number
  private skillTTL: number
  private telemetry: { enabled: boolean; mode: SkillTelemetryMode; sink: SkillTelemetrySink }

  constructor(options: SkillManagerOptions = {}) {
    this.eventBus = options.eventBus
    this.trace = options.trace
    this.debug = options.debug ?? false
    this.maxFullyLoadedSkills = options.maxFullyLoadedSkills ?? 10
    this.skillTTL = options.skillTTL ?? 300000 // 5 minutes
    const mode = options.skillTelemetry?.mode ?? 'basic'
    this.telemetry = {
      enabled: options.skillTelemetry?.enabled ?? true,
      mode,
      sink: options.skillTelemetry?.sink ?? 'both'
    }
    if (mode === 'off') {
      this.telemetry.enabled = false
    }
  }

  /**
   * Register a skill
   */
  register(skill: Skill, options: SkillRegistrationOptions = {}): void {
    if (this.skills.has(skill.id)) {
      this.log(`Skill "${skill.id}" already registered, updating...`)
      this.unload(skill.id)
    }

    this.skills.set(skill.id, skill)
    const approvedByUser = options.approvedByUser ?? skill.meta?.approvedByUser ?? true
    this.approvalBySkillId.set(skill.id, approvedByUser)

    // Build tool → skill mapping for lazy loading
    if (skill.tools) {
      for (const toolName of skill.tools) {
        const existingSkills = this.toolToSkillMap.get(toolName) ?? []
        if (!existingSkills.includes(skill.id)) {
          existingSkills.push(skill.id)
          this.toolToSkillMap.set(toolName, existingSkills)
        }
      }
    }

    if (approvedByUser) {
      // Initialize loaded content based on loading strategy
      this.initializeSkillContent(skill)
    } else {
      // Unapproved skills are discoverable, but never injected into prompt.
      this.loadedContent.set(skill.id, {
        state: 'registered',
        skill,
        content: '',
        lastAccessed: Date.now(),
        accessCount: 0
      })
      this.emit('skill:blocked', { skillId: skill.id, reason: 'unapproved' })
      this.recordTelemetry(
        'skill.load_blocked',
        { skillId: skill.id, reason: 'unapproved', source: 'register' },
        `blocked id=${skill.id} reason=unapproved`
      )
    }

    this.emit('skill:registered', { skillId: skill.id, skill })
    this.recordTelemetry(
      'skill.registered',
      {
        skillId: skill.id,
        strategy: skill.loadingStrategy,
        summaryTokens: skill.estimatedTokens.summary,
        fullTokens: skill.estimatedTokens.full,
        approvedByUser
      },
      `registered id=${skill.id} strategy=${skill.loadingStrategy} approved=${approvedByUser}`
    )
    this.log(`Registered skill: ${skill.id} (strategy: ${skill.loadingStrategy}, tools: [${skill.tools?.join(', ') || 'none'}])`)
  }

  /**
   * Register multiple skills
   */
  registerAll(skills: Skill[]): void {
    for (const skill of skills) {
      this.register(skill)
    }
    // Always log summary after batch registration (key event)
    if (skills.length > 0) {
      const usage = this.getTokenUsage()
      const names = skills.map(s => s.id).join(', ')
      this.logInfo(`Registered ${skills.length} skills: [${names}] | tokens: ${usage.current}/${usage.maxPotential}`)
    }
  }

  /**
   * Get a skill by ID
   */
  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId)
  }

  /**
   * Check if a skill is registered
   */
  has(skillId: string): boolean {
    return this.skills.has(skillId)
  }

  /**
   * Check if a registered skill is approved for loading
   */
  isApproved(skillId: string): boolean {
    return this.approvalBySkillId.get(skillId) !== false
  }

  /**
   * Get all registered skills
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values())
  }

  /**
   * Get skills by loading strategy
   */
  getByStrategy(strategy: SkillLoadingStrategy): Skill[] {
    return this.getAll().filter(s => s.loadingStrategy === strategy)
  }

  /**
   * Get skills bound to a specific tool
   */
  getSkillsForTool(toolName: string): Skill[] {
    const skillIds = this.toolToSkillMap.get(toolName) ?? []
    return skillIds.map(id => this.skills.get(id)!).filter(Boolean)
  }

  /**
   * Initialize skill content based on loading strategy
   */
  private initializeSkillContent(skill: Skill): void {
    const content: LoadedSkillContent = {
      state: 'registered',
      skill,
      content: '',
      lastAccessed: Date.now(),
      accessCount: 0
    }

    if (skill.loadingStrategy === 'eager') {
      // Eager: load full content immediately
      content.state = 'fully-loaded'
      content.content = this.buildFullContent(skill)
      this.emit('skill:loaded', {
        skillId: skill.id,
        state: 'fully-loaded',
        tokensLoaded: skill.estimatedTokens.full
      })
      this.recordTelemetry(
        'skill.loaded.full',
        { skillId: skill.id, strategy: skill.loadingStrategy, trigger: 'eager', tokens: skill.estimatedTokens.full },
        `eager-load id=${skill.id} tokens=+${skill.estimatedTokens.full}`
      )
    } else {
      // Lazy/on-demand: use a compact pointer hint instead of the full summary.
      // This reduces per-skill prompt cost from ~80-100 tokens to ~20 tokens.
      // The agent requests full instructions via ctx-get("skill.load", { id }).
      content.state = 'summary-loaded'
      content.content = this.buildPointerContent(skill)
      this.emit('skill:loaded', {
        skillId: skill.id,
        state: 'summary-loaded',
        tokensLoaded: skill.estimatedTokens.summary
      })
      this.recordTelemetry(
        'skill.loaded.summary',
        { skillId: skill.id, reason: 'register', tokens: skill.estimatedTokens.summary },
        `pointer-load id=${skill.id} tokens=~20`
      )
    }

    this.loadedContent.set(skill.id, content)
  }

  /**
   * Build pointer content — a single compact hint used for lazy/on-demand skills
   * before they are requested. This keeps the system prompt lean (~20 tokens per
   * skill) compared to the full summary (~80-100 tokens).
   * The agent calls ctx-get("skill.load", { id }) to get full instructions.
   */
  private buildPointerContent(skill: Skill): string {
    return `> **[skill:${skill.id}]** ${skill.shortDescription} — call ctx-get("skill.load", {"id": "${skill.id}"}) to load full instructions.`
  }

  /**
   * Build full content with all sections
   */
  private buildFullContent(skill: Skill): string {
    const sections: string[] = []

    sections.push(`## ${skill.name}`)
    sections.push(skill.instructions.summary)

    if (skill.instructions.procedures) {
      sections.push('### Procedures')
      sections.push(skill.instructions.procedures)
    }

    if (skill.instructions.examples) {
      sections.push('### Examples')
      sections.push(skill.instructions.examples)
    }

    if (skill.instructions.troubleshooting) {
      sections.push('### Troubleshooting')
      sections.push(skill.instructions.troubleshooting)
    }

    return sections.join('\n\n')
  }

  /**
   * Load a skill to full state
   * Called when skill is needed (e.g., associated tool is first used)
   */
  loadFully(
    skillId: string,
    options?: { trigger?: 'tool' | 'on-demand' | 'eager' | 'manual'; triggerTool?: string }
  ): string | undefined {
    const content = this.loadedContent.get(skillId)
    if (!content) {
      this.log(`Cannot load unknown skill: ${skillId}`)
      return undefined
    }

    if (!this.isApproved(skillId)) {
      this.emit('skill:blocked', { skillId, reason: 'unapproved' })
      this.recordTelemetry(
        'skill.load_blocked',
        { skillId, reason: 'unapproved', source: 'loadFully' },
        `blocked id=${skillId} reason=unapproved`
      )
      return undefined
    }

    // Update access tracking
    content.lastAccessed = Date.now()
    content.accessCount++
    this.emit('skill:accessed', {
      skillId,
      accessCount: content.accessCount
    })

    // Already fully loaded
    if (content.state === 'fully-loaded') {
      return content.content
    }

    // Check if on-demand skill and not explicitly requested
    if (content.skill.loadingStrategy === 'on-demand') {
      // For on-demand skills, don't auto-upgrade
      // They need explicit loadOnDemand() call
      return content.content
    }

    // Upgrade to fully loaded
    content.state = 'fully-loaded'
    content.content = this.buildFullContent(content.skill)

    this.emit('skill:loaded', {
      skillId,
      state: 'fully-loaded',
      tokensLoaded: content.skill.estimatedTokens.full
    })
    this.recordTelemetry(
      'skill.loaded.full',
      {
        skillId,
        strategy: content.skill.loadingStrategy,
        trigger: options?.trigger ?? 'manual',
        triggerTool: options?.triggerTool,
        tokens: content.skill.estimatedTokens.full
      },
      options?.trigger === 'tool'
        ? `lazy-load id=${skillId} trigger=${options.triggerTool ?? 'unknown'} tokens=+${content.skill.estimatedTokens.full}`
        : `load id=${skillId} trigger=${options?.trigger ?? 'manual'} tokens=+${content.skill.estimatedTokens.full}`
    )

    this.log(`Fully loaded skill: ${skillId} (~${content.skill.estimatedTokens.full} tokens)`)

    // Enforce max loaded limit
    this.enforceLoadedLimit()

    return content.content
  }

  /**
   * Explicitly load an on-demand skill
   */
  loadOnDemand(skillId: string): string | undefined {
    const content = this.loadedContent.get(skillId)
    if (!content) {
      this.log(`Cannot load unknown skill: ${skillId}`)
      return undefined
    }

    if (!this.isApproved(skillId)) {
      this.emit('skill:blocked', { skillId, reason: 'unapproved' })
      this.recordTelemetry(
        'skill.load_blocked',
        { skillId, reason: 'unapproved', source: 'loadOnDemand' },
        `blocked id=${skillId} reason=unapproved`
      )
      return undefined
    }

    content.lastAccessed = Date.now()
    content.accessCount++

    if (content.state !== 'fully-loaded') {
      content.state = 'fully-loaded'
      content.content = this.buildFullContent(content.skill)

      this.emit('skill:loaded', {
        skillId,
        state: 'fully-loaded',
        tokensLoaded: content.skill.estimatedTokens.full
      })
      this.recordTelemetry(
        'skill.loaded.full',
        {
          skillId,
          strategy: content.skill.loadingStrategy,
          trigger: 'on-demand',
          tokens: content.skill.estimatedTokens.full
        },
        `on-demand-load id=${skillId} tokens=+${content.skill.estimatedTokens.full}`
      )

      this.log(`On-demand loaded skill: ${skillId}`)
      this.enforceLoadedLimit()
    }

    return content.content
  }

  /**
   * Trigger skill loading for associated tools (lazy loading)
   * Called by ToolRegistry before tool execution
   */
  onToolUsed(toolName: string): void {
    // skill-script-run performs targeted loading for the requested skillId.
    // Avoid broad auto-loading of every skill bound to this tool.
    if (toolName === 'skill-script-run') return

    const skillIds = this.toolToSkillMap.get(toolName)
    if (!skillIds || skillIds.length === 0) return

    for (const skillId of skillIds) {
      const content = this.loadedContent.get(skillId)
      if (content && content.skill.loadingStrategy === 'lazy') {
        const wasLoaded = content.state === 'fully-loaded'
        this.loadFully(skillId, { trigger: 'tool', triggerTool: toolName })
        if (!wasLoaded) {
          // Always log lazy load trigger (key event for observability)
          this.logInfo(`Tool "${toolName}" → loaded skill "${skillId}" (~${content.skill.estimatedTokens.full} tokens)`)
        }
      }
    }
  }

  /**
   * Get current content for a skill (whatever is loaded)
   */
  getContent(skillId: string): string | undefined {
    const content = this.loadedContent.get(skillId)
    if (!content) return undefined

    content.lastAccessed = Date.now()
    return content.content
  }

  /**
   * Get loading state for a skill
   */
  getState(skillId: string): SkillState | undefined {
    return this.loadedContent.get(skillId)?.state
  }

  /**
   * Get all currently loaded content for prompt compilation
   * Returns content organized by loading state
   */
  getLoadedContents(): { eager: string[]; lazy: string[]; onDemand: string[] } {
    const result = {
      eager: [] as string[],
      lazy: [] as string[],
      onDemand: [] as string[]
    }

    for (const [, content] of this.loadedContent) {
      if (!content.content) continue
      if (content.skill.loadingStrategy === 'eager') {
        result.eager.push(content.content)
      } else if (content.skill.loadingStrategy === 'lazy') {
        result.lazy.push(content.content)
      } else {
        result.onDemand.push(content.content)
      }
    }

    return result
  }

  /**
   * Get prompt sections for all currently loaded skills
   * Used by PromptCompiler
   */
  getPromptSections(): Array<{ id: string; content: string; protected: boolean }> {
    const sections: Array<{ id: string; content: string; protected: boolean }> = []

    for (const [skillId, content] of this.loadedContent) {
      if (!content.content) continue
      sections.push({
        id: `skill:${skillId}`,
        content: content.content,
        // Eager skills are protected; lazy/on-demand can be trimmed
        protected: content.skill.loadingStrategy === 'eager'
      })
    }

    return sections
  }

  /**
   * Downgrade a fully loaded skill to summary state
   */
  downgrade(skillId: string): void {
    const content = this.loadedContent.get(skillId)
    if (!content) return

    if (content.state === 'fully-loaded' && content.skill.loadingStrategy !== 'eager') {
      content.state = 'summary-loaded'
      content.content = this.buildPointerContent(content.skill)
      this.log(`Downgraded skill: ${skillId}`)
    }
  }

  /**
   * Unload a skill completely
   */
  unload(skillId: string): void {
    const skill = this.skills.get(skillId)
    if (!skill) return

    this.skills.delete(skillId)
    this.loadedContent.delete(skillId)
    this.approvalBySkillId.delete(skillId)

    // Clean up tool mapping
    if (skill.tools) {
      for (const toolName of skill.tools) {
        const skillIds = this.toolToSkillMap.get(toolName)
        if (skillIds) {
          const index = skillIds.indexOf(skillId)
          if (index >= 0) {
            skillIds.splice(index, 1)
          }
          if (skillIds.length === 0) {
            this.toolToSkillMap.delete(toolName)
          }
        }
      }
    }

    this.emit('skill:unloaded', { skillId })
    this.log(`Unloaded skill: ${skillId}`)
  }

  /**
   * Alias used by hot-reload workflows
   */
  unregister(skillId: string): boolean {
    if (!this.skills.has(skillId)) return false
    this.unload(skillId)
    return true
  }

  /**
   * Get total estimated token usage
   */
  getTokenUsage(): { current: number; maxPotential: number } {
    let current = 0
    let maxPotential = 0

    for (const [, content] of this.loadedContent) {
      if (!this.isApproved(content.skill.id)) continue
      maxPotential += content.skill.estimatedTokens.full

      if (content.state === 'fully-loaded') {
        current += content.skill.estimatedTokens.full
      } else if (content.state === 'summary-loaded') {
        current += content.skill.estimatedTokens.summary
      }
    }

    return { current, maxPotential }
  }

  /**
   * Enforce maximum fully loaded skills limit
   * Downgrade oldest accessed skills
   */
  private enforceLoadedLimit(): void {
    const fullyLoaded = Array.from(this.loadedContent.values())
      .filter(c => c.state === 'fully-loaded' && c.skill.loadingStrategy !== 'eager')
      .sort((a, b) => a.lastAccessed - b.lastAccessed)

    while (fullyLoaded.length > this.maxFullyLoadedSkills) {
      const oldest = fullyLoaded.shift()
      if (oldest) {
        this.downgrade(oldest.skill.id)
      }
    }
  }

  /**
   * Clean up expired skills
   * Call this periodically to free memory
   */
  cleanup(): void {
    const now = Date.now()

    for (const [skillId, content] of this.loadedContent) {
      if (
        content.state === 'fully-loaded' &&
        content.skill.loadingStrategy !== 'eager' &&
        now - content.lastAccessed > this.skillTTL
      ) {
        this.downgrade(skillId)
      }
    }
  }

  /**
   * Reset all skills to initial state
   */
  reset(): void {
    for (const skill of this.skills.values()) {
      if (this.isApproved(skill.id)) {
        this.initializeSkillContent(skill)
      } else {
        this.loadedContent.set(skill.id, {
          state: 'registered',
          skill,
          content: '',
          lastAccessed: Date.now(),
          accessCount: 0
        })
      }
    }
    this.log('Reset all skills to initial state')
  }

  /**
   * Emit a skill.created event from dynamic skill creation flow.
   */
  recordSkillCreated(
    skill: Skill,
    options?: { filePath?: string; approvedByUser?: boolean }
  ): void {
    this.recordTelemetry(
      'skill.created',
      {
        skillId: skill.id,
        loadingStrategy: skill.loadingStrategy,
        tools: skill.tools ?? [],
        filePath: options?.filePath,
        approvedByUser: options?.approvedByUser ?? this.isApproved(skill.id)
      },
      `created id=${skill.id} strategy=${skill.loadingStrategy} tools=${(skill.tools ?? []).join(',') || 'none'} approved=${options?.approvedByUser ?? this.isApproved(skill.id)}`
    )
  }

  /**
   * Token savings snapshot for current loading state.
   */
  getTokenSavingsSnapshot(): SkillTokenSavings {
    let summaryOnlyTokens = 0
    let fullyLoadedTokens = 0
    let currentLoadedTokens = 0

    for (const [skillId, content] of this.loadedContent) {
      if (!this.isApproved(skillId)) continue
      summaryOnlyTokens += content.skill.estimatedTokens.summary
      fullyLoadedTokens += content.skill.estimatedTokens.full
      if (content.state === 'fully-loaded') {
        currentLoadedTokens += content.skill.estimatedTokens.full
      } else if (content.state === 'summary-loaded') {
        currentLoadedTokens += content.skill.estimatedTokens.summary
      }
    }

    return {
      summaryOnlyTokens,
      fullyLoadedTokens,
      estimatedSavedTokens: Math.max(0, fullyLoadedTokens - currentLoadedTokens)
    }
  }

  /**
   * Emit per-run token savings telemetry.
   */
  reportTokenSavings(runId?: string, sessionId?: string): SkillTokenSavings {
    const savings = this.getTokenSavingsSnapshot()
    this.emit('skill:token-savings', { runId, sessionId, savings })
    this.recordTelemetry(
      'skill.token_savings',
      { runId, sessionId, ...savings },
      `token-savings run=${runId ?? '-'} saved=~${savings.estimatedSavedTokens} (summary=${savings.summaryOnlyTokens} full=${savings.fullyLoadedTokens})`
    )
    return savings
  }

  /**
   * Get statistics about loaded skills
   */
  getStats(): {
    total: number
    registered: number
    summaryLoaded: number
    fullyLoaded: number
    byStrategy: Record<SkillLoadingStrategy, number>
    tokenUsage: { current: number; maxPotential: number }
  } {
    const stats = {
      total: this.skills.size,
      registered: 0,
      summaryLoaded: 0,
      fullyLoaded: 0,
      byStrategy: {
        eager: 0,
        lazy: 0,
        'on-demand': 0
      } as Record<SkillLoadingStrategy, number>,
      tokenUsage: this.getTokenUsage()
    }

    for (const content of this.loadedContent.values()) {
      switch (content.state) {
        case 'registered':
          stats.registered++
          break
        case 'summary-loaded':
          stats.summaryLoaded++
          break
        case 'fully-loaded':
          stats.fullyLoaded++
          break
      }
      stats.byStrategy[content.skill.loadingStrategy]++
    }

    return stats
  }

  private emit<K extends keyof SkillManagerEvents>(
    event: K,
    data: SkillManagerEvents[K]
  ): void {
    this.eventBus?.emit(event, data)
  }

  /**
   * Emit structured telemetry + concise console log for key lifecycle events.
   */
  recordTelemetry(event: string, data: Record<string, unknown>, message?: string): void {
    if (!this.telemetry.enabled) return

    if (this.telemetry.sink === 'trace' || this.telemetry.sink === 'both') {
      this.trace?.record({
        type: 'skill.telemetry' as any,
        data: {
          event,
          ...data
        }
      })
    }

    if ((this.telemetry.sink === 'console' || this.telemetry.sink === 'both') && this.telemetry.mode !== 'off' && message) {
      const prefix = this.telemetry.mode === 'verbose' ? `[skill:${event}]` : '[skill]'
      console.log(`${prefix} ${message}`)
    }
  }

  /**
   * Debug log (only when debug: true)
   */
  private log(message: string): void {
    if (this.debug) {
      console.log(`[SkillManager] ${message}`)
    }
  }

  /**
   * Important log (always output, for key events)
   */
  private logInfo(message: string): void {
    console.log(`[Skills] ${message}`)
  }
}
