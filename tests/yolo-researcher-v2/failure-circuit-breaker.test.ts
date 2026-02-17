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

    expect(failuresMd).toContain('[WARN][host]')
    expect(failuresMd).toContain('Recovered after blocked override')
    expect(turn4Exit.trim()).toBe('-1')
  })
})
