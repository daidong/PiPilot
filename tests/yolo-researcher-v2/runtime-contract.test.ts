import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { ProjectStore } from '../../examples/yolo-researcher/v2/project-store.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function bashSuccessEvent(command: string, stdout: string, cwd?: string) {
  return [
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'bash',
      input: {
        command,
        ...(cwd ? { cwd } : {})
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'bash',
      success: true,
      result: {
        success: true,
        data: {
          stdout,
          stderr: '',
          exitCode: 0
        }
      }
    }
  ]
}

function writeSuccessEvent(filePath: string, content: string = 'ok') {
  return [
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'write',
      input: {
        path: filePath,
        content
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'write',
      success: true,
      result: {
        success: true,
        data: {
          path: filePath
        }
      }
    }
  ]
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

async function seedActivePlanDoneDefinition(projectPath: string, doneDefinition: string[]): Promise<void> {
  const store = new ProjectStore(projectPath, 'Seed plan', ['Define measurable success criteria.'], 'host')
  await store.init()
  const panel = await store.load()
  const active = panel.planBoard.find((item) => item.id === 'P1') ?? panel.planBoard[0]
  if (!active) return

  await store.applyUpdate({
    planBoard: [{
      id: active.id,
      title: active.title,
      status: 'ACTIVE',
      doneDefinition,
      evidencePaths: [],
      priority: active.priority
    }]
  })
}

describe('yolo-researcher v2 runtime contract', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('creates minimal layout and captures native tool-event outputs', async () => {
    const projectPath = await createTempDir('yolo-v2-layout-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt', 'evidence_min: 1'])

    const session = createYoloSession({
      projectPath,
      goal: 'Run one evidence-producing command',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run one command and save raw output',
          status: 'success',
          summary: 'Fetched baseline output token v2-ok',
          primaryAction: `bash: node -e "console.log('v2-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured baseline verification output.',
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: bashSuccessEvent(`node -e "console.log('v2-ok')"`, 'v2-ok\n'),
          projectUpdate: {
            facts: [
              {
                text: 'Node command produced expected token v2-ok',
                evidencePath: 'runs/turn-0001/stdout.txt'
              }
            ],
            currentPlan: ['Run next minimal verification command', 'Stop after milestone confirmation', 'Summarize evidence']
          }
        }
      ])
    })

    await session.init()
    const first = await session.runNextTurn()

    expect(first.turnNumber).toBe(1)
    expect(first.status).toBe('success')
    expect(first.primaryAction).toContain('node -e')
    expect(first.toolEventsCount).toBe(2)

    const base = projectPath
    const turnDir = path.join(base, 'runs', 'turn-0001')

    await expect(fs.access(path.join(base, 'PROJECT.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(base, 'FAILURES.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'action.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'result.json'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'cmd.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'stdout.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'stderr.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'exit_code.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'artifacts', 'tool-events.jsonl'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'artifacts', 'changed_files.json'))).resolves.toBeUndefined()

    const stdout = await readText(path.join(turnDir, 'stdout.txt'))
    const exitCode = await readText(path.join(turnDir, 'exit_code.txt'))
    const result = JSON.parse(await readText(path.join(turnDir, 'result.json'))) as Record<string, unknown>
    const projectMd = await readText(path.join(base, 'PROJECT.md'))

    expect(stdout).toContain('v2-ok')
    expect(exitCode.trim()).toBe('0')
    expect(result.exit_code).toBe(0)
    expect(result.runtime).toBe('host')
    expect(result.cmd).toBe(`node -e "console.log('v2-ok')"`)
    expect(typeof result.cwd).toBe('string')
    expect(typeof result.timestamp).toBe('string')
    expect(typeof result.duration_sec).toBe('number')
    expect(result.tool_events_count).toBe(2)
    expect(Array.isArray(result.evidence_paths)).toBe(true)
    expect(typeof result.evidence_refs).toBe('object')
    expect(projectMd).toContain('runs/turn-0001/stdout.txt')
    expect(projectMd).toContain('## Done (Do-not-repeat)')
    expect(projectMd).toContain('bash:node -e console.log(v2-ok)')
  })

  it('degrades runTurn runtime errors into failure turns instead of throwing', async () => {
    const projectPath = await createTempDir('yolo-v2-runtime-error-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Handle agent crash safely',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => {
          throw new Error('simulated crash')
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('failure')
    expect(turn.summary).toContain('Native turn runtime error')

    const actionMd = await readText(path.join(projectPath, 'runs', 'turn-0001', 'action.md'))
    expect(actionMd).toContain('Native turn runtime error')
  })

  it('creates ask-user artifact when native turn returns ask_user', async () => {
    const projectPath = await createTempDir('yolo-v2-ask-user-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Request a required user decision',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Need user policy choice before applying risky change',
          status: 'ask_user',
          summary: 'Need explicit risk tolerance input.',
          askQuestion: 'Choose one: conservative patch or aggressive refactor.'
        })
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('ask_user')

    const askArtifact = await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'artifacts',
      'ask-user.md'
    ))
    expect(askArtifact).toContain('# Blocking Question')
    expect(askArtifact).toContain('conservative patch or aggressive refactor')
  })

  it('auto-attaches turn evidence bundle to projectUpdate rows missing explicit evidence', async () => {
    const projectPath = await createTempDir('yolo-v2-evidence-bundle-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt'])

    const session = createYoloSession({
      projectPath,
      goal: 'Attach runtime evidence to structured updates',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Emit structured updates without explicit evidence paths',
          status: 'success',
          summary: 'Completed one bounded execution.',
          primaryAction: `bash: node -e "console.log('bundle-ok')"`,
          toolEvents: bashSuccessEvent(`node -e "console.log('bundle-ok')"`, 'bundle-ok\n'),
          projectUpdate: {
            facts: [{ text: 'Observed stable runtime output token.' } as unknown as { text: string; evidencePath: string }],
            constraints: ['CPU budget remains limited.'] as unknown as { text: string; evidencePath: string }[],
            claims: [{ claim: 'Runtime-derived control metadata is deterministic.', status: 'partial' } as unknown as { claim: string; evidencePaths: string[]; status: 'uncovered' | 'partial' | 'covered' }]
          }
        })
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('Observed stable runtime output token. (evidence: runs/turn-0001/result.json)')
    expect(projectMd).toContain('CPU budget remains limited. (evidence: runs/turn-0001/result.json)')
    expect(projectMd).toContain('Runtime-derived control metadata is deterministic.')
  })

  it('marks successful turns without delta evidence as no_delta', async () => {
    const projectPath = await createTempDir('yolo-v2-no-delta-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Verify no-delta mechanical status',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Synthesize without producing verifiable artifacts',
          status: 'success',
          summary: 'No new artifacts created.'
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('NO_DELTA')

    const result = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'result.json'
    ))) as Record<string, unknown>
    expect(result.status).toBe('no_delta')
    expect(Array.isArray(result.delta_reasons)).toBe(true)
  })

  it('accepts workspace-root runs artifact writes', async () => {
    const projectPath = await createTempDir('yolo-v2-path-policy-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Enforce coherent artifact paths',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write artifact to legacy path',
          status: 'success',
          summary: 'Wrote problem statement.',
          primaryAction: 'write: runs/turn-0001/artifacts/problem_statement.md',
          toolEvents: writeSuccessEvent('runs/turn-0001/artifacts/problem_statement.md', '# Problem statement')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')

    const result = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'result.json'
    ))) as Record<string, unknown>
    expect(result.status).toBe('no_delta')
  })

  it('skips projectUpdate evidence paths that do not exist under workspace runs', async () => {
    const projectPath = await createTempDir('yolo-v2-evidence-check-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Reject unverifiable project updates',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Attempt to record unsupported fact',
          status: 'success',
          summary: 'Recorded one fact.',
          primaryAction: 'synthesize: record fact',
          projectUpdate: {
            facts: [
              {
                text: 'Claim with missing evidence',
                evidencePath: 'runs/turn-0001/artifacts/missing-proof.md'
              }
            ],
            currentPlan: ['Step 1', 'Step 2', 'Step 3']
          }
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).not.toContain('PROJECT.md update rejected')
  })

  it('repairs work evidence paths in the same turn by snapshotting into runs artifacts', async () => {
    const projectPath = await createTempDir('yolo-v2-evidence-repair-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt', 'evidence_min: 1'])

    const workDir = path.join(projectPath, 'work', 'openevolve-logger')
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(
      path.join(workDir, 'p6_logger_instrumentation_map.md'),
      '# Logger instrumentation map\n',
      'utf-8'
    )

    const session = createYoloSession({
      projectPath,
      goal: 'Repair evidence path in same turn',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Capture logger evidence and update project',
          status: 'success',
          summary: 'Captured logger evidence and baseline runtime output.',
          primaryAction: 'bash: echo repair-check',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured baseline output and logger evidence snapshot.',
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: bashSuccessEvent('echo repair-check', 'repair-check\n'),
          projectUpdate: {
            facts: [
              {
                text: 'Logger instrumentation map captured',
                evidencePath: 'work/openevolve-logger/p6_logger_instrumentation_map.md'
              }
            ],
            currentPlan: ['Continue instrumentation', 'Run verification', 'Summarize findings']
          }
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')
    expect(turn.summary).not.toContain('PROJECT.md update rejected')

    const snapshotPath = path.join(
      projectPath,
      'runs',
      'turn-0001',
      'artifacts',
      'evidence',
      'p6-logger-instrumentation-map.md'
    )
    await expect(fs.access(snapshotPath)).resolves.toBeUndefined()

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('runs/turn-0001/artifacts/evidence/p6-logger-instrumentation-map.md')
  })

  it('blocks repeated no-delta fingerprints as redundant', async () => {
    const projectPath = await createTempDir('yolo-v2-redundant-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Verify redundancy breaker',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Repeatable synthesis pass',
          status: 'success',
          summary: 'First synthesis pass without artifacts.',
          primaryAction: 'synthesize: meta-controller roadmap'
        },
        {
          intent: 'Repeat same synthesis pass',
          status: 'success',
          summary: 'Second synthesis pass without artifacts.',
          primaryAction: 'synthesize: meta-controller roadmap'
        }
      ])
    })

    await session.init()
    const first = await session.runNextTurn()
    const second = await session.runNextTurn()

    expect(first.status).toBe('no_delta')
    expect(second.status).toBe('blocked')
    expect(second.summary).toContain('Redundant action blocked')

    const failuresMd = await readText(path.join(projectPath, 'FAILURES.md'))
    expect(failuresMd).toContain('[BLOCKED][redundant]')
    expect(failuresMd).toContain('agent:synthesize: meta-controller roadmap')
  })

  it('captures literature-search script artifact paths into project key artifacts', async () => {
    const projectPath = await createTempDir('yolo-v2-literature-script-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: literature-cache.json'])

    const session = createYoloSession({
      projectPath,
      goal: 'Bootstrap prior-art evidence using literature-search full mode',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run full literature sweep',
          status: 'success',
          summary: 'Completed full literature sweep and persisted artifacts.',
          primaryAction: 'skill-script-run: literature-search/search-sweep',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Persisted sweep artifacts to local literature cache.',
          evidencePaths: ['runs/turn-0001/artifacts/literature-cache.json'],
          toolEvents: [
            {
              timestamp: new Date().toISOString(),
              phase: 'call',
              tool: 'skill-script-run',
              input: { skillId: 'literature-search', script: 'search-sweep', args: ['--query', 'OpenEvolve agentic optimization'] }
            },
            {
              timestamp: new Date().toISOString(),
              phase: 'result',
              tool: 'skill-script-run',
              success: true,
              input: { skillId: 'literature-search', script: 'search-sweep' },
              result: {
                success: true,
                data: {
                  structuredResult: {
                    paperCount: 36,
                    jsonPath: 'runs/turn-0001/artifacts/literature/sweep-20260217-openevolve.json',
                    markdownPath: 'runs/turn-0001/artifacts/literature/sweep-20260217-openevolve.md'
                  }
                }
              }
            }
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature/sweep-20260217-openevolve.json')
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature/sweep-20260217-openevolve.md')

    const cacheManifest = await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'artifacts',
      'literature-cache.json'
    ))
    expect(cacheManifest).toContain('scriptArtifacts')
  })

  it('captures literature-search wrapper artifact paths into project key artifacts', async () => {
    const projectPath = await createTempDir('yolo-v2-literature-wrapper-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: literature-cache.json'])

    const session = createYoloSession({
      projectPath,
      goal: 'Bootstrap prior-art evidence using literature-search wrapper',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run full literature sweep with wrapper',
          status: 'success',
          summary: 'Wrapper completed full literature sweep.',
          primaryAction: 'literature-search: sweep',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Persisted wrapper sweep outputs in local literature library.',
          evidencePaths: ['runs/turn-0001/artifacts/literature-cache.json'],
          toolEvents: [
            {
              timestamp: new Date().toISOString(),
              phase: 'call',
              tool: 'literature-search',
              input: { query: 'OpenEvolve agentic optimization', mode: 'sweep' }
            },
            {
              timestamp: new Date().toISOString(),
              phase: 'result',
              tool: 'literature-search',
              success: true,
              input: { query: 'OpenEvolve agentic optimization', mode: 'sweep' },
              result: {
                success: true,
                data: {
                  mode: 'sweep',
                  script: 'search-sweep',
                  paperCount: 24,
                  jsonPath: 'runs/turn-0001/artifacts/literature/sweep-20260217-wrapper.json',
                  markdownPath: 'runs/turn-0001/artifacts/literature/sweep-20260217-wrapper.md'
                }
              }
            }
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature/sweep-20260217-wrapper.json')
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature/sweep-20260217-wrapper.md')
  })

  it('writes plan delta fields and updates plan board status', async () => {
    const projectPath = await createTempDir('yolo-v2-plan-delta-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt', 'evidence_min: 1'])

    const session = createYoloSession({
      projectPath,
      goal: 'Validate v2.1 plan board progress binding',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Advance active plan item with verifiable output',
          status: 'success',
          summary: 'Completed baseline verification.',
          primaryAction: `bash: node -e "console.log('plan-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> DONE',
          delta: 'Baseline verification complete; move to next plan item.',
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: bashSuccessEvent(`node -e "console.log('plan-ok')"`, 'plan-ok\n'),
          projectUpdate: {
            planBoard: [{
              id: 'P1',
              title: 'Bootstrap pending: replace with 3-5 goal-specific next actions in the next turn.',
              status: 'ACTIVE',
              doneDefinition: ['runs/turn-0001/stdout.txt'],
              evidencePaths: ['runs/turn-0001/stdout.txt'],
              priority: 1
            }]
          }
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')
    expect(turn.activePlanId).toBe('P1')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.active_plan_id).toBe('P1')
    expect(result.status_change).toBe('P1 ACTIVE -> DONE')
    expect(Array.isArray(result.plan_evidence_paths)).toBe(true)

    const actionMd = await readText(path.join(projectPath, 'runs', 'turn-0001', 'action.md'))
    expect(actionMd).toContain('## Plan Delta')
    expect(actionMd).toContain('active_plan_id: P1')
    expect(actionMd).toContain('status_change: P1 ACTIVE -> DONE')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('## Plan Board (stable IDs)')
    expect(projectMd).toContain('P1 [DONE]')
  })

  it('does not allow failed turns to mark active plan items as DONE', async () => {
    const projectPath = await createTempDir('yolo-v2-plan-no-cheat-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Do not close plan item on failure',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Attempt completion but command fails',
          status: 'failure',
          summary: 'Build failed due to missing dependency.',
          primaryAction: 'bash: npm run build',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> DONE',
          delta: 'Tried to complete implementation.',
          evidencePaths: ['runs/turn-0001/stderr.txt'],
          toolEvents: [
            {
              timestamp: new Date().toISOString(),
              phase: 'call',
              tool: 'bash',
              input: { command: 'npm run build' }
            },
            {
              timestamp: new Date().toISOString(),
              phase: 'result',
              tool: 'bash',
              success: false,
              result: {
                success: false,
                data: {
                  stdout: '',
                  stderr: 'ModuleNotFoundError: missing_dep\n',
                  exitCode: 1
                }
              }
            }
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('failure')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('P1 [ACTIVE]')
    expect(projectMd).not.toContain('P1 [DONE]')
  })

  it('ignores LLM-authored DROPPED transition and keeps runtime-derived plan control', async () => {
    const projectPath = await createTempDir('yolo-v2-plan-drop-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt'])

    const session = createYoloSession({
      projectPath,
      goal: 'Validate drop discipline',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Attempt to drop active item without required metadata',
          status: 'success',
          summary: 'Tried to drop active item.',
          primaryAction: `bash: node -e "console.log('drop-attempt')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> DROPPED',
          delta: 'Drop task',
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: bashSuccessEvent(`node -e "console.log('drop-attempt')"`, 'drop-attempt\n')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.status).toBe('success')
    expect(result.active_plan_id).toBe('P1')
    expect(result.status_change).toBe('P1 ACTIVE -> DONE')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).not.toContain('P1 [DROPPED]')
  })

  it('ignores planBoard structural rewrites outside planner checkpoint turns', async () => {
    const projectPath = await createTempDir('yolo-v2-plan-carry-forward-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Validate carry-forward plan discipline',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Inject one extra plan item',
          status: 'stopped',
          summary: 'Plan board updated.',
          stopReason: 'done',
          projectUpdate: {
            planBoard: [{
              id: 'P2',
              title: 'Add telemetry patch',
              status: 'TODO',
              doneDefinition: ['patch.diff exists'],
              evidencePaths: [],
              priority: 2
            }]
          }
        })
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('stopped')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('P1 [ACTIVE]')
    expect(projectMd).not.toContain('P2 [TODO] Add telemetry patch')
  })

  it('allows planBoard structural rewrites during planner checkpoint turns', async () => {
    const projectPath = await createTempDir('yolo-v2-plan-checkpoint-allow-')
    tempDirs.push(projectPath)

    const seedSession = createYoloSession({
      projectPath,
      goal: 'Original checkpoint goal',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Seed run',
          status: 'stopped',
          summary: 'Seed done.',
          stopReason: 'done'
        })
      }
    })
    await seedSession.init()
    const t1 = await seedSession.runNextTurn()
    expect(t1.status).toBe('stopped')

    const projectPathMd = path.join(projectPath, 'PROJECT.md')
    const before = await readText(projectPathMd)
    const after = before.replace('- Goal: Original checkpoint goal', '- Goal: Updated checkpoint goal')
    await fs.writeFile(projectPathMd, after, 'utf-8')

    const checkpointSession = createYoloSession({
      projectPath,
      goal: 'Original checkpoint goal',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Planner checkpoint governance turn',
          status: 'stopped',
          summary: 'Checkpoint board rewrite.',
          stopReason: 'done',
          projectUpdate: {
            planBoard: [{
              id: 'P2',
              title: 'Add telemetry patch',
              status: 'TODO',
              doneDefinition: ['deliverable: telemetry_patch.md'],
              evidencePaths: [],
              priority: 2
            }]
          }
        })
      }
    })

    await checkpointSession.init()
    const t2 = await checkpointSession.runNextTurn()
    expect(t2.status).toBe('stopped')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('P1 [ACTIVE]')
    expect(projectMd).toContain('P2 [TODO] Add telemetry patch')
  })

  it('triggers planner checkpoint when goal changes between turns', async () => {
    const projectPath = await createTempDir('yolo-v2-goal-change-checkpoint-')
    tempDirs.push(projectPath)

    const seedSession = createYoloSession({
      projectPath,
      goal: 'Initial goal',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Seed baseline run',
          status: 'stopped',
          summary: 'Seed done.',
          stopReason: 'done'
        })
      }
    })
    await seedSession.init()
    const t1 = await seedSession.runNextTurn()
    expect(t1.status).toBe('stopped')

    const projectPathMd = path.join(projectPath, 'PROJECT.md')
    const before = await readText(projectPathMd)
    const after = before.replace('- Goal: Initial goal', '- Goal: Updated goal')
    await fs.writeFile(projectPathMd, after, 'utf-8')

    let checkpointSeen: { due: boolean; reasons: string[] } | null = null
    const checkSession = createYoloSession({
      projectPath,
      goal: 'Initial goal',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          checkpointSeen = context.plannerCheckpoint
            ? { due: context.plannerCheckpoint.due, reasons: [...context.plannerCheckpoint.reasons] }
            : null
          return {
            intent: 'Observe checkpoint',
            status: 'stopped',
            summary: 'Observed checkpoint context.',
            stopReason: 'done'
          }
        }
      }
    })

    await checkSession.init()
    const t2 = await checkSession.runNextTurn()
    expect(t2.status).toBe('stopped')
    expect(checkpointSeen).not.toBeNull()
    expect(checkpointSeen?.due).toBe(true)
    expect(checkpointSeen?.reasons).toContain('goal_or_constraints_changed')
  })

  it('raises planner checkpoint after consecutive no-delta turns', async () => {
    const projectPath = await createTempDir('yolo-v2-planner-checkpoint-')
    tempDirs.push(projectPath)

    const warmupSession = createYoloSession({
      projectPath,
      goal: 'Trigger planner checkpoint',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'No-op turn one',
          status: 'success',
          summary: 'No artifacts this turn.'
        },
        {
          intent: 'No-op turn two',
          status: 'success',
          summary: 'Still no artifacts.'
        }
      ])
    })

    await warmupSession.init()
    const t1 = await warmupSession.runNextTurn()
    const t2 = await warmupSession.runNextTurn()
    expect(t1.status).toBe('no_delta')
    expect(t2.status).toBe('blocked')

    let checkpointSeen: { due: boolean; reasons: string[] } | null = null
    const checkpointSession = createYoloSession({
      projectPath,
      goal: 'Observe planner checkpoint context',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          checkpointSeen = context.plannerCheckpoint
            ? { due: context.plannerCheckpoint.due, reasons: [...context.plannerCheckpoint.reasons] }
            : null
          return {
            intent: 'Observe planner checkpoint',
            status: 'stopped',
            summary: 'Checkpoint observed.',
            stopReason: 'done'
          }
        }
      }
    })

    await checkpointSession.init()
    const t3 = await checkpointSession.runNextTurn()
    expect(t3.status).toBe('stopped')
    expect(checkpointSeen).not.toBeNull()
    expect(checkpointSeen?.due).toBe(true)
    expect(checkpointSeen?.reasons).toContain('redundancy_blocked')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0003', 'result.json'))) as Record<string, unknown>
    expect(result.planner_checkpoint_due).toBe(true)
    expect(Array.isArray(result.planner_checkpoint_reasons)).toBe(true)
  })
})
