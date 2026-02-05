/**
 * SkillRegistry Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SkillRegistry } from '../../src/skills/skill-registry.js'
import { defineSkill } from '../../src/skills/define-skill.js'

describe('SkillRegistry', () => {
  let registry: SkillRegistry

  const skillA = defineSkill({
    id: 'skill-a',
    name: 'Skill A',
    shortDescription: 'First test skill',
    instructions: { summary: 'Summary A' },
    tools: ['tool-a', 'tool-shared'],
    tags: ['category-1', 'feature-x'],
    loadingStrategy: 'lazy'
  })

  const skillB = defineSkill({
    id: 'skill-b',
    name: 'Skill B',
    shortDescription: 'Second test skill',
    instructions: { summary: 'Summary B' },
    tools: ['tool-b', 'tool-shared'],
    tags: ['category-2', 'feature-x'],
    loadingStrategy: 'eager'
  })

  const skillC = defineSkill({
    id: 'skill-c',
    name: 'Skill C',
    shortDescription: 'Third test skill',
    instructions: { summary: 'Summary C' },
    tools: ['tool-c'],
    tags: ['category-1'],
    loadingStrategy: 'on-demand'
  })

  beforeEach(() => {
    registry = new SkillRegistry()
  })

  describe('registration', () => {
    it('should register a skill', () => {
      registry.register(skillA)

      expect(registry.has('skill-a')).toBe(true)
      expect(registry.get('skill-a')).toBe(skillA)
    })

    it('should register multiple skills', () => {
      registry.registerAll([skillA, skillB, skillC])

      expect(registry.getAll()).toHaveLength(3)
    })

    it('should unregister a skill', () => {
      registry.register(skillA)
      expect(registry.has('skill-a')).toBe(true)

      registry.unregister('skill-a')

      expect(registry.has('skill-a')).toBe(false)
    })
  })

  describe('tool index', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should find skills by tool', () => {
      const skills = registry.getByTool('tool-a')

      expect(skills).toHaveLength(1)
      expect(skills[0].id).toBe('skill-a')
    })

    it('should find multiple skills for shared tool', () => {
      const skills = registry.getByTool('tool-shared')

      expect(skills).toHaveLength(2)
      expect(skills.map(s => s.id)).toContain('skill-a')
      expect(skills.map(s => s.id)).toContain('skill-b')
    })

    it('should return empty array for unknown tool', () => {
      const skills = registry.getByTool('unknown-tool')

      expect(skills).toHaveLength(0)
    })

    it('should update tool index on unregister', () => {
      registry.unregister('skill-a')

      const skills = registry.getByTool('tool-shared')

      expect(skills).toHaveLength(1)
      expect(skills[0].id).toBe('skill-b')
    })
  })

  describe('tag index', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should find skills by tag', () => {
      const skills = registry.getByTag('category-1')

      expect(skills).toHaveLength(2)
      expect(skills.map(s => s.id)).toContain('skill-a')
      expect(skills.map(s => s.id)).toContain('skill-c')
    })

    it('should find skills with shared tag', () => {
      const skills = registry.getByTag('feature-x')

      expect(skills).toHaveLength(2)
    })

    it('should return empty array for unknown tag', () => {
      const skills = registry.getByTag('unknown-tag')

      expect(skills).toHaveLength(0)
    })
  })

  describe('strategy filter', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should filter by loading strategy', () => {
      expect(registry.getByStrategy('lazy')).toHaveLength(1)
      expect(registry.getByStrategy('eager')).toHaveLength(1)
      expect(registry.getByStrategy('on-demand')).toHaveLength(1)
    })
  })

  describe('query', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should query by ids', () => {
      const results = registry.query({ ids: ['skill-a', 'skill-c'] })

      expect(results).toHaveLength(2)
      expect(results.map(s => s.id)).toContain('skill-a')
      expect(results.map(s => s.id)).toContain('skill-c')
    })

    it('should query by tools', () => {
      const results = registry.query({ tools: ['tool-shared'] })

      expect(results).toHaveLength(2)
    })

    it('should query by tags', () => {
      const results = registry.query({ tags: ['category-1'] })

      expect(results).toHaveLength(2)
    })

    it('should query by strategy', () => {
      const results = registry.query({ strategy: 'eager' })

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('skill-b')
    })

    it('should query by search text in name', () => {
      const results = registry.query({ search: 'Skill A' })

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('skill-a')
    })

    it('should query by search text in description', () => {
      const results = registry.query({ search: 'Second' })

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('skill-b')
    })

    it('should combine multiple query filters', () => {
      const results = registry.query({
        tags: ['category-1'],
        strategy: 'lazy'
      })

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('skill-a')
    })
  })

  describe('findMatches', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should score and rank matches', () => {
      const matches = registry.findMatches({ tools: ['tool-shared'] })

      expect(matches).toHaveLength(2)
      expect(matches[0].score).toBeGreaterThan(0)
      expect(matches[0].matchedBy).toContain('tool')
    })

    it('should score ID matches highest', () => {
      const matches = registry.findMatches({
        ids: ['skill-a'],
        tools: ['tool-shared']
      })

      const skillAMatch = matches.find(m => m.skill.id === 'skill-a')
      const skillBMatch = matches.find(m => m.skill.id === 'skill-b')

      expect(skillAMatch!.score).toBeGreaterThan(skillBMatch!.score)
    })

    it('should include match sources', () => {
      const matches = registry.findMatches({
        ids: ['skill-a'],
        tools: ['tool-a'],
        tags: ['category-1']
      })

      const match = matches.find(m => m.skill.id === 'skill-a')

      expect(match!.matchedBy).toContain('id')
      expect(match!.matchedBy).toContain('tool')
      expect(match!.matchedBy).toContain('tag')
    })

    it('should sort results by score descending', () => {
      const matches = registry.findMatches({
        tools: ['tool-a', 'tool-shared']
      })

      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score)
      }
    })
  })

  describe('recommend', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should recommend skills based on context', () => {
      const recommendations = registry.recommend({
        tools: ['tool-shared'],
        maxResults: 2
      })

      expect(recommendations).toHaveLength(2)
    })

    it('should respect maxResults limit', () => {
      const recommendations = registry.recommend({
        tags: ['category-1', 'category-2'],
        maxResults: 1
      })

      expect(recommendations).toHaveLength(1)
    })
  })

  describe('utility methods', () => {
    beforeEach(() => {
      registry.registerAll([skillA, skillB, skillC])
    })

    it('should return all unique tags', () => {
      const tags = registry.getAllTags()

      expect(tags).toContain('category-1')
      expect(tags).toContain('category-2')
      expect(tags).toContain('feature-x')
    })

    it('should return all tools that have skills', () => {
      const tools = registry.getAllTools()

      expect(tools).toContain('tool-a')
      expect(tools).toContain('tool-b')
      expect(tools).toContain('tool-shared')
    })

    it('should provide registry stats', () => {
      const stats = registry.getStats()

      expect(stats.totalSkills).toBe(3)
      expect(stats.byStrategy.lazy).toBe(1)
      expect(stats.byStrategy.eager).toBe(1)
      expect(stats.byStrategy['on-demand']).toBe(1)
      expect(stats.totalTools).toBe(4) // tool-a, tool-b, tool-c, tool-shared
      expect(stats.totalTags).toBe(3) // category-1, category-2, feature-x
    })

    it('should clear all skills', () => {
      registry.clear()

      expect(registry.getAll()).toHaveLength(0)
      expect(registry.getAllTags()).toHaveLength(0)
      expect(registry.getAllTools()).toHaveLength(0)
    })
  })
})
