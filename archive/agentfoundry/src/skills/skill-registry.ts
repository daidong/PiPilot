/**
 * Skill Registry
 *
 * Central registry for discovering and accessing skills.
 * Provides query capabilities for skill matching and recommendations.
 */

import type { Skill, SkillLoadingStrategy } from '../types/skill.js'

/**
 * Query options for finding skills
 */
export interface SkillQuery {
  /**
   * Filter by skill IDs
   */
  ids?: string[]

  /**
   * Filter by associated tool names
   */
  tools?: string[]

  /**
   * Filter by tags
   */
  tags?: string[]

  /**
   * Filter by loading strategy
   */
  strategy?: SkillLoadingStrategy

  /**
   * Text search in name and description
   */
  search?: string
}

/**
 * Skill match result with relevance score
 */
export interface SkillMatch {
  skill: Skill
  score: number
  matchedBy: ('id' | 'tool' | 'tag' | 'search')[]
}

/**
 * SkillRegistry provides discovery and query capabilities for skills
 */
export class SkillRegistry {
  private skills: Map<string, Skill> = new Map()
  private toolIndex: Map<string, Set<string>> = new Map()
  private tagIndex: Map<string, Set<string>> = new Map()

  /**
   * Register a skill
   */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill)

    // Build tool index
    if (skill.tools) {
      for (const toolName of skill.tools) {
        if (!this.toolIndex.has(toolName)) {
          this.toolIndex.set(toolName, new Set())
        }
        this.toolIndex.get(toolName)!.add(skill.id)
      }
    }

    // Build tag index
    if (skill.tags) {
      for (const tag of skill.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set())
        }
        this.tagIndex.get(tag)!.add(skill.id)
      }
    }
  }

  /**
   * Register multiple skills
   */
  registerAll(skills: Skill[]): void {
    for (const skill of skills) {
      this.register(skill)
    }
  }

  /**
   * Unregister a skill
   */
  unregister(skillId: string): void {
    const skill = this.skills.get(skillId)
    if (!skill) return

    this.skills.delete(skillId)

    // Clean tool index
    if (skill.tools) {
      for (const toolName of skill.tools) {
        this.toolIndex.get(toolName)?.delete(skillId)
      }
    }

    // Clean tag index
    if (skill.tags) {
      for (const tag of skill.tags) {
        this.tagIndex.get(tag)?.delete(skillId)
      }
    }
  }

  /**
   * Get a skill by ID
   */
  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId)
  }

  /**
   * Get all registered skills
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values())
  }

  /**
   * Check if a skill is registered
   */
  has(skillId: string): boolean {
    return this.skills.has(skillId)
  }

  /**
   * Get skills associated with a tool
   */
  getByTool(toolName: string): Skill[] {
    const skillIds = this.toolIndex.get(toolName)
    if (!skillIds) return []
    return Array.from(skillIds).map(id => this.skills.get(id)!).filter(Boolean)
  }

  /**
   * Get skills by tag
   */
  getByTag(tag: string): Skill[] {
    const skillIds = this.tagIndex.get(tag)
    if (!skillIds) return []
    return Array.from(skillIds).map(id => this.skills.get(id)!).filter(Boolean)
  }

  /**
   * Get skills by loading strategy
   */
  getByStrategy(strategy: SkillLoadingStrategy): Skill[] {
    return this.getAll().filter(s => s.loadingStrategy === strategy)
  }

  /**
   * Query skills with filters
   */
  query(options: SkillQuery): Skill[] {
    let results = this.getAll()

    // Filter by IDs
    if (options.ids && options.ids.length > 0) {
      const idSet = new Set(options.ids)
      results = results.filter(s => idSet.has(s.id))
    }

    // Filter by tools
    if (options.tools && options.tools.length > 0) {
      const toolSet = new Set(options.tools)
      results = results.filter(s =>
        s.tools?.some(t => toolSet.has(t))
      )
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      const tagSet = new Set(options.tags)
      results = results.filter(s =>
        s.tags?.some(t => tagSet.has(t))
      )
    }

    // Filter by strategy
    if (options.strategy) {
      results = results.filter(s => s.loadingStrategy === options.strategy)
    }

    // Filter by search text
    if (options.search) {
      const searchLower = options.search.toLowerCase()
      results = results.filter(s =>
        s.name.toLowerCase().includes(searchLower) ||
        s.shortDescription.toLowerCase().includes(searchLower) ||
        s.instructions.summary.toLowerCase().includes(searchLower)
      )
    }

    return results
  }

  /**
   * Find best matching skills with relevance scoring
   */
  findMatches(options: SkillQuery): SkillMatch[] {
    const matches: SkillMatch[] = []
    const idSet = options.ids ? new Set(options.ids) : null
    const toolSet = options.tools ? new Set(options.tools) : null
    const tagSet = options.tags ? new Set(options.tags) : null
    const searchLower = options.search?.toLowerCase()

    for (const skill of this.skills.values()) {
      let score = 0
      const matchedBy: SkillMatch['matchedBy'] = []

      // ID match (highest priority)
      if (idSet && idSet.has(skill.id)) {
        score += 100
        matchedBy.push('id')
      }

      // Tool match
      if (toolSet && skill.tools?.some(t => toolSet.has(t))) {
        const toolMatches = skill.tools.filter(t => toolSet.has(t)).length
        score += 50 * toolMatches
        matchedBy.push('tool')
      }

      // Tag match
      if (tagSet && skill.tags?.some(t => tagSet.has(t))) {
        const tagMatches = skill.tags.filter(t => tagSet.has(t)).length
        score += 25 * tagMatches
        matchedBy.push('tag')
      }

      // Search match
      if (searchLower) {
        if (skill.name.toLowerCase().includes(searchLower)) {
          score += 30
          matchedBy.push('search')
        } else if (skill.shortDescription.toLowerCase().includes(searchLower)) {
          score += 20
          if (!matchedBy.includes('search')) matchedBy.push('search')
        } else if (skill.instructions.summary.toLowerCase().includes(searchLower)) {
          score += 10
          if (!matchedBy.includes('search')) matchedBy.push('search')
        }
      }

      // Strategy filter (doesn't add score, just filters)
      if (options.strategy && skill.loadingStrategy !== options.strategy) {
        continue
      }

      if (score > 0 || matchedBy.length > 0) {
        matches.push({ skill, score, matchedBy })
      }
    }

    // Sort by score descending
    return matches.sort((a, b) => b.score - a.score)
  }

  /**
   * Recommend skills for a given context
   */
  recommend(context: {
    tools?: string[]
    tags?: string[]
    text?: string
    maxResults?: number
  }): Skill[] {
    const matches = this.findMatches({
      tools: context.tools,
      tags: context.tags,
      search: context.text
    })

    const limit = context.maxResults ?? 5
    return matches.slice(0, limit).map(m => m.skill)
  }

  /**
   * Get all unique tags
   */
  getAllTags(): string[] {
    return Array.from(this.tagIndex.keys())
  }

  /**
   * Get all unique tools that have skills
   */
  getAllTools(): string[] {
    return Array.from(this.toolIndex.keys())
  }

  /**
   * Get statistics about the registry
   */
  getStats(): {
    totalSkills: number
    byStrategy: Record<SkillLoadingStrategy, number>
    totalTools: number
    totalTags: number
  } {
    const byStrategy: Record<SkillLoadingStrategy, number> = {
      eager: 0,
      lazy: 0,
      'on-demand': 0
    }

    for (const skill of this.skills.values()) {
      byStrategy[skill.loadingStrategy]++
    }

    return {
      totalSkills: this.skills.size,
      byStrategy,
      totalTools: this.toolIndex.size,
      totalTags: this.tagIndex.size
    }
  }

  /**
   * Clear all registered skills
   */
  clear(): void {
    this.skills.clear()
    this.toolIndex.clear()
    this.tagIndex.clear()
  }
}

/**
 * Global skill registry instance
 */
export const globalSkillRegistry = new SkillRegistry()
