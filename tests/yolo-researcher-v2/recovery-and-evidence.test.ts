import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

describe('yolo-researcher v2 recovery and evidence discipline', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('recovers across sessions and increments turn id', async () => {
    const projectPath = await createTempDir('yolo-v2-recover-')
    tempDirs.push(projectPath)

    await fs.writeFile(path.join(projectPath, 'seed.txt'), 'seed-data\n', 'utf-8')

    const firstSession = createYoloSession({
      projectPath,
      projectId: 'rq-recover-001',
      goal: 'Recovery test',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Read seed file',
          action: { kind: 'Read', targetPath: 'seed.txt' },
          projectUpdate: {
            facts: [
              {
                text: 'Seed file exists and is readable',
                evidencePath: 'runs/turn-0001/stdout.txt'
              }
            ]
          }
        }
      ])
    })

    await firstSession.init()
    const firstTurn = await firstSession.runNextTurn()
    expect(firstTurn.turnNumber).toBe(1)

    const restartedSession = createYoloSession({
      projectPath,
      projectId: 'rq-recover-001',
      goal: 'Recovery test',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Stop after recovery check',
          action: { kind: 'Stop', reason: 'Recovery verified.' }
        }
      ])
    })

    await restartedSession.init()
    const recent = await restartedSession.getRecentTurns(3)
    expect(recent.length).toBeGreaterThanOrEqual(1)
    expect(recent[0]?.turnNumber).toBe(1)

    const secondTurn = await restartedSession.runNextTurn()
    expect(secondTurn.turnNumber).toBe(2)
  })

  it('rejects Facts updates without runs/turn evidence paths', async () => {
    const projectPath = await createTempDir('yolo-v2-evidence-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      projectId: 'rq-evidence-001',
      goal: 'Evidence pointer validation',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Try writing an invalid fact',
          action: { kind: 'Write', targetPath: 'note.md', content: 'tmp' },
          projectUpdate: {
            facts: [
              {
                text: 'Invalid because evidence path is outside runs',
                evidencePath: 'note.md'
              }
            ]
          }
        }
      ])
    })

    await session.init()
    await expect(session.runNextTurn()).rejects.toThrow('evidence path must start with runs/turn-xxxx/')

    const failuresMd = await readText(path.join(projectPath, 'yolo', 'rq-evidence-001', 'FAILURES.md'))
    expect(failuresMd).toContain('# Failures / Blockers')
  })
})
