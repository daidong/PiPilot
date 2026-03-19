/**
 * AsyncChannel unit tests
 */

import { describe, it, expect } from 'vitest'
import { createChannel } from '../../src/utils/async-channel.js'

describe('AsyncChannel', () => {
  it('delivers pushed values in order', async () => {
    const ch = createChannel<number>()
    ch.push(1)
    ch.push(2)
    ch.push(3)
    ch.done()

    const values: number[] = []
    for await (const v of ch) {
      values.push(v)
    }
    expect(values).toEqual([1, 2, 3])
  })

  it('works when consumer waits before producer pushes', async () => {
    const ch = createChannel<string>()

    // Push after a delay
    setTimeout(() => {
      ch.push('hello')
      ch.push('world')
      ch.done()
    }, 10)

    const values: string[] = []
    for await (const v of ch) {
      values.push(v)
    }
    expect(values).toEqual(['hello', 'world'])
  })

  it('returns empty iterable when done() is called immediately', async () => {
    const ch = createChannel<number>()
    ch.done()

    const values: number[] = []
    for await (const v of ch) {
      values.push(v)
    }
    expect(values).toEqual([])
  })

  it('ignores pushes after done()', async () => {
    const ch = createChannel<number>()
    ch.push(1)
    ch.done()
    ch.push(2) // should be ignored

    const values: number[] = []
    for await (const v of ch) {
      values.push(v)
    }
    expect(values).toEqual([1])
  })

  it('propagates errors to the consumer', async () => {
    const ch = createChannel<number>()

    setTimeout(() => {
      ch.push(1)
      ch.error(new Error('boom'))
    }, 10)

    const values: number[] = []
    let caught: string | undefined

    try {
      for await (const v of ch) {
        values.push(v)
      }
    } catch (e) {
      caught = (e as Error).message
    }

    expect(values).toEqual([1])
    expect(caught).toBe('boom')
  })

  it('interleaves push and pull correctly', async () => {
    const ch = createChannel<number>()
    const values: number[] = []

    // Simulate interleaved producer/consumer
    const consumer = (async () => {
      for await (const v of ch) {
        values.push(v)
      }
    })()

    // Push values with small delays
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 5))
      ch.push(i)
    }
    ch.done()

    await consumer
    expect(values).toEqual([0, 1, 2, 3, 4])
  })
})
