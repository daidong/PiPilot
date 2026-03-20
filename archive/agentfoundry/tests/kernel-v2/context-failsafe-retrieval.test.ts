import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ContextAssemblerV2 } from '../../src/kernel-v2/context-assembler-v2.js'
import { resolveKernelV2Config } from '../../src/kernel-v2/defaults.js'
import { KernelV2Storage } from '../../src/kernel-v2/storage.js'
import type { KernelV2TelemetryEvent } from '../../src/kernel-v2/types.js'

describe('ContextAssemblerV2 fail-safe and retrieval fallback', () => {
  it('reduces protected turns in fail-safe mode and emits retrieval fallback telemetry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-failsafe-'))
    const storage = new KernelV2Storage(dir)
    await storage.init()

    const cfg = resolveKernelV2Config({
      enabled: true,
      profile: 'legacy',
      context: {
        protectedRecentTurns: 3
      },
      retrieval: {
        fallbackChain: ['vector-only', 'raw-file-scan'],
        rawScanLimitTokens: 60
      }
    }, 1200, 'gpt-5.4')

    const project = await storage.getOrCreateProject()
    await storage.bindSessionToProject('sess_failsafe', project.projectId)

    await storage.upsertTask({
      taskId: 'task_auth',
      projectId: project.projectId,
      status: 'in_progress',
      currentGoal: 'Fix auth refresh flow',
      nowDoing: 'Inspecting token expiry',
      blockedBy: [],
      nextAction: 'Patch refresh branch',
      lastSessionId: 'sess_failsafe',
      updatedAt: new Date().toISOString()
    })

    await storage.putMemoryFact({
      namespace: 'project',
      key: 'auth.refresh.strategy',
      value: { version: 2 },
      valueText: 'Refresh token strategy v2',
      tags: ['auth'],
      sensitivity: 'internal',
      status: 'active',
      confidence: 0.95,
      provenance: {
        sourceType: 'tool',
        sourceRef: 'test',
        traceId: 'trace_test',
        sessionId: 'sess_failsafe',
        createdBy: 'model'
      }
    })

    await storage.addArtifact({
      projectId: project.projectId,
      type: 'document',
      path: 'docs/auth.md',
      mimeType: 'text/markdown',
      summary: 'Auth refresh token expiration notes',
      sourceRef: 'docs/auth.md'
    })

    for (let i = 1; i <= 4; i++) {
      await storage.appendTurn('sess_failsafe', { role: 'user', content: `user turn ${i} auth refresh` })
      await storage.appendTurn('sess_failsafe', { role: 'assistant', content: `assistant turn ${i}` })
    }

    const events: KernelV2TelemetryEvent[] = []
    const assembler = new ContextAssemblerV2(storage, cfg, (event) => {
      events.push(event)
    })

    const result = await assembler.assemble('sess_failsafe', project.projectId, {
      systemPromptTokens: 900,
      toolSchemasTokens: 500,
      query: 'auth refresh token expiry'
    })

    expect(result.failSafeMode).toBe(true)
    expect(result.protectedTurnsRequested).toBe(3)
    expect(result.protectedTurnsKept).toBeGreaterThanOrEqual(1)
    expect(result.protectedTurnsKept).toBeLessThan(result.protectedTurnsRequested)
    expect(result.protectedTurnsDropped).toBe(result.protectedTurnsRequested - result.protectedTurnsKept)

    const retrievalEvent = events.find(event => event.event === 'retrieval.hybrid.stats')
    expect(retrievalEvent).toBeDefined()
    expect((retrievalEvent?.payload.mode as string) === 'raw-file-scan').toBe(true)
    expect(Number(retrievalEvent?.payload.fallbackDepth ?? 0)).toBeGreaterThanOrEqual(1)
  })
})
