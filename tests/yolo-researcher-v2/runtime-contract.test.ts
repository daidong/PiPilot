import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

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

function bashFailureEvent(command: string, stderr: string, cwd?: string) {
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
      success: false,
      result: {
        success: false,
        error: stderr,
        data: {
          stdout: '',
          stderr,
          exitCode: 1
        }
      }
    }
  ]
}

function bashToolInvocationFailureEvent(command: string, error: string, cwd?: string) {
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
      success: false,
      result: {
        success: false,
        error
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

function codingLargeRepoDelegateEvents(cwd: string = '.') {
  return [
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'skill-script-run',
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-run-to-completion',
        args: ['--task', 'apply repo patch', '--cwd', cwd]
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'skill-script-run',
      success: true,
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-run-to-completion'
      },
      result: {
        success: true,
        data: {
          structuredResult: {
            schema: 'coding-large-repo.result.v1',
            script: 'agent-run-to-completion',
            status: 'completed',
            exit_code: 0
          }
        }
      }
    }
  ]
}

function codingLargeRepoAsyncRunningEvents(sessionId: string, cwd: string = '.') {
  return [
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'skill-script-run',
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-run-to-completion',
        args: ['--task', 'delegate patch', '--cwd', cwd, '--async', 'always', '--session-id', sessionId]
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'skill-script-run',
      success: true,
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-run-to-completion'
      },
      result: {
        success: true,
        data: {
          structuredResult: {
            schema: 'coding-large-repo.result.v1',
            script: 'agent-start',
            status: 'running',
            session_id: sessionId,
            pid: 321
          }
        }
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'skill-script-run',
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-poll',
        args: ['--session-id', sessionId]
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'skill-script-run',
      success: true,
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-poll',
        args: ['--session-id', sessionId]
      },
      result: {
        success: true,
        data: {
          structuredResult: {
            schema: 'coding-large-repo.result.v1',
            script: 'agent-poll',
            status: 'running',
            session_id: sessionId,
            pid: 321
          }
        }
      }
    }
  ]
}

function codingLargeRepoAsyncCompletedEvents(sessionId: string, cwd: string = '.') {
  return [
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'skill-script-run',
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-run-to-completion',
        args: ['--task', 'delegate patch', '--cwd', cwd, '--async', 'always', '--session-id', sessionId]
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'skill-script-run',
      success: true,
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-run-to-completion'
      },
      result: {
        success: true,
        data: {
          structuredResult: {
            schema: 'coding-large-repo.result.v1',
            script: 'agent-start',
            status: 'running',
            session_id: sessionId,
            pid: 654
          }
        }
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'call' as const,
      tool: 'skill-script-run',
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-poll',
        args: ['--session-id', sessionId]
      }
    },
    {
      timestamp: new Date().toISOString(),
      phase: 'result' as const,
      tool: 'skill-script-run',
      success: true,
      input: {
        skillId: 'coding-large-repo',
        script: 'agent-poll',
        args: ['--session-id', sessionId]
      },
      result: {
        success: true,
        data: {
          structuredResult: {
            schema: 'coding-large-repo.result.v1',
            script: 'agent-poll',
            status: 'completed',
            session_id: sessionId,
            exit_code: 0
          }
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

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

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

  it('builds ask_user summary from runtime failure facts and filters contradictory no-output claims', async () => {
    const projectPath = await createTempDir('yolo-v2-ask-user-runtime-facts-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Avoid contradictory ask_user failure narrative',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Escalate with contradictory narrative',
          status: 'ask_user',
          summary: 'pytest failed with no stdout/stderr; needs environment check.',
          askQuestion: 'No stdout/stderr was returned. Can you confirm if long-lived subprocesses are blocked?',
          toolEvents: bashFailureEvent(
            'python -m pytest -q',
            'ModuleNotFoundError: No module named mlx',
            '.'
          )
        })
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('ask_user')
    expect(turn.summary.toLowerCase()).not.toContain('no stdout')
    expect(turn.summary).toContain('command_failure')

    const askArtifact = await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'artifacts',
      'ask-user.md'
    ))
    expect(askArtifact).toContain('Runtime Failure Summary (auto-generated)')
    expect(askArtifact).toContain('classification: command_failure')
    expect(askArtifact).toContain('last_failed_cmd: python -m pytest -q')
    expect(askArtifact).toContain('error_excerpt: ModuleNotFoundError: No module named mlx')
    expect(askArtifact).toContain('output_captured: yes')
    expect(askArtifact.toLowerCase()).not.toContain('no stdout/stderr')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.last_failure_kind).toBe('command_failure')
    expect(result.last_failed_cmd).toBe('python -m pytest -q')
    expect(result.last_failed_exit_code).toBe(1)
    expect(String(result.last_failed_error_excerpt || '')).toContain('ModuleNotFoundError')
  })

  it('classifies bash policy/tool wrapper failures as tool_invocation_failure', async () => {
    const projectPath = await createTempDir('yolo-v2-ask-user-tool-failure-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Classify tool-level failures correctly',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Escalate a tool wrapper failure',
          status: 'ask_user',
          summary: 'Need permission clarification.',
          askQuestion: 'Please confirm runtime permissions.',
          toolEvents: bashToolInvocationFailureEvent(
            'python -m pytest -q',
            'policy_denied: blocked by a security policy',
            '.'
          )
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
    expect(askArtifact).toContain('classification: tool_invocation_failure')
    expect(askArtifact).toContain('output_captured: no')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.last_failure_kind).toBe('tool_invocation_failure')
    expect(result.last_failed_cmd).toBe('python -m pytest -q')
    expect(result.last_failed_exit_code).toBeNull()
    expect(String(result.last_failed_error_excerpt || '')).toContain('policy_denied')
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

  it('demotes speculative environment constraints to hypotheses when no tool-backed proof exists', async () => {
    const projectPath = await createTempDir('yolo-v2-constraint-demote-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt', 'evidence_min: 1'])

    const session = createYoloSession({
      projectPath,
      goal: 'Avoid ungrounded environment blockers',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Publish one env blocker claim without proof',
          status: 'success',
          summary: 'Finished one bounded check.',
          primaryAction: `bash: node -e "console.log('ok')"`,
          toolEvents: bashSuccessEvent(`node -e "console.log('ok')"`, 'ok\n'),
          projectUpdate: {
            constraints: [{
              text: 'No LLM provider/API key is configured in this workspace.',
              evidencePath: 'runs/turn-0001/stdout.txt'
            }]
          }
        })
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const store = new ProjectStore(projectPath, 'Avoid ungrounded environment blockers', ['Define measurable success criteria.'], 'host')
    await store.init()
    const panel = await store.load()

    expect(panel.constraints.some((row) => /no llm provider\/api key is configured/i.test(row.text))).toBe(false)
    expect(panel.hypotheses.some((row) => /no llm provider\/api key is configured/i.test(row))).toBe(true)
  })

  it('keeps environment constraints when stderr/tool evidence explicitly proves them', async () => {
    const projectPath = await createTempDir('yolo-v2-constraint-keep-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt', 'evidence_min: 1'])

    const session = createYoloSession({
      projectPath,
      goal: 'Retain grounded environment blockers',
      defaultRuntime: 'host',
      agent: {
        runTurn: async () => ({
          intent: 'Record true env blocker from tool failure',
          status: 'failure',
          summary: 'Tool reported missing API key.',
          primaryAction: `bash: python - <<'PY'\nraise SystemExit('OPENAI_API_KEY missing')\nPY`,
          toolEvents: bashFailureEvent(
            `python - <<'PY'\nraise SystemExit('OPENAI_API_KEY missing')\nPY`,
            'OPENAI_API_KEY missing: provider not configured'
          ),
          projectUpdate: {
            constraints: [{
              text: 'No LLM provider/API key is configured in this workspace.',
              evidencePath: 'runs/turn-0001/stderr.txt'
            }]
          }
        })
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('failure')

    const store = new ProjectStore(projectPath, 'Retain grounded environment blockers', ['Define measurable success criteria.'], 'host')
    await store.init()
    const panel = await store.load()

    expect(panel.constraints.some((row) => /no llm provider\/api key is configured/i.test(row.text))).toBe(true)
  })

  it('does not ingest artifacts/workspace repo trees into plan evidence', async () => {
    const projectPath = await createTempDir('yolo-v2-ignore-workspace-artifacts-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: artifacts/exp_run_metrics.json', 'evidence_min: 1'])

    const session = createYoloSession({
      projectPath,
      goal: 'Avoid evidence pollution from workspace clones under turn artifacts',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          const turnId = `turn-${String(context.turnNumber).padStart(4, '0')}`
          const artifactsDir = path.join(context.runsDir, turnId, 'artifacts')
          await fs.mkdir(path.join(artifactsDir, 'workspace', 'openevolve', '.git'), { recursive: true })
          await fs.mkdir(path.join(artifactsDir, 'workspace', 'openevolve', 'examples'), { recursive: true })
          await fs.writeFile(path.join(artifactsDir, 'workspace', 'openevolve', '.git', 'config'), '[core]\n', 'utf-8')
          await fs.writeFile(path.join(artifactsDir, 'workspace', 'openevolve', 'examples', 'README.md'), '# demo\n', 'utf-8')
          await fs.writeFile(path.join(artifactsDir, 'exp_run_metrics.json'), '{"auc":0.9}\n', 'utf-8')

          return {
            intent: 'Write one deliverable and a local workspace clone payload under artifacts',
            status: 'success',
            summary: 'Wrote deliverable.',
            primaryAction: `write: runs/${turnId}/artifacts/exp_run_metrics.json`,
            toolEvents: writeSuccessEvent(`runs/${turnId}/artifacts/exp_run_metrics.json`, '{"auc":0.9}\n')
          }
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(['success', 'no_delta']).toContain(turn.status)

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).not.toContain('artifacts/workspace/openevolve')
    expect(projectMd).toContain('runs/turn-0001/artifacts/exp_run_metrics.json')
  })

  it('caps plan board evidence paths to prevent unbounded growth', async () => {
    const projectPath = await createTempDir('yolo-v2-plan-evidence-cap-')
    tempDirs.push(projectPath)
    const store = new ProjectStore(projectPath, 'Plan evidence cap', ['Define measurable success criteria.'], 'host')
    await store.init()

    const allEvidence = Array.from(
      { length: 80 },
      (_, idx) => `runs/turn-${String(idx + 1).padStart(4, '0')}/artifacts/evidence-${idx + 1}.md`
    )
    for (const entry of allEvidence) {
      const absPath = path.join(projectPath, entry)
      await fs.mkdir(path.dirname(absPath), { recursive: true })
      await fs.writeFile(absPath, '# evidence\n', 'utf-8')
    }

    const applied = await store.applyTurnPlanDelta({
      activePlanId: 'P1',
      turnStatus: 'success',
      evidencePaths: allEvidence
    })

    expect(applied.applied).toBe(true)
    const panel = await store.load()
    const p1 = panel.planBoard.find((item) => item.id === 'P1')
    expect(p1).toBeTruthy()
    expect((p1?.evidencePaths.length ?? 0)).toBeLessThanOrEqual(40)
    expect(p1?.evidencePaths).toContain(allEvidence[allEvidence.length - 1]!)
  })

  ;(HAS_GIT ? it : it.skip)('writes patch.diff with real git diff hunks for touched repo files', async () => {
    const projectPath = await createTempDir('yolo-v2-git-patch-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: stdout.txt'])

    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
    await fs.writeFile(path.join(projectPath, 'src', 'sample.ts'), 'export const v = 1\n', 'utf-8')

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: projectPath, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectPath, stdio: 'ignore' })

    await fs.writeFile(path.join(projectPath, 'src', 'sample.ts'), 'export const v = 2\n', 'utf-8')

    const session = createYoloSession({
      projectPath,
      goal: 'Capture git patch snapshot for touched files',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Modify source file and verify output',
          status: 'success',
          summary: 'Modified source file.',
          primaryAction: `bash: node -e "console.log('patch-ok')"`,
          toolEvents: [
            ...writeSuccessEvent('src/sample.ts', 'export const v = 2'),
            ...bashSuccessEvent(`node -e "console.log('patch-ok')"`, 'patch-ok\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(['success', 'no_delta']).toContain(turn.status)

    const patch = await readText(path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'patch.diff'))
    expect(patch).toContain('diff --git a/src/sample.ts b/src/sample.ts')
  })

  it('downgrades git-repo code edits without coding-large-repo delegate flow', async () => {
    const projectPath = await createTempDir('yolo-v2-coding-repo-gate-')
    tempDirs.push(projectPath)

    const repoRoot = path.join(projectPath, 'external', 'openevolve')
    const targetPath = path.join(repoRoot, 'openevolve', 'iteration.py')
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, '# baseline\n', 'utf-8')
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: external/openevolve/openevolve/iteration.py'])

    const session = createYoloSession({
      projectPath,
      goal: 'Modify nested git repo safely',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Directly edit repo file without coding-large-repo workflow',
          status: 'success',
          summary: 'Edited target code path.',
          primaryAction: `write: external/openevolve/openevolve/iteration.py`,
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: [
            ...writeSuccessEvent('external/openevolve/openevolve/iteration.py', '# changed\n'),
            ...bashSuccessEvent(`node -e "console.log('repo-edit-no-skill')"`, 'repo-edit-no-skill\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('repo_code_edit_without_coding_large_repo')

    const result = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'result.json'
    ))) as Record<string, unknown>
    expect(result.blocked_reason).toBe('repo_code_edit_without_coding_large_repo')
  })

  it('accepts git-repo code edits when coding-large-repo delegate flow is invoked', async () => {
    const projectPath = await createTempDir('yolo-v2-coding-repo-allowed-')
    tempDirs.push(projectPath)

    const repoRoot = path.join(projectPath, 'external', 'openevolve')
    const targetPath = path.join(repoRoot, 'openevolve', 'iteration.py')
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, '# baseline\n', 'utf-8')
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: external/openevolve/openevolve/iteration.py'])

    const session = createYoloSession({
      projectPath,
      goal: 'Modify nested git repo safely',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run coding-large-repo delegate flow before editing repo file',
          status: 'success',
          summary: 'Edited repo code through delegate workflow.',
          primaryAction: 'skill-script-run: coding-large-repo/agent-run-to-completion',
          evidencePaths: ['runs/turn-0001/stdout.txt'],
          toolEvents: [
            ...codingLargeRepoDelegateEvents('external/openevolve'),
            ...writeSuccessEvent('external/openevolve/openevolve/iteration.py', '# changed by delegate\n'),
            ...bashSuccessEvent(`node -e "console.log('repo-edit-with-skill')"`, 'repo-edit-with-skill\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')
  })

  it('enforces explicit repo target policy for code-touch turns when requireRepoTarget=true', async () => {
    const projectPath = await createTempDir('yolo-v2-repo-target-required-')
    tempDirs.push(projectPath)

    const repoRoot = path.join(projectPath, 'external', 'openevolve')
    const targetPath = path.join(repoRoot, 'openevolve', 'iteration.py')
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, '# baseline\n', 'utf-8')
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: external/openevolve/openevolve/iteration.py'])

    const session = createYoloSession({
      projectPath,
      goal: 'Require explicit repo target on code touch',
      defaultRuntime: 'host',
      requireRepoTarget: true,
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run delegate without matching repo target',
          status: 'success',
          summary: 'Edited repo code through delegate workflow.',
          primaryAction: 'skill-script-run: coding-large-repo/agent-run-to-completion',
          toolEvents: [
            ...codingLargeRepoDelegateEvents('.'),
            ...writeSuccessEvent('external/openevolve/openevolve/iteration.py', '# changed by delegate\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.blocked_reason).toBe('missing_repo_target')
  })

  it('persists resolved_repo when explicit repo target is provided', async () => {
    const projectPath = await createTempDir('yolo-v2-repo-target-resolved-')
    tempDirs.push(projectPath)

    const repoRoot = path.join(projectPath, 'external', 'openevolve')
    const targetPath = path.join(repoRoot, 'openevolve', 'iteration.py')
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, '# baseline\n', 'utf-8')
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: external/openevolve/openevolve/iteration.py'])

    const session = createYoloSession({
      projectPath,
      goal: 'Bind code-touch turn to explicit repo target',
      defaultRuntime: 'host',
      requireRepoTarget: true,
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run delegate with explicit repo target',
          status: 'success',
          summary: 'Edited repo code through targeted delegate workflow.',
          primaryAction: 'skill-script-run: coding-large-repo/agent-run-to-completion',
          repoId: 'openevolve',
          toolEvents: [
            ...codingLargeRepoDelegateEvents('external/openevolve'),
            ...writeSuccessEvent('external/openevolve/openevolve/iteration.py', '# changed by delegate\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    const resolvedRepo = (result.resolved_repo ?? {}) as Record<string, unknown>
    expect(resolvedRepo.repo_id).toBe('openevolve')
    expect(resolvedRepo.repo_path).toBe('external/openevolve')
  })

  it('recovers nested non-canonical runs outputs into canonical turn artifacts (path-anchor recover)', async () => {
    const projectPath = await createTempDir('yolo-v2-path-anchor-recover-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: artifacts/openevolve_repo_intake.md'])

    const session = createYoloSession({
      projectPath,
      goal: 'Recover nested runs output to canonical turn artifacts',
      defaultRuntime: 'host',
      pathAnchor: { audit: true, mode: 'recover' },
      agent: {
        runTurn: async (context) => {
          const nestedFile = path.join(
            context.projectRoot,
            'external',
            'openevolve_repo',
            'runs',
            `turn-${String(context.turnNumber).padStart(4, '0')}`,
            'artifacts',
            'openevolve_repo_intake.md'
          )
          await fs.mkdir(path.dirname(nestedFile), { recursive: true })
          await fs.writeFile(nestedFile, '# intake\n', 'utf-8')
          return {
            intent: 'Write nested turn artifact from repo-local cwd',
            status: 'success',
            summary: 'Nested artifact written.',
            primaryAction: 'write: external/openevolve_repo/runs/turn-0001/artifacts/openevolve_repo_intake.md',
            toolEvents: writeSuccessEvent('external/openevolve_repo/runs/turn-0001/artifacts/openevolve_repo_intake.md', '# intake\n')
          }
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(['success', 'no_delta']).toContain(turn.status)

    const canonicalArtifact = path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'openevolve_repo_intake.md')
    await expect(fs.access(canonicalArtifact)).resolves.toBeUndefined()

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    const violation = (result.path_anchor_violation ?? {}) as Record<string, unknown>
    expect(violation.detected).toBe(true)
    expect(Number(violation.count)).toBeGreaterThan(0)
    const rewriteEvents = Array.isArray(result.path_rewrite_events) ? result.path_rewrite_events : []
    expect(rewriteEvents.length).toBeGreaterThan(0)
  })

  it('blocks turn when nested non-canonical runs outputs are detected in fail mode', async () => {
    const projectPath = await createTempDir('yolo-v2-path-anchor-fail-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: artifacts/openevolve_repo_intake.md'])

    const session = createYoloSession({
      projectPath,
      goal: 'Fail on nested runs output drift',
      defaultRuntime: 'host',
      pathAnchor: { audit: true, mode: 'fail' },
      agent: {
        runTurn: async (context) => {
          const nestedFile = path.join(
            context.projectRoot,
            'external',
            'openevolve_repo',
            'runs',
            `turn-${String(context.turnNumber).padStart(4, '0')}`,
            'artifacts',
            'openevolve_repo_intake.md'
          )
          await fs.mkdir(path.dirname(nestedFile), { recursive: true })
          await fs.writeFile(nestedFile, '# intake\n', 'utf-8')
          return {
            intent: 'Write nested turn artifact from repo-local cwd',
            status: 'success',
            summary: 'Nested artifact written.',
            primaryAction: 'write: external/openevolve_repo/runs/turn-0001/artifacts/openevolve_repo_intake.md',
            toolEvents: writeSuccessEvent('external/openevolve_repo/runs/turn-0001/artifacts/openevolve_repo_intake.md', '# intake\n')
          }
        }
      }
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('blocked')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.blocked_reason).toBe('path_anchor_violation')
  })

  it('downgrades in-flight async delegate observation to no_delta during warmup', async () => {
    const projectPath = await createTempDir('yolo-v2-coding-agent-warmup-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: artifacts/p8_checkpoint_and_delegate_restart.md'])

    const session = createYoloSession({
      projectPath,
      goal: 'Avoid early stalled judgement on async delegate sessions',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Start delegate and check immediate status',
          status: 'success',
          summary: 'Session looks stalled from immediate log tail.',
          primaryAction: 'skill-script-run: coding-large-repo/agent-poll',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          toolEvents: [
            ...codingLargeRepoAsyncRunningEvents('coding-agent-test-warmup', '.'),
            ...writeSuccessEvent('runs/turn-0001/artifacts/p8_checkpoint_and_delegate_restart.md', '# checkpoint\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('delegate_session_in_warmup')

    const result = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'result.json'
    ))) as Record<string, unknown>
    expect(result.blocked_reason).toBe('delegate_session_in_warmup')
    const observation = (result.coding_agent_sessions ?? {}) as Record<string, unknown>
    expect(observation.observed).toBe(true)
    expect(observation.has_running_only).toBe(true)
  })

  it('keeps success when async delegate polling has terminal completion evidence', async () => {
    const projectPath = await createTempDir('yolo-v2-coding-agent-terminal-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: artifacts/p8_checkpoint_and_delegate_restart.md'])

    const session = createYoloSession({
      projectPath,
      goal: 'Preserve success once delegate reaches terminal state',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Poll delegate to completion and record checkpoint',
          status: 'success',
          summary: 'Session completed; proceed with next execution step.',
          primaryAction: 'skill-script-run: coding-large-repo/agent-poll',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          toolEvents: [
            ...codingLargeRepoAsyncCompletedEvents('coding-agent-test-done', '.'),
            ...writeSuccessEvent('runs/turn-0001/artifacts/p8_checkpoint_and_delegate_restart.md', '# checkpoint\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'result.json'
    ))) as Record<string, unknown>
    expect(result.blocked_reason).toBeUndefined()
    const observation = (result.coding_agent_sessions ?? {}) as Record<string, unknown>
    expect(observation.observed).toBe(true)
    expect(observation.has_terminal).toBe(true)
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
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0001',
      'result.json'
    ))) as Record<string, unknown>
    expect(result.status).toBe('success')
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

  it('captures literature-study artifact paths into project key artifacts', async () => {
    const projectPath = await createTempDir('yolo-v2-literature-study-wrapper-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: literature-cache.json'])

    const session = createYoloSession({
      projectPath,
      goal: 'Bootstrap prior-art evidence using literature-study',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run literature study pipeline',
          status: 'success',
          summary: 'Literature study completed with coverage report.',
          primaryAction: 'literature-study: standard',
          toolEvents: [
            {
              timestamp: new Date().toISOString(),
              phase: 'call',
              tool: 'literature-study',
              input: { query: 'OpenEvolve agentic optimization', mode: 'standard' }
            },
            {
              timestamp: new Date().toISOString(),
              phase: 'result',
              tool: 'literature-study',
              success: true,
              input: { query: 'OpenEvolve agentic optimization', mode: 'standard' },
              result: {
                success: true,
                data: {
                  mode: 'standard',
                  planPath: 'runs/turn-0001/artifacts/literature-study/plan.json',
                  reviewPath: 'runs/turn-0001/artifacts/literature-study/review.md',
                  paperListPath: 'runs/turn-0001/artifacts/literature-study/papers.json',
                  coveragePath: 'runs/turn-0001/artifacts/literature-study/coverage.json',
                  summaryPath: 'runs/turn-0001/artifacts/literature-study/summary.json'
                }
              }
            }
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(['success', 'no_delta']).toContain(turn.status)

    const projectMd = await readText(path.join(projectPath, 'PROJECT.md'))
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature-study/review.md')
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature-study/papers.json')
    expect(projectMd).toContain('runs/turn-0001/artifacts/literature-study/coverage.json')
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

  it('normalizes fixed-turn deliverable paths and allows turn-local deliverable touch', async () => {
    const projectPath = await createTempDir('yolo-v2-deliverable-normalize-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: runs/turn-0009/artifacts/implementation_notes.md',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Touch a turn-local deliverable path',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write implementation notes artifact for active plan',
          status: 'success',
          summary: 'Wrote implementation notes.',
          primaryAction: 'write: runs/turn-0001/artifacts/implementation_notes.md',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created implementation notes artifact.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0001/artifacts/implementation_notes.md', '# implementation notes\n'),
            ...bashSuccessEvent(`node -e "console.log('deliverable-ok')"`, 'deliverable-ok\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    const deltaReasons = Array.isArray(result.delta_reasons) ? result.delta_reasons.map(String) : []
    expect(deltaReasons).toContain('plan_deliverable_touched')
    expect(result.blocked_reason).toBeUndefined()
  })

  it('treats mixed done_definition narrative rows as non-blocking when mechanical rules are present', async () => {
    const projectPath = await createTempDir('yolo-v2-done-definition-narrative-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'Goal: land runnable harness',
      '- deliverable: artifacts/narrative_ok.md',
      'Notes: this row is narrative and should not block runtime',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Allow mechanical deliverable touch despite narrative rows',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write the deliverable artifact',
          status: 'success',
          summary: 'Narrative-friendly done_definition turn succeeded.',
          primaryAction: 'write: runs/turn-0001/artifacts/narrative_ok.md',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created narrative_ok artifact.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0001/artifacts/narrative_ok.md', '# ok\n'),
            ...bashSuccessEvent(`node -e "console.log('narrative-done-def-ok')"`, 'narrative-done-def-ok\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    const deltaReasons = Array.isArray(result.delta_reasons) ? result.delta_reasons.map(String) : []
    expect(deltaReasons).toContain('plan_deliverable_touched')
    expect(result.blocked_reason).toBeUndefined()
  })

  it('reuses the next turn number when a trailing turn directory is empty', async () => {
    const projectPath = await createTempDir('yolo-v2-empty-turn-dir-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, ['deliverable: artifacts/probe.txt', 'evidence_min: 2'])

    const session = createYoloSession({
      projectPath,
      goal: 'Ignore empty trailing turn directories',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'First run writes probe artifact',
          status: 'success',
          summary: 'first',
          primaryAction: 'write: runs/turn-0001/artifacts/probe.txt',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created probe artifact.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0001/artifacts/probe.txt', 'one\n'),
            ...bashSuccessEvent(`node -e "console.log('first-turn')"`, 'first-turn\n')
          ]
        },
        {
          intent: 'Second run should use turn-0002, not skip to turn-0003',
          status: 'success',
          summary: 'second',
          primaryAction: 'write: runs/turn-0002/artifacts/probe.txt',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Updated probe artifact.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0002/artifacts/probe.txt', 'two\n'),
            ...bashSuccessEvent(`node -e "console.log('second-turn')"`, 'second-turn\n')
          ]
        }
      ])
    })

    await session.init()
    const first = await session.runNextTurn()
    expect(first.turnNumber).toBe(1)

    await fs.mkdir(path.join(projectPath, 'runs', 'turn-0002', 'artifacts'), { recursive: true })

    const second = await session.runNextTurn()
    expect(second.turnNumber).toBe(2)
    await expect(fs.access(path.join(projectPath, 'runs', 'turn-0002', 'result.json'))).resolves.toBeUndefined()
  })

  it('applies micro-checkpoint deliverable alignment when active plan deliverable mismatches this turn output', async () => {
    const projectPath = await createTempDir('yolo-v2-micro-checkpoint-deliverable-align-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/unit_test_acceptance.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Align active deliverable to turn output and avoid no_delta',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Generate benchmark results artifact',
          status: 'success',
          summary: 'Benchmark results generated.',
          primaryAction: 'write: runs/turn-0001/artifacts/benchmark_results.json',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created benchmark results.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0001/artifacts/benchmark_results.json', '{"rho":0.9}\n'),
            ...bashSuccessEvent(`node -e "console.log('micro-checkpoint-ok')"`, 'micro-checkpoint-ok\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.micro_checkpoint_applied).toBe(true)
    expect(result.micro_checkpoint_deliverable).toBe('artifacts/benchmark_results.json')
    expect(result.blocked_reason).toBeUndefined()

    const store = new ProjectStore(projectPath, 'Micro checkpoint verify', ['Define measurable success criteria.'], 'host')
    const panel = await store.load()
    const p1 = panel.planBoard.find((item) => item.id === 'P1')
    expect(p1?.doneDefinition.some((line) => line.trim().toLowerCase() === 'deliverable: artifacts/benchmark_results.json')).toBe(true)
  })

  it('co-updates shared-deliverable plans within the same successful turn', async () => {
    const projectPath = await createTempDir('yolo-v2-shared-deliverable-co-update-')
    tempDirs.push(projectPath)

    const store = new ProjectStore(projectPath, 'Shared deliverable test', ['Define measurable success criteria.'], 'host')
    await store.init()
    const seeded = await store.load()
    const p1 = seeded.planBoard.find((item) => item.id === 'P1') ?? seeded.planBoard[0]
    if (!p1) {
      throw new Error('expected seeded P1 plan item')
    }

    const sharedDoneDefinition = ['deliverable: artifacts/shared.md', 'evidence_min: 1']
    await store.applyUpdate({
      planBoard: [
        {
          id: 'P1',
          title: p1.title,
          status: 'ACTIVE',
          doneDefinition: sharedDoneDefinition,
          evidencePaths: [],
          priority: 1
        },
        {
          id: 'P2',
          title: 'Secondary shared deliverable',
          status: 'TODO',
          doneDefinition: sharedDoneDefinition,
          evidencePaths: [],
          priority: 2
        }
      ]
    })

    const session = createYoloSession({
      projectPath,
      goal: 'Shared deliverable should progress both plans',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write shared deliverable once',
          status: 'success',
          summary: 'Shared deliverable written.',
          primaryAction: 'write: runs/turn-0001/artifacts/shared.md',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created shared artifact.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0001/artifacts/shared.md', '# shared\n'),
            ...bashSuccessEvent(`node -e "console.log('shared-ok')"`, 'shared-ok\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const after = await store.load()
    const afterP1 = after.planBoard.find((item) => item.id === 'P1')
    const afterP2 = after.planBoard.find((item) => item.id === 'P2')
    expect(afterP1?.status).toBe('DONE')
    expect(afterP2?.status).toBe('DONE')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.active_plan_id).toBe('P1')
    expect(result.co_touched_plan_ids).toEqual(['P2'])
    expect(result.co_touched_deliverable_plan_ids).toEqual(['P2'])
    const deltaReasons = Array.isArray(result.delta_reasons) ? result.delta_reasons.map(String) : []
    expect(deltaReasons).toContain('co_plan_deliverable_touched')
    expect(Array.isArray(result.co_plan_status_changes)).toBe(true)
    expect((result.co_plan_status_changes as string[])).toContain('P2 TODO -> DONE')
  })

  it('downgrades legacy OpenAI Python script usage to force openai>=1.x compatibility', async () => {
    const projectPath = await createTempDir('yolo-v2-openai-compat-gate-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/run_calibration_live.py',
      'evidence_min: 1'
    ])

    const legacyScript = [
      'import openai',
      'def run_one(model):',
      '  return openai.ChatCompletion.create(model=model, messages=[{"role":"user","content":"hi"}])',
      ''
    ].join('\n')

    const session = createYoloSession({
      projectPath,
      goal: 'Reject legacy openai ChatCompletion usage',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write legacy OpenAI calibration script',
          status: 'success',
          summary: 'Legacy script written.',
          primaryAction: 'write: runs/turn-0001/artifacts/run_calibration_live.py',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created calibration script.',
          toolEvents: [
            ...writeSuccessEvent('runs/turn-0001/artifacts/run_calibration_live.py', legacyScript),
            ...bashSuccessEvent(`node -e "console.log('legacy-openai-script')"`, 'legacy-openai-script\n')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('openai_script_compat_issue')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, unknown>
    expect(result.blocked_reason).toBe('openai_script_compat_issue')
  })

  it('semantic gate shadow mode records decision but does not mutate no_delta status', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-shadow-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/benchmark_results.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Shadow semantic gate should be non-mutating',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'shadow',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'touched',
        confidence: 0.99,
        touched_deliverables: [{
          id: 'artifacts/benchmark_results.json',
          evidence_refs: ['runs/turn-0001/stdout.txt'],
          reason_codes: ['semantic_match']
        }]
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run an execution-only probe with no deliverable file write',
          status: 'success',
          summary: 'Probe finished.',
          primaryAction: `bash: node -e "console.log('probe-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured command output.',
          toolEvents: bashSuccessEvent(`node -e "console.log('probe-ok')"`, 'probe-ok\n')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('missing_plan_deliverable_touch')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.semantic_gate?.invoked).toBe(true)
    expect(result.semantic_gate?.accepted).toBe(false)
    expect(result.semantic_gate?.mode).toBe('shadow')
    expect(result.semantic_gate?.reject_reason).toBe('shadow_mode')
  })

  it('semantic gate enforce_touch_only can recover eligible missing_plan_deliverable_touch', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-enforce-touch-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/benchmark_results.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Allow touch-only semantic correction',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'enforce_touch_only',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'touched',
        confidence: 0.93,
        touched_deliverables: [{
          id: 'artifacts/benchmark_results.json',
          evidence_refs: ['runs/turn-0001/stdout.txt'],
          reason_codes: ['semantic_match']
        }]
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run execution-only probe with output evidence',
          status: 'success',
          summary: 'Probe finished.',
          primaryAction: `bash: node -e "console.log('probe-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured command output.',
          toolEvents: bashSuccessEvent(`node -e "console.log('probe-ok')"`, 'probe-ok\n')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('success')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.semantic_gate?.invoked).toBe(true)
    expect(result.semantic_gate?.accepted).toBe(true)
    expect(result.semantic_gate?.mode).toBe('enforce_touch_only')
    const deltaReasons = Array.isArray(result.delta_reasons) ? result.delta_reasons.map(String) : []
    expect(deltaReasons).toContain('semantic_plan_deliverable_touched')
    expect(result.blocked_reason).toBeUndefined()
  })

  it('semantic gate rejects touched verdict with invalid evidence refs', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-invalid-evidence-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/benchmark_results.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Reject invalid semantic evidence refs',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'enforce_touch_only',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'touched',
        confidence: 0.99,
        touched_deliverables: [{
          id: 'artifacts/benchmark_results.json',
          evidence_refs: ['runs/turn-9999/stdout.txt'],
          reason_codes: ['semantic_match']
        }]
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run execution-only probe with output evidence',
          status: 'success',
          summary: 'Probe finished.',
          primaryAction: `bash: node -e "console.log('probe-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured command output.',
          toolEvents: bashSuccessEvent(`node -e "console.log('probe-ok')"`, 'probe-ok\n')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('missing_plan_deliverable_touch')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.semantic_gate?.invoked).toBe(true)
    expect(result.semantic_gate?.accepted).toBe(false)
    expect(String(result.semantic_gate?.reject_reason || '')).toContain('cross_turn_evidence_ref')
  })

  it('semantic gate rejects low-confidence touched verdict', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-low-confidence-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/benchmark_results.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Reject low-confidence semantic correction',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'enforce_touch_only',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'touched',
        confidence: 0.6,
        touched_deliverables: [{
          id: 'artifacts/benchmark_results.json',
          evidence_refs: ['runs/turn-0001/stdout.txt'],
          reason_codes: ['semantic_match']
        }]
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run execution-only probe with output evidence',
          status: 'success',
          summary: 'Probe finished.',
          primaryAction: `bash: node -e "console.log('probe-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured command output.',
          toolEvents: bashSuccessEvent(`node -e "console.log('probe-ok')"`, 'probe-ok\n')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('missing_plan_deliverable_touch')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.semantic_gate?.invoked).toBe(true)
    expect(result.semantic_gate?.accepted).toBe(false)
    expect(String(result.semantic_gate?.reject_reason || '')).toContain('confidence_below_threshold')
  })

  it('semantic gate abstain is a no-op', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-abstain-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/benchmark_results.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Abstain should not mutate no_delta',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'enforce_touch_only',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'abstain',
        confidence: 0
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run execution-only probe with output evidence',
          status: 'success',
          summary: 'Probe finished.',
          primaryAction: `bash: node -e "console.log('probe-ok')"`,
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured command output.',
          toolEvents: bashSuccessEvent(`node -e "console.log('probe-ok')"`, 'probe-ok\n')
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('missing_plan_deliverable_touch')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.semantic_gate?.invoked).toBe(true)
    expect(result.semantic_gate?.accepted).toBe(false)
    expect(result.semantic_gate?.reject_reason).toBe('verdict_abstain')
  })

  it('semantic gate does not run when a hard runtime gate blocks the turn', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-hard-block-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/run_calibration_live.py',
      'evidence_min: 1'
    ])

    const legacyScript = [
      'import openai',
      'def run_one(model):',
      '  return openai.ChatCompletion.create(model=model, messages=[{"role":"user","content":"hi"}])',
      ''
    ].join('\n')

    const session = createYoloSession({
      projectPath,
      goal: 'Semantic correction must not bypass hard runtime blocks',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'enforce_touch_only',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'touched',
        confidence: 0.99,
        touched_deliverables: [{
          id: 'artifacts/run_calibration_live.py',
          evidence_refs: ['runs/turn-0001/artifacts/run_calibration_live.py'],
          reason_codes: ['deliverable_semantic_match']
        }]
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Write legacy OpenAI calibration script',
          status: 'success',
          summary: 'Legacy script written.',
          primaryAction: 'write: runs/turn-0001/artifacts/run_calibration_live.py',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Created calibration script.',
          toolEvents: writeSuccessEvent('runs/turn-0001/artifacts/run_calibration_live.py', legacyScript)
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('openai_script_compat_issue')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.blocked_reason).toBe('openai_script_compat_issue')
    expect(result.semantic_gate?.invoked).toBe(false)
    expect(result.semantic_gate?.accepted).toBe(false)
  })

  it('semantic gate is ineligible when hard violation signal exists in failed tool events', async () => {
    const projectPath = await createTempDir('yolo-v2-semantic-hard-signal-')
    tempDirs.push(projectPath)
    await seedActivePlanDoneDefinition(projectPath, [
      'deliverable: artifacts/benchmark_results.json',
      'evidence_min: 1'
    ])

    const session = createYoloSession({
      projectPath,
      goal: 'Hard violation signal should suppress semantic arbitration',
      defaultRuntime: 'host',
      semanticGate: {
        mode: 'enforce_touch_only',
        confidenceThreshold: 0.85
      },
      semanticGateEvaluator: async () => ({
        schema: 'yolo.semantic_gate.output.v1',
        verdict: 'touched',
        confidence: 0.99,
        touched_deliverables: [{
          id: 'artifacts/benchmark_results.json',
          evidence_refs: ['runs/turn-0001/artifacts/evidence/policy_note.md'],
          reason_codes: ['semantic_match']
        }]
      }),
      agent: new ScriptedSingleAgent([
        {
          intent: 'Produce non-deliverable artifact while tool error indicates policy denial',
          status: 'success',
          summary: 'Collected partial evidence.',
          primaryAction: 'write: runs/turn-0001/artifacts/evidence/policy_note.md',
          activePlanId: 'P1',
          statusChange: 'P1 ACTIVE -> ACTIVE',
          delta: 'Captured tool failure note.',
          toolEvents: [
            ...bashFailureEvent('sudo rm -rf /tmp/x', 'policy_denied: blocked by a security policy'),
            ...bashSuccessEvent(`node -e "console.log('still-running')"`, 'still-running\n'),
            ...writeSuccessEvent('runs/turn-0001/artifacts/evidence/policy_note.md', 'blocked by policy')
          ]
        }
      ])
    })

    await session.init()
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).toContain('missing_plan_deliverable_touch')

    const result = JSON.parse(await readText(path.join(projectPath, 'runs', 'turn-0001', 'result.json'))) as Record<string, any>
    expect(result.semantic_gate?.eligible).toBe(false)
    expect(result.semantic_gate?.invoked).toBe(false)
    expect(result.semantic_gate?.accepted).toBe(false)
    expect(String(result.semantic_gate?.reject_reason || '')).toContain('hard_violation:policy_denied')
  })

  it('applies redundancy checkpoint cooldown instead of triggering planner checkpoint every turn', async () => {
    const projectPath = await createTempDir('yolo-v2-checkpoint-cooldown-')
    tempDirs.push(projectPath)

    let callCount = 0
    let turn3Checkpoint: { due: boolean; reasons: string[] } | null = null
    let turn4Checkpoint: { due: boolean; reasons: string[] } | null = null

    const session = createYoloSession({
      projectPath,
      goal: 'Verify checkpoint cooldown behavior',
      defaultRuntime: 'host',
      agent: {
        runTurn: async (context) => {
          callCount += 1
          if (callCount === 1) {
            return {
              intent: 'No-op turn one',
              status: 'success',
              summary: 'No artifacts this turn.',
              primaryAction: 'synthesize: repeated-no-delta-action'
            }
          }
          if (callCount === 2) {
            return {
              intent: 'No-op turn two',
              status: 'success',
              summary: 'Still no artifacts.',
              primaryAction: 'synthesize: repeated-no-delta-action'
            }
          }
          if (callCount === 3) {
            turn3Checkpoint = context.plannerCheckpoint
              ? { due: context.plannerCheckpoint.due, reasons: [...context.plannerCheckpoint.reasons] }
              : null
            return {
              intent: 'Observe checkpoint after redundancy block',
              status: 'stopped',
              summary: 'Observed checkpoint state.',
              stopReason: 'done'
            }
          }
          turn4Checkpoint = context.plannerCheckpoint
            ? { due: context.plannerCheckpoint.due, reasons: [...context.plannerCheckpoint.reasons] }
            : null
          return {
            intent: 'Observe checkpoint cooldown window',
            status: 'stopped',
            summary: 'Observed checkpoint state during cooldown.',
            stopReason: 'done'
          }
        }
      }
    })

    await session.init()
    const t1 = await session.runNextTurn()
    const t2 = await session.runNextTurn()
    const t3 = await session.runNextTurn()
    const t4 = await session.runNextTurn()

    expect(t1.status).toBe('no_delta')
    expect(t2.status).toBe('blocked')
    expect(t3.status).toBe('stopped')
    expect(t4.status).toBe('stopped')
    expect(turn3Checkpoint?.due).toBe(true)
    expect(turn3Checkpoint?.reasons).toContain('redundancy_blocked')
    expect(turn4Checkpoint).toBeNull()
  })
})
