/**
 * Skill Tools — `load_skill` tool for on-demand skill loading.
 *
 * The agent calls load_skill(name) to get full SKILL.md instructions
 * injected into its context. Skills are discovered at startup and listed
 * in the system prompt catalog; this tool loads the detailed procedures.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { getSkillByName, buildSkillContext, type SkillEntry } from '../skills/loader.js'
import { toAgentResult } from './tool-utils.js'

function buildMissingSkillError(name: string, skills: SkillEntry[]): string {
  const needle = name.trim().toLowerCase()
  const suggestions = skills
    .map((e) => e.name)
    .filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
    .slice(0, 5)
  if (suggestions.length === 0) {
    return `Skill not found: "${name}". Available skills: ${skills.map((s) => s.name).join(', ')}`
  }
  return `Skill not found: "${name}". Did you mean: ${suggestions.join(', ')}?`
}

export function createLoadSkillTool(skills: SkillEntry[]): AgentTool {
  return {
    name: 'load_skill',
    label: 'Load Skill',
    description: 'Load and activate the full instructions for a named skill from the skills catalog. Use this before relying on a skill for structured output, specific methodology, or specialized workflows.',
    parameters: Type.Object({
      name: Type.String({ description: 'The skill name from the skills catalog' })
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { name: string }
      const entry = getSkillByName(skills, params.name)
      if (!entry) {
        return toAgentResult('load_skill', {
          success: false,
          error: buildMissingSkillError(params.name, skills)
        })
      }
      const context = buildSkillContext(entry)
      return toAgentResult('load_skill', {
        success: true,
        data: context
      })
    }
  }
}
