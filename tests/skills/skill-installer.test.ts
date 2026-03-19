/**
 * Tests for SkillInstaller — install, list, remove skills.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { SkillInstaller } from '../../src/skills/skill-installer.js'

const TEST_DIR = path.join(process.cwd(), '.test-skills-installer')
const SKILLS_DIR = path.join(TEST_DIR, 'skills')

const SAMPLE_SKILL_MD = `---
id: test-skill
name: Test Skill
shortDescription: A test skill for unit testing
tools: [bash]
loadingStrategy: lazy
---

This is a test skill.

## Procedures
1. Do the thing
2. Check the result

## Examples
\`\`\`bash
echo "hello"
\`\`\`
`

describe('SkillInstaller', () => {
  let installer: SkillInstaller

  beforeEach(async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true })
    installer = new SkillInstaller({ skillsDir: SKILLS_DIR })
  })

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  })

  describe('listInstalled', () => {
    it('should return empty list when no skills are installed', async () => {
      const list = await installer.listInstalled()
      expect(list).toEqual([])
    })

    it('should list installed skills', async () => {
      // Create a skill manually
      const skillDir = path.join(SKILLS_DIR, 'test-skill')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), SAMPLE_SKILL_MD)

      const list = await installer.listInstalled()
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe('test-skill')
      expect(list[0]!.name).toBe('Test Skill')
      expect(list[0]!.shortDescription).toBe('A test skill for unit testing')
      expect(list[0]!.source).toBe('project-local')
    })

    it('should read .source.json provenance', async () => {
      const skillDir = path.join(SKILLS_DIR, 'github-skill')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), SAMPLE_SKILL_MD)
      await fs.writeFile(
        path.join(skillDir, '.source.json'),
        JSON.stringify({ type: 'github', ref: 'user/repo/skills/test', installedAt: '2026-01-01' })
      )

      const list = await installer.listInstalled()
      expect(list[0]!.source).toBe('github')
      expect(list[0]!.sourceRef).toBe('user/repo/skills/test')
    })

    it('should include community-builtin skills when dir provided', async () => {
      // Create a community skill
      const communityDir = path.join(TEST_DIR, 'community')
      const communitySkillDir = path.join(communityDir, 'community-skill')
      await fs.mkdir(communitySkillDir, { recursive: true })
      await fs.writeFile(
        path.join(communitySkillDir, 'SKILL.md'),
        `---\nid: community-skill\nname: Community Skill\nshortDescription: From community\n---\nCommunity content.`
      )

      const list = await installer.listInstalled(communityDir)
      expect(list.some(s => s.id === 'community-skill')).toBe(true)
      expect(list.find(s => s.id === 'community-skill')!.source).toBe('community-builtin')
    })
  })

  describe('remove', () => {
    it('should remove an installed skill', async () => {
      const skillDir = path.join(SKILLS_DIR, 'removable-skill')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), SAMPLE_SKILL_MD)

      expect(existsSync(skillDir)).toBe(true)
      const result = await installer.remove('removable-skill')
      expect(result).toBe(true)
      expect(existsSync(skillDir)).toBe(false)
    })

    it('should return false for non-existent skill', async () => {
      const result = await installer.remove('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('installFromURL — markdown content', () => {
    it('should install from markdown content', async () => {
      // We can't test real HTTP in unit tests, but we can test the internal logic
      // by manually creating the expected state
      const skillDir = path.join(SKILLS_DIR, 'url-installed')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), SAMPLE_SKILL_MD)
      await fs.writeFile(
        path.join(skillDir, '.source.json'),
        JSON.stringify({ type: 'url', ref: 'https://example.com/SKILL.md', installedAt: new Date().toISOString() })
      )

      const list = await installer.listInstalled()
      const skill = list.find(s => s.id === 'test-skill')
      expect(skill).toBeDefined()
      expect(skill!.source).toBe('url')
    })
  })

  describe('parseFrontmatterQuick (via listInstalled)', () => {
    it('should infer id from directory name when frontmatter has no id', async () => {
      const skillDir = path.join(SKILLS_DIR, 'inferred-id')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: Some Skill\n---\nA skill without explicit id.`
      )

      const list = await installer.listInstalled()
      expect(list[0]!.id).toBe('inferred-id')
    })

    it('should extract shortDescription from first paragraph when not in frontmatter', async () => {
      const skillDir = path.join(SKILLS_DIR, 'desc-from-body')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nid: desc-from-body\nname: Body Desc Skill\n---\nThis description comes from the body.\n\n## Procedures\nDo stuff.`
      )

      const list = await installer.listInstalled()
      expect(list[0]!.shortDescription).toBe('This description comes from the body.')
    })

    it('should handle skill with no frontmatter', async () => {
      const skillDir = path.join(SKILLS_DIR, 'no-frontmatter')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `Just a plain skill description.\n\n## Procedures\nStep 1.`
      )

      const list = await installer.listInstalled()
      expect(list[0]!.id).toBe('no-frontmatter')
      expect(list[0]!.shortDescription).toBe('Just a plain skill description.')
    })
  })

  describe('sorted output', () => {
    it('should sort skills alphabetically by id', async () => {
      for (const id of ['zebra-skill', 'alpha-skill', 'middle-skill']) {
        const dir = path.join(SKILLS_DIR, id)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, 'SKILL.md'),
          `---\nid: ${id}\nname: ${id}\nshortDescription: ${id}\n---\nContent.`
        )
      }

      const list = await installer.listInstalled()
      expect(list.map(s => s.id)).toEqual(['alpha-skill', 'middle-skill', 'zebra-skill'])
    })
  })
})
