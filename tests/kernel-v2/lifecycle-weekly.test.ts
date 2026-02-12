import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { createKernelV2 } from '../../src/kernel-v2/kernel.js'
import { KernelV2Storage } from '../../src/kernel-v2/storage.js'

describe('KernelV2 weekly lifecycle', () => {
  it('runs weekly lifecycle and decays old memory facts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-life-'))

    const storage = new KernelV2Storage(dir)
    await storage.init()

    const oldDate = new Date(Date.now() - (100 * 24 * 60 * 60 * 1000)).toISOString()
    await storage.putMemoryFact({
      namespace: 'project',
      key: 'legacy.flag',
      value: true,
      valueText: 'old flag',
      tags: [],
      sensitivity: 'internal',
      status: 'active',
      confidence: 0.9,
      provenance: {
        sourceType: 'tool',
        sourceRef: 'seed',
        traceId: 'trace_seed',
        createdBy: 'system'
      }
    }, {
      id: 'mem_legacy_flag',
      createdAt: oldDate,
      updatedAt: oldDate
    })

    const metaPath = path.join(dir, '.agentfoundry', 'maintenance', 'lifecycle-meta.json')
    await fs.mkdir(path.dirname(metaPath), { recursive: true })
    await fs.writeFile(metaPath, JSON.stringify({ lastRunAt: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString() }), 'utf-8')

    const kernel = createKernelV2({
      projectPath: dir,
      contextWindow: 200000,
      modelId: 'gpt-5.2',
      config: {
        enabled: true,
        profile: 'legacy',
        lifecycle: {
          autoWeekly: true,
          decayThresholdDays: 90
        },
        telemetry: { mode: 'stderr' }
      }
    })

    await kernel.init()

    const latest = await storage.getLatestMemoryFact('project', 'legacy.flag')
    expect(latest?.status).toBe('deprecated')

    const archivePath = path.join(dir, '.agentfoundry', 'memory', 'archive.jsonl')
    const archiveRaw = await fs.readFile(archivePath, 'utf-8')
    expect(archiveRaw).toContain('legacy.flag')
  })
})
