/**
 * Tests for YAML skills dependency configuration.
 */

import { describe, it, expect } from 'vitest'
import { validateConfig, type AgentYAMLConfig } from '../../src/config/loader.js'

describe('YAML skills config validation', () => {
  it('should accept valid skills with id', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ id: 'my-skill' }],
    }
    expect(validateConfig(config)).toEqual([])
  })

  it('should accept valid skills with github', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ github: 'user/repo/skills/my-skill' }],
    }
    expect(validateConfig(config)).toEqual([])
  })

  it('should accept valid skills with github repo root', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ github: 'user/repo' }],
    }
    expect(validateConfig(config)).toEqual([])
  })

  it('should accept valid skills with url', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ url: 'https://example.com/skills/SKILL.md' }],
    }
    expect(validateConfig(config)).toEqual([])
  })

  it('should accept mixed skill entries', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [
        { id: 'local-skill' },
        { github: 'user/repo/path' },
        { url: 'https://example.com/skill.tar.gz' },
      ],
    }
    expect(validateConfig(config)).toEqual([])
  })

  it('should reject skill entry with no keys', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{}],
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('must have one of'))).toBe(true)
  })

  it('should reject skill entry with multiple keys', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ id: 'x', github: 'user/repo' }],
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('exactly one of'))).toBe(true)
  })

  it('should reject invalid github path', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ github: 'no-slash' }],
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('owner/repo'))).toBe(true)
  })

  it('should reject non-http url', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: [{ url: 'ftp://example.com/skill.md' }],
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('http://'))).toBe(true)
  })

  it('should reject non-array skills', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: 'not-an-array' as any,
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('must be an array'))).toBe(true)
  })

  it('should reject non-object skill entries', () => {
    const config: AgentYAMLConfig = {
      id: 'test',
      skills: ['string-entry' as any],
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('must be an object'))).toBe(true)
  })
})
