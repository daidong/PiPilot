import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { createTempDir, cleanupTempDir } from '../test-utils.js'
import { ExternalSkillLoader } from '../../src/skills/external-skill-loader.js'
import { renderExternalSkillMarkdown } from '../../src/skills/skill-file.js'

describe('ExternalSkillLoader', () => {
  let tempDir: string
  let skillsDir: string

  beforeEach(async () => {
    tempDir = await createTempDir('external-skill-loader-')
    skillsDir = path.join(tempDir, '.agentfoundry', 'skills')
    await fs.mkdir(skillsDir, { recursive: true })
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  it('loads approved and unapproved skills with approval state', async () => {
    const approvedContent = renderExternalSkillMarkdown(
      {
        id: 'approved-skill',
        name: 'Approved Skill',
        shortDescription: 'approved',
        loadingStrategy: 'lazy',
        tools: ['read'],
        meta: { approvedByUser: true }
      },
      `# Summary
Approved summary.

## Procedures
Use read first.`
    )

    const unapprovedContent = renderExternalSkillMarkdown(
      {
        id: 'unapproved-skill',
        name: 'Unapproved Skill',
        shortDescription: 'unapproved',
        loadingStrategy: 'lazy',
        tools: ['grep'],
        meta: { approvedByUser: false }
      },
      `# Summary
Unapproved summary.`
    )

    await fs.writeFile(path.join(skillsDir, 'approved-skill.skill.md'), approvedContent, 'utf-8')
    await fs.writeFile(path.join(skillsDir, 'unapproved-skill.skill.md'), unapprovedContent, 'utf-8')

    const loader = new ExternalSkillLoader({ skillsDir })
    const loaded = await loader.loadAll()

    expect(loaded).toHaveLength(2)
    const approved = loaded.find(item => item.skill.id === 'approved-skill')
    const unapproved = loaded.find(item => item.skill.id === 'unapproved-skill')
    expect(approved?.approvedByUser).toBe(true)
    expect(unapproved?.approvedByUser).toBe(false)
  })

  it('rejects skill id collision with built-ins', async () => {
    const onError = vi.fn()
    const content = renderExternalSkillMarkdown(
      {
        id: 'context-retrieval-skill',
        name: 'Bad Collision',
        shortDescription: 'collides with built-in',
        loadingStrategy: 'lazy',
        tools: ['ctx-get'],
        meta: { approvedByUser: true }
      },
      `# Summary
collision`
    )
    const filePath = path.join(skillsDir, 'collision.skill.md')
    await fs.writeFile(filePath, content, 'utf-8')

    const loader = new ExternalSkillLoader({
      skillsDir,
      builtInSkillIds: ['context-retrieval-skill'],
      onError
    })

    const loaded = await loader.loadAll()
    expect(loaded).toHaveLength(0)
    expect(onError).toHaveBeenCalled()
  })
})
