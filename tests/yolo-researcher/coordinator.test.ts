import { describe, expect, it } from 'vitest'

import { createYoloCoordinator } from '../../examples/yolo-researcher/agents/coordinator.js'
import type { AgentLike } from '../../examples/yolo-researcher/agents/coordinator.js'
import type { TurnSpec } from '../../examples/yolo-researcher/runtime/types.js'

function buildTurnSpec(): TurnSpec {
  return {
    turnNumber: 1,
    stage: 'S1',
    branch: {
      activeBranchId: 'B-001',
      activeNodeId: 'N-001',
      action: 'advance'
    },
    objective: 'define hypothesis',
    expectedAssets: ['Hypothesis'],
    constraints: {
      maxToolCalls: 10,
      maxWallClockSec: 120,
      maxStepCount: 20,
      maxNewAssets: 5,
      maxDiscoveryOps: 10,
      maxReadBytes: 100000,
      maxPromptTokens: 2000,
      maxCompletionTokens: 1000,
      maxTurnTokens: 3000,
      maxTurnCostUsd: 1
    }
  }
}

describe('yolo coordinator', () => {
  it('parses coordinator JSON output and aggregates metrics', async () => {
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolCall('read', { path: 'README.md' })
          callbacks.onToolResult('read', { success: true, data: { bytes: 256 } }, { path: 'README.md' })
          callbacks.onToolCall('grep', { pattern: 'TODO' })

          return {
            success: true,
            output: JSON.stringify({
              summary: 'Turn completed',
              assets: [{ type: 'Hypothesis', payload: { text: 'h1' } }]
            }),
            steps: 4,
            trace: [],
            durationMs: 1500,
            usage: {
              tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
              cost: {
                promptCost: 0.001,
                completionCost: 0.002,
                cachedReadCost: 0,
                cacheCreationCost: 0,
                totalCost: 0.003,
                modelId: 'gpt-5-mini'
              },
              callCount: 1,
              cacheHitRate: 0,
              durationMs: 1500
            }
          }
        }
      })
    })

    const result = await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S1',
      goal: 'test goal',
      mergedUserInputs: []
    })

    expect(result.summary).toBe('Turn completed')
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]?.type).toBe('Hypothesis')
    expect(result.metrics.toolCalls).toBe(2)
    expect(result.metrics.discoveryOps).toBe(2)
    expect(result.metrics.readBytes).toBe(256)
    expect(result.metrics.stepCount).toBe(4)
    expect(result.metrics.turnTokens).toBe(150)
    expect(result.metrics.turnCostUsd).toBe(0.003)
    expect(result.executionTrace?.length).toBeGreaterThan(0)
    expect(result.askUser?.required).toBe(false)
  })

  it('prefers ask_user tool payload over json field', async () => {
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onAskUser({ question: 'Need user confirmation?', checkpoint: 'claim-freeze', blocking: true })
          return {
            success: true,
            output: JSON.stringify({
              summary: 'waiting',
              assets: [{ type: 'RiskRegister', payload: { reason: 'waiting' } }],
              askUser: { question: 'from json' }
            }),
            steps: 1,
            trace: [],
            durationMs: 100,
            usage: {
              tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              cost: {
                promptCost: 0,
                completionCost: 0,
                cachedReadCost: 0,
                cacheCreationCost: 0,
                totalCost: 0,
                modelId: 'gpt-5-mini'
              },
              callCount: 1,
              cacheHitRate: 0,
              durationMs: 100
            }
          }
        }
      })
    })

    const result = await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S1',
      goal: 'test goal',
      mergedUserInputs: []
    })

    expect(result.askUser?.question).toBe('Need user confirmation?')
    expect(result.askUser?.checkpoint).toBe('claim-freeze')
  })

  it('falls back to Note when output has no assets', async () => {
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (): AgentLike => ({
        ensureInit: async () => {},
        run: async () => ({
          success: true,
          output: 'not a valid json response',
          steps: 1,
          trace: [],
          durationMs: 10,
          usage: {
            tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            cost: {
              promptCost: 0,
              completionCost: 0,
              cachedReadCost: 0,
              cacheCreationCost: 0,
              totalCost: 0,
              modelId: 'gpt-5-mini'
            },
            callCount: 1,
            cacheHitRate: 0,
            durationMs: 10
          }
        })
      })
    })

    const result = await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S1',
      goal: 'test goal',
      mergedUserInputs: []
    })

    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]?.type).toBe('Note')
  })

  it('returns failure summary and fallback asset when agent run fails', async () => {
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (): AgentLike => ({
        ensureInit: async () => {},
        run: async () => ({
          success: false,
          output: 'model failed',
          error: 'upstream timeout',
          steps: 1,
          trace: [],
          durationMs: 10
        })
      })
    })

    const result = await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S1',
      goal: 'test goal',
      mergedUserInputs: []
    })

    expect(result.summary).toContain('Coordinator run failed')
    expect(result.assets[0]?.type).toBe('Note')
  })
})
