/**
 * Business-Semantic Until Conditions Tests
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  until,
  evaluateBusinessUntil,
  evaluateThreeState,
  isBusinessUntilSpec,
  isFieldUntilSpec,
  isValidatorUntilSpec,
  isThreeStateUntilSpec
} from '../../src/team/flow/until.js'
import { state } from '../../src/team/state/typed-blackboard.js'
import type { UntilEvaluationContext } from '../../src/team/flow/until.js'

// Helper to create evaluation context
function createContext(
  stateValues: Record<string, unknown>,
  options: Partial<UntilEvaluationContext> = {}
): UntilEvaluationContext {
  return {
    getStateValue: (path: string) => {
      const parts = path.split('.')
      let value: unknown = stateValues
      for (const part of parts) {
        if (value === null || value === undefined || typeof value !== 'object') {
          return undefined
        }
        value = (value as Record<string, unknown>)[part]
      }
      return value
    },
    iteration: options.iteration ?? 0,
    budget: options.budget,
    progressTracker: options.progressTracker
  }
}

describe('until builder', () => {
  describe('until.field', () => {
    it('should create field-eq condition with TypedStateRef', () => {
      const spec = until.field(state.path<boolean>('review.approved')).eq(true)

      expect(spec.type).toBe('field-eq')
      expect(spec.path).toBe('review.approved')
      expect(spec.value).toBe(true)
    })

    it('should create field-eq condition with string path', () => {
      const spec = until.field('status').eq('completed')

      expect(spec.type).toBe('field-eq')
      expect(spec.path).toBe('status')
      expect(spec.value).toBe('completed')
    })

    it('should create field-neq condition', () => {
      const spec = until.field(state.path<string>('status')).neq('pending')

      expect(spec.type).toBe('field-neq')
      expect(spec.path).toBe('status')
      expect(spec.value).toBe('pending')
    })

    it('should create field-truthy condition', () => {
      const spec = until.field(state.path<boolean>('completed')).truthy()

      expect(spec.type).toBe('field-truthy')
      expect(spec.path).toBe('completed')
    })

    it('should create field-falsy condition', () => {
      const spec = until.field(state.path<boolean>('hasErrors')).falsy()

      expect(spec.type).toBe('field-falsy')
      expect(spec.path).toBe('hasErrors')
    })

    it('should create field-compare condition', () => {
      const spec = until.field(state.path<number>('confidence')).compare('gte', 0.9)

      expect(spec.type).toBe('field-compare')
      expect(spec.path).toBe('confidence')
      expect(spec.comparator).toBe('gte')
      expect(spec.value).toBe(0.9)
    })
  })

  describe('until.validator', () => {
    it('should create validator condition', () => {
      const schema = z.array(z.object({ resolved: z.boolean() }))
      const check = (issues: Array<{ resolved: boolean }>) => issues.every(i => i.resolved)

      const spec = until.validator(state.path('issues'), schema, check)

      expect(spec.type).toBe('validator')
      expect(spec.path).toBe('issues')
      expect(spec.schema).toBe(schema)
      expect(typeof spec.check).toBe('function')
    })
  })

  describe('until.maxIterations', () => {
    it('should create max-iterations condition', () => {
      const spec = until.maxIterations(5)

      expect(spec.type).toBe('max-iterations')
      expect(spec.count).toBe(5)
    })
  })

  describe('until.noProgress', () => {
    it('should create no-progress condition with default window', () => {
      const spec = until.noProgress()

      expect(spec.type).toBe('no-progress')
      expect(spec.windowSize).toBeUndefined()
    })

    it('should create no-progress condition with custom window', () => {
      const spec = until.noProgress(3)

      expect(spec.type).toBe('no-progress')
      expect(spec.windowSize).toBe(3)
    })
  })

  describe('until.budgetExceeded', () => {
    it('should create budget-exceeded condition', () => {
      const spec = until.budgetExceeded()

      expect(spec.type).toBe('budget-exceeded')
    })
  })

  describe('until.all', () => {
    it('should create combined all condition', () => {
      const spec = until.all(
        until.field(state.path('approved')).eq(true),
        until.field(state.path('confidence')).compare('gte', 0.8)
      )

      expect(spec.type).toBe('all')
      expect(spec.conditions.length).toBe(2)
    })
  })

  describe('until.any', () => {
    it('should create combined any condition', () => {
      const spec = until.any(
        until.field(state.path('approved')).eq(true),
        until.maxIterations(5)
      )

      expect(spec.type).toBe('any')
      expect(spec.conditions.length).toBe(2)
    })
  })
})

describe('evaluateBusinessUntil', () => {
  describe('field-eq', () => {
    it('should return true when field equals value', () => {
      const spec = until.field('approved').eq(true)
      const ctx = createContext({ approved: true })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })

    it('should return false when field does not equal value', () => {
      const spec = until.field('approved').eq(true)
      const ctx = createContext({ approved: false })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })

    it('should handle nested paths', () => {
      const spec = until.field('review.approved').eq(true)
      const ctx = createContext({ review: { approved: true } })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })
  })

  describe('field-neq', () => {
    it('should return true when field does not equal value', () => {
      const spec = until.field('status').neq('pending')
      const ctx = createContext({ status: 'completed' })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })

    it('should return false when field equals value', () => {
      const spec = until.field('status').neq('pending')
      const ctx = createContext({ status: 'pending' })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })
  })

  describe('field-truthy', () => {
    it('should return true for truthy values', () => {
      const spec = until.field('completed').truthy()

      expect(evaluateBusinessUntil(spec, createContext({ completed: true }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ completed: 1 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ completed: 'yes' }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ completed: {} }))).toBe(true)
    })

    it('should return false for falsy values', () => {
      const spec = until.field('completed').truthy()

      expect(evaluateBusinessUntil(spec, createContext({ completed: false }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({ completed: 0 }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({ completed: '' }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({ completed: null }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({}))).toBe(false)
    })
  })

  describe('field-falsy', () => {
    it('should return true for falsy values', () => {
      const spec = until.field('hasErrors').falsy()

      expect(evaluateBusinessUntil(spec, createContext({ hasErrors: false }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ hasErrors: 0 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({}))).toBe(true)
    })

    it('should return false for truthy values', () => {
      const spec = until.field('hasErrors').falsy()

      expect(evaluateBusinessUntil(spec, createContext({ hasErrors: true }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({ hasErrors: 1 }))).toBe(false)
    })
  })

  describe('field-compare', () => {
    it('should evaluate gt correctly', () => {
      const spec = until.field('count').compare('gt', 5)

      expect(evaluateBusinessUntil(spec, createContext({ count: 6 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ count: 5 }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({ count: 4 }))).toBe(false)
    })

    it('should evaluate gte correctly', () => {
      const spec = until.field('confidence').compare('gte', 0.9)

      expect(evaluateBusinessUntil(spec, createContext({ confidence: 0.95 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ confidence: 0.9 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ confidence: 0.85 }))).toBe(false)
    })

    it('should evaluate lt correctly', () => {
      const spec = until.field('errors').compare('lt', 3)

      expect(evaluateBusinessUntil(spec, createContext({ errors: 2 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ errors: 3 }))).toBe(false)
    })

    it('should evaluate lte correctly', () => {
      const spec = until.field('retries').compare('lte', 3)

      expect(evaluateBusinessUntil(spec, createContext({ retries: 3 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({ retries: 4 }))).toBe(false)
    })

    it('should return false for non-numeric values', () => {
      const spec = until.field('value').compare('gt', 5)

      expect(evaluateBusinessUntil(spec, createContext({ value: 'not a number' }))).toBe(false)
    })
  })

  describe('validator', () => {
    it('should return true when validator check passes', () => {
      const schema = z.object({ approved: z.boolean(), score: z.number() })
      const check = (v: { approved: boolean; score: number }) => v.approved && v.score >= 0.8

      const spec = until.validator('review', schema, check)
      const ctx = createContext({ review: { approved: true, score: 0.9 } })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })

    it('should return false when validator check fails', () => {
      const schema = z.object({ approved: z.boolean() })
      const check = (v: { approved: boolean }) => v.approved

      const spec = until.validator('review', schema, check)
      const ctx = createContext({ review: { approved: false } })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })

    it('should return false when schema validation fails', () => {
      const schema = z.object({ approved: z.boolean() })
      const check = (v: { approved: boolean }) => v.approved

      const spec = until.validator('review', schema, check)
      const ctx = createContext({ review: { approved: 'not a boolean' } })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })

    it('should return false when value is undefined', () => {
      const schema = z.object({ approved: z.boolean() })
      const check = () => true

      const spec = until.validator('missing', schema, check)
      const ctx = createContext({})

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })
  })

  describe('max-iterations', () => {
    it('should return true when iteration count reached', () => {
      const spec = until.maxIterations(3)

      expect(evaluateBusinessUntil(spec, createContext({}, { iteration: 3 }))).toBe(true)
      expect(evaluateBusinessUntil(spec, createContext({}, { iteration: 5 }))).toBe(true)
    })

    it('should return false when iteration count not reached', () => {
      const spec = until.maxIterations(3)

      expect(evaluateBusinessUntil(spec, createContext({}, { iteration: 2 }))).toBe(false)
      expect(evaluateBusinessUntil(spec, createContext({}, { iteration: 0 }))).toBe(false)
    })
  })

  describe('budget-exceeded', () => {
    it('should return true when budget exceeded', () => {
      const spec = until.budgetExceeded()
      const ctx = createContext({}, {
        budget: { used: 100, limit: 100 }
      })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })

    it('should return false when budget not exceeded', () => {
      const spec = until.budgetExceeded()
      const ctx = createContext({}, {
        budget: { used: 50, limit: 100 }
      })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })

    it('should return false when no budget tracker', () => {
      const spec = until.budgetExceeded()
      const ctx = createContext({})

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })
  })

  describe('all combinator', () => {
    it('should return true when all conditions are true', () => {
      const spec = until.all(
        until.field('approved').eq(true),
        until.field('confidence').compare('gte', 0.8)
      )
      const ctx = createContext({ approved: true, confidence: 0.9 })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })

    it('should return false when any condition is false', () => {
      const spec = until.all(
        until.field('approved').eq(true),
        until.field('confidence').compare('gte', 0.8)
      )
      const ctx = createContext({ approved: true, confidence: 0.5 })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })
  })

  describe('any combinator', () => {
    it('should return true when any condition is true', () => {
      const spec = until.any(
        until.field('approved').eq(true),
        until.maxIterations(5)
      )
      const ctx = createContext({ approved: false }, { iteration: 5 })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(true)
    })

    it('should return false when all conditions are false', () => {
      const spec = until.any(
        until.field('approved').eq(true),
        until.maxIterations(5)
      )
      const ctx = createContext({ approved: false }, { iteration: 2 })

      expect(evaluateBusinessUntil(spec, ctx)).toBe(false)
    })
  })
})

describe('type guards', () => {
  describe('isBusinessUntilSpec', () => {
    it('should return true for business until specs', () => {
      expect(isBusinessUntilSpec(until.field('x').eq(true))).toBe(true)
      expect(isBusinessUntilSpec(until.field('x').neq(false))).toBe(true)
      expect(isBusinessUntilSpec(until.field('x').truthy())).toBe(true)
      expect(isBusinessUntilSpec(until.field('x').falsy())).toBe(true)
      expect(isBusinessUntilSpec(until.field('x').compare('gt', 5))).toBe(true)
      expect(isBusinessUntilSpec(until.maxIterations(3))).toBe(true)
      expect(isBusinessUntilSpec(until.noProgress())).toBe(true)
      expect(isBusinessUntilSpec(until.budgetExceeded())).toBe(true)
      expect(isBusinessUntilSpec(until.all())).toBe(true)
      expect(isBusinessUntilSpec(until.any())).toBe(true)
    })

    it('should return false for non-business until specs', () => {
      expect(isBusinessUntilSpec(null)).toBe(false)
      expect(isBusinessUntilSpec(undefined)).toBe(false)
      expect(isBusinessUntilSpec({})).toBe(false)
      expect(isBusinessUntilSpec({ type: 'predicate' })).toBe(false)
    })
  })

  describe('isFieldUntilSpec', () => {
    it('should return true for field until specs', () => {
      expect(isFieldUntilSpec(until.field('x').eq(true))).toBe(true)
      expect(isFieldUntilSpec(until.field('x').neq(false))).toBe(true)
      expect(isFieldUntilSpec(until.field('x').truthy())).toBe(true)
      expect(isFieldUntilSpec(until.field('x').falsy())).toBe(true)
      expect(isFieldUntilSpec(until.field('x').compare('gt', 5))).toBe(true)
    })

    it('should return false for non-field until specs', () => {
      expect(isFieldUntilSpec(until.maxIterations(3))).toBe(false)
      expect(isFieldUntilSpec(until.budgetExceeded())).toBe(false)
      expect(isFieldUntilSpec(null)).toBe(false)
    })
  })

  describe('isValidatorUntilSpec', () => {
    it('should return true for validator until specs', () => {
      const schema = z.boolean()
      expect(isValidatorUntilSpec(until.validator('x', schema, () => true))).toBe(true)
    })

    it('should return false for non-validator until specs', () => {
      expect(isValidatorUntilSpec(until.field('x').eq(true))).toBe(false)
      expect(isValidatorUntilSpec(null)).toBe(false)
    })
  })

  describe('isThreeStateUntilSpec', () => {
    it('should return true for three-state until specs', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })
      expect(isThreeStateUntilSpec(spec)).toBe(true)
    })

    it('should return false for other until specs', () => {
      expect(isThreeStateUntilSpec(until.field('x').eq(true))).toBe(false)
      expect(isThreeStateUntilSpec(until.maxIterations(3))).toBe(false)
      expect(isThreeStateUntilSpec(null)).toBe(false)
    })
  })
})

describe('three-state termination', () => {
  describe('until.threeState', () => {
    it('should create three-state condition spec', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })

      expect(spec.type).toBe('three-state')
      expect(spec.approvalPath).toBe('review.approved')
      expect(spec.refinementPath).toBe('review.additionalQueries')
    })

    it('should accept custom hasActionableRefinement function', () => {
      const customCheck = (r: unknown) => Array.isArray(r) && r.length > 2
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.queries',
        hasActionableRefinement: customCheck
      })

      expect(spec.hasActionableRefinement).toBe(customCheck)
    })
  })

  describe('evaluateThreeState', () => {
    it('should return success when approved is true', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })
      const ctx = createContext({
        review: { approved: true, additionalQueries: [] }
      })

      const result = evaluateThreeState(spec, ctx)

      expect(result.done).toBe(true)
      expect(result.reason).toBe('approved')
      expect(result.failed).toBe(false)
    })

    it('should return no-actionable-refinement when rejected with empty queries', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })
      const ctx = createContext({
        review: { approved: false, additionalQueries: [] }
      })

      const result = evaluateThreeState(spec, ctx)

      expect(result.done).toBe(true)
      expect(result.reason).toBe('no-actionable-refinement')
      expect(result.failed).toBe(true)
    })

    it('should return no-actionable-refinement when refinement is undefined', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })
      const ctx = createContext({
        review: { approved: false }
      })

      const result = evaluateThreeState(spec, ctx)

      expect(result.done).toBe(true)
      expect(result.reason).toBe('no-actionable-refinement')
      expect(result.failed).toBe(true)
    })

    it('should return no-actionable-refinement when refinement is null', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })
      const ctx = createContext({
        review: { approved: false, additionalQueries: null }
      })

      const result = evaluateThreeState(spec, ctx)

      expect(result.done).toBe(true)
      expect(result.reason).toBe('no-actionable-refinement')
      expect(result.failed).toBe(true)
    })

    it('should return continue when rejected with actionable queries', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.additionalQueries'
      })
      const ctx = createContext({
        review: { approved: false, additionalQueries: ['query1', 'query2'] }
      })

      const result = evaluateThreeState(spec, ctx)

      expect(result.done).toBe(false)
      expect(result.reason).toBe('continue')
      expect(result.failed).toBe(false)
    })

    it('should use custom hasActionableRefinement check', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.suggestions',
        hasActionableRefinement: (r) => {
          // Only consider it actionable if there are at least 2 suggestions
          return Array.isArray(r) && r.length >= 2
        }
      })

      // Single suggestion - not actionable
      const ctx1 = createContext({
        review: { approved: false, suggestions: ['one'] }
      })
      expect(evaluateThreeState(spec, ctx1)).toEqual({
        done: true,
        reason: 'no-actionable-refinement',
        failed: true
      })

      // Two suggestions - actionable
      const ctx2 = createContext({
        review: { approved: false, suggestions: ['one', 'two'] }
      })
      expect(evaluateThreeState(spec, ctx2)).toEqual({
        done: false,
        reason: 'continue',
        failed: false
      })
    })

    it('should work with nested approval paths', () => {
      const spec = until.threeState({
        approvalPath: 'feedback.result.approved',
        refinementPath: 'feedback.result.nextSteps'
      })
      const ctx = createContext({
        feedback: {
          result: {
            approved: true,
            nextSteps: []
          }
        }
      })

      const result = evaluateThreeState(spec, ctx)

      expect(result.done).toBe(true)
      expect(result.reason).toBe('approved')
    })

    it('should handle object refinements as actionable when non-empty', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.changes'
      })

      // Empty object - not actionable
      const ctx1 = createContext({
        review: { approved: false, changes: {} }
      })
      expect(evaluateThreeState(spec, ctx1).reason).toBe('no-actionable-refinement')

      // Non-empty object - actionable
      const ctx2 = createContext({
        review: { approved: false, changes: { title: 'New title' } }
      })
      expect(evaluateThreeState(spec, ctx2).reason).toBe('continue')
    })
  })

  describe('evaluateBusinessUntil with three-state', () => {
    it('should work as condition in evaluateBusinessUntil', () => {
      const spec = until.threeState({
        approvalPath: 'review.approved',
        refinementPath: 'review.queries'
      })

      // Approved - should stop
      const ctx1 = createContext({ review: { approved: true, queries: [] } })
      expect(evaluateBusinessUntil(spec, ctx1)).toBe(true)

      // Not approved with queries - should continue
      const ctx2 = createContext({ review: { approved: false, queries: ['q'] } })
      expect(evaluateBusinessUntil(spec, ctx2)).toBe(false)

      // Not approved without queries - should stop (failed)
      const ctx3 = createContext({ review: { approved: false, queries: [] } })
      expect(evaluateBusinessUntil(spec, ctx3)).toBe(true)
    })
  })
})
