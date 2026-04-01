/**
 * Auto-Memory Tools — save-memory and delete-memory.
 *
 * These replace the old `update-memory` tool with a structured approach:
 * each memory is a standalone file, agent.md becomes an index.
 */

import type { ResearchTool } from '../tools/entity-tools.js'
import { toolError } from '../tools/tool-utils.js'
import {
  type MemoryType,
  memoryFilename,
  ensureMemoryDir,
  writeMemoryFile,
  deleteMemoryFile,
  listMemoryFiles,
  findMemoryByName,
  updateAgentMdIndex,
  type MemoryEntry
} from './memory-utils.js'

const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

export function createSaveMemoryTool(projectPath: string): ResearchTool {
  return {
    name: 'save-memory',
    description:
      'Save a memory to long-term storage. Each memory becomes a file in .research-pilot/memory/ ' +
      'and an index entry in agent.md (visible every turn). ' +
      'Types: "user" (preferences/background), "feedback" (corrections to behavior), ' +
      '"project" (decisions/deadlines/context), "reference" (external pointers/reusable info). ' +
      'If a memory with the same name+type exists, it is updated.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: VALID_TYPES,
          description: 'Memory category'
        },
        name: {
          type: 'string',
          description: 'Short identifier (used as title and filename slug)'
        },
        content: {
          type: 'string',
          description: 'The memory content (markdown). Keep it concise and focused.'
        }
      },
      required: ['type', 'name', 'content']
    },
    execute: async (input) => {
      const type = String(input.type || '') as MemoryType
      const name = String(input.name || '').trim()
      const content = String(input.content || '').trim()

      if (!VALID_TYPES.includes(type)) {
        return toolError('INVALID_PARAMETER', `Invalid memory type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`, {
          suggestions: ['Use "user", "feedback", "project", or "reference".']
        })
      }
      if (!name) return toolError('MISSING_PARAMETER', 'name is required.', {
        suggestions: ['Provide a short descriptive name for this memory.']
      })
      if (!content) return toolError('MISSING_PARAMETER', 'content is required.', {
        suggestions: ['Provide the memory content to save.']
      })

      ensureMemoryDir(projectPath)

      const filename = memoryFilename(type, name)
      const description = content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 120)

      const entry: MemoryEntry = {
        frontmatter: { name, description, type },
        content,
        filename
      }

      writeMemoryFile(projectPath, entry)

      const allEntries = listMemoryFiles(projectPath)
      const indexResult = updateAgentMdIndex(projectPath, allEntries)

      if (!indexResult.success) {
        return toolError('OUTPUT_TOO_LARGE',
          'agent.md index exceeded size limit. Remove some memories first.', {
          suggestions: ['Use delete-memory to remove outdated entries before saving new ones.']
        })
      }

      return {
        success: true,
        data: {
          message: `Memory saved: ${name} (${type})`,
          filename,
          totalMemories: allEntries.length,
          agentMdChars: indexResult.charCount
        }
      }
    }
  }
}

export function createDeleteMemoryTool(projectPath: string): ResearchTool {
  return {
    name: 'delete-memory',
    description: 'Delete a memory by name. Removes the file and its index entry in agent.md.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the memory to delete (case-insensitive match)'
        }
      },
      required: ['name']
    },
    execute: async (input) => {
      const name = String(input.name || '').trim()
      if (!name) return toolError('MISSING_PARAMETER', 'name is required.', {
        suggestions: ['Provide the name of the memory to delete.']
      })

      const existing = findMemoryByName(projectPath, name)
      if (!existing) {
        return toolError('NOT_FOUND', `Memory not found: "${name}"`, {
          suggestions: ['Check the memory name — it is case-insensitive. Current memories are listed in agent.md.']
        })
      }

      deleteMemoryFile(projectPath, existing.filename)

      const allEntries = listMemoryFiles(projectPath)
      updateAgentMdIndex(projectPath, allEntries)

      return {
        success: true,
        data: {
          message: `Memory deleted: ${name}`,
          totalMemories: allEntries.length
        }
      }
    }
  }
}

export function createMemoryTools(projectPath: string): ResearchTool[] {
  return [
    createSaveMemoryTool(projectPath),
    createDeleteMemoryTool(projectPath)
  ]
}
