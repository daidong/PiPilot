import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { createKernelV2 } from '../../src/kernel-v2/kernel.js'

describe('KernelV2 recovery and telemetry', () => {
  it('auto-recovers corrupted jsonl and writes telemetry file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-recover-'))
    const factsDir = path.join(dir, '.agent-foundry-v2', 'memory')
    await fs.mkdir(factsDir, { recursive: true })

    const good = JSON.stringify({ id: 'mem1', namespace: 'project', key: 'k', value: 1 })
    const bad = '{bad-json-line'
    await fs.writeFile(path.join(factsDir, 'facts.jsonl'), `${good}\n${bad}\n`, 'utf-8')

    const kernel = createKernelV2({
      projectPath: dir,
      contextWindow: 200000,
      modelId: 'gpt-5.2',
      config: {
        enabled: true,
        telemetry: { mode: 'stderr+file' }
      }
    })

    await kernel.init()

    const repaired = await fs.readFile(path.join(factsDir, 'facts.jsonl'), 'utf-8')
    expect(repaired.includes(bad)).toBe(false)
    expect(repaired.includes(good)).toBe(true)

    const snapshotsDir = path.join(dir, '.agent-foundry-v2', 'recovery', 'snapshots')
    const snapshots = await fs.readdir(snapshotsDir)
    expect(snapshots.length).toBeGreaterThan(0)

    const telemetryPath = path.join(dir, '.agent-foundry-v2', 'logs', 'kernel-v2.log')
    const telemetryRaw = await fs.readFile(telemetryPath, 'utf-8')
    expect(telemetryRaw).toContain('storage.recovery.applied')
  })
})
