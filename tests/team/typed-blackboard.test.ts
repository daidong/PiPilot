/**
 * Typed Blackboard Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  TypedBlackboard,
  createTypedBlackboard,
  createStatePaths,
  state,
  isTypedStateRef,
  isTypedInitialRef,
  isTypedPrevRef,
  isTypedConstRef,
  isTypedInputRef
} from '../../src/team/state/typed-blackboard.js'

describe('TypedBlackboard', () => {
  const testSchema = {
    plan: z.object({
      queries: z.array(z.string()),
      strategy: z.string()
    }),
    results: z.array(z.object({
      title: z.string(),
      score: z.number()
    })),
    approved: z.boolean()
  }

  let blackboard: TypedBlackboard<typeof testSchema>

  beforeEach(() => {
    blackboard = createTypedBlackboard({
      namespace: 'test',
      schema: testSchema
    })
  })

  describe('basic operations', () => {
    it('should set and get typed values', () => {
      blackboard.set('plan', {
        queries: ['test query'],
        strategy: 'broad'
      })

      const plan = blackboard.get('plan')
      expect(plan).toEqual({
        queries: ['test query'],
        strategy: 'broad'
      })
    })

    it('should return undefined for missing keys', () => {
      expect(blackboard.get('plan')).toBeUndefined()
    })

    it('should check if key exists', () => {
      expect(blackboard.has('plan')).toBe(false)
      blackboard.set('plan', { queries: [], strategy: 'narrow' })
      expect(blackboard.has('plan')).toBe(true)
    })

    it('should delete values', () => {
      blackboard.set('approved', true)
      expect(blackboard.has('approved')).toBe(true)

      blackboard.delete('approved')
      expect(blackboard.has('approved')).toBe(false)
    })
  })

  describe('validation', () => {
    it('should validate values on set', () => {
      expect(() =>
        blackboard.set('plan', { queries: 'not-an-array', strategy: 'test' } as any)
      ).toThrow()
    })

    it('should validate with validate method', () => {
      const validPlan = { queries: ['test'], strategy: 'broad' }
      expect(blackboard.validate('plan', validPlan)).toEqual(validPlan)
    })

    it('should throw on invalid value in validate', () => {
      expect(() =>
        blackboard.validate('plan', { invalid: true })
      ).toThrow()
    })

    it('should return success/error with safeParse', () => {
      const validResult = blackboard.safeParse('approved', true)
      expect(validResult.success).toBe(true)
      if (validResult.success) {
        expect(validResult.data).toBe(true)
      }

      const invalidResult = blackboard.safeParse('approved', 'not-a-boolean')
      expect(invalidResult.success).toBe(false)
    })
  })

  describe('validateOnRead', () => {
    it('should validate on read when enabled', () => {
      const validatingBlackboard = createTypedBlackboard({
        namespace: 'test',
        schema: testSchema,
        validateOnRead: true
      })

      validatingBlackboard.set('plan', { queries: ['test'], strategy: 'narrow' })
      expect(validatingBlackboard.get('plan')).toEqual({
        queries: ['test'],
        strategy: 'narrow'
      })
    })
  })

  describe('path-based access', () => {
    it('should get nested path values', () => {
      blackboard.setPath('deep.nested.value', { data: 123 })
      expect(blackboard.getPath('deep.nested.value')).toEqual({ data: 123 })
    })
  })

  describe('toObject', () => {
    it('should return all state as object', () => {
      blackboard.set('plan', { queries: ['q1'], strategy: 's1' })
      blackboard.set('approved', true)

      const obj = blackboard.toObject()
      expect(obj.plan).toEqual({ queries: ['q1'], strategy: 's1' })
      expect(obj.approved).toBe(true)
    })
  })

  describe('getSchema', () => {
    it('should return the schema', () => {
      expect(blackboard.getSchema()).toBe(testSchema)
    })
  })
})

describe('createStatePaths', () => {
  it('should create typed path references from schema', () => {
    const schema = {
      plan: z.object({ query: z.string() }),
      results: z.array(z.string())
    }

    const paths = createStatePaths(schema)

    expect(paths.plan.type).toBe('typed-state-ref')
    expect(paths.plan.path).toBe('plan')
    expect(paths.results.type).toBe('typed-state-ref')
    expect(paths.results.path).toBe('results')
  })
})

describe('state helpers', () => {
  describe('state.schema', () => {
    it('should create a schema definition', () => {
      const def = state.schema({
        data: z.string()
      })

      expect(def.type).toBe('state-schema')
      expect(def.schema.data).toBeDefined()
    })
  })

  describe('state.path', () => {
    it('should create a typed state reference', () => {
      const ref = state.path<string>('myPath')

      expect(ref.type).toBe('typed-state-ref')
      expect(ref.path).toBe('myPath')
    })
  })

  describe('state.initial', () => {
    it('should create a typed initial reference', () => {
      const ref = state.initial<{ query: string }>()

      expect(ref.type).toBe('typed-initial-ref')
    })
  })

  describe('state.prev', () => {
    it('should create a typed prev reference', () => {
      const ref = state.prev<string>()

      expect(ref.type).toBe('typed-prev-ref')
    })
  })

  describe('state.const', () => {
    it('should create a typed const reference', () => {
      const ref = state.const({ value: 123 })

      expect(ref.type).toBe('typed-const-ref')
      expect(ref.value).toEqual({ value: 123 })
    })
  })
})

describe('type guards', () => {
  it('isTypedStateRef', () => {
    expect(isTypedStateRef(state.path('test'))).toBe(true)
    expect(isTypedStateRef(state.initial())).toBe(false)
    expect(isTypedStateRef(null)).toBe(false)
  })

  it('isTypedInitialRef', () => {
    expect(isTypedInitialRef(state.initial())).toBe(true)
    expect(isTypedInitialRef(state.path('test'))).toBe(false)
    expect(isTypedInitialRef(null)).toBe(false)
  })

  it('isTypedPrevRef', () => {
    expect(isTypedPrevRef(state.prev())).toBe(true)
    expect(isTypedPrevRef(state.initial())).toBe(false)
    expect(isTypedPrevRef(null)).toBe(false)
  })

  it('isTypedConstRef', () => {
    expect(isTypedConstRef(state.const(123))).toBe(true)
    expect(isTypedConstRef(state.path('test'))).toBe(false)
    expect(isTypedConstRef(null)).toBe(false)
  })

  it('isTypedInputRef', () => {
    expect(isTypedInputRef(state.path('test'))).toBe(true)
    expect(isTypedInputRef(state.initial())).toBe(true)
    expect(isTypedInputRef(state.prev())).toBe(true)
    expect(isTypedInputRef(state.const(123))).toBe(true)
    expect(isTypedInputRef(null)).toBe(false)
    expect(isTypedInputRef({ ref: 'initial' })).toBe(false) // Not typed ref
  })
})
