import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloSession } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

describe('yolo-researcher v2 user input bridge', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('feeds submitted user input into next native turn context and clears queue after successful runTurn', async () => {
    const projectPath = await createTempDir('yolo-v2-user-input-')
    tempDirs.push(projectPath)

    let calls = 0

    const session = createYoloSession({
      projectPath,
      goal: 'Bridge ask-user responses into next turn context',
      agent: {
        runTurn: async (context) => {
          calls += 1

          if (calls === 1) {
            return {
              intent: 'Need user preference before continuing',
              status: 'ask_user',
              summary: 'Need runtime preference from user',
              askQuestion: 'Choose runtime and continue strategy.'
            }
          }

          if (calls === 2) {
            expect(context.pendingUserInputs).toHaveLength(1)
            expect(context.pendingUserInputs[0]?.text).toContain('Use docker runtime')
            expect(context.pendingUserInputs[0]?.evidencePath).toMatch(/^runs\/turn-0002\/artifacts\/user-input-/)

            await fs.writeFile(
              path.join(context.projectRoot, 'reply.txt'),
              context.pendingUserInputs[0]?.text ?? '',
              'utf-8'
            )

            return {
              intent: 'Apply user instruction',
              status: 'success',
              summary: 'Applied user runtime preference.',
              primaryAction: 'write: reply.txt',
              projectUpdate: {
                currentPlan: ['Continue with runtime-specific probes', 'Collect one constraint evidence', 'Validate first hypothesis']
              }
            }
          }

          expect(context.pendingUserInputs).toHaveLength(0)
          return {
            intent: 'Stop after consuming reply',
            status: 'stopped',
            summary: 'Retained input was consumed and queue is empty.',
            stopReason: 'Done.'
          }
        }
      }
    })

    await session.init()

    const askTurn = await session.runNextTurn()
    expect(askTurn.status).toBe('ask_user')

    await session.submitUserInput('Use docker runtime and continue with minimal checks.')

    const secondTurn = await session.runNextTurn()
    expect(['success', 'no_delta']).toContain(secondTurn.status)

    const replyFile = await fs.readFile(path.join(projectPath, 'reply.txt'), 'utf-8')
    expect(replyFile).toContain('Use docker runtime')

    expect(secondTurn.evidencePaths.some((entry) => /runs\/turn-0002\/artifacts\/user-input-/.test(entry))).toBe(true)

    const queue = await fs.readFile(path.join(projectPath, 'user-input-queue.json'), 'utf-8')
    expect(JSON.parse(queue)).toEqual([])

    const stopTurn = await session.runNextTurn()
    expect(stopTurn.status).toBe('stopped')
  })

  it('retains queued user input when runTurn throws and consumes it on next successful turn', async () => {
    const projectPath = await createTempDir('yolo-v2-user-input-fallback-')
    tempDirs.push(projectPath)

    let calls = 0

    const session = createYoloSession({
      projectPath,
      goal: 'Keep queued input across runtime error turns',
      agent: {
        runTurn: async (context) => {
          calls += 1

          if (calls === 1) {
            return {
              intent: 'Need user clarification',
              status: 'ask_user',
              summary: 'Need missing path details.',
              askQuestion: 'Provide missing path details.'
            }
          }

          if (calls === 2) {
            throw new Error('transient native agent crash')
          }

          expect(context.pendingUserInputs).toHaveLength(1)
          expect(context.pendingUserInputs[0]?.text).toContain('Path is src/index.ts')

          return {
            intent: 'Consume retained input after runtime error',
            status: 'stopped',
            summary: 'Retained input was visible.',
            stopReason: 'Retained input was visible.'
          }
        }
      }
    })

    await session.init()

    const first = await session.runNextTurn()
    expect(first.status).toBe('ask_user')

    await session.submitUserInput('Path is src/index.ts')

    const errorTurn = await session.runNextTurn()
    expect(errorTurn.status).toBe('failure')
    expect(errorTurn.summary).toContain('Native turn runtime error')

    const retainedTurn = await session.runNextTurn()
    expect(retainedTurn.status).toBe('stopped')
    expect(retainedTurn.summary).toContain('Retained input was visible')
  })
})
