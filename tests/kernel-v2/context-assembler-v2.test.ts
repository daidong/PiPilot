import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { KernelV2Storage } from '../../src/kernel-v2/storage.js'
import { ContextAssemblerV2 } from '../../src/kernel-v2/context-assembler-v2.js'
import { resolveKernelV2Config } from '../../src/kernel-v2/defaults.js'

describe('ContextAssemblerV2', () => {
  it('keeps protected recent turns and appends task anchor', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-ctx-'))
    const storage = new KernelV2Storage(dir)
    await storage.init()

    const cfg = resolveKernelV2Config({
      enabled: true,
      context: { protectedRecentTurns: 3 }
    }, 200000, 'gpt-5.2')

    const assembler = new ContextAssemblerV2(storage, cfg)

    const project = await storage.getOrCreateProject()
    await storage.bindSessionToProject('sess_ctx', project.projectId)

    await storage.upsertTask({
      taskId: 'task_auth',
      projectId: project.projectId,
      status: 'in_progress',
      currentGoal: 'Fix auth refresh flow',
      nowDoing: 'Reading auth.ts',
      blockedBy: [],
      nextAction: 'Patch token expiry logic',
      lastSessionId: 'sess_ctx',
      updatedAt: new Date().toISOString()
    })

    for (let i = 1; i <= 4; i++) {
      await storage.appendTurn('sess_ctx', { role: 'user', content: `user-${i}` })
      await storage.appendTurn('sess_ctx', { role: 'assistant', content: `assistant-${i}` })
    }

    const result = await assembler.assemble('sess_ctx', project.projectId, {
      systemPromptTokens: 1000,
      toolSchemasTokens: 500
    })

    expect(result.protectedTurnsKept).toBe(3)
    expect(result.workingContextBlock).toContain('user-2')
    expect(result.workingContextBlock).toContain('user-3')
    expect(result.workingContextBlock).toContain('user-4')
    expect(result.workingContextBlock).toContain('## Task Anchor')
    expect(result.workingContextBlock).toContain('CurrentGoal: Fix auth refresh flow')
  })
})
