import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

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

function successOutcome(cmd: string, stdout: string) {
  return {
    intent: `Verify remediation for: ${cmd}`,
    status: 'success' as const,
    summary: 'Command executed successfully.',
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
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

describe('yolo-researcher v2 failure circuit breaker', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('escalates deterministic failures to BLOCKED and writes UNBLOCKED after verified success', async () => {
    const projectPath = await createTempDir('yolo-v2-fail-')
    tempDirs.push(projectPath)

    const flakyCmd = 'python -c "import missing_dep"'
    const errorLine = 'ModuleNotFoundError: missing_dep'

    const session = createYoloSession({
      projectPath,
      goal: 'Verify deterministic failure breaker',
      agent: new ScriptedSingleAgent([
        failureOutcome(flakyCmd, errorLine),
        failureOutcome(flakyCmd, errorLine),
        failureOutcome(flakyCmd, errorLine),
        failureOutcome(flakyCmd, errorLine),
        successOutcome(flakyCmd, 'fixed\n')
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

    const base = projectPath
    const failuresMd = await readText(path.join(base, 'FAILURES.md'))
    const turn4Exit = await readText(path.join(base, 'runs', 'turn-0004', 'exit_code.txt'))
    const turn4Result = JSON.parse(await readText(path.join(base, 'runs', 'turn-0004', 'result.json'))) as Record<string, unknown>

    expect(failuresMd).toContain('[WARN][host]')
    expect(failuresMd).toContain('[UNBLOCKED][host]')
    expect(failuresMd).toContain('was: BLOCKED (ModuleNotFoundError: missing_dep)')
    expect(failuresMd).toContain('resolved: Successful native verification after remediation.')
    expect(failuresMd).toContain('evidence: runs/turn-0005/result.json')
    expect(turn4Exit.trim()).toBe('1')
    expect(turn4Result.exit_code).toBe(1)
    expect(turn4Result.runtime).toBe('host')
  })

  it('lets old BLOCKED fingerprints expire after moving beyond the last-10-turn window', async () => {
    const projectPath = await createTempDir('yolo-v2-window-')
    tempDirs.push(projectPath)

    const flakyCmd = 'python -c "import missing_dep"'
    const flakyError = 'ModuleNotFoundError: missing_dep'
    const successCmd = 'node -e "console.log(\"steady-state\")"'

    const outcomes = [
      failureOutcome(flakyCmd, flakyError),
      failureOutcome(flakyCmd, flakyError),
      failureOutcome(flakyCmd, flakyError),
      ...Array.from({ length: 10 }, () => successOutcome(successCmd, 'steady-state\n')),
      failureOutcome(flakyCmd, flakyError)
    ]

    const session = createYoloSession({
      projectPath,
      goal: 'Verify BLOCKED expiry window',
      agent: new ScriptedSingleAgent(outcomes)
    })

    await session.init()

    let lastStatus = ''
    for (let i = 0; i < outcomes.length; i += 1) {
      const result = await session.runNextTurn()
      lastStatus = result.status
    }

    expect(lastStatus).toBe('failure')

    const turn14 = JSON.parse(await readText(path.join(
      projectPath,
      'runs',
      'turn-0014',
      'result.json'
    ))) as Record<string, unknown>

    expect(turn14.exit_code).toBe(1)
    expect(typeof turn14.failure_fingerprint).toBe('string')
  })
})
