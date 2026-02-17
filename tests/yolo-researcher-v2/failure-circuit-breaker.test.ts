import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

describe('yolo-researcher v2 failure circuit breaker', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('escalates deterministic failures to BLOCKED and intercepts retries', async () => {
    const projectPath = await createTempDir('yolo-v2-fail-')
    tempDirs.push(projectPath)

    const flakyCmd = `node -e "if (process.env.FIXED === '1') { console.log('fixed'); process.exit(0); } console.error('ModuleNotFoundError: missing_dep'); process.exit(1);"`

    const session = createYoloSession({
      projectPath,
      projectId: 'rq-failure-001',
      goal: 'Verify deterministic failure breaker',
      agent: new ScriptedSingleAgent([
        { intent: 'Initial failing probe', action: { kind: 'Exec', cmd: flakyCmd, runtime: 'host' } },
        { intent: 'Second failing probe', action: { kind: 'Exec', cmd: flakyCmd, runtime: 'host' } },
        { intent: 'Third failing probe to trigger BLOCKED', action: { kind: 'Exec', cmd: flakyCmd, runtime: 'host' } },
        { intent: 'Retry should be intercepted', action: { kind: 'Exec', cmd: flakyCmd, runtime: 'host' } },
        {
          intent: 'Run minimal override verification after remediation',
          action: {
            kind: 'Exec',
            cmd: flakyCmd,
            runtime: 'host',
            blockedOverrideReason: 'Dependency installed; verify once.',
            env: { FIXED: '1' }
          }
        }
      ])
    })

    await session.init()
    const r1 = await session.runNextTurn()
    const r2 = await session.runNextTurn()
    const r3 = await session.runNextTurn()
    const r4 = await session.runNextTurn()
    const r5 = await session.runNextTurn()

    expect(r1.status).toBe('failure')
    expect(r2.status).toBe('failure')
    expect(r3.status).toBe('failure')
    expect(r4.status).toBe('blocked')
    expect(r4.blockedBy?.status).toBe('BLOCKED')
    expect(r5.status).toBe('success')

    const base = path.join(projectPath, 'yolo', 'rq-failure-001')
    const failuresMd = await readText(path.join(base, 'FAILURES.md'))
    const turn4Exit = await readText(path.join(base, 'runs', 'turn-0004', 'exit_code.txt'))
    const turn4Result = JSON.parse(await readText(path.join(base, 'runs', 'turn-0004', 'result.json'))) as Record<string, unknown>

    expect(failuresMd).toContain('[WARN][host]')
    expect(failuresMd).toContain('[UNBLOCKED][host]')
    expect(failuresMd).toContain('was: BLOCKED (ModuleNotFoundError: missing_dep)')
    expect(failuresMd).toContain('resolved: Dependency installed; verify once.')
    expect(failuresMd).toContain('evidence: runs/turn-0005/result.json')
    expect(turn4Exit.trim()).toBe('-1')
    expect(turn4Result.exit_code).toBe(-1)
    expect(turn4Result.runtime).toBe('host')
  })

  it('lets old BLOCKED fingerprints expire after moving beyond the last-10-turn window', async () => {
    const projectPath = await createTempDir('yolo-v2-window-')
    tempDirs.push(projectPath)

    const flakyCmd = `node -e "console.error('ModuleNotFoundError: missing_dep'); process.exit(1);"`
    const successCmd = `node -e "console.log('steady-state')"`
    const actions = [
      { intent: 'fail-1', action: { kind: 'Exec' as const, cmd: flakyCmd, runtime: 'host' as const } },
      { intent: 'fail-2', action: { kind: 'Exec' as const, cmd: flakyCmd, runtime: 'host' as const } },
      { intent: 'fail-3', action: { kind: 'Exec' as const, cmd: flakyCmd, runtime: 'host' as const } },
      ...Array.from({ length: 10 }, (_, i) => ({
        intent: `success-${i + 1}`,
        action: { kind: 'Exec' as const, cmd: successCmd, runtime: 'host' as const }
      })),
      { intent: 'fail-after-window', action: { kind: 'Exec' as const, cmd: flakyCmd, runtime: 'host' as const } }
    ]

    const session = createYoloSession({
      projectPath,
      projectId: 'rq-window-001',
      goal: 'Verify BLOCKED expiry window',
      agent: new ScriptedSingleAgent(actions)
    })

    await session.init()

    let lastStatus = ''
    for (let i = 0; i < actions.length; i += 1) {
      const result = await session.runNextTurn()
      lastStatus = result.status
    }

    expect(lastStatus).toBe('failure')

    const turn14 = JSON.parse(await readText(path.join(
      projectPath,
      'yolo',
      'rq-window-001',
      'runs',
      'turn-0014',
      'result.json'
    ))) as Record<string, unknown>
    expect(turn14.exit_code).toBe(1)
    expect(typeof turn14.failure_fingerprint).toBe('string')
  })
})
