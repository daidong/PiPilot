/**
 * Academic Writing Skill Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SkillManager } from '../../../src/skills/skill-manager.js'
import { academicWritingSkill } from '../../../examples/research-pilot/skills/index.js'

describe('academicWritingSkill', () => {
  let manager: SkillManager

  beforeEach(() => {
    manager = new SkillManager({ debug: false })
  })

  describe('definition', () => {
    it('should have correct id and name', () => {
      expect(academicWritingSkill.id).toBe('academic-writing-skill')
      expect(academicWritingSkill.name).toBe('Academic Writing')
    })

    it('should be configured for lazy loading', () => {
      expect(academicWritingSkill.loadingStrategy).toBe('lazy')
    })

    it('should be associated with writing tools', () => {
      expect(academicWritingSkill.tools).toContain('writing-outline')
      expect(academicWritingSkill.tools).toContain('writing-draft')
    })

    it('should have appropriate tags', () => {
      expect(academicWritingSkill.tags).toContain('writing')
      expect(academicWritingSkill.tags).toContain('academic')
      expect(academicWritingSkill.tags).toContain('narrative')
    })
  })

  describe('instructions', () => {
    it('should have a concise summary', () => {
      expect(academicWritingSkill.instructions.summary).toBeDefined()
      expect(academicWritingSkill.instructions.summary.length).toBeLessThan(500)
    })

    it('should have detailed procedures', () => {
      const procedures = academicWritingSkill.instructions.procedures!
      expect(procedures).toContain('Writing Philosophy')
      expect(procedures).toContain('narrative')
      expect(procedures).toContain('Outlining Process')
      expect(procedures).toContain('Drafting Process')
    })

    it('should have examples', () => {
      const examples = academicWritingSkill.instructions.examples!
      expect(examples).toContain('Good vs Bad')
      expect(examples).toContain('Citation Integration')
    })

    it('should have troubleshooting', () => {
      const troubleshooting = academicWritingSkill.instructions.troubleshooting!
      expect(troubleshooting).toContain('feels like a list')
      expect(troubleshooting).toContain('Citations feel bolted on')
    })
  })

  describe('token estimates', () => {
    it('should have reasonable summary tokens', () => {
      expect(academicWritingSkill.estimatedTokens.summary).toBeLessThan(150)
    })

    it('should have larger full tokens', () => {
      expect(academicWritingSkill.estimatedTokens.full).toBeGreaterThan(
        academicWritingSkill.estimatedTokens.summary
      )
    })
  })

  describe('SkillManager integration', () => {
    it('should register correctly', () => {
      manager.register(academicWritingSkill)

      expect(manager.get('academic-writing-skill')).toBe(academicWritingSkill)
    })

    it('should start with summary-loaded state (lazy)', () => {
      manager.register(academicWritingSkill)

      expect(manager.getState('academic-writing-skill')).toBe('summary-loaded')
    })

    it('should load fully when tool is used', () => {
      manager.register(academicWritingSkill)

      manager.onToolUsed('writing-outline')

      expect(manager.getState('academic-writing-skill')).toBe('fully-loaded')
    })

    it('should provide pointer content initially', () => {
      manager.register(academicWritingSkill)

      const content = manager.getContent('academic-writing-skill')

      // Lazy skills show a compact pointer, not the full summary
      expect(content).toContain('skill:academic-writing-skill')
      expect(content).toContain('skill.load')
      expect(content).not.toContain('Writing Philosophy')  // Full section not loaded yet
    })

    it('should provide full content after loading', () => {
      manager.register(academicWritingSkill)
      manager.loadFully('academic-writing-skill')

      const content = manager.getContent('academic-writing-skill')

      expect(content).toContain('Academic Writing')
      expect(content).toContain('Writing Philosophy')
      expect(content).toContain('Procedures')
      expect(content).toContain('Examples')
    })
  })

  describe('token savings', () => {
    it('should demonstrate token savings before first use', () => {
      manager.register(academicWritingSkill)

      const usage = manager.getTokenUsage()
      const summaryTokens = academicWritingSkill.estimatedTokens.summary
      const fullTokens = academicWritingSkill.estimatedTokens.full

      // Before loading: only summary tokens used
      expect(usage.current).toBeLessThanOrEqual(summaryTokens * 1.5)  // Allow some overhead

      // Potential savings: difference between full and current
      const potentialSavings = fullTokens - usage.current
      expect(potentialSavings).toBeGreaterThan(0)

      // Should save at least 80% of full content initially
      const savingsRatio = potentialSavings / fullTokens
      expect(savingsRatio).toBeGreaterThan(0.8)
    })
  })
})
