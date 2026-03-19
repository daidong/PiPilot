/**
 * SKILL.md file parsing and serialization helpers.
 */

import path from 'node:path'
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

export interface ParseExternalSkillOptions {
  filePath?: string
  defaultId?: string
  defaultName?: string
  defaultShortDescription?: string
  defaultLoadingStrategy?: SkillLoadingStrategy
  defaultTools?: string[]
  defaultTags?: string[]
  defaultMeta?: Record<string, unknown>
  defaultApprovedByUser?: boolean
}

interface FrontmatterSplit {
  frontmatterRaw?: string
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

function normalizeToolName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-')
  const aliasMap: Record<string, string> = {
    read: 'read',
    write: 'write',
    edit: 'edit',
    bash: 'bash',
    'skill-script-run': 'skill-script-run',
    'skill-create': 'skill-create',
    'skill-approve': 'skill-approve'
  }
  return aliasMap[normalized] ?? normalized
}

function parseToolArray(value: unknown): string[] | undefined {
  const values = parseStringArray(value)
  if (!values) return undefined
  const normalized = [...new Set(values.map(normalizeToolName).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
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

function toKebabCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function toTitleCaseFromId(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeSkillId(value: string): string {
  let normalized = toKebabCase(value)
  if (!normalized) normalized = 'skill'
  if (!/^[a-z]/.test(normalized)) {
    normalized = `skill-${normalized}`
  }
  return normalized
}

function inferDefaultId(options: ParseExternalSkillOptions): string | undefined {
  if (options.defaultId?.trim()) {
    return normalizeSkillId(options.defaultId)
  }

  const filePath = options.filePath?.trim()
  if (!filePath) return undefined

  const fileName = path.basename(filePath).toLowerCase()
  if (fileName === 'skill.md') {
    return normalizeSkillId(path.basename(path.dirname(filePath)))
  }

  const withoutSkillExt = path.basename(filePath).replace(/\.skill\.md$/i, '')
  const withoutMd = withoutSkillExt.replace(/\.md$/i, '')
  return normalizeSkillId(withoutMd)
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  if (lines[0]?.trim() !== '---') {
    return { body: normalized.trim() }
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
  // Only split at ## (level 2) headings — sub-headings (###, ####, etc.)
  // remain as content within their parent block
  const headingRegex = /^##\s+(.+?)\s*$/

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

function parseFrontmatterObject(
  frontmatterRaw: string | undefined,
  body: string,
  options: ParseExternalSkillOptions
): ExternalSkillFrontmatter {
  const parsed = frontmatterRaw
    ? (YAML.parse(frontmatterRaw) as Record<string, unknown> | null)
    : {}

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid SKILL.md frontmatter.')
  }

  const inferredId = inferDefaultId(options)
  const id = normalizeSkillId(
    typeof parsed.id === 'string' && parsed.id.trim().length > 0
      ? parsed.id
      : (inferredId ?? 'skill')
  )
  const name = (
    typeof parsed.name === 'string' && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : (options.defaultName?.trim() || toTitleCaseFromId(id))
  )

  const paragraph = firstNonEmptyParagraph(body)
  const descriptionFallback = typeof parsed.description === 'string' ? parsed.description.trim() : ''
  const shortDescription = (
    typeof parsed.shortDescription === 'string' && parsed.shortDescription.trim().length > 0
      ? parsed.shortDescription.trim()
      : (descriptionFallback || options.defaultShortDescription?.trim() || paragraph || `Skill instructions for ${name}`)
  )

  const loadingStrategy = parseLoadingStrategy(parsed.loadingStrategy)
    ?? options.defaultLoadingStrategy
  const allowedTools = parseToolArray((parsed as Record<string, unknown>)['allowed-tools'])
    ?? parseToolArray((parsed as Record<string, unknown>).allowedTools)
  const tools = parseToolArray(parsed.tools)
    ?? allowedTools
    ?? parseToolArray(options.defaultTools)
  const tags = parseStringArray(parsed.tags)
    ?? parseStringArray(options.defaultTags)

  const metaRaw = parsed.meta
  const parsedMeta = (metaRaw && typeof metaRaw === 'object')
    ? { ...(metaRaw as Record<string, unknown>) }
    : {}
  const defaultMeta = options.defaultMeta ?? {}
  const mergedMeta: Record<string, unknown> = {
    ...defaultMeta,
    ...parsedMeta
  }

  if (
    options.defaultApprovedByUser !== undefined &&
    mergedMeta.approvedByUser === undefined
  ) {
    mergedMeta.approvedByUser = options.defaultApprovedByUser
  }

  return {
    ...parsed,
    id,
    name,
    shortDescription,
    ...(loadingStrategy ? { loadingStrategy } : {}),
    ...(tools ? { tools } : {}),
    ...(tags ? { tags } : {}),
    ...(Object.keys(mergedMeta).length > 0 ? { meta: mergedMeta } : {})
  }
}

export function parseExternalSkill(
  content: string,
  options: ParseExternalSkillOptions = {}
): ParsedExternalSkill {
  const { frontmatterRaw, body } = splitFrontmatter(content)
  const frontmatter = parseFrontmatterObject(frontmatterRaw, body, options)
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
    summary = frontmatter.shortDescription
  }
  if (!summary) {
    throw new Error('SKILL.md requires a summary section or non-empty content.')
  }

  const proceduresParts = [...proceduresChunks, ...unknownChunks]
  const procedures = proceduresParts.length > 0 ? proceduresParts.join('\n\n').trim() : undefined
  const examples = examplesChunks.length > 0 ? examplesChunks.join('\n\n').trim() : undefined
  const troubleshooting = troubleshootingChunks.length > 0 ? troubleshootingChunks.join('\n\n').trim() : undefined

  const approvedByUser = frontmatter.meta?.approvedByUser !== false

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
