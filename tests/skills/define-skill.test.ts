/**
 * defineSkill Factory Tests
 */

import { describe, it, expect } from 'vitest'
import { defineSkill, extendSkill, mergeSkills } from '../../src/skills/define-skill.js'

describe('defineSkill', () => {
  it('should create a valid skill from config', () => {
    const skill = defineSkill({
      id: 'test-skill',
      name: 'Test Skill',
      shortDescription: 'A test skill',
      instructions: {
        summary: 'Test summary'
      }
    })

    expect(skill.id).toBe('test-skill')
    expect(skill.name).toBe('Test Skill')
    expect(skill.shortDescription).toBe('A test skill')
    expect(skill.instructions.summary).toBe('Test summary')
    expect(skill.loadingStrategy).toBe('lazy') // default
    expect(skill.tools).toEqual([])
    expect(skill.tags).toEqual([])
  })

  it('should accept all optional fields', () => {
    const skill = defineSkill({
      id: 'full-skill',
      name: 'Full Skill',
      shortDescription: 'All fields provided',
      instructions: {
        summary: 'Summary',
        procedures: 'Procedures',
        examples: 'Examples',
        troubleshooting: 'Troubleshooting'
      },
      tools: ['tool1', 'tool2'],
      loadingStrategy: 'eager',
      tags: ['tag1', 'tag2']
    })

    expect(skill.instructions.procedures).toBe('Procedures')
    expect(skill.instructions.examples).toBe('Examples')
    expect(skill.instructions.troubleshooting).toBe('Troubleshooting')
    expect(skill.tools).toEqual(['tool1', 'tool2'])
    expect(skill.loadingStrategy).toBe('eager')
    expect(skill.tags).toEqual(['tag1', 'tag2'])
  })

  it('should trim whitespace from instructions', () => {
    const skill = defineSkill({
      id: 'trim-skill',
      name: 'Trim Skill',
      shortDescription: 'Testing trim',
      instructions: {
        summary: '  Summary with whitespace  ',
        procedures: '\n\nProcedures\n\n'
      }
    })

    expect(skill.instructions.summary).toBe('Summary with whitespace')
    expect(skill.instructions.procedures).toBe('Procedures')
  })

  it('should calculate token estimates', () => {
    const skill = defineSkill({
      id: 'estimated-skill',
      name: 'Estimated Skill',
      shortDescription: 'Testing estimates',
      instructions: {
        summary: 'A'.repeat(100), // ~25 tokens
        procedures: 'B'.repeat(400) // ~100 tokens
      }
    })

    expect(skill.estimatedTokens.summary).toBeGreaterThan(0)
    expect(skill.estimatedTokens.full).toBeGreaterThan(skill.estimatedTokens.summary)
  })

  it('should use provided token estimates', () => {
    const skill = defineSkill({
      id: 'manual-estimate-skill',
      name: 'Manual Estimate',
      shortDescription: 'Custom estimates',
      instructions: {
        summary: 'Summary'
      },
      estimatedTokens: {
        summary: 100,
        full: 500
      }
    })

    expect(skill.estimatedTokens.summary).toBe(100)
    expect(skill.estimatedTokens.full).toBe(500)
  })

  describe('validation', () => {
    it('should throw on missing id', () => {
      expect(() => defineSkill({
        id: '',
        name: 'Test',
        shortDescription: 'Test',
        instructions: { summary: 'Test' }
      })).toThrow('Skill id is required')
    })

    it('should throw on invalid id format', () => {
      expect(() => defineSkill({
        id: 'Invalid_ID',
        name: 'Test',
        shortDescription: 'Test',
        instructions: { summary: 'Test' }
      })).toThrow('kebab-case')
    })

    it('should throw on missing name', () => {
      expect(() => defineSkill({
        id: 'test-skill',
        name: '',
        shortDescription: 'Test',
        instructions: { summary: 'Test' }
      })).toThrow('Skill name is required')
    })

    it('should throw on missing shortDescription', () => {
      expect(() => defineSkill({
        id: 'test-skill',
        name: 'Test',
        shortDescription: '',
        instructions: { summary: 'Test' }
      })).toThrow('Skill shortDescription is required')
    })

    it('should throw on missing instructions.summary', () => {
      expect(() => defineSkill({
        id: 'test-skill',
        name: 'Test',
        shortDescription: 'Test',
        instructions: { summary: '' }
      })).toThrow('Skill instructions.summary is required')
    })
  })
})

describe('extendSkill', () => {
  const baseSkill = defineSkill({
    id: 'base-skill',
    name: 'Base Skill',
    shortDescription: 'Base description',
    instructions: {
      summary: 'Base summary',
      procedures: 'Base procedures'
    },
    tools: ['base-tool'],
    tags: ['base-tag']
  })

  it('should extend with new id and name', () => {
    const extended = extendSkill(baseSkill, {
      id: 'extended-skill',
      name: 'Extended Skill'
    })

    expect(extended.id).toBe('extended-skill')
    expect(extended.name).toBe('Extended Skill')
    expect(extended.shortDescription).toBe('Base description')
  })

  it('should override instructions', () => {
    const extended = extendSkill(baseSkill, {
      instructions: {
        summary: 'New summary'
      }
    })

    expect(extended.instructions.summary).toBe('New summary')
    expect(extended.instructions.procedures).toBe('Base procedures') // preserved
  })

  it('should merge tags', () => {
    const extended = extendSkill(baseSkill, {
      tags: ['new-tag']
    })

    expect(extended.tags).toContain('base-tag')
    expect(extended.tags).toContain('new-tag')
  })

  it('should override tools if provided', () => {
    const extended = extendSkill(baseSkill, {
      tools: ['new-tool']
    })

    expect(extended.tools).toEqual(['new-tool'])
  })
})

describe('mergeSkills', () => {
  const skillA = defineSkill({
    id: 'skill-a',
    name: 'Skill A',
    shortDescription: 'First skill',
    instructions: {
      summary: 'Summary A',
      procedures: 'Procedures A'
    },
    tools: ['tool-a'],
    tags: ['tag-a']
  })

  const skillB = defineSkill({
    id: 'skill-b',
    name: 'Skill B',
    shortDescription: 'Second skill',
    instructions: {
      summary: 'Summary B',
      examples: 'Examples B'
    },
    tools: ['tool-b'],
    tags: ['tag-b']
  })

  it('should merge multiple skills into one', () => {
    const merged = mergeSkills('merged-skill', 'Merged Skill', [skillA, skillB])

    expect(merged.id).toBe('merged-skill')
    expect(merged.name).toBe('Merged Skill')
  })

  it('should combine instructions with headers', () => {
    const merged = mergeSkills('merged-skill', 'Merged Skill', [skillA, skillB])

    expect(merged.instructions.summary).toContain('### Skill A')
    expect(merged.instructions.summary).toContain('### Skill B')
    expect(merged.instructions.summary).toContain('Summary A')
    expect(merged.instructions.summary).toContain('Summary B')
  })

  it('should combine tools from all skills', () => {
    const merged = mergeSkills('merged-skill', 'Merged Skill', [skillA, skillB])

    expect(merged.tools).toContain('tool-a')
    expect(merged.tools).toContain('tool-b')
  })

  it('should combine tags from all skills', () => {
    const merged = mergeSkills('merged-skill', 'Merged Skill', [skillA, skillB])

    expect(merged.tags).toContain('tag-a')
    expect(merged.tags).toContain('tag-b')
  })

  it('should deduplicate tools and tags', () => {
    const skillWithDupe = defineSkill({
      id: 'skill-dupe',
      name: 'Skill Dupe',
      shortDescription: 'Has duplicate tool',
      instructions: { summary: 'Summary' },
      tools: ['tool-a'], // duplicate
      tags: ['tag-a'] // duplicate
    })

    const merged = mergeSkills('merged-skill', 'Merged Skill', [skillA, skillWithDupe])

    expect(merged.tools!.filter(t => t === 'tool-a')).toHaveLength(1)
    expect(merged.tags!.filter(t => t === 'tag-a')).toHaveLength(1)
  })

  it('should throw on empty skills array', () => {
    expect(() => mergeSkills('merged', 'Merged', [])).toThrow('At least one skill is required')
  })
})
