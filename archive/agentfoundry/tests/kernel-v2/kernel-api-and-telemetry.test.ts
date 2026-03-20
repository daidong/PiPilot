import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createKernelV2 } from '../../src/kernel-v2/kernel.js'

describe('KernelV2 API and telemetry coverage', () => {
  it('supports RFC-011 core APIs and emits baseline events', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-api-'))
    const kernel = createKernelV2({
      projectPath: dir,
      contextWindow: 1200,
      modelId: 'gpt-5.4',
      config: {
        enabled: true,
        profile: 'legacy',
        telemetry: { mode: 'stderr+file' }
      }
    })

    await kernel.init()

    const turn = await kernel.runTurn({
      sessionId: 'sess_api',
      userPrompt: 'Continue implementing auth refresh flow in src/auth.ts',
      systemPromptTokens: 900,
      toolSchemasTokens: 500
    }, {
      messages: [
        {
          role: 'assistant',
          content: 'Investigated src/auth.ts and found blocker: missing refresh-token secret'
        }
      ],
      promptTokens: 1100
    })

    expect(turn.projectId).toBeTruthy()
    expect(turn.task.taskId).toBeTruthy()

    const activeTasks = await kernel.listActiveTasks(turn.projectId)
    expect(activeTasks.length).toBeGreaterThan(0)

    const task = await kernel.getTaskState(turn.projectId, activeTasks[0]!.taskId)
    expect(task).not.toBeNull()

    const continuity = await kernel.getSessionContinuity(turn.projectId, 'sess_api')
    expect(continuity).not.toBeNull()

    const resolvedProject = await kernel.resolveProject({ sessionId: 'sess_api' })
    expect(resolvedProject.projectId).toBe(turn.projectId)

    await fs.writeFile(path.join(dir, 'notes.txt'), 'line1\nline2\nline3', 'utf-8')
    const replay = await kernel.replay({ type: 'path', value: 'notes.txt' })
    expect(replay.found).toBe(true)
    expect(replay.source).toBe('filesystem')

    const integrity = await kernel.verifyIntegrity()
    expect(typeof integrity.checkedAt).toBe('string')
    expect(Array.isArray(integrity.issues)).toBe(true)

    const telemetryPath = path.join(dir, '.agentfoundry', 'logs', 'kernel-v2.log')
    const telemetryRaw = await fs.readFile(telemetryPath, 'utf-8')
    expect(telemetryRaw).toContain('task.anchor.injected')
    expect(telemetryRaw).toContain('context.protected_zone.kept')
    expect(telemetryRaw).toContain('context.failsafe.entered')
  })

  it('minimal profile skips legacy task/memory telemetry scaffolding', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-api-min-'))
    const kernel = createKernelV2({
      projectPath: dir,
      contextWindow: 1200,
      modelId: 'gpt-5.4',
      config: {
        enabled: true,
        profile: 'minimal',
        telemetry: { mode: 'stderr+file' }
      }
    })

    await kernel.init()

    const turn = await kernel.runTurn({
      sessionId: 'sess_api_min',
      userPrompt: 'Summarize progress for this coding task',
      systemPromptTokens: 900,
      toolSchemasTokens: 500
    }, {
      messages: [
        {
          role: 'assistant',
          content: 'Implemented minimal profile and verified tests.'
        }
      ],
      promptTokens: 1000
    })

    expect(turn.projectId).toBeTruthy()
    expect(turn.task.taskId).toContain('minimal_')

    const activeTasks = await kernel.listActiveTasks(turn.projectId)
    expect(activeTasks).toEqual([])

    const telemetryPath = path.join(dir, '.agentfoundry', 'logs', 'kernel-v2.log')
    const telemetryRaw = await fs.readFile(telemetryPath, 'utf-8')
    expect(telemetryRaw).not.toContain('task.anchor.injected')
    expect(telemetryRaw).not.toContain('retrieval mode=')
    expect(telemetryRaw).toContain('retrieval skipped profile=minimal')
  })
})
