/**
 * SKILL.md file parsing and serialization helpers.
 */

import YAML from 'yaml'
import { defineSkill } from './define-skill.js'
import type { Skill, SkillLoadingStrategy } from '../types/skill.js'

export interface ExternalSkillFrontmatter {
  id: string
  name: string
  shortDescription: string
  loadingStrategy?: SkillLoadingStrategy
  tools?: string[]
  tags?: string[]
  meta?: {
    approvedByUser?: boolean
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ParsedExternalSkill {
  skill: Skill
  frontmatter: ExternalSkillFrontmatter
  body: string
  approvedByUser: boolean
}

interface FrontmatterSplit {
  frontmatterRaw: string
  body: string
}

interface HeadingBlock {
  heading: string
  content: string
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
  return values.length > 0 ? values : undefined
}

function parseLoadingStrategy(value: unknown): SkillLoadingStrategy | undefined {
  if (value !== 'eager' && value !== 'lazy' && value !== 'on-demand') return undefined
  return value
}

function normalizeHeadingForMatch(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function classifyHeading(heading: string): 'summary' | 'procedures' | 'examples' | 'troubleshooting' | undefined {
  const normalized = normalizeHeadingForMatch(heading)
  if (!normalized) return undefined

  const words = normalized.split(' ').filter(Boolean)
  const isShortHeading = words.length <= 3

  if (normalized === 'summary' || normalized === 'overview' || normalized === 'tldr') return 'summary'
  if (normalized === 'procedures' || normalized === 'procedure' || normalized === 'workflow') return 'procedures'
  if (normalized === 'examples' || normalized === 'example' || normalized === 'usage') return 'examples'
  if (normalized === 'troubleshooting' || normalized === 'faq') return 'troubleshooting'

  if (!isShortHeading) return undefined
  return undefined
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') {
    throw new Error('SKILL.md must start with YAML frontmatter (---).')
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex < 0) {
    throw new Error('SKILL.md frontmatter is missing closing "---".')
  }

  const frontmatterRaw = lines.slice(1, endIndex).join('\n')
  const body = lines.slice(endIndex + 1).join('\n').trim()

  return { frontmatterRaw, body }
}

function splitHeadingBlocks(body: string): { preamble: string; blocks: HeadingBlock[] } {
  const lines = body.split('\n')
  const headingRegex = /^#{1,6}\s+(.+?)\s*$/

  const preambleLines: string[] = []
  const blocks: HeadingBlock[] = []

  let currentHeading: string | null = null
  let currentLines: string[] = []

  for (const rawLine of lines) {
    const line = rawLine ?? ''
    const match = line.match(headingRegex)

    if (match) {
      if (currentHeading !== null) {
        blocks.push({
          heading: currentHeading,
          content: currentLines.join('\n').trim()
        })
      } else {
        preambleLines.push(...currentLines)
      }

      currentHeading = (match[1] ?? '').trim()
      currentLines = []
      continue
    }

    currentLines.push(line)
  }

  if (currentHeading !== null) {
    blocks.push({
      heading: currentHeading,
      content: currentLines.join('\n').trim()
    })
  } else {
    preambleLines.push(...currentLines)
  }

  return {
    preamble: preambleLines.join('\n').trim(),
    blocks
  }
}

function firstNonEmptyParagraph(body: string): string {
  const lines = body.split('\n')
  const paragraph: string[] = []

  for (const rawLine of lines) {
    const line = rawLine ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      if (paragraph.length > 0) break
      continue
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed)
  }

  return paragraph.join(' ').trim()
}

function parseFrontmatterObject(frontmatterRaw: string): ExternalSkillFrontmatter {
  const parsed = YAML.parse(frontmatterRaw) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid SKILL.md frontmatter.')
  }

  const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  const shortDescription = typeof parsed.shortDescription === 'string'
    ? parsed.shortDescription.trim()
    : ''

  if (!id || !name || !shortDescription) {
    throw new Error('SKILL.md frontmatter requires id, name, shortDescription.')
  }

  const loadingStrategy = parseLoadingStrategy(parsed.loadingStrategy)
  const tools = parseStringArray(parsed.tools)
  const tags = parseStringArray(parsed.tags)
  const metaRaw = parsed.meta
  const meta = (metaRaw && typeof metaRaw === 'object')
    ? { ...(metaRaw as Record<string, unknown>) }
    : undefined

  return {
    ...parsed,
    id,
    name,
    shortDescription,
    ...(loadingStrategy ? { loadingStrategy } : {}),
    ...(tools ? { tools } : {}),
    ...(tags ? { tags } : {}),
    ...(meta ? { meta } : {})
  }
}

export function parseExternalSkill(content: string): ParsedExternalSkill {
  const { frontmatterRaw, body } = splitFrontmatter(content)
  const frontmatter = parseFrontmatterObject(frontmatterRaw)
  const { preamble, blocks } = splitHeadingBlocks(body)

  const summaryChunks: string[] = []
  const proceduresChunks: string[] = []
  const examplesChunks: string[] = []
  const troubleshootingChunks: string[] = []
  const unknownChunks: string[] = []

  if (preamble) {
    summaryChunks.push(preamble)
  }

  for (const block of blocks) {
    const sectionType = classifyHeading(block.heading)
    const contentText = block.content.trim()
    if (!contentText) continue

    switch (sectionType) {
      case 'summary':
        summaryChunks.push(contentText)
        break
      case 'procedures':
        proceduresChunks.push(contentText)
        break
      case 'examples':
        examplesChunks.push(contentText)
        break
      case 'troubleshooting':
        troubleshootingChunks.push(contentText)
        break
      default:
        unknownChunks.push(`## ${block.heading}\n${contentText}`)
        break
    }
  }

  let summary = summaryChunks.join('\n\n').trim()
  if (!summary) {
    summary = firstNonEmptyParagraph(body)
  }
  if (!summary) {
    throw new Error('SKILL.md requires a summary section or a non-empty first paragraph.')
  }

  const proceduresParts = [...proceduresChunks, ...unknownChunks]
  const procedures = proceduresParts.length > 0 ? proceduresParts.join('\n\n').trim() : undefined
  const examples = examplesChunks.length > 0 ? examplesChunks.join('\n\n').trim() : undefined
  const troubleshooting = troubleshootingChunks.length > 0 ? troubleshootingChunks.join('\n\n').trim() : undefined

  const approvedByUser = frontmatter.meta?.approvedByUser === true

  const skill = defineSkill({
    id: frontmatter.id,
    name: frontmatter.name,
    shortDescription: frontmatter.shortDescription,
    instructions: {
      summary,
      procedures,
      examples,
      troubleshooting
    },
    tools: frontmatter.tools ?? [],
    loadingStrategy: frontmatter.loadingStrategy ?? 'lazy',
    tags: frontmatter.tags ?? [],
    meta: frontmatter.meta
  })

  return {
    skill,
    frontmatter,
    body,
    approvedByUser
  }
}

export function renderExternalSkillMarkdown(
  frontmatter: ExternalSkillFrontmatter,
  body: string
): string {
  const yamlContent = YAML.stringify(frontmatter).trimEnd()
  const bodyContent = body.trim()
  return `---\n${yamlContent}\n---\n\n${bodyContent}\n`
}

export function updateFrontmatter(content: string, frontmatter: ExternalSkillFrontmatter): string {
  const { body } = splitFrontmatter(content)
  return renderExternalSkillMarkdown(frontmatter, body)
}
