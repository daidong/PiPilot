/**
 * skill.load - On-demand skill instruction loader
 *
 * Fetches the full instructions for a registered skill by ID.
 * Skills in lazy/on-demand mode are listed in the system prompt as pointers;
 * call this source to load the full content when you need it.
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { SkillManager } from '../skills/skill-manager.js'

export interface SkillLoadParams {
  /** Skill ID (e.g., "git-workflow", "llm-compute") */
  id: string
}

export interface SkillLoadData {
  id: string
  name: string
  content: string
}

export const skillLoad: ContextSource<SkillLoadParams, SkillLoadData> = defineContextSource({
  id: 'skill.load',
  kind: 'get',
  description: 'Load full instructions for a skill. Use this when a skill pointer appears in the system prompt and you need the full procedures.',
  shortDescription: 'Load full skill instructions by ID',
  resourceTypes: ['skill'],
  params: [
    { name: 'id', type: 'string', required: true, description: 'Skill ID to load (e.g., "git-workflow")' }
  ],
  examples: [
    { description: 'Load git workflow skill', params: { id: 'git-workflow' }, resultSummary: 'Full git workflow procedures and examples' }
  ],
  costTier: 'cheap',

  fetch: async (params, runtime): Promise<ContextResult<SkillLoadData>> => {
    const startTime = Date.now()

    if (!params?.id) {
      return createErrorResult('Missing required field "id"', {
        durationMs: Date.now() - startTime,
        suggestions: ['Provide skill id: ctx-get("skill.load", { id: "git-workflow" })']
      })
    }

    const skillManager = (runtime as any).skillManager as SkillManager | undefined
    if (!skillManager) {
      return createErrorResult('SkillManager not available', {
        durationMs: Date.now() - startTime
      })
    }

    const skill = skillManager.get(params.id)
    if (!skill) {
      const available = skillManager.getAll().map(s => s.id)
      return createErrorResult(`Skill "${params.id}" not found`, {
        durationMs: Date.now() - startTime,
        suggestions: available.length > 0
          ? [`Available skills: ${available.join(', ')}`]
          : ['No skills are currently registered']
      })
    }

    // Force-load full content (works for any loading strategy)
    const content = skillManager.loadFully(params.id, { trigger: 'on-demand' })
      ?? skillManager.getContent(params.id)
      ?? `## ${skill.name}\n${skill.instructions.summary}`

    return createSuccessResult(
      { id: params.id, name: skill.name, content },
      content,
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: { complete: true },
        kindEcho: {
          source: 'skill.load',
          kind: 'get',
          paramsUsed: { id: params.id }
        }
      }
    )
  }
})
