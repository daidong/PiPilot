/**
 * ComputeEvent is purely a discriminated union — most of its testing
 * happens via Registry. What we test here is the contract that callers
 * rely on: every event kind is JSON-serializable (amendment A5
 * extends to events, since they cross IPC the same way backendData does).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ComputeEvent } from '../events.js'

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

test('every ComputeEvent variant round-trips through JSON without loss', () => {
  const samples: ComputeEvent[] = [
    {
      kind: 'availability-changed',
      backend: 'modal',
      availability: {
        available: false,
        missingRequirements: ['Modal CLI not installed'],
        hints: ['pip install modal'],
      },
    },
    {
      kind: 'plan-ready',
      backend: 'modal',
      planId: 'mp-abc',
      requiresApproval: true,
      plan: {
        planId: 'mp-abc',
        backend: 'modal',
        createdAt: '2026-05-17T00:00:00.000Z',
        command: 'modal run script.py',
        taskProfile: {
          cpuDensity: 'low',
          gpuDensity: 'heavy',
          memoryPattern: 'growing',
          ioPattern: 'read_heavy',
          chunkable: true,
          resumable: true,
          idempotent: true,
          hasExternalSideEffects: false,
          networkRequired: true,
          expectedDurationClass: 'hours',
          reasoning: 'test',
        },
        costEstimate: {
          estimatedTotalUsd: 1.23,
          hourlyRateUsd: 4.56,
          expectedDurationMinutes: 16,
          notes: 'GPU only',
          coverage: 'lower_bound',
        },
        backendData: { gpuType: 'A100' },
        backendDataVersion: 1,
      },
    },
    {
      kind: 'plan-approved',
      backend: 'modal',
      planId: 'mp-abc',
      approvedAt: '2026-05-17T00:01:00.000Z',
    },
    {
      kind: 'plan-rejected',
      backend: 'modal',
      planId: 'mp-abc',
      rejectedAt: '2026-05-17T00:01:00.000Z',
      comments: 'too expensive',
    },
    {
      kind: 'run-update',
      backend: 'local',
      runId: 'local-run-1',
      status: {
        status: 'running',
        elapsedSeconds: 12,
        outputBytes: 1024,
        outputLines: 8,
        outputTail: 'progress: 50%\n',
        stalled: false,
        backendData: { sandbox: 'process' },
        backendDataVersion: 1,
      },
    },
    {
      kind: 'run-complete',
      backend: 'local',
      runId: 'local-run-1',
      status: {
        status: 'completed',
        exitCode: 0,
        elapsedSeconds: 14,
        outputBytes: 2048,
        outputLines: 16,
        outputTail: 'done\n',
        stalled: false,
        backendData: { sandbox: 'process' },
        backendDataVersion: 1,
      },
    },
    {
      kind: 'cost-killed',
      backend: 'modal',
      runId: 'mr-xyz',
      estimatedCostUsd: 5.1,
      thresholdUsd: 5.0,
    },
  ]

  for (const event of samples) {
    const cloned = roundTrip(event)
    assert.deepEqual(cloned, event, `round trip lost data for kind=${event.kind}`)
  }
})
