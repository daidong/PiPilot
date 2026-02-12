/**
 * skill-create - Create a project-local skill directory with SKILL.md and register it.
 */

import path from 'node:path'

import { FRAMEWORK_DIR } from '../constants.js'
import { defineTool } from '../factories/define-tool.js'
import { defineSkill } from '../skills/define-skill.js'
import { renderExternalSkillMarkdown } from '../skills/skill-file.js'
import type { SkillLoadingStrategy, Skill } from '../types/skill.js'
import type { Tool } from '../types/tool.js'

export interface SkillCreateInput {
  id: string
  name: string
  shortDescription: string
  summary: string
  procedures?: string
  examples?: string
  troubleshooting?: string
  tools?: string[]
  tags?: string[]
}

export interface SkillCreateOutput {
  skillId: string
  filePath: string
  skillDir: string
  loadingStrategy: SkillLoadingStrategy
  tools: string[]
  message: string
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .map(v => typeof v === 'string' ? v.trim() : '')
    .filter(Boolean))]
}

function validateSkillId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(id)
}

function getExternalSkillsDir(runtimeProjectPath: string, configuredDir?: string): string | null {
  const targetDir = configuredDir && configuredDir.trim().length > 0
    ? configuredDir.trim()
    : `${FRAMEWORK_DIR}/skills`

  if (path.isAbsolute(targetDir)) {
    const relative = path.relative(runtimeProjectPath, targetDir)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return relative || '.'
  }

  const normalized = targetDir.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (normalized.startsWith('../')) return null
  return normalized
}

function inferToolsFromSession(runtime: { sessionState: { get: <T>(key: string) => T | undefined } }): string[] {
  const recentTools = runtime.sessionState.get<string[]>('recentSuccessfulTools')
  return normalizeStringArray(recentTools ?? [])
}

function buildSkillBody(input: SkillCreateInput): string {
  const sections: string[] = []

  sections.push('# Summary')
  sections.push(input.summary.trim())

  if (input.procedures?.trim()) {
    sections.push('## Procedures')
    sections.push(input.procedures.trim())
  }

  if (input.examples?.trim()) {
    sections.push('## Examples')
    sections.push(input.examples.trim())
  }

  if (input.troubleshooting?.trim()) {
    sections.push('## Troubleshooting')
    sections.push(input.troubleshooting.trim())
  }

  return sections.join('\n\n')
}

export const skillCreateTool: Tool<SkillCreateInput, SkillCreateOutput> = defineTool({
  name: 'skill-create',
  description: `Create a reusable project-local skill directory in ${FRAMEWORK_DIR}/skills.

Use this after discovering patterns worth reusing.
- Defaults to loadingStrategy: lazy
- Requires trigger tools (provided or inferred)
- Registers skill immediately for this runtime`,
  parameters: {
    id: { type: 'string', required: true, description: 'Unique skill ID (kebab-case)' },
    name: { type: 'string', required: true, description: 'Human-readable skill name' },
    shortDescription: { type: 'string', required: true, description: 'Short description for skill matching' },
    summary: { type: 'string', required: true, description: 'Concise overview (~100 tokens)' },
    procedures: { type: 'string', required: false, description: 'Detailed procedure guidance' },
    examples: { type: 'string', required: false, description: 'Usage examples' },
    troubleshooting: { type: 'string', required: false, description: 'Troubleshooting notes' },
    tools: { type: 'array', required: false, description: 'Trigger tools for lazy loading' },
    tags: { type: 'array', required: false, description: 'Skill tags' }
  },
  execute: async (input, { runtime, sessionId }) => {
    try {
      if (!validateSkillId(input.id)) {
        return {
          success: false,
          error: `Invalid id "${input.id}". Use kebab-case (letters, numbers, hyphens; start with letter).`
        }
      }

      if (!runtime.skillManager) {
        return {
          success: false,
          error: 'SkillManager is not available in runtime.'
        }
      }

      if (runtime.skillManager.has(input.id) || runtime.skillRegistry?.has(input.id)) {
        return {
          success: false,
          error: `Skill id already exists: ${input.id}`
        }
      }

      const inputTools = normalizeStringArray(input.tools)
      const inferredTools = inputTools.length > 0 ? inputTools : inferToolsFromSession(runtime)
      if (inferredTools.length === 0) {
        return {
          success: false,
          error: 'tools[] is required for lazy skills. Provide tools explicitly or create after using tools in this run.'
        }
      }

      const tags = normalizeStringArray(input.tags)
      const loadingStrategy: SkillLoadingStrategy = 'lazy'
      const now = new Date().toISOString()
      const configuredSkillsDir = runtime.sessionState.get<string>('externalSkillsDir')
      const skillsDir = getExternalSkillsDir(runtime.projectPath, configuredSkillsDir)
      if (!skillsDir) {
        return {
          success: false,
          error: 'Configured externalSkillsDir is outside project root.'
        }
      }

      const relativeSkillDir = path.join(skillsDir, input.id)
      const relativeFilePath = path.join(relativeSkillDir, 'SKILL.md')
      const frontmatter = {
        id: input.id,
        name: input.name,
        shortDescription: input.shortDescription,
        loadingStrategy,
        tools: inferredTools,
        ...(tags.length > 0 ? { tags } : {}),
        meta: {
          createdBy: 'agent',
          createdAt: now,
          sessionId,
          version: 1,
          approvedByUser: true
        }
      }
      const markdown = renderExternalSkillMarkdown(frontmatter, buildSkillBody(input))

      const writeResult = await runtime.io.writeFile(relativeFilePath, markdown)
      if (!writeResult.success) {
        return {
          success: false,
          error: writeResult.error ?? 'Failed to write skill file.'
        }
      }

      const skill: Skill = defineSkill({
        id: input.id,
        name: input.name,
        shortDescription: input.shortDescription,
        instructions: {
          summary: input.summary.trim(),
          ...(input.procedures?.trim() ? { procedures: input.procedures.trim() } : {}),
          ...(input.examples?.trim() ? { examples: input.examples.trim() } : {}),
          ...(input.troubleshooting?.trim() ? { troubleshooting: input.troubleshooting.trim() } : {})
        },
        tools: inferredTools,
        loadingStrategy,
        tags,
        meta: frontmatter.meta
      })

      runtime.skillManager.register(skill, {
        approvedByUser: true,
        source: 'external',
        filePath: path.join(runtime.projectPath, relativeFilePath)
      })
      runtime.skillRegistry?.register(skill)
      runtime.skillManager.recordSkillCreated(skill, {
        filePath: relativeFilePath,
        approvedByUser: true
      })

      return {
        success: true,
        data: {
          skillId: input.id,
          filePath: relativeFilePath,
          skillDir: relativeSkillDir,
          loadingStrategy,
          tools: inferredTools,
          message: `Skill "${input.name}" created and registered (lazy).`
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
