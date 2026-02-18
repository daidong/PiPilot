import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { ProjectStore } from '../../examples/yolo-researcher/v2/project-store.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

function bashSuccessEvent(command: string, stdout: string) {
  return [
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'bash',
      input: { command }
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

function failureOutcome(cmd: string, errorLine: string) {
  return {
    intent: `Run failing probe: ${cmd}`,
    status: 'failure' as const,
    summary: `Command failed: ${errorLine}`,
    primaryAction: `bash: ${cmd}`,
    toolEvents: [
      {
        timestamp: new Date().toISOString(),
        phase: 'call' as const,
        tool: 'bash',
        input: { command: cmd }
      },
      {
        timestamp: new Date().toISOString(),
        phase: 'result' as const,
        tool: 'bash',
        success: false,
        result: {
          success: false,
          data: {
            stdout: '',
            stderr: `${errorLine}\n`,
            exitCode: 1
          },
          error: errorLine
        }
      }
    ]
  }
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

async function writeArtifact(runsDir: string, turnNumber: number, fileName: string, content: string = 'placeholder'): Promise<void> {
  const turnId = `turn-${String(turnNumber).padStart(4, '0')}`
  const dir = path.join(runsDir, turnId, 'artifacts')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, fileName), content, 'utf-8')
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

describe('yolo-researcher v2 convergence discipline', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('bare bash with empty stdout → no_delta', async () => {
    const projectPath = await createTempDir('yolo-v2-bare-bash-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Test bare bash detection',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run bash with empty output',
          status: 'success',
          summary: 'Bash ran with no output.',
          primaryAction: 'bash: true',
          toolEvents: bashSuccessEvent('true', '')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()

    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('NO_DELTA')
  })

  it('bash with non-empty stdout → success', async () => {
    const projectPath = await createTempDir('yolo-v2-bash-output-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt', 'evidence_min: 1'])

    const session = createYoloSession({
      projectPath,
      goal: 'Test bash with output detection',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run bash with output',
          status: 'success',
          summary: 'Bash produced output.',
          primaryAction: `bash: node -e "console.log('v2-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured command output evidence.',
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: bashSuccessEvent(`node -e "console.log('v2-ok')"`, 'v2-ok\n'),
          projectUpdate: {
            currentPlan: ['Step 1: verify', 'Step 2: analyze', 'Step 3: report']
          }
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()

    expect(turn.status).toBe('success')
  })

  it('stagnation exposes dominant action context after 4/5 same action type', async () => {
    const projectPath = await createTempDir('yolo-v2-stagnation-')
    tempDirs.push(projectPath)

    // Pre-create 5 turns using the same action type.
    const yoloRoot = projectPath
    const runsDir = path.join(yoloRoot, 'runs')

    for (let i = 1; i <= 5; i++) {
      await writeArtifact(runsDir, i, 'notes.md', 'some notes')
      const turnId = `turn-${String(i).padStart(4, '0')}`
      const turnDir = path.join(runsDir, turnId)
      await fs.mkdir(turnDir, { recursive: true })
      await fs.writeFile(path.join(turnDir, 'result.json'), JSON.stringify({
        status: 'success',
        action_type: 'fetch',
        action_fingerprint: `fetch:https://example.com/q${i}`,
        delta_reasons: ['artifact_file']
      }), 'utf-8')
      await fs.writeFile(path.join(turnDir, 'action.md'), `# Turn ${turnId}\n\n## Result\n- Status: success\n- Key observation: notes\n`, 'utf-8')
    }

    let captured: { dominantAction: string; count: number; window: number } | null = null

    // Turn 6 should receive stagnation details in context.
    const session = createYoloSession({
      projectPath,
      goal: 'Test stagnation detection',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          if (context.stagnation?.stagnant) {
            captured = {
              dominantAction: context.stagnation.dominantAction,
              count: context.stagnation.count,
              window: context.stagnation.window
            }
          }
          return {
            intent: 'Stop after checking stagnation context',
            status: 'stopped',
            summary: 'Checked stagnation context.',
            stopReason: 'done'
          }
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()

    expect(turn.status).toBe('stopped')
    expect(captured).toEqual({
      dominantAction: 'fetch',
      count: 5,
      window: 5
    })
  })

  it('stagnation downgrades non-deliverable artifact to no_delta', async () => {
    const projectPath = await createTempDir('yolo-v2-stag-downgrade-')
    tempDirs.push(projectPath)

    const yoloRoot = projectPath
    const runsDir = path.join(yoloRoot, 'runs')

    // Pre-create 5 turns with dominant action type = bash.
    for (let i = 1; i <= 5; i++) {
      await writeArtifact(runsDir, i, 'analysis.md', 'analysis content')
      const turnId = `turn-${String(i).padStart(4, '0')}`
      const turnDir = path.join(runsDir, turnId)
      await fs.writeFile(path.join(turnDir, 'result.json'), JSON.stringify({
        status: 'success',
        action_type: 'bash',
        action_fingerprint: `bash:analysis-${i}`,
        delta_reasons: ['artifact_file']
      }), 'utf-8')
      await fs.writeFile(path.join(turnDir, 'action.md'), `# Turn ${turnId}\n\n## Result\n- Status: success\n- Key observation: analysis\n`, 'utf-8')
    }

    // Turn 6 produces an artifact file (notes.md) but NOT a deliverable
    const session = createYoloSession({
      projectPath,
      goal: 'Test stagnation artifact downgrade',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write non-deliverable artifact',
          status: 'success',
          summary: 'Wrote generic notes.',
          primaryAction: 'bash: echo notes > notes.md',
          toolEvents: bashSuccessEvent('echo notes > notes.md', 'notes\n'),
          projectUpdate: {
            currentPlan: ['Produce problem statement', 'Run literature sweep', 'Draft paper']
          }
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()

    // Should be no_delta because stagnation clears weak deltas
    expect(turn.status).toBe('no_delta')
  })

  it('stagnation allows deliverable artifact', async () => {
    const projectPath = await createTempDir('yolo-v2-stag-allow-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: literature_map.md', 'evidence_min: 1'])

    const yoloRoot = projectPath
    const runsDir = path.join(yoloRoot, 'runs')

    // Pre-create 5 turns with dominant action type "agent".
    // Seed S1 deliverable so creating literature_map in turn 6 advances stage (S2 -> S3).
    for (let i = 1; i <= 5; i++) {
      if (i === 1) {
        await writeArtifact(runsDir, i, 'problem_statement.md', '# Problem\n')
      } else {
        await writeArtifact(runsDir, i, 'random.md', 'random content')
      }
      const turnId = `turn-${String(i).padStart(4, '0')}`
      const turnDir = path.join(runsDir, turnId)
      await fs.writeFile(path.join(turnDir, 'result.json'), JSON.stringify({
        status: 'success',
        action_fingerprint: `agent:random-${i}`,
        delta_reasons: ['artifact_file']
      }), 'utf-8')
      await fs.writeFile(path.join(turnDir, 'action.md'), `# Turn ${turnId}\n\n## Result\n- Status: success\n- Key observation: random\n`, 'utf-8')
    }

    // Turn 6: use a custom agent that writes literature_map.md into its own artifacts dir
    const session = createYoloSession({
      projectPath,
      goal: 'Test stagnation allows deliverable',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          // Write deliverable directly into the turn's artifacts dir
          const turnId = `turn-${String(context.turnNumber).padStart(4, '0')}`
          const artifactsDir = path.join(context.runsDir, turnId, 'artifacts')
          await fs.mkdir(artifactsDir, { recursive: true })
          await fs.writeFile(
            path.join(artifactsDir, 'literature_map.md'),
            '# Literature Map\n\n- Paper A\n- Paper B\n',
            'utf-8'
          )
          return {
            intent: 'Produce literature map deliverable',
            status: 'success',
            summary: 'Created literature map.',
            primaryAction: 'write: literature_map.md',
            activePlanId: 'P1',
            statusChange: 'P1 ACTIVE -> ACTIVE',
            delta: 'Added literature_map deliverable artifact.',
            evidencePaths: [`runs/${turnId}/artifacts/literature_map.md`],
            projectUpdate: {
              currentPlan: ['Analyze papers', 'Generate ideas', 'Draft paper']
            }
          }
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()

    // Should remain success because the deliverable file exists in THIS turn's artifacts
    expect(turn.status).toBe('success')
  })

  it('stagnation allows exp-xxxx directory when it advances stage', async () => {
    const projectPath = await createTempDir('yolo-v2-stag-exp-dir-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: exp-001', 'evidence_min: 1'])

    const yoloRoot = projectPath
    const runsDir = path.join(yoloRoot, 'runs')

    // Pre-create 5 turns with dominant action type "agent".
    // Also seed S1-S3 deliverables so stage before turn 6 is S4.
    await writeArtifact(runsDir, 1, 'problem_statement.md', '# Problem\n')
    await writeArtifact(runsDir, 2, 'literature_map.md', '# Literature\n')
    await writeArtifact(runsDir, 3, 'idea_candidates.md', '# Ideas\n')
    await writeArtifact(runsDir, 4, 'notes.md', 'notes')
    await writeArtifact(runsDir, 5, 'notes-2.md', 'notes')

    for (let i = 1; i <= 5; i++) {
      const turnId = `turn-${String(i).padStart(4, '0')}`
      const turnDir = path.join(runsDir, turnId)
      await fs.mkdir(turnDir, { recursive: true })
      await fs.writeFile(path.join(turnDir, 'result.json'), JSON.stringify({
        status: 'success',
        action_type: 'agent',
        action_fingerprint: `agent:prep-${i}`,
        delta_reasons: ['artifact_file']
      }), 'utf-8')
      await fs.writeFile(path.join(turnDir, 'action.md'), `# Turn ${turnId}\n\n## Result\n- Status: success\n- Key observation: prep\n`, 'utf-8')
    }

    const session = createYoloSession({
      projectPath,
      goal: 'Test exp directory stage advancement',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          const turnId = `turn-${String(context.turnNumber).padStart(4, '0')}`
          const artifactsDir = path.join(context.runsDir, turnId, 'artifacts')
          await fs.mkdir(path.join(artifactsDir, 'exp-001'), { recursive: true })
          await fs.writeFile(path.join(artifactsDir, 'exp-001', 'README.md'), '# Experiment\n', 'utf-8')
          return {
            intent: 'Create experiment directory deliverable',
            status: 'success',
            summary: 'Created exp-001 deliverable.',
            primaryAction: 'synthesize: experiment deliverable',
            activePlanId: 'P1',
            statusChange: 'P1 ACTIVE -> ACTIVE',
            delta: 'Added exp-001 experiment deliverable.',
            evidencePaths: [`runs/${turnId}/artifacts/exp-001/README.md`],
            projectUpdate: {
              currentPlan: ['Run experiment', 'Analyze results', 'Draft paper']
            }
          }
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')
    expect(turn.stageStatus?.currentStage).toBe('S5')
  })

  it('stagnation + redundancy → blocked', async () => {
    const projectPath = await createTempDir('yolo-v2-stag-blocked-')
    tempDirs.push(projectPath)

    const yoloRoot = projectPath
    const runsDir = path.join(yoloRoot, 'runs')

    // Pre-create 5 turns without deliverables
    for (let i = 1; i <= 5; i++) {
      await writeArtifact(runsDir, i, 'stuff.md', 'stuff')
      const turnId = `turn-${String(i).padStart(4, '0')}`
      const turnDir = path.join(runsDir, turnId)
      await fs.writeFile(path.join(turnDir, 'result.json'), JSON.stringify({
        status: 'success',
        action_fingerprint: `agent:stuff-${i}`,
        delta_reasons: ['artifact_file']
      }), 'utf-8')
      await fs.writeFile(path.join(turnDir, 'action.md'), `# Turn ${turnId}\n\n## Result\n- Status: success\n- Key observation: stuff\n`, 'utf-8')
    }

    // Turn 6: no_delta (stagnation), Turn 7: same fingerprint → blocked
    const session = createYoloSession({
      projectPath,
      goal: 'Test stagnation to blocked escalation',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Non-deliverable pass 1',
          status: 'success',
          summary: 'Generic synthesis.',
          primaryAction: 'synthesize: roadmap',
          projectUpdate: {
            currentPlan: ['Draft problem statement', 'Run sweep', 'Draft paper']
          }
        },
        {
          intent: 'Non-deliverable pass 2',
          status: 'success',
          summary: 'Generic synthesis again.',
          primaryAction: 'synthesize: roadmap',
          projectUpdate: {
            currentPlan: ['Draft problem statement', 'Run sweep', 'Draft paper']
          }
        }
      ])
    })

    await session.init()
    const first = await session.runNextTurn()
    const second = await session.runNextTurn()

    expect(first.status).toBe('no_delta')
    expect(second.status).toBe('blocked')
    expect(second.summary).toContain('Redundant action blocked')
  })

  it('BLOCKED (4th failure) promotes constraint', async () => {
    const projectPath = await createTempDir('yolo-v2-blocked-constraint-')
    tempDirs.push(projectPath)

    const flakyCmd = 'python -c "import missing_dep"'
    const errorLine = 'ModuleNotFoundError: missing_dep'

    const session = createYoloSession({
      projectPath,
      goal: 'Verify BLOCKED promotes to constraint',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        failureOutcome(flakyCmd, errorLine),
        failureOutcome(flakyCmd, errorLine),
        failureOutcome(flakyCmd, errorLine),
        failureOutcome(flakyCmd, errorLine)
      ])
    })

    await session.init()
    await session.runNextTurn()
    await session.runNextTurn()
    await session.runNextTurn()
    const r4 = await session.runNextTurn()

    expect(r4.status).toBe('blocked')

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('[ENV-BLOCKED]')
    expect(projectMd).toContain('ModuleNotFoundError')
  })

  it('stage inference from artifact scan', async () => {
    const projectPath = await createTempDir('yolo-v2-stage-infer-')
    tempDirs.push(projectPath)

    const yoloRoot = projectPath
    const runsDir = path.join(yoloRoot, 'runs')

    // Pre-create a turn with problem_statement.md
    await writeArtifact(runsDir, 1, 'problem_statement.md', '# Problem Statement\n')
    const turnDir = path.join(runsDir, 'turn-0001')
    await fs.writeFile(path.join(turnDir, 'result.json'), JSON.stringify({
      status: 'success',
      action_fingerprint: 'agent:write-problem',
      delta_reasons: ['artifact_file']
    }), 'utf-8')
    await fs.writeFile(path.join(turnDir, 'action.md'), '# Turn turn-0001\n\n## Result\n- Status: success\n', 'utf-8')

    // Turn 2: produce some bash output
    const session = createYoloSession({
      projectPath,
      goal: 'Test stage inference',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run verification',
          status: 'success',
          summary: 'Verified state.',
          primaryAction: 'bash: echo check',
          toolEvents: bashSuccessEvent('echo check', 'check\n'),
          projectUpdate: {
            currentPlan: ['Create literature map', 'Generate ideas', 'Draft paper']
          }
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()

    // problem_statement exists → S1 complete → current stage should be S2
    expect(turn.stageStatus).toBeDefined()
    expect(turn.stageStatus?.currentStage).toBe('S2')
    expect(turn.stageStatus?.label).toBe('Literature')

    // Verify result.json also has stage_status
    const resultJson = JSON.parse(await readText(path.join(runsDir, 'turn-0002', 'result.json'))) as Record<string, unknown>
    const stageStatus = resultJson.stage_status as Record<string, unknown>
    expect(stageStatus.currentStage).toBe('S2')
  })

  it('claims parsing round-trip + dedup', async () => {
    const projectPath = await createTempDir('yolo-v2-claims-roundtrip-')
    tempDirs.push(projectPath)

    const yoloRoot = projectPath
    await fs.mkdir(yoloRoot, { recursive: true })

    const store = new ProjectStore(yoloRoot, 'Test claims', [], 'host')
    await store.init()

    // Add claims via applyUpdate
    await store.applyUpdate({
      claims: [
        { claim: 'LLM-guided generation outperforms random', evidencePaths: ['runs/turn-0001/result.json'], status: 'uncovered' },
        { claim: 'LLM-guided generation outperforms random', evidencePaths: ['runs/turn-0002/result.json'], status: 'partial' }
      ]
    })

    const panel = await store.load()

    // Should be deduped to 1 claim with merged evidence and upgraded status
    expect(panel.claims.length).toBe(1)
    expect(panel.claims[0].claim).toBe('LLM-guided generation outperforms random')
    expect(panel.claims[0].status).toBe('partial')
    expect(panel.claims[0].evidencePaths).toContain('runs/turn-0001/result.json')
    expect(panel.claims[0].evidencePaths).toContain('runs/turn-0002/result.json')

    // Verify round-trip: reload from file
    const reloaded = await store.load()
    expect(reloaded.claims.length).toBe(1)
    expect(reloaded.claims[0].claim).toBe('LLM-guided generation outperforms random')
  })

  it('claims evidence validation rejects bad paths', async () => {
    const projectPath = await createTempDir('yolo-v2-claims-validate-')
    tempDirs.push(projectPath)

    const yoloRoot = projectPath
    await fs.mkdir(yoloRoot, { recursive: true })

    const store = new ProjectStore(yoloRoot, 'Test claims validation', [], 'host')
    await store.init()

    await expect(store.applyUpdate({
      claims: [
        { claim: 'Test claim', evidencePaths: ['/absolute/bad/path.json'], status: 'covered' }
      ]
    })).rejects.toThrow('evidence path must start with runs/turn-xxxx/')
  })

  it('constraints compressed beyond MAX_CONSTRAINTS', async () => {
    const projectPath = await createTempDir('yolo-v2-constraints-compress-')
    tempDirs.push(projectPath)

    const yoloRoot = projectPath
    await fs.mkdir(yoloRoot, { recursive: true })

    const store = new ProjectStore(yoloRoot, 'Test constraint compression', [], 'host')
    await store.init()

    // Add 15 constraints one by one
    for (let i = 1; i <= 15; i++) {
      await store.applyUpdate({
        constraints: [{
          text: `Constraint ${i}`,
          evidencePath: `runs/turn-${String(i).padStart(4, '0')}/stderr.txt`
        }]
      })
    }

    const panel = await store.load()

    // Should be compressed to at most 10
    expect(panel.constraints.length).toBeLessThanOrEqual(10)
    // Should keep the most recent ones (last 10)
    expect(panel.constraints.some(c => c.text === 'Constraint 15')).toBe(true)
    expect(panel.constraints.some(c => c.text === 'Constraint 6')).toBe(true)
    // Oldest should be dropped (Constraint 1 through 5)
    expect(panel.constraints.some(c => c.text === 'Constraint 1')).toBe(false)
    expect(panel.constraints.some(c => c.text === 'Constraint 5')).toBe(false)
  })
})
