import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createKernelV2 } from '../../src/kernel-v2/kernel.js'

describe('KernelV2 replay path guard', () => {
  it('rejects replay path that resolves outside project root', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-path-guard-'))
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-path-guard-outside-'))
    const outsideFile = path.join(outsideDir, 'outside.txt')
    await fs.writeFile(outsideFile, 'outside', 'utf-8')

    const kernel = createKernelV2({
      projectPath: projectDir,
      contextWindow: 1200,
      modelId: 'gpt-5.4',
      config: {
        enabled: true
      }
    })

    await kernel.init()
    const replay = await kernel.replay({ type: 'path', value: outsideFile })
    expect(replay.found).toBe(false)
    expect(replay.source).toBe('filesystem')
    expect(replay.content).toBe('')
  })
})

