import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { createKernelV2 } from '../../src/kernel-v2/kernel.js'
import { KernelV2Storage } from '../../src/kernel-v2/storage.js'

describe('KernelV2Migrator', () => {
  it('auto-migrates v1 sessions and memory on first startup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-migrate-'))

    const v1MessagesDir = path.join(dir, '.agent-foundry', 'sessions', 'sess_old')
    await fs.mkdir(v1MessagesDir, { recursive: true })
    await fs.writeFile(
      path.join(v1MessagesDir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'hello', timestamp: new Date().toISOString() }),
        JSON.stringify({ role: 'assistant', content: 'world', timestamp: new Date().toISOString() })
      ].join('\n') + '\n',
      'utf-8'
    )

    const memoryDir = path.join(dir, '.agent-foundry', 'memory')
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(
      path.join(memoryDir, 'items.json'),
      JSON.stringify({
        version: '1.0.0',
        items: {
          'project:auth.mode': {
            id: 'mem_old_1',
            namespace: 'project',
            key: 'auth.mode',
            value: { mode: 'jwt' },
            tags: ['config'],
            sensitivity: 'internal',
            status: 'active',
            provenance: {
              traceId: 'trace_old_1',
              createdBy: 'model'
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      }),
      'utf-8'
    )

    const kernel = createKernelV2({
      projectPath: dir,
      contextWindow: 200000,
      modelId: 'gpt-5.2',
      config: {
        enabled: true,
        telemetry: { mode: 'stderr' }
      }
    })

    await kernel.init()

    const storage = new KernelV2Storage(dir)
    await storage.init()

    const turns = await storage.getSessionTurns('sess_old')
    expect(turns.length).toBe(2)

    const mem = await storage.getLatestMemoryFact('project', 'auth.mode')
    expect(mem?.value).toEqual({ mode: 'jwt' })

    const markerPath = path.join(dir, '.agent-foundry-v2', 'migration', 'v1-migration.json')
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf-8')) as { skipped: boolean; migratedMessages: number; migratedMemoryItems: number }
    expect(marker.skipped).toBe(false)
    expect(marker.migratedMessages).toBe(2)
    expect(marker.migratedMemoryItems).toBe(1)
  })
})
