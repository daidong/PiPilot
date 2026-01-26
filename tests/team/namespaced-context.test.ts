/**
 * Tests for NamespacedContext, ContextPermissions, and ConflictResolver
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  NamespacedContext,
  createNamespacedContext,
  AccessDeniedError
} from '../../src/team/state/namespaced-context.js'
import {
  ContextPermissions,
  WILDCARD_AGENT
} from '../../src/team/state/context-permissions.js'
import {
  ConflictResolver,
  WriteConflictError,
  createLastWriteWinsResolver,
  createMergeResolver,
  createRejectResolver,
  createCustomResolver
} from '../../src/team/state/conflict-resolver.js'

// ============================================================================
// NamespacedContext Tests
// ============================================================================

describe('NamespacedContext', () => {
  let context: NamespacedContext

  beforeEach(() => {
    context = createNamespacedContext({ teamId: 'test-team' })
  })

  describe('team namespace', () => {
    it('should allow any agent to read team namespace', () => {
      context.set('agent1', 'team', 'data', { value: 123 })
      const result = context.get<{ value: number }>('agent2', 'team', 'data')
      expect(result).toEqual({ value: 123 })
    })

    it('should allow any agent to write team namespace', () => {
      context.set('agent1', 'team', 'key1', 'value1')
      context.set('agent2', 'team', 'key2', 'value2')

      expect(context.get('agent1', 'team', 'key1')).toBe('value1')
      expect(context.get('agent1', 'team', 'key2')).toBe('value2')
    })

    it('should list keys in team namespace', () => {
      context.set('agent1', 'team', 'findings', {})
      context.set('agent1', 'team', 'draft', {})
      context.set('agent1', 'team', 'review', {})

      const keys = context.keys('agent1', 'team')
      expect(keys).toContain('findings')
      expect(keys).toContain('draft')
      expect(keys).toContain('review')
    })

    it('should check if key exists', () => {
      context.set('agent1', 'team', 'exists', true)

      expect(context.has('agent1', 'team', 'exists')).toBe(true)
      expect(context.has('agent1', 'team', 'not-exists')).toBe(false)
    })
  })

  describe('agent namespace', () => {
    it('should allow owner to read/write own namespace', () => {
      context.set('researcher', 'agent.researcher', 'notes', 'my notes')
      const result = context.get('researcher', 'agent.researcher', 'notes')
      expect(result).toBe('my notes')
    })

    it('should deny other agents from reading private namespace', () => {
      context.set('researcher', 'agent.researcher', 'secret', 'data')

      expect(() => {
        context.get('writer', 'agent.researcher', 'secret')
      }).toThrow(AccessDeniedError)
    })

    it('should deny other agents from writing private namespace', () => {
      expect(() => {
        context.set('writer', 'agent.researcher', 'hijack', 'bad data')
      }).toThrow(AccessDeniedError)
    })
  })

  describe('namespace accessors', () => {
    it('should provide team() accessor', () => {
      const team = context.team('agent1')
      team.set('data', { count: 5 })

      expect(team.get<{ count: number }>('data')).toEqual({ count: 5 })
      expect(team.has('data')).toBe(true)
      expect(team.keys()).toContain('data')
    })

    it('should provide private_() accessor', () => {
      const priv = context.private_('agent1')
      priv.set('secret', 'hidden')

      expect(priv.get('secret')).toBe('hidden')
    })

    it('should support append operation', () => {
      const team = context.team('agent1')
      team.set('items', ['a'])
      team.append('items', 'b')

      expect(team.get('items')).toEqual(['a', 'b'])
    })

    it('should support patch operation', () => {
      const team = context.team('agent1')
      team.set('config', { host: 'localhost', port: 8080 })
      team.patch('config', { port: 9000 })

      expect(team.get('config')).toEqual({ host: 'localhost', port: 9000 })
    })
  })

  describe('export/import', () => {
    it('should export and import state', () => {
      context.set('agent1', 'team', 'data', { key: 'value' })

      const exported = context.export()
      expect(exported.entries.length).toBeGreaterThan(0)

      // Import to a new context with SAME teamId (paths are absolute with teamId prefix)
      const newContext = createNamespacedContext({ teamId: 'test-team' })
      newContext.import(exported)

      // Now we can access the data normally
      const result = newContext.get('agent1', 'team', 'data')
      expect(result).toEqual({ key: 'value' })
    })
  })
})

// ============================================================================
// ContextPermissions Tests
// ============================================================================

describe('ContextPermissions', () => {
  let permissions: ContextPermissions

  beforeEach(() => {
    permissions = new ContextPermissions()
  })

  describe('default permissions', () => {
    it('should allow all agents to read/write team namespace', () => {
      expect(permissions.canAccess('agent1', 'team', 'read')).toBe(true)
      expect(permissions.canAccess('agent1', 'team', 'write')).toBe(true)
      expect(permissions.canAccess('anyone', 'team', 'write')).toBe(true)
    })

    it('should allow owner full access to own namespace', () => {
      expect(permissions.canAccess('researcher', 'agent.researcher', 'read')).toBe(true)
      expect(permissions.canAccess('researcher', 'agent.researcher', 'write')).toBe(true)
      expect(permissions.canAccess('researcher', 'agent.researcher', 'admin')).toBe(true)
    })

    it('should deny non-owner access to agent namespace', () => {
      expect(permissions.canAccess('writer', 'agent.researcher', 'read')).toBe(false)
      expect(permissions.canAccess('writer', 'agent.researcher', 'write')).toBe(false)
    })
  })

  describe('custom permissions', () => {
    it('should grant specific permissions', () => {
      // Grant writer read access to researcher's namespace
      permissions.grant('writer', 'agent.researcher', 'read')

      expect(permissions.canAccess('writer', 'agent.researcher', 'read')).toBe(true)
      expect(permissions.canAccess('writer', 'agent.researcher', 'write')).toBe(false)
    })

    it('should revoke permissions', () => {
      // Revoke write access from team for specific agent
      permissions.revoke('troublemaker', 'team', 'write')

      expect(permissions.canAccess('troublemaker', 'team', 'write')).toBe(false)
      expect(permissions.canAccess('troublemaker', 'team', 'read')).toBe(false) // revoke denies everything at that level
    })

    it('should support wildcard agent', () => {
      // Grant all agents read access to a specific agent namespace
      permissions.grant(WILDCARD_AGENT, 'agent.shared', 'read')

      expect(permissions.canAccess('anyone', 'agent.shared', 'read')).toBe(true)
    })
  })

  describe('permission check details', () => {
    it('should return detailed check result', () => {
      const result = permissions.checkAccess('researcher', 'agent.researcher', 'admin')

      expect(result.allowed).toBe(true)
      expect(result.grantedBy).toBe('owner')
    })

    it('should explain denial reason', () => {
      const result = permissions.checkAccess('writer', 'agent.researcher', 'read')

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('Not namespace owner')
    })
  })

  describe('export/import', () => {
    it('should export and import permissions', () => {
      permissions.grant('special', 'agent.protected', 'write')

      const exported = permissions.export()
      const newPerms = new ContextPermissions()
      newPerms.import(exported)

      expect(newPerms.canAccess('special', 'agent.protected', 'write')).toBe(true)
    })
  })
})

// ============================================================================
// ConflictResolver Tests
// ============================================================================

describe('ConflictResolver', () => {
  const createMeta = (existingWriter: string, incomingWriter: string): Parameters<ConflictResolver['resolve']>[2] => ({
    key: 'testKey',
    namespace: 'team',
    existingWriter,
    existingTimestamp: 1000,
    incomingWriter,
    incomingTimestamp: 2000
  })

  describe('last-write-wins strategy', () => {
    it('should always return incoming value', () => {
      const resolver = createLastWriteWinsResolver()

      const result = resolver.resolve(
        { old: true },
        { new: true },
        createMeta('agent1', 'agent2')
      )

      expect(result).toEqual({ new: true })
    })
  })

  describe('merge strategy', () => {
    it('should deep merge objects', () => {
      const resolver = createMergeResolver()

      const result = resolver.resolve(
        { a: 1, b: { x: 10 } },
        { c: 3, b: { y: 20 } },
        createMeta('agent1', 'agent2')
      )

      expect(result).toEqual({ a: 1, c: 3, b: { x: 10, y: 20 } })
    })

    it('should concatenate arrays', () => {
      const resolver = createMergeResolver()

      const result = resolver.resolve(
        ['a', 'b'],
        ['c', 'd'],
        createMeta('agent1', 'agent2')
      )

      expect(result).toEqual(['a', 'b', 'c', 'd'])
    })

    it('should handle null values', () => {
      const resolver = createMergeResolver()

      expect(resolver.resolve(null, 'incoming', createMeta('a', 'b'))).toBe('incoming')
      expect(resolver.resolve('existing', null, createMeta('a', 'b'))).toBe('existing')
    })
  })

  describe('reject strategy', () => {
    it('should throw WriteConflictError', () => {
      const resolver = createRejectResolver()

      expect(() => {
        resolver.resolve('old', 'new', createMeta('agent1', 'agent2'))
      }).toThrow(WriteConflictError)
    })

    it('should include conflict metadata in error', () => {
      const resolver = createRejectResolver()
      const meta = createMeta('agent1', 'agent2')

      try {
        resolver.resolve('old', 'new', meta)
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(WriteConflictError)
        expect((e as WriteConflictError).meta.existingWriter).toBe('agent1')
        expect((e as WriteConflictError).meta.incomingWriter).toBe('agent2')
      }
    })
  })

  describe('custom strategy', () => {
    it('should call custom resolver', () => {
      const resolver = createCustomResolver<number>((existing, incoming, meta) => {
        // Custom: take the maximum
        return Math.max(existing, incoming)
      })

      const result = resolver.resolve(5, 10, createMeta('a', 'b'))
      expect(result).toBe(10)

      const result2 = resolver.resolve(20, 10, createMeta('a', 'b'))
      expect(result2).toBe(20)
    })

    it('should require custom resolver function', () => {
      expect(() => {
        new ConflictResolver({ strategy: 'custom' })
      }).toThrow('Custom conflict strategy requires a customResolver function')
    })
  })

  describe('resolveWithDetails', () => {
    it('should return detailed resolution result', () => {
      const resolver = createLastWriteWinsResolver()

      const result = resolver.resolveWithDetails('old', 'new', createMeta('a', 'b'))

      expect(result.value).toBe('new')
      expect(result.strategy).toBe('last-write-wins')
      expect(result.hadConflict).toBe(true)
      expect(result.winner).toBe('incoming')
    })
  })

  describe('setStrategy', () => {
    it('should change strategy at runtime', () => {
      const resolver = createLastWriteWinsResolver()

      // Initially last-write-wins
      expect(resolver.resolve([1], [2], createMeta('a', 'b'))).toEqual([2])

      // Switch to merge
      resolver.setStrategy('merge')
      expect(resolver.resolve([1], [2], createMeta('a', 'b'))).toEqual([1, 2])
    })
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe('P2 Integration', () => {
  it('should handle multi-agent collaboration scenario', () => {
    const context = createNamespacedContext({
      teamId: 'research-team',
      conflictStrategy: 'merge'
    })

    // Researcher writes findings to shared space
    context.set('researcher', 'team', 'findings', ['Finding 1'])
    context.append('researcher', 'team', 'findings', 'Finding 2')

    // Writer reads findings and writes draft
    const findings = context.get<string[]>('writer', 'team', 'findings')
    expect(findings).toEqual(['Finding 1', 'Finding 2'])

    context.set('writer', 'team', 'draft', {
      content: 'Based on findings...',
      basedOn: findings
    })

    // Reviewer reads draft
    const draft = context.get<{ content: string }>('reviewer', 'team', 'draft')
    expect(draft?.content).toBe('Based on findings...')

    // Each agent has private notes
    context.set('researcher', 'agent.researcher', 'notes', 'My research notes')
    context.set('writer', 'agent.writer', 'notes', 'My writing notes')

    // Agents cannot read each other's private notes
    expect(() => {
      context.get('writer', 'agent.researcher', 'notes')
    }).toThrow(AccessDeniedError)
  })

  it('should handle permission customization', () => {
    const context = createNamespacedContext({ teamId: 'secure-team' })
    const permissions = context.getPermissions()

    // Only coordinator can write to decisions
    permissions.revoke(WILDCARD_AGENT, 'team', 'write')
    permissions.grant('coordinator', 'team', 'write')
    permissions.grant(WILDCARD_AGENT, 'team', 'read')

    // Coordinator can write
    context.set('coordinator', 'team', 'decision', 'approved')

    // Others can read
    expect(context.get('anyone', 'team', 'decision')).toBe('approved')

    // Others cannot write
    expect(() => {
      context.set('rogue-agent', 'team', 'decision', 'hijacked')
    }).toThrow(AccessDeniedError)
  })
})
