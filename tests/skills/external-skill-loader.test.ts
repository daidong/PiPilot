import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { createTempDir, cleanupTempDir } from '../test-utils.js'
import { ExternalSkillLoader } from '../../src/skills/external-skill-loader.js'
import { renderExternalSkillMarkdown } from '../../src/skills/skill-file.js'
import { resolveCommunitySkillDir } from '../../src/skills/skill-source-paths.js'

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

    await fs.mkdir(path.join(skillsDir, 'approved-skill'), { recursive: true })
    await fs.mkdir(path.join(skillsDir, 'unapproved-skill'), { recursive: true })
    await fs.writeFile(path.join(skillsDir, 'approved-skill', 'SKILL.md'), approvedContent, 'utf-8')
    await fs.writeFile(path.join(skillsDir, 'unapproved-skill', 'SKILL.md'), unapprovedContent, 'utf-8')

    const loader = new ExternalSkillLoader({
      skillSources: [{ dir: skillsDir, sourceType: 'project-local' }]
    })
    const loaded = await loader.loadAll()

    expect(loaded).toHaveLength(2)
    const approved = loaded.find(item => item.skill.id === 'approved-skill')
    const unapproved = loaded.find(item => item.skill.id === 'unapproved-skill')
    expect(approved?.approvedByUser).toBe(true)
    expect(unapproved?.approvedByUser).toBe(false)
    expect(approved?.sourceType).toBe('project-local')
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
    await fs.mkdir(path.join(skillsDir, 'collision'), { recursive: true })
    const filePath = path.join(skillsDir, 'collision', 'SKILL.md')
    await fs.writeFile(filePath, content, 'utf-8')

    const loader = new ExternalSkillLoader({
      skillSources: [{ dir: skillsDir, sourceType: 'project-local' }],
      builtInSkillIds: ['context-retrieval-skill'],
      onError
    })

    const loaded = await loader.loadAll()
    expect(loaded).toHaveLength(0)
    expect(onError).toHaveBeenCalled()
  })

  it('discovers scripts and infers metadata for SKILL.md without frontmatter', async () => {
    const skillDir = path.join(skillsDir, 'quick-audit')
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `
# Summary
Run fast checks with the bundled script.
`, 'utf-8')
    await fs.writeFile(path.join(skillDir, 'scripts', 'audit.sh'), 'echo "audit:$1"\n', 'utf-8')

    const loader = new ExternalSkillLoader({
      skillSources: [{ dir: skillsDir, sourceType: 'project-local' }]
    })
    const loaded = await loader.loadAll()

    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.skill.id).toBe('quick-audit')
    expect(loaded[0]?.scripts).toHaveLength(1)
    expect(loaded[0]?.scripts[0]?.name).toBe('audit')
    expect(loaded[0]?.scripts[0]?.runner).toBe('bash')
    const scripts = (loaded[0]?.skill.meta?.scripts as Array<{ name: string }> | undefined) ?? []
    expect(scripts[0]?.name).toBe('audit')
  })

  it('maps claude-style allowed-tools to normalized tools', async () => {
    const skillDir = path.join(skillsDir, 'format-compat')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---
name: format-compat
description: claude style metadata
allowed-tools:
  - Read
  - Write
  - Bash
---

# Summary
Compatibility skill.
`, 'utf-8')

    const loader = new ExternalSkillLoader({
      skillSources: [{ dir: skillsDir, sourceType: 'project-local' }]
    })
    const loaded = await loader.loadAll()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.skill.id).toBe('format-compat')
    expect(loaded[0]?.skill.tools).toEqual(['read', 'write', 'bash'])
    expect(loaded[0]?.skill.shortDescription).toBe('claude style metadata')
  })

  it('keeps community conversion skills script-only for lazy load isolation', async () => {
    const communityDir = resolveCommunitySkillDir(process.cwd())
    const loader = new ExternalSkillLoader({
      skillSources: [{ dir: communityDir, sourceType: 'community-builtin' }]
    })

    const loaded = await loader.loadAll()
    const expectedIds = ['markitdown', 'document-docx']

    for (const skillId of expectedIds) {
      const record = loaded.find(item => item.skill.id === skillId)
      expect(record, `${skillId} should be loaded`).toBeTruthy()
      expect(record?.skill.tools, `${skillId} should only bind skill-script-run`).toEqual(['skill-script-run'])
    }
  })
})
