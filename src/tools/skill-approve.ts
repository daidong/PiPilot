/**
 * skill-approve - Approve an external SKILL.md for regular loading.
 */

import path from 'node:path'

import { defineTool } from '../factories/define-tool.js'
import { parseExternalSkill, updateFrontmatter } from '../skills/skill-file.js'
import type { SkillLoadingStrategy } from '../types/skill.js'
import type { Tool } from '../types/tool.js'

export interface SkillApproveInput {
  id: string
  setLoadingStrategy?: SkillLoadingStrategy
}

export interface SkillApproveOutput {
  skillId: string
  filePath: string
  loadingStrategy: SkillLoadingStrategy
  approvedByUser: boolean
  message: string
}

function isValidLoadingStrategy(value: unknown): value is SkillLoadingStrategy {
  return value === 'eager' || value === 'lazy' || value === 'on-demand'
}

function getExternalSkillsDir(runtimeProjectPath: string, configuredDir?: string): string | null {
  const targetDir = configuredDir && configuredDir.trim().length > 0
    ? configuredDir.trim()
    : '.agentfoundry/skills'

  if (path.isAbsolute(targetDir)) {
    const relative = path.relative(runtimeProjectPath, targetDir)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return relative || '.'
  }

  const normalized = targetDir.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (normalized.startsWith('../')) return null
  return normalized
}

export const skillApproveTool: Tool<SkillApproveInput, SkillApproveOutput> = defineTool({
  name: 'skill-approve',
  description: 'Approve a skill for regular use (sets meta.approvedByUser=true).',
  parameters: {
    id: {
      type: 'string',
      required: true,
      description: 'Skill ID to approve'
    },
    setLoadingStrategy: {
      type: 'string',
      required: false,
      description: 'Optional loading strategy override: eager | lazy | on-demand'
    }
  },
  execute: async (input, { runtime }) => {
    try {
      if (!runtime.skillManager) {
        return {
          success: false,
          error: 'SkillManager is not available in runtime.'
        }
      }

      if (input.setLoadingStrategy !== undefined && !isValidLoadingStrategy(input.setLoadingStrategy)) {
        return {
          success: false,
          error: `Invalid loading strategy: ${String(input.setLoadingStrategy)}`
        }
      }

      const configuredSkillsDir = runtime.sessionState.get<string>('externalSkillsDir')
      const skillsDir = getExternalSkillsDir(runtime.projectPath, configuredSkillsDir)
      if (!skillsDir) {
        return {
          success: false,
          error: 'Configured externalSkillsDir is outside project root.'
        }
      }

      const relativeFilePath = path.join(skillsDir, `${input.id}.skill.md`)
      const readResult = await runtime.io.readFile(relativeFilePath)
      if (!readResult.success || !readResult.data) {
        return {
          success: false,
          error: readResult.error ?? `Skill file not found: ${relativeFilePath}`
        }
      }

      const parsed = parseExternalSkill(readResult.data)
      const updatedFrontmatter = {
        ...parsed.frontmatter,
        ...(input.setLoadingStrategy ? { loadingStrategy: input.setLoadingStrategy } : {}),
        meta: {
          ...(parsed.frontmatter.meta ?? {}),
          approvedByUser: true
        }
      }

      const updatedMarkdown = updateFrontmatter(readResult.data, updatedFrontmatter)
      const writeResult = await runtime.io.writeFile(relativeFilePath, updatedMarkdown)
      if (!writeResult.success) {
        return {
          success: false,
          error: writeResult.error ?? 'Failed to update skill file.'
        }
      }

      const reparsed = parseExternalSkill(updatedMarkdown)
      runtime.skillManager.register(reparsed.skill, {
        approvedByUser: true,
        source: 'external',
        filePath: path.join(runtime.projectPath, relativeFilePath)
      })
      runtime.skillRegistry?.register(reparsed.skill)
      runtime.skillManager.recordTelemetry(
        'skill.approved',
        {
          skillId: reparsed.skill.id,
          loadingStrategy: reparsed.skill.loadingStrategy,
          filePath: relativeFilePath
        },
        `approved id=${reparsed.skill.id} strategy=${reparsed.skill.loadingStrategy}`
      )

      if (reparsed.skill.loadingStrategy === 'eager') {
        runtime.skillManager.loadFully(reparsed.skill.id, { trigger: 'eager' })
      }

      return {
        success: true,
        data: {
          skillId: reparsed.skill.id,
          filePath: relativeFilePath,
          loadingStrategy: reparsed.skill.loadingStrategy,
          approvedByUser: true,
          message: `Skill "${reparsed.skill.name}" approved.`
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
