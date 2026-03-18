import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { KernelV2Storage } from '../../src/kernel-v2/storage.js'
import { MemoryWriteGateV2 } from '../../src/kernel-v2/memory-write-gate-v2.js'
import { CompactionEngineV2 } from '../../src/kernel-v2/compaction-engine-v2.js'
import { resolveKernelV2Config } from '../../src/kernel-v2/defaults.js'

describe('CompactionEngineV2', () => {
  it('compacts old turns and enforces replay refs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-comp-'))
    const storage = new KernelV2Storage(dir)
    await storage.init()

    for (let i = 1; i <= 5; i++) {
      await storage.appendTurn('sess_comp', { role: 'user', content: `Investigate issue ${i}` })
      await storage.appendTurn('sess_comp', { role: 'assistant', content: `Result ${i}` })
    }

    const cfg = resolveKernelV2Config({ enabled: true }, 2000, 'gpt-5.4')
    const gate = new MemoryWriteGateV2(storage, {
      maxWritesPerTurn: 20,
      maxWritesPerSession: 500,
      preFlushReserve: 5
    })

    const compaction = new CompactionEngineV2(storage, gate, cfg)

    const result = await compaction.maybeCompact({
      sessionId: 'sess_comp',
      promptTokens: 1900,
      protectedRecentTurns: 3,
      preFlushCandidates: []
    })

    expect(result.compacted).toBe(true)
    expect(result.segment).toBeDefined()
    expect(result.segment?.replayRefs.length).toBeGreaterThan(0)

    const segments = await storage.listCompactSegments('sess_comp')
    expect(segments.length).toBeGreaterThan(0)
  })
})
