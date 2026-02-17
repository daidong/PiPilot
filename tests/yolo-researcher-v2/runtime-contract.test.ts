import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
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

describe('yolo-researcher v2 runtime contract', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('creates minimal layout and captures native tool-event outputs', async () => {
    const projectPath = await createTempDir('yolo-v2-layout-')
    tempDirs.push(projectPath)

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

  it('rejects projectUpdate evidence paths that do not exist under workspace runs', async () => {
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
    expect(turn.status).toBe('failure')
    expect(turn.summary).toContain('PROJECT.md update rejected')
    expect(turn.summary).toContain('does not exist under workspace session root')
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
                    jsonPath: '.yolo-researcher/library/literature/sweep-20260217-openevolve.json',
                    markdownPath: '.yolo-researcher/library/literature/sweep-20260217-openevolve.md'
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
    expect(projectMd).toContain('.yolo-researcher/library/literature/sweep-20260217-openevolve.json')
    expect(projectMd).toContain('.yolo-researcher/library/literature/sweep-20260217-openevolve.md')

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
                  jsonPath: '.yolo-researcher/library/literature/sweep-20260217-wrapper.json',
                  markdownPath: '.yolo-researcher/library/literature/sweep-20260217-wrapper.md'
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
    expect(projectMd).toContain('.yolo-researcher/library/literature/sweep-20260217-wrapper.json')
    expect(projectMd).toContain('.yolo-researcher/library/literature/sweep-20260217-wrapper.md')
  })
})
