import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { KernelV2Storage } from '../../src/kernel-v2/storage.js'

describe('KernelV2Storage concurrency safety', () => {
  it('serializes appendTurn across concurrent storage instances', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-storage-concurrency-'))
    const storageA = new KernelV2Storage(dir)
    const storageB = new KernelV2Storage(dir)

    await Promise.all([storageA.init(), storageB.init()])

    const sessionId = 'sess_concurrency'
    const writes: Array<Promise<unknown>> = []
    for (let i = 0; i < 40; i += 1) {
      const storage = i % 2 === 0 ? storageA : storageB
      writes.push(storage.appendTurn(sessionId, { role: 'user', content: `turn ${i}` }))
    }
    await Promise.all(writes)

    const turns = await storageA.getSessionTurns(sessionId)
    expect(turns.length).toBe(40)

    const indexes = turns.map(turn => turn.index).sort((a, b) => a - b)
    expect(indexes[0]).toBe(1)
    expect(indexes[indexes.length - 1]).toBe(40)
    expect(new Set(indexes).size).toBe(40)

    for (let i = 0; i < indexes.length; i += 1) {
      expect(indexes[i]).toBe(i + 1)
    }
  })
})

