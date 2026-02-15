import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { UserIngressManager } from '../../examples/yolo-researcher/index.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

describe('user ingress manager', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('reviews staged files with accept/dedup/reject outcomes', async () => {
    const projectPath = await createTempDir('yolo-ingress-')
    tempDirs.push(projectPath)

    const sessionDir = path.join(projectPath, 'yolo', 'sid-ingress')
    const manager = new UserIngressManager(sessionDir)
    await manager.init()

    const ingressDir = await manager.ensureTurnIngressDir(1)
    await fs.writeFile(path.join(ingressDir, 'a.txt'), 'hello ingress', 'utf-8')
    await fs.writeFile(path.join(ingressDir, 'dup.txt'), 'hello ingress', 'utf-8')
    await fs.writeFile(path.join(ingressDir, 'large.bin'), Buffer.alloc(26 * 1024 * 1024))

    const review = await manager.reviewTurnIngress(1)
    expect(review).not.toBeNull()
    expect(review?.accepted.length).toBe(2)
    expect(review?.rejected.length).toBe(1)
    expect(review?.rejected[0]?.reason).toBe('file_too_large')
    expect(review?.accepted.some((item) => Boolean(item.deduplicatedFrom))).toBe(true)

    if (!review) return
    await expect(fs.access(path.join(sessionDir, review.manifestPath))).resolves.toBeUndefined()
    await expect(fs.access(path.join(sessionDir, review.ingressDir))).rejects.toThrow()
  })
})
