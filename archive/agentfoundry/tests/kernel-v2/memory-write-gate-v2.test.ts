import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { KernelV2Storage } from '../../src/kernel-v2/storage.js'
import { MemoryWriteGateV2 } from '../../src/kernel-v2/memory-write-gate-v2.js'

describe('MemoryWriteGateV2', () => {
  it('writes and supersedes by namespace/key', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-gate-'))
    const storage = new KernelV2Storage(dir)
    await storage.init()

    const gate = new MemoryWriteGateV2(storage, {
      maxWritesPerTurn: 20,
      maxWritesPerSession: 500,
      preFlushReserve: 5
    })

    gate.beginTurn()
    const first = await gate.writeCandidate({
      namespace: 'project',
      key: 'auth.strategy',
      value: { type: 'jwt' },
      sourceType: 'tool',
      sourceRef: 'tool:memory-put',
      createdBy: 'model',
      confidence: 0.9
    }, 'sess_1')

    const second = await gate.writeCandidate({
      namespace: 'project',
      key: 'auth.strategy',
      value: { type: 'session' },
      sourceType: 'tool',
      sourceRef: 'tool:memory-update',
      createdBy: 'model',
      confidence: 0.9
    }, 'sess_1')

    expect(first.action).toBe('PUT')
    expect(second.action).toBe('SUPERSEDE')

    const current = await gate.get('project', 'auth.strategy')
    expect(current?.value).toEqual({ type: 'session' })
  })

  it('enforces per-turn and per-session limits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kv2-gate-limits-'))
    const storage = new KernelV2Storage(dir)
    await storage.init()

    const gate = new MemoryWriteGateV2(storage, {
      maxWritesPerTurn: 1,
      maxWritesPerSession: 2,
      preFlushReserve: 1
    })

    gate.beginTurn()

    const first = await gate.writeCandidate({
      namespace: 'project',
      key: 'k1',
      value: 1,
      sourceType: 'tool',
      sourceRef: 'test',
      createdBy: 'model',
      confidence: 0.8
    }, 'sess_2')

    const second = await gate.writeCandidate({
      namespace: 'project',
      key: 'k2',
      value: 2,
      sourceType: 'tool',
      sourceRef: 'test',
      createdBy: 'model',
      confidence: 0.8
    }, 'sess_2')

    expect(first.action).toBe('PUT')
    expect(second.action).toBe('RATE_LIMITED')

    gate.beginTurn()

    const third = await gate.writeCandidate({
      namespace: 'project',
      key: 'k3',
      value: 3,
      sourceType: 'tool',
      sourceRef: 'test',
      createdBy: 'model',
      confidence: 0.8
    }, 'sess_2')

    const fourth = await gate.writeCandidate({
      namespace: 'project',
      key: 'k4',
      value: 4,
      sourceType: 'tool',
      sourceRef: 'test',
      createdBy: 'model',
      confidence: 0.8
    }, 'sess_2', 'preflush')

    expect(third.action).toBe('PUT')
    expect(fourth.action).toBe('RATE_LIMITED')
  })
})
