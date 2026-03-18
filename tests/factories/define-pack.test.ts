/**
 * definePack Factory Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  definePack,
  mergePacks,
  extendPack,
  filterPack,
  createEmptyPack
} from '../../src/factories/define-pack.js'
import type { Tool } from '../../src/types/tool.js'
import type { Policy } from '../../src/types/policy.js'
import type { ContextSource } from '../../src/types/context.js'
import type { Skill } from '../../src/types/skill.js'
import type { Pack } from '../../src/types/pack.js'

// Helper factories
function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({ success: true })
  }
}

function makePolicy(id: string, phase: 'guard' | 'mutate' | 'observe' = 'guard'): Policy {
  return {
    id,
    phase,
    match: () => true,
    decide: () => ({ action: 'allow' })
  }
}

function makeContextSource(id: string): ContextSource {
  return {
    id,
    namespace: id.split('.')[0],
    kind: 'get',
    description: `Source ${id}`,
    shortDescription: `Source ${id}`,
    resourceTypes: [],
    costTier: 'cheap',
    fetch: async () => ({
      success: true,
      data: null,
      rendered: '',
      provenance: { operations: [], durationMs: 0, cached: false },
      coverage: { complete: true }
    })
  }
}

function makeSkill(id: string, strategy: 'eager' | 'lazy' | 'on-demand' = 'lazy'): Skill {
  return {
    id,
    name: `Skill ${id}`,
    shortDescription: `Description for ${id}`,
    instructions: { summary: `Summary for ${id}` },
    tools: [],
    loadingStrategy: strategy,
    tags: [],
    estimatedTokens: { summary: 50, full: 200 }
  }
}

function makePack(id: string, overrides: Partial<Pack> = {}): Pack {
  return {
    id,
    description: `Pack ${id}`,
    tools: [],
    policies: [],
    contextSources: [],
    skills: [],
    dependencies: [],
    ...overrides
  }
}

describe('definePack', () => {
  it('should create a valid pack from config', () => {
    const tool = makeTool('read')
    const policy = makePolicy('guard-1')

    const pack = definePack({
      id: 'test-pack',
      description: 'A test pack',
      tools: [tool],
      policies: [policy]
    })

    expect(pack.id).toBe('test-pack')
    expect(pack.description).toBe('A test pack')
    expect(pack.tools).toHaveLength(1)
    expect(pack.policies).toHaveLength(1)
    expect(pack.contextSources).toEqual([])
    expect(pack.skills).toEqual([])
    expect(pack.dependencies).toEqual([])
  })

  it('should throw when id is missing', () => {
    expect(() => definePack({
      id: '',
      description: 'desc'
    })).toThrow('Pack id is required')
  })

  it('should throw when description is missing', () => {
    expect(() => definePack({
      id: 'test',
      description: ''
    })).toThrow('Pack description is required')
  })

  it('should auto-build skillLoadingConfig from skills', () => {
    const eagerSkill = makeSkill('eager-skill', 'eager')
    const lazySkill = makeSkill('lazy-skill', 'lazy')
    const onDemandSkill = makeSkill('on-demand-skill', 'on-demand')

    const pack = definePack({
      id: 'skill-pack',
      description: 'Has skills',
      skills: [eagerSkill, lazySkill, onDemandSkill]
    })

    expect(pack.skillLoadingConfig).toBeDefined()
    expect(pack.skillLoadingConfig!.eager).toContain('eager-skill')
    expect(pack.skillLoadingConfig!.lazy).toContain('lazy-skill')
    expect(pack.skillLoadingConfig!.onDemand).toContain('on-demand-skill')
  })

  it('should not override explicit skillLoadingConfig', () => {
    const skill = makeSkill('my-skill', 'lazy')
    const customConfig = { eager: ['my-skill'], lazy: [], onDemand: [] }

    const pack = definePack({
      id: 'custom-config-pack',
      description: 'Custom config',
      skills: [skill],
      skillLoadingConfig: customConfig
    })

    expect(pack.skillLoadingConfig!.eager).toContain('my-skill')
    expect(pack.skillLoadingConfig!.lazy).toEqual([])
  })

  it('should warn when using both promptFragment and skills', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    definePack({
      id: 'mixed-pack',
      description: 'Uses both',
      skills: [makeSkill('s1')],
      promptFragment: 'Some legacy prompt'
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('both promptFragment and skills')
    )

    warnSpy.mockRestore()
  })

  it('should preserve onInit and onDestroy callbacks', () => {
    const onInit = vi.fn()
    const onDestroy = vi.fn()

    const pack = definePack({
      id: 'lifecycle-pack',
      description: 'Has lifecycle',
      onInit,
      onDestroy
    })

    expect(pack.onInit).toBe(onInit)
    expect(pack.onDestroy).toBe(onDestroy)
  })
})

describe('mergePacks', () => {
  it('should merge two packs', () => {
    const pack1 = makePack('pack1', {
      tools: [makeTool('tool-a')],
      policies: [makePolicy('policy-a')]
    })
    const pack2 = makePack('pack2', {
      tools: [makeTool('tool-b')],
      policies: [makePolicy('policy-b')]
    })

    const merged = mergePacks(pack1, pack2)

    expect(merged.id).toBe('pack1+pack2')
    expect(merged.tools).toHaveLength(2)
    expect(merged.policies).toHaveLength(2)
  })

  it('should deduplicate tools by name', () => {
    const pack1 = makePack('p1', { tools: [makeTool('read')] })
    const pack2 = makePack('p2', { tools: [makeTool('read'), makeTool('write')] })

    const merged = mergePacks(pack1, pack2)

    expect(merged.tools).toHaveLength(2)
    expect(merged.tools!.map(t => t.name)).toEqual(['read', 'write'])
  })

  it('should deduplicate policies by id', () => {
    const pack1 = makePack('p1', { policies: [makePolicy('guard-1')] })
    const pack2 = makePack('p2', { policies: [makePolicy('guard-1'), makePolicy('guard-2')] })

    const merged = mergePacks(pack1, pack2)

    expect(merged.policies).toHaveLength(2)
  })

  it('should deduplicate skills by id', () => {
    const pack1 = makePack('p1', { skills: [makeSkill('skill-a')] })
    const pack2 = makePack('p2', { skills: [makeSkill('skill-a'), makeSkill('skill-b')] })

    const merged = mergePacks(pack1, pack2)

    expect(merged.skills).toHaveLength(2)
  })

  it('should merge skill loading configs without duplicates', () => {
    const pack1 = makePack('p1', {
      skillLoadingConfig: { eager: ['s1'], lazy: ['s2'], onDemand: [] }
    })
    const pack2 = makePack('p2', {
      skillLoadingConfig: { eager: ['s1', 's3'], lazy: [], onDemand: ['s4'] }
    })

    const merged = mergePacks(pack1, pack2)

    expect(merged.skillLoadingConfig!.eager).toEqual(['s1', 's3'])
    expect(merged.skillLoadingConfig!.lazy).toEqual(['s2'])
    expect(merged.skillLoadingConfig!.onDemand).toEqual(['s4'])
  })

  it('should merge prompt fragments', () => {
    const pack1 = makePack('p1', { promptFragment: 'Fragment A' })
    const pack2 = makePack('p2', { promptFragment: 'Fragment B' })

    const merged = mergePacks(pack1, pack2)

    expect(merged.promptFragment).toContain('Fragment A')
    expect(merged.promptFragment).toContain('Fragment B')
  })

  it('should merge dependencies without duplicates', () => {
    const pack1 = makePack('p1', { dependencies: ['dep-a', 'dep-b'] })
    const pack2 = makePack('p2', { dependencies: ['dep-b', 'dep-c'] })

    const merged = mergePacks(pack1, pack2)

    expect(merged.dependencies).toEqual(['dep-a', 'dep-b', 'dep-c'])
  })

  it('should merge onInit functions', async () => {
    const init1 = vi.fn()
    const init2 = vi.fn()

    const pack1 = makePack('p1')
    pack1.onInit = init1
    const pack2 = makePack('p2')
    pack2.onInit = init2

    const merged = mergePacks(pack1, pack2)
    await merged.onInit!({} as any)

    expect(init1).toHaveBeenCalled()
    expect(init2).toHaveBeenCalled()
  })

  it('should merge onDestroy functions', async () => {
    const destroy1 = vi.fn()
    const destroy2 = vi.fn()

    const pack1 = makePack('p1')
    pack1.onDestroy = destroy1
    const pack2 = makePack('p2')
    pack2.onDestroy = destroy2

    const merged = mergePacks(pack1, pack2)
    await merged.onDestroy!({} as any)

    expect(destroy1).toHaveBeenCalled()
    expect(destroy2).toHaveBeenCalled()
  })
})

describe('extendPack', () => {
  it('should extend base pack with new tools', () => {
    const base = makePack('base', { tools: [makeTool('read')] })

    const extended = extendPack(base, {
      tools: [makeTool('write')]
    })

    expect(extended.tools).toHaveLength(2)
    expect(extended.tools!.map(t => t.name)).toEqual(['read', 'write'])
  })

  it('should override id and description when provided', () => {
    const base = makePack('base')

    const extended = extendPack(base, {
      id: 'extended',
      description: 'Extended pack'
    })

    expect(extended.id).toBe('extended')
    expect(extended.description).toBe('Extended pack')
  })

  it('should keep base id and description when not overridden', () => {
    const base = makePack('base')

    const extended = extendPack(base, {
      tools: [makeTool('new-tool')]
    })

    expect(extended.id).toBe('base')
    expect(extended.description).toBe('Pack base')
  })

  it('should deduplicate skills when extending', () => {
    const base = makePack('base', { skills: [makeSkill('shared-skill')] })

    const extended = extendPack(base, {
      skills: [makeSkill('shared-skill'), makeSkill('new-skill')]
    })

    expect(extended.skills).toHaveLength(2)
    expect(extended.skills!.map(s => s.id)).toEqual(['shared-skill', 'new-skill'])
  })

  it('should merge skill loading configs with deduplication', () => {
    const base = makePack('base', {
      skillLoadingConfig: { eager: ['s1'], lazy: ['s2'], onDemand: [] }
    })

    const extended = extendPack(base, {
      skillLoadingConfig: { eager: ['s1', 's3'], lazy: [], onDemand: ['s4'] }
    })

    expect(extended.skillLoadingConfig!.eager).toEqual(['s1', 's3'])
    expect(extended.skillLoadingConfig!.lazy).toEqual(['s2'])
    expect(extended.skillLoadingConfig!.onDemand).toEqual(['s4'])
  })

  it('should merge dependencies without duplicates', () => {
    const base = makePack('base', { dependencies: ['dep-a'] })

    const extended = extendPack(base, {
      dependencies: ['dep-a', 'dep-b']
    })

    expect(extended.dependencies).toEqual(['dep-a', 'dep-b'])
  })

  it('should chain onInit and onDestroy', async () => {
    const baseInit = vi.fn()
    const extInit = vi.fn()
    const baseDestroy = vi.fn()
    const extDestroy = vi.fn()

    const base = makePack('base')
    base.onInit = baseInit
    base.onDestroy = baseDestroy

    const extended = extendPack(base, {
      onInit: extInit,
      onDestroy: extDestroy
    })

    await extended.onInit!({} as any)
    await extended.onDestroy!({} as any)

    expect(baseInit).toHaveBeenCalled()
    expect(extInit).toHaveBeenCalled()
    expect(baseDestroy).toHaveBeenCalled()
    expect(extDestroy).toHaveBeenCalled()
  })

  it('should concatenate prompt fragments', () => {
    const base = makePack('base', { promptFragment: 'Base prompt' })

    const extended = extendPack(base, {
      promptFragment: 'Extension prompt'
    })

    expect(extended.promptFragment).toContain('Base prompt')
    expect(extended.promptFragment).toContain('Extension prompt')
  })
})

describe('filterPack', () => {
  it('should filter tools by predicate', () => {
    const pack = makePack('full', {
      tools: [makeTool('read'), makeTool('write'), makeTool('bash')]
    })

    const filtered = filterPack(pack, {
      tools: (t) => t.name !== 'bash'
    })

    expect(filtered.tools).toHaveLength(2)
    expect(filtered.tools!.map(t => t.name)).toEqual(['read', 'write'])
  })

  it('should filter policies by predicate', () => {
    const pack = makePack('full', {
      policies: [makePolicy('guard-1'), makePolicy('mutate-1', 'mutate')]
    })

    const filtered = filterPack(pack, {
      policies: (p) => p.phase === 'guard'
    })

    expect(filtered.policies).toHaveLength(1)
    expect(filtered.policies![0].id).toBe('guard-1')
  })

  it('should filter skills and update skillLoadingConfig', () => {
    const pack = makePack('full', {
      skills: [makeSkill('keep-skill', 'eager'), makeSkill('remove-skill', 'lazy')],
      skillLoadingConfig: {
        eager: ['keep-skill'],
        lazy: ['remove-skill'],
        onDemand: []
      }
    })

    const filtered = filterPack(pack, {
      skills: (s) => s.id === 'keep-skill'
    })

    expect(filtered.skills).toHaveLength(1)
    expect(filtered.skills![0].id).toBe('keep-skill')
    expect(filtered.skillLoadingConfig!.eager).toEqual(['keep-skill'])
    expect(filtered.skillLoadingConfig!.lazy).toEqual([])
  })

  it('should leave unfiltered components untouched', () => {
    const pack = makePack('full', {
      tools: [makeTool('read'), makeTool('write')],
      policies: [makePolicy('guard-1')]
    })

    const filtered = filterPack(pack, {
      tools: (t) => t.name === 'read'
    })

    // Tools filtered
    expect(filtered.tools).toHaveLength(1)
    // Policies untouched
    expect(filtered.policies).toHaveLength(1)
  })

  it('should handle pack without skillLoadingConfig', () => {
    const pack = makePack('minimal', {
      skills: [makeSkill('s1')]
    })
    // Explicitly no skillLoadingConfig
    delete (pack as any).skillLoadingConfig

    const filtered = filterPack(pack, {
      skills: () => false
    })

    expect(filtered.skills).toHaveLength(0)
    expect(filtered.skillLoadingConfig).toBeUndefined()
  })
})

describe('createEmptyPack', () => {
  it('should create a pack with no components', () => {
    const pack = createEmptyPack('empty', 'An empty pack')

    expect(pack.id).toBe('empty')
    expect(pack.description).toBe('An empty pack')
    expect(pack.tools).toEqual([])
    expect(pack.policies).toEqual([])
    expect(pack.contextSources).toEqual([])
    expect(pack.skills).toEqual([])
    expect(pack.dependencies).toEqual([])
  })

  it('should be extendable after creation', () => {
    const empty = createEmptyPack('starter', 'Starter pack')
    const extended = extendPack(empty, {
      tools: [makeTool('read')]
    })

    expect(extended.tools).toHaveLength(1)
  })
})
