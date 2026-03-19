import { describe, it, expect } from 'vitest'
import { ok, err, tryCatch, type Result } from '../../src/utils/result.js'

describe('Result utilities', () => {
  describe('ok()', () => {
    it('creates an Ok result', () => {
      const r = ok(42)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe(42)
    })

    it('works with undefined', () => {
      const r = ok(undefined)
      expect(r.ok).toBe(true)
    })

    it('works with objects', () => {
      const r = ok({ x: 1 })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.x).toBe(1)
    })
  })

  describe('err()', () => {
    it('creates an Err result with Error', () => {
      const e = new Error('fail')
      const r = err(e)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(e)
    })

    it('works with string errors', () => {
      const r: Result<never, string> = err('something went wrong')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('something went wrong')
    })
  })

  describe('tryCatch()', () => {
    it('returns ok when the async function succeeds', async () => {
      const r = await tryCatch(async () => 'hello')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe('hello')
    })

    it('returns err when the async function throws an Error', async () => {
      const r = await tryCatch(async () => { throw new Error('boom') })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toBe('boom')
    })

    it('wraps non-Error throws into an Error', async () => {
      const r = await tryCatch(async () => { throw 'raw string error' })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(Error)
        expect(r.error.message).toBe('raw string error')
      }
    })

    it('wraps object throws into an Error', async () => {
      const r = await tryCatch(async () => { throw { code: 404 } })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBeInstanceOf(Error)
    })

    it('the returned promise itself never rejects', async () => {
      await expect(
        tryCatch(async () => { throw new Error('x') })
      ).resolves.toBeDefined()
    })

    it('preserves the resolved value type', async () => {
      const r = await tryCatch(async () => ({ id: 1, name: 'Alice' }))
      if (r.ok) {
        expect(r.value.id).toBe(1)
        expect(r.value.name).toBe('Alice')
      }
    })
  })

  describe('type narrowing', () => {
    it('narrows to value after ok check', () => {
      const r: Result<number> = ok(7)
      if (r.ok) {
        // TypeScript would error if r.value didn't exist here
        expect(typeof r.value).toBe('number')
      }
    })

    it('narrows to error after !ok check', () => {
      const r: Result<number> = err(new Error('test'))
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(Error)
      }
    })
  })
})
