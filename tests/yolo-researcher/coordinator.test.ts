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

  it('includes coding-large-repo guidance in coordinator prompt for coding-heavy turns', async () => {
    let capturedPrompt = ''
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (): AgentLike => ({
        ensureInit: async () => {},
        run: async (prompt: string) => {
          capturedPrompt = prompt
          return {
            success: true,
            output: JSON.stringify({
              summary: 'Turn completed',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 50,
            usage: {
              tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
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
              durationMs: 50
            }
          }
        }
      })
    })

    const turnSpec = buildTurnSpec()
    turnSpec.stage = 'S2'
    turnSpec.objective = 'Implement and verify a non-trivial refactor across repository modules'

    await coordinator.runTurn({
      turnSpec,
      stage: 'S2',
      goal: 'Implement and verify non-trivial repository refactor with local tests',
      mergedUserInputs: []
    })

    expect(capturedPrompt).toContain('coding-large-repo')
    expect(capturedPrompt).toContain('skill-script-run')
    expect(capturedPrompt).toContain('delegate-coding-agent')
    expect(capturedPrompt).toContain('--runtime auto')
  })

  it('includes cloudlab skill guidance in coordinator prompt for distributed CloudLab turns', async () => {
    let capturedPrompt = ''
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (): AgentLike => ({
        ensureInit: async () => {},
        run: async (prompt: string) => {
          capturedPrompt = prompt
          return {
            success: true,
            output: JSON.stringify({
              summary: 'Turn completed',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 50,
            usage: {
              tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
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
              durationMs: 50
            }
          }
        }
      })
    })

    const turnSpec = buildTurnSpec()
    turnSpec.stage = 'S2'
    turnSpec.objective = 'Run a CloudLab distributed benchmark and collect per-node artifacts'

    await coordinator.runTurn({
      turnSpec,
      stage: 'S2',
      goal: 'Run CloudLab Portal API multi-node benchmark workflow',
      mergedUserInputs: []
    })

    expect(capturedPrompt).toContain('cloudlab-distributed-experiments')
    expect(capturedPrompt).toContain('portal-intake')
    expect(capturedPrompt).toContain('distributed-ssh')
    expect(capturedPrompt).toContain('experiment-terminate')
  })

  it('injects intent route into coordinator prompt for dual-layer routing consistency', async () => {
    let capturedPrompt = ''
    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      createAgentInstance: (): AgentLike => ({
        ensureInit: async () => {},
        run: async (prompt: string) => {
          capturedPrompt = prompt
          return {
            success: true,
            output: JSON.stringify({
              summary: 'Turn completed',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 50,
            usage: {
              tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
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
              durationMs: 50
            }
          }
        }
      })
    })

    const turnSpec = buildTurnSpec()
    turnSpec.stage = 'S2'
    turnSpec.objective = 'summarize benchmark findings'

    await coordinator.runTurn({
      turnSpec,
      stage: 'S2',
      goal: 'summarize benchmark findings',
      mergedUserInputs: [],
      intentRoute: {
        label: 'coding_repository',
        isCoding: true,
        confidence: 0.93,
        source: 'router_model'
      }
    })

    expect(capturedPrompt).toContain('IntentRoute:')
    expect(capturedPrompt).toContain('"isCoding":true')
    expect(capturedPrompt).toContain('Intent router marks this turn as coding-heavy')
  })

  it('emits structured tool_result preview for policy-denied errors', async () => {
    const activityEvents: Array<{ kind?: string; tool?: string; preview?: string }> = []
    const structuredError = JSON.stringify({
      success: false,
      error: {
        category: 'policy_denied',
        source: 'policy:require-approval-destructive',
        data: {
          tool: 'bash',
          reason: 'Approval required but no handler configured'
        }
      },
      guidance: 'Try a different tool or approach.'
    })

    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      onActivity: (event) => activityEvents.push(event),
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolResult('bash', { success: false, error: structuredError }, { command: 'rm -rf /tmp' })
          return {
            success: true,
            output: JSON.stringify({
              summary: 'Tool failed as expected',
              assets: [{ type: 'Note', payload: { text: 'captured tool failure' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 20,
            usage: {
              tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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
              durationMs: 20
            }
          }
        }
      })
    })

    await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S1',
      goal: 'test goal',
      mergedUserInputs: []
    })

    const event = activityEvents.find((item) => item.kind === 'tool_result' && item.tool === 'bash')
    expect(event?.preview).toContain('policy_denied')
    expect(event?.preview).toContain('policy:require-approval-destructive')
    expect(event?.preview).toContain('Approval required')
  })

  it('falls back to stderr snippet in tool_result preview for generic command errors', async () => {
    const activityEvents: Array<{ kind?: string; tool?: string; preview?: string }> = []

    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      onActivity: (event) => activityEvents.push(event),
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolResult(
            'bash',
            {
              success: false,
              error: 'Command exited with code 2',
              data: {
                stdout: '',
                stderr: "python: can't open file 'missing.py': [Errno 2] No such file or directory",
                exitCode: 2
              }
            },
            { command: 'python missing.py' }
          )
          return {
            success: true,
            output: JSON.stringify({
              summary: 'Captured command failure',
              assets: [{ type: 'Note', payload: { text: 'stderr captured' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 20,
            usage: {
              tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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
              durationMs: 20
            }
          }
        }
      })
    })

    await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S1',
      goal: 'test goal',
      mergedUserInputs: []
    })

    const event = activityEvents.find((item) => item.kind === 'tool_result' && item.tool === 'bash')
    expect(event?.preview).toContain('Command exited with code 2:')
    expect(event?.preview).toContain("can't open file")
  })

  it('uses coding-large-repo structured result for tool_result preview', async () => {
    const activityEvents: Array<{ kind?: string; tool?: string; preview?: string }> = []

    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      onActivity: (event) => activityEvents.push(event),
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolResult(
            'skill-script-run',
            {
              success: true,
              data: {
                skillId: 'coding-large-repo',
                script: 'delegate-coding-agent',
                stdout: [
                  'provider: codex',
                  'exit_code: 0',
                  'AF_RESULT_JSON: {"schema":"coding-large-repo.result.v1","script":"delegate-coding-agent","provider":"codex","status":"completed","exit_code":0,"log_path":".yolo-researcher/logs/coding-large-repo/delegate.log"}'
                ].join('\n'),
                stderr: '',
                exitCode: 0,
                structuredResult: {
                  schema: 'coding-large-repo.result.v1',
                  script: 'delegate-coding-agent',
                  provider: 'codex',
                  status: 'completed',
                  exit_code: 0,
                  log_path: '.yolo-researcher/logs/coding-large-repo/delegate.log'
                }
              }
            },
            { skillId: 'coding-large-repo', script: 'delegate-coding-agent' }
          )

          return {
            success: true,
            output: JSON.stringify({
              summary: 'Structured result captured',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 20,
            usage: {
              tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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
              durationMs: 20
            }
          }
        }
      })
    })

    await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S2',
      goal: 'test structured skill result',
      mergedUserInputs: []
    })

    const event = activityEvents.find((item) => item.kind === 'tool_result' && item.tool === 'skill-script-run')
    expect(event?.preview).toContain('coding-large-repo/delegate-coding-agent')
    expect(event?.preview).toContain('status=completed')
    expect(event?.preview).toContain('provider=codex')
  })

  it('includes verify runtime fallback fields in coding-large-repo tool_result preview', async () => {
    const activityEvents: Array<{ kind?: string; tool?: string; preview?: string }> = []

    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      onActivity: (event) => activityEvents.push(event),
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolResult(
            'skill-script-run',
            {
              success: true,
              data: {
                skillId: 'coding-large-repo',
                script: 'verify-targets',
                stdout: [
                  'exit_code: 0',
                  'AF_RESULT_JSON: {"schema":"coding-large-repo.result.v1","script":"verify-targets","status":"completed","exit_code":0,"requested_runtime":"auto","effective_runtime":"host","fallback_used":true,"log_path":".yolo-researcher/logs/coding-large-repo/verify.log"}'
                ].join('\n'),
                stderr: '',
                exitCode: 0,
                structuredResult: {
                  schema: 'coding-large-repo.result.v1',
                  script: 'verify-targets',
                  status: 'completed',
                  exit_code: 0,
                  requested_runtime: 'auto',
                  effective_runtime: 'host',
                  fallback_used: true,
                  log_path: '.yolo-researcher/logs/coding-large-repo/verify.log'
                }
              }
            },
            { skillId: 'coding-large-repo', script: 'verify-targets' }
          )

          return {
            success: true,
            output: JSON.stringify({
              summary: 'Structured verify result captured',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 20,
            usage: {
              tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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
              durationMs: 20
            }
          }
        }
      })
    })

    await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S2',
      goal: 'test verify runtime fields',
      mergedUserInputs: []
    })

    const event = activityEvents.find((item) => item.kind === 'tool_result' && item.tool === 'skill-script-run')
    expect(event?.preview).toContain('coding-large-repo/verify-targets')
    expect(event?.preview).toContain('requested_runtime=auto')
    expect(event?.preview).toContain('effective_runtime=host')
    expect(event?.preview).toContain('fallbac')
  })

  it('uses coding-large-repo structured result from stderr marker on failed tool_result preview', async () => {
    const activityEvents: Array<{ kind?: string; tool?: string; preview?: string }> = []

    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      onActivity: (event) => activityEvents.push(event),
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolResult(
            'skill-script-run',
            {
              success: false,
              error: 'Script exited with code 143',
              data: {
                skillId: 'coding-large-repo',
                script: 'delegate-coding-agent',
                stdout: '',
                stderr: 'AF_RESULT_JSON: {"schema":"coding-large-repo.result.v1","script":"delegate-coding-agent","provider":"codex","status":"error","exit_code":143,"log_path":".yolo-researcher/logs/coding-large-repo/delegate.log"}',
                exitCode: 143
              }
            },
            { skillId: 'coding-large-repo', script: 'delegate-coding-agent' }
          )

          return {
            success: true,
            output: JSON.stringify({
              summary: 'Structured failure preview captured',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 20,
            usage: {
              tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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
              durationMs: 20
            }
          }
        }
      })
    })

    await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S2',
      goal: 'test structured stderr fallback',
      mergedUserInputs: []
    })

    const event = activityEvents.find((item) => item.kind === 'tool_result' && item.tool === 'skill-script-run')
    expect(event?.preview).toContain('coding-large-repo/delegate-coding-agent')
    expect(event?.preview).toContain('status=error')
    expect(event?.preview).toContain('exit=143')
  })

  it('uses cloudlab structured result for tool_result preview', async () => {
    const activityEvents: Array<{ kind?: string; tool?: string; preview?: string }> = []

    const coordinator = createYoloCoordinator({
      projectPath: process.cwd(),
      model: 'gpt-5-mini',
      onActivity: (event) => activityEvents.push(event),
      createAgentInstance: (callbacks): AgentLike => ({
        ensureInit: async () => {},
        run: async () => {
          callbacks.onToolResult(
            'skill-script-run',
            {
              success: true,
              data: {
                skillId: 'cloudlab-distributed-experiments',
                script: 'distributed-ssh',
                stdout: [
                  'success_hosts: 3',
                  'AF_RESULT_JSON: {"schema":"cloudlab-distributed-experiments.result.v1","script":"distributed-ssh","status":"partial","exit_code":0,"experiment_id":"exp-123","total_hosts":4,"failed_hosts":1,"out_dir":".yolo-researcher/logs/cloudlab-distributed-experiments/distributed-ssh-1","summary_path":".yolo-researcher/logs/cloudlab-distributed-experiments/distributed-ssh-1/summary.json"}'
                ].join('\n'),
                stderr: '',
                exitCode: 0,
                structuredResult: {
                  schema: 'cloudlab-distributed-experiments.result.v1',
                  script: 'distributed-ssh',
                  status: 'partial',
                  exit_code: 0,
                  experiment_id: 'exp-123',
                  total_hosts: 4,
                  failed_hosts: 1,
                  out_dir: '.yolo-researcher/logs/cloudlab-distributed-experiments/distributed-ssh-1',
                  summary_path: '.yolo-researcher/logs/cloudlab-distributed-experiments/distributed-ssh-1/summary.json'
                }
              }
            },
            { skillId: 'cloudlab-distributed-experiments', script: 'distributed-ssh' }
          )

          return {
            success: true,
            output: JSON.stringify({
              summary: 'Structured cloudlab result captured',
              assets: [{ type: 'Note', payload: { text: 'ok' } }]
            }),
            steps: 1,
            trace: [],
            durationMs: 20,
            usage: {
              tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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
              durationMs: 20
            }
          }
        }
      })
    })

    await coordinator.runTurn({
      turnSpec: buildTurnSpec(),
      stage: 'S2',
      goal: 'test cloudlab structured skill result',
      mergedUserInputs: []
    })

    const event = activityEvents.find((item) => item.kind === 'tool_result' && item.tool === 'skill-script-run')
    expect(event?.preview).toContain('cloudlab-distributed-experiments/distributed-ssh')
    expect(event?.preview).toContain('status=partial')
    expect(event?.preview).toContain('failed_hosts=1')
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
