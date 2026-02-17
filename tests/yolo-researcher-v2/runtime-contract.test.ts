import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

describe('yolo-researcher v2 runtime contract', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('creates minimal layout and captures raw exec outputs', async () => {
    const projectPath = await createTempDir('yolo-v2-layout-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      projectId: 'rq-minimal-001',
      goal: 'Run one evidence-producing command',
      defaultRuntime: 'host',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Run one command and save raw output',
          expectedOutcome: 'stdout/stderr/exit_code are persisted',
          action: {
            kind: 'Exec',
            cmd: `node -e "console.log('v2-ok')"`,
            runtime: 'host'
          },
          projectUpdate: {
            facts: [
              {
                text: 'Node command produced expected token v2-ok',
                evidencePath: 'runs/turn-0001/stdout.txt'
              }
            ],
            currentPlan: ['Run next minimal verification command', 'Stop after milestone confirmation']
          }
        },
        {
          intent: 'Stop after baseline evidence is captured',
          action: { kind: 'Stop', reason: 'Baseline done.' }
        }
      ])
    })

    await session.init()
    const first = await session.runNextTurn()

    expect(first.turnNumber).toBe(1)
    expect(first.status).toBe('success')

    const base = path.join(projectPath, 'yolo', 'rq-minimal-001')
    await expect(fs.access(path.join(base, 'PROJECT.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(base, 'FAILURES.md'))).resolves.toBeUndefined()

    const turnDir = path.join(base, 'runs', 'turn-0001')
    await expect(fs.access(path.join(turnDir, 'action.md'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'cmd.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'stdout.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'stderr.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'exit_code.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(turnDir, 'artifacts'))).resolves.toBeUndefined()

    const stdout = await readText(path.join(turnDir, 'stdout.txt'))
    const exitCode = await readText(path.join(turnDir, 'exit_code.txt'))
    const projectMd = await readText(path.join(base, 'PROJECT.md'))

    expect(stdout).toContain('v2-ok')
    expect(exitCode.trim()).toBe('0')
    expect(projectMd).toContain('runs/turn-0001/stdout.txt')
  })
})
