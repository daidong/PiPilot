/**
 * Schema Utilities Tests
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  boundedArray,
  analyzeSchema,
  assertSchemaCompatible,
  warnSchemaIssues,
  nullable,
  withDefault,
  stringEnum
} from '../../src/llm/schema-utils.js'

describe('boundedArray', () => {
  it('should create an array with max length', () => {
    const schema = boundedArray(z.string(), 5)
    expect(schema.safeParse(['a', 'b', 'c']).success).toBe(true)
    expect(schema.safeParse(['a', 'b', 'c', 'd', 'e']).success).toBe(true)
    expect(schema.safeParse(['a', 'b', 'c', 'd', 'e', 'f']).success).toBe(false)
  })

  it('should create an array with min and max length', () => {
    const schema = boundedArray(z.number(), 5, 2)
    expect(schema.safeParse([1]).success).toBe(false)
    expect(schema.safeParse([1, 2]).success).toBe(true)
    expect(schema.safeParse([1, 2, 3, 4, 5]).success).toBe(true)
    expect(schema.safeParse([1, 2, 3, 4, 5, 6]).success).toBe(false)
  })

  it('should work with complex schemas', () => {
    const itemSchema = z.object({ id: z.number(), name: z.string() })
    const schema = boundedArray(itemSchema, 3)

    expect(schema.safeParse([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' }
    ]).success).toBe(true)

    expect(schema.safeParse([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
      { id: 4, name: 'd' }
    ]).success).toBe(false)
  })
})

describe('analyzeSchema', () => {
  it('should pass for compatible schemas', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      email: z.string().nullable(),
      tags: z.array(z.string())
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('should detect optional fields', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional()
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].type).toBe('optional')
    expect(result.issues[0].path).toBe('nickname')
  })

  it('should detect multiple optional fields', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().optional(),
      c: z.boolean()
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(false)
    expect(result.issues).toHaveLength(2)
  })

  it('should detect nested optional fields', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        bio: z.string().optional()
      })
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(false)
    expect(result.issues[0].path).toBe('user.bio')
  })

  it('should allow nullable fields', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().nullable()
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(true)
  })

  it('should allow default fields', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number().default(0)
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(true)
  })

  it('should detect transforms', () => {
    const schema = z.object({
      name: z.string().transform(s => s.toUpperCase())
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(false)
    expect(result.issues[0].type).toBe('effect')
  })

  it('should analyze arrays', () => {
    const schema = z.object({
      items: z.array(z.object({
        id: z.number(),
        value: z.string().optional()
      }))
    })

    const result = analyzeSchema(schema)
    expect(result.compatible).toBe(false)
    expect(result.issues[0].path).toBe('items[].value')
  })
})

describe('assertSchemaCompatible', () => {
  it('should not throw for compatible schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number()
    })

    expect(() => assertSchemaCompatible(schema, 'TestSchema')).not.toThrow()
  })

  it('should throw for incompatible schema', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional()
    })

    expect(() => assertSchemaCompatible(schema, 'TestSchema')).toThrow(
      /TestSchema has compatibility issues/
    )
  })
})

describe('warnSchemaIssues', () => {
  it('should return analysis result', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional()
    })

    const result = warnSchemaIssues(schema, 'TestSchema')
    expect(result.compatible).toBe(false)
    expect(result.issues).toHaveLength(1)
  })
})

describe('nullable helper', () => {
  it('should create nullable schema', () => {
    const schema = nullable(z.string())

    expect(schema.safeParse('hello').success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse(undefined).success).toBe(false)
  })
})

describe('withDefault helper', () => {
  it('should create schema with default value', () => {
    const schema = withDefault(z.number(), 10)

    expect(schema.parse(5)).toBe(5)
    expect(schema.parse(undefined)).toBe(10)
  })

  it('should work with complex defaults', () => {
    const schema = withDefault(z.array(z.string()), [])

    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(schema.parse(undefined)).toEqual([])
  })
})

describe('stringEnum helper', () => {
  it('should create string enum', () => {
    const schema = stringEnum(['pending', 'approved', 'rejected'] as const)

    expect(schema.safeParse('pending').success).toBe(true)
    expect(schema.safeParse('approved').success).toBe(true)
    expect(schema.safeParse('invalid').success).toBe(false)
  })
})

describe('real-world schema examples', () => {
  it('should validate a well-designed research schema', () => {
    const PaperSchema = z.object({
      title: z.string(),
      authors: z.array(z.string()),
      year: nullable(z.number()),
      abstract: nullable(z.string()),
      citations: withDefault(z.number(), 0)
    })

    const ReviewSchema = z.object({
      approved: z.boolean(),
      score: z.number().min(0).max(10),
      feedback: nullable(z.string()),
      additionalQueries: withDefault(z.array(z.string()), [])
    })

    expect(analyzeSchema(PaperSchema).compatible).toBe(true)
    expect(analyzeSchema(ReviewSchema).compatible).toBe(true)
  })

  it('should flag a poorly designed schema', () => {
    const BadSchema = z.object({
      title: z.string(),
      subtitle: z.string().optional(),  // Should use nullable
      metadata: z.object({
        createdAt: z.string().optional(),  // Should use nullable or default
        tags: z.array(z.string()).optional()  // Should use default([])
      })
    })

    const result = analyzeSchema(BadSchema)
    expect(result.compatible).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
  })
})
