import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession, ScriptedSingleAgent } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

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
      goal: 'Recovery test',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Capture first baseline evidence',
          status: 'success',
          summary: 'Baseline turn completed.',
          primaryAction: 'bash: cat seed.txt',
          toolEvents: [
            {
              timestamp: new Date().toISOString(),
              phase: 'call',
              tool: 'bash',
              input: { command: 'cat seed.txt' }
            },
            {
              timestamp: new Date().toISOString(),
              phase: 'result',
              tool: 'bash',
              success: true,
              result: {
                success: true,
                data: {
                  stdout: 'seed-data\n',
                  stderr: '',
                  exitCode: 0
                }
              }
            }
          ],
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
      goal: 'Recovery test',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Stop after recovery check',
          status: 'stopped',
          summary: 'Recovery verified.',
          stopReason: 'Recovery verified.'
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

  it('skips invalid Facts evidence paths without failing the turn', async () => {
    const projectPath = await createTempDir('yolo-v2-evidence-')
    tempDirs.push(projectPath)

    const session = createYoloSession({
      projectPath,
      goal: 'Evidence pointer validation',
      agent: new ScriptedSingleAgent([
        {
          intent: 'Try writing an invalid fact',
          status: 'success',
          summary: 'Attempted to persist fact with invalid evidence path.',
          primaryAction: 'agent.run',
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
    const turn = await session.runNextTurn()
    expect(turn.status).toBe('no_delta')
    expect(turn.summary).not.toContain('PROJECT.md update rejected')

    const failuresMd = await fs.readFile(path.join(projectPath, 'FAILURES.md'), 'utf-8')
    expect(failuresMd).toContain('# Failures / Blockers')
  })
})
