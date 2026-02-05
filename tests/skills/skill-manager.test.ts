/**
 * SkillManager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SkillManager } from '../../src/skills/skill-manager.js'
import { defineSkill } from '../../src/skills/define-skill.js'
import { EventBus } from '../../src/core/event-bus.js'

describe('SkillManager', () => {
  let manager: SkillManager
  let eventBus: EventBus

  const testSkill = defineSkill({
    id: 'test-skill',
    name: 'Test Skill',
    shortDescription: 'A test skill for unit testing',
    instructions: {
      summary: 'This is a test skill summary.',
      procedures: 'Step 1: Do something\nStep 2: Do something else',
      examples: '// Example code here',
      troubleshooting: 'If something goes wrong, check this.'
    },
    tools: ['test-tool'],
    loadingStrategy: 'lazy'
  })

  const eagerSkill = defineSkill({
    id: 'eager-skill',
    name: 'Eager Skill',
    shortDescription: 'Always loaded skill',
    instructions: {
      summary: 'This skill is always loaded.',
      procedures: 'Always available procedures.'
    },
    tools: ['eager-tool'],
    loadingStrategy: 'eager'
  })

  const onDemandSkill = defineSkill({
    id: 'on-demand-skill',
    name: 'On Demand Skill',
    shortDescription: 'Explicitly loaded skill',
    instructions: {
      summary: 'This skill must be explicitly loaded.'
    },
    tools: ['demand-tool'],
    loadingStrategy: 'on-demand'
  })

  beforeEach(() => {
    eventBus = new EventBus()
    manager = new SkillManager({ eventBus, debug: false })
  })

  describe('registration', () => {
    it('should register a skill', () => {
      manager.register(testSkill)

      expect(manager.get('test-skill')).toBe(testSkill)
      expect(manager.getAll()).toHaveLength(1)
    })

    it('should register multiple skills', () => {
      manager.registerAll([testSkill, eagerSkill, onDemandSkill])

      expect(manager.getAll()).toHaveLength(3)
    })

    it('should update existing skill on re-registration', () => {
      manager.register(testSkill)

      const updatedSkill = defineSkill({
        ...testSkill,
        name: 'Updated Test Skill'
      })
      manager.register(updatedSkill)

      expect(manager.get('test-skill')?.name).toBe('Updated Test Skill')
      expect(manager.getAll()).toHaveLength(1)
    })
  })

  describe('loading strategies', () => {
    it('should fully load eager skills on registration', () => {
      manager.register(eagerSkill)

      expect(manager.getState('eager-skill')).toBe('fully-loaded')
      const content = manager.getContent('eager-skill')
      expect(content).toContain('Always available procedures')
    })

    it('should only load summary for lazy skills on registration', () => {
      manager.register(testSkill)

      expect(manager.getState('test-skill')).toBe('summary-loaded')
      const content = manager.getContent('test-skill')
      expect(content).toContain('test skill summary')
      expect(content).not.toContain('Step 1: Do something')
    })

    it('should only load summary for on-demand skills on registration', () => {
      manager.register(onDemandSkill)

      expect(manager.getState('on-demand-skill')).toBe('summary-loaded')
    })
  })

  describe('lazy loading', () => {
    it('should fully load lazy skill when loadFully is called', () => {
      manager.register(testSkill)

      const content = manager.loadFully('test-skill')

      expect(manager.getState('test-skill')).toBe('fully-loaded')
      expect(content).toContain('Step 1: Do something')
      expect(content).toContain('Example code here')
    })

    it('should trigger skill loading when associated tool is used', () => {
      manager.register(testSkill)

      manager.onToolUsed('test-tool')

      expect(manager.getState('test-skill')).toBe('fully-loaded')
    })

    it('should not load on-demand skill when tool is used', () => {
      manager.register(onDemandSkill)

      manager.onToolUsed('demand-tool')

      expect(manager.getState('on-demand-skill')).toBe('summary-loaded')
    })

    it('should load on-demand skill only when explicitly requested', () => {
      manager.register(onDemandSkill)

      manager.loadOnDemand('on-demand-skill')

      expect(manager.getState('on-demand-skill')).toBe('fully-loaded')
    })
  })

  describe('tool to skill mapping', () => {
    it('should return skills associated with a tool', () => {
      manager.registerAll([testSkill, eagerSkill])

      const skills = manager.getSkillsForTool('test-tool')

      expect(skills).toHaveLength(1)
      expect(skills[0].id).toBe('test-skill')
    })

    it('should return empty array for unknown tool', () => {
      manager.register(testSkill)

      const skills = manager.getSkillsForTool('unknown-tool')

      expect(skills).toHaveLength(0)
    })
  })

  describe('content management', () => {
    it('should build summary content correctly', () => {
      manager.register(testSkill)

      const content = manager.getContent('test-skill')

      expect(content).toContain('## Test Skill')
      expect(content).toContain('test skill summary')
    })

    it('should build full content with all sections', () => {
      manager.register(testSkill)
      manager.loadFully('test-skill')

      const content = manager.getContent('test-skill')

      expect(content).toContain('## Test Skill')
      expect(content).toContain('### Procedures')
      expect(content).toContain('### Examples')
      expect(content).toContain('### Troubleshooting')
    })

    it('should downgrade fully loaded skill to summary', () => {
      manager.register(testSkill)
      manager.loadFully('test-skill')
      expect(manager.getState('test-skill')).toBe('fully-loaded')

      manager.downgrade('test-skill')

      expect(manager.getState('test-skill')).toBe('summary-loaded')
      const content = manager.getContent('test-skill')
      expect(content).not.toContain('### Procedures')
    })

    it('should not downgrade eager skills', () => {
      manager.register(eagerSkill)

      manager.downgrade('eager-skill')

      expect(manager.getState('eager-skill')).toBe('fully-loaded')
    })
  })

  describe('prompt sections', () => {
    it('should generate prompt sections for loaded skills', () => {
      manager.registerAll([testSkill, eagerSkill])

      const sections = manager.getPromptSections()

      expect(sections).toHaveLength(2)
      expect(sections.find(s => s.id === 'skill:test-skill')).toBeDefined()
      expect(sections.find(s => s.id === 'skill:eager-skill')).toBeDefined()
    })

    it('should mark eager skills as protected', () => {
      manager.register(eagerSkill)

      const sections = manager.getPromptSections()

      const eagerSection = sections.find(s => s.id === 'skill:eager-skill')
      expect(eagerSection?.protected).toBe(true)
    })

    it('should not mark lazy skills as protected', () => {
      manager.register(testSkill)

      const sections = manager.getPromptSections()

      const lazySection = sections.find(s => s.id === 'skill:test-skill')
      expect(lazySection?.protected).toBe(false)
    })
  })

  describe('token usage', () => {
    it('should calculate current token usage', () => {
      manager.registerAll([testSkill, eagerSkill])

      const usage = manager.getTokenUsage()

      expect(usage.current).toBeGreaterThan(0)
      expect(usage.maxPotential).toBeGreaterThan(usage.current)
    })

    it('should update current usage when skill is fully loaded', () => {
      manager.register(testSkill)
      const usageBefore = manager.getTokenUsage()

      manager.loadFully('test-skill')
      const usageAfter = manager.getTokenUsage()

      expect(usageAfter.current).toBeGreaterThan(usageBefore.current)
    })
  })

  describe('cleanup and management', () => {
    it('should unload a skill', () => {
      manager.register(testSkill)
      expect(manager.get('test-skill')).toBeDefined()

      manager.unload('test-skill')

      expect(manager.get('test-skill')).toBeUndefined()
      expect(manager.getSkillsForTool('test-tool')).toHaveLength(0)
    })

    it('should reset all skills to initial state', () => {
      manager.register(testSkill)
      manager.loadFully('test-skill')
      expect(manager.getState('test-skill')).toBe('fully-loaded')

      manager.reset()

      expect(manager.getState('test-skill')).toBe('summary-loaded')
    })

    it('should provide stats about loaded skills', () => {
      manager.registerAll([testSkill, eagerSkill, onDemandSkill])

      const stats = manager.getStats()

      expect(stats.total).toBe(3)
      expect(stats.byStrategy.eager).toBe(1)
      expect(stats.byStrategy.lazy).toBe(1)
      expect(stats.byStrategy['on-demand']).toBe(1)
    })
  })

  describe('getByStrategy', () => {
    it('should filter skills by loading strategy', () => {
      manager.registerAll([testSkill, eagerSkill, onDemandSkill])

      expect(manager.getByStrategy('lazy')).toHaveLength(1)
      expect(manager.getByStrategy('eager')).toHaveLength(1)
      expect(manager.getByStrategy('on-demand')).toHaveLength(1)
    })
  })
})
