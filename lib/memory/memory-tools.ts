/**
 * Auto-Memory Tools — save-memory and delete-memory.
 *
 * Native pi-mono AgentTool implementations. Each memory is a standalone
 * file under .research-pilot/memory/, with agent.md serving as the index.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from '../tools/tool-utils.js'
import { createMemoryLedgerWriter } from '../ledger/memory-ledger.js'
import {
  type MemoryType,
  memoryFilename,
  ensureMemoryDir,
  writeMemoryFile,
  deleteMemoryFile,
  listMemoryFiles,
  findMemoryByName,
  findAllMemoriesByName,
  updateAgentMdIndex,
  withIndexLock,
  type MemoryEntry
} from './memory-utils.js'

const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

/** Best-effort ledger append. Failures swallowed — ledger never blocks the tool path. */
function appendMemoryLedger(
  projectPath: string,
  op: 'create' | 'update' | 'delete',
  type: MemoryType,
  filename: string,
  turnId: string | undefined
): void {
  try {
    const writer = createMemoryLedgerWriter(projectPath)
    void writer.append({
      memoryId: filename,
      op,
      scope: 'project',
      type,
      provenance: { source: 'tool-output' },
      turnId
    })
  } catch {
    // ignore
  }
}

export function createSaveMemoryTool(projectPath: string, getTurnId?: () => string | undefined): AgentTool {
  return {
    name: 'save-memory',
    label: 'Save memory',
    description:
      'Save a memory to long-term storage. Each memory becomes a file in .research-pilot/memory/ ' +
      'and an index entry in agent.md (visible every turn). ' +
      'Types: "user" (preferences/background), "feedback" (corrections to behavior), ' +
      '"project" (decisions/deadlines/context), "reference" (external pointers/reusable info). ' +
      'If a memory with the same name+type exists, it is updated.',
    parameters: Type.Object({
      type: Type.Union(VALID_TYPES.map(t => Type.Literal(t)), { description: 'Memory category' }),
      name: Type.String({ description: 'Short identifier (used as title and filename slug)' }),
      content: Type.String({ description: 'The memory content (markdown). Keep it concise and focused.' })
    }),
    execute: async (_toolCallId, rawParams) => {
      const input = rawParams as Record<string, unknown>
      const type = String(input.type || '') as MemoryType
      const name = String(input.name || '').trim()
      const content = String(input.content || '').trim()

      if (!VALID_TYPES.includes(type)) {
        return toAgentResult('save-memory', toolError(
          'INVALID_PARAMETER',
          `Invalid memory type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`,
          { suggestions: ['Use "user", "feedback", "project", or "reference".'] }
        ))
      }
      if (!name) {
        return toAgentResult('save-memory', toolError('MISSING_PARAMETER', 'name is required.', {
          suggestions: ['Provide a short descriptive name for this memory.']
        }))
      }
      if (!content) {
        return toAgentResult('save-memory', toolError('MISSING_PARAMETER', 'content is required.', {
          suggestions: ['Provide the memory content to save.']
        }))
      }

      // Robust description — skip empty lines to find a meaningful first line
      const lines = content.split('\n')
      const firstNonEmpty = lines.find(l => l.trim().length > 0) || ''
      const description = firstNonEmpty.replace(/^#+\s*/, '').trim().slice(0, 120) || name

      return withIndexLock(() => {
        ensureMemoryDir(projectPath)

        const filename = memoryFilename(type, name)
        // Detect whether this is a new memory or an overwrite for ledger op.
        const existed = !!findMemoryByName(projectPath, name, type)
        const entry: MemoryEntry = {
          frontmatter: { name, description, type },
          content,
          filename
        }

        writeMemoryFile(projectPath, entry)

        const allEntries = listMemoryFiles(projectPath)
        const indexResult = updateAgentMdIndex(projectPath, allEntries)

        if (!indexResult.success) {
          // Rollback the memory file if index update fails
          deleteMemoryFile(projectPath, filename)
          return toAgentResult('save-memory', toolError(
            'OUTPUT_TOO_LARGE',
            'agent.md index exceeded size limit. Remove some memories first.',
            { suggestions: ['Use delete-memory to remove outdated entries before saving new ones.'] }
          ))
        }

        // Telemetry §8.2: ledger row for create/update.
        appendMemoryLedger(projectPath, existed ? 'update' : 'create', type, filename, getTurnId?.())

        return toAgentResult('save-memory', {
          success: true,
          data: {
            message: `Memory saved: ${name} (${type})`,
            filename,
            totalMemories: allEntries.length,
            agentMdChars: indexResult.charCount
          }
        })
      })
    }
  }
}

export function createDeleteMemoryTool(projectPath: string, getTurnId?: () => string | undefined): AgentTool {
  return {
    name: 'delete-memory',
    label: 'Delete memory',
    description: 'Delete a memory by name. Removes the file and its index entry in agent.md. ' +
      'If multiple memories share the same name (different types), specify type to disambiguate.',
    parameters: Type.Object({
      name: Type.String({ description: 'Name of the memory to delete (case-insensitive match)' }),
      type: Type.Optional(Type.Union(VALID_TYPES.map(t => Type.Literal(t)), {
        description: 'Optional: memory type to disambiguate when multiple memories share the same name'
      }))
    }),
    execute: async (_toolCallId, rawParams) => {
      const input = rawParams as Record<string, unknown>
      const name = String(input.name || '').trim()
      const type = input.type ? String(input.type) as MemoryType : undefined
      if (!name) {
        return toAgentResult('delete-memory', toolError('MISSING_PARAMETER', 'name is required.', {
          suggestions: ['Provide the name of the memory to delete.']
        }))
      }

      // Check for ambiguity when multiple memories share the same name
      const allMatches = findAllMemoriesByName(projectPath, name)
      if (allMatches.length === 0) {
        return toAgentResult('delete-memory', toolError('NOT_FOUND', `Memory not found: "${name}"`, {
          suggestions: ['Check the memory name — it is case-insensitive. Current memories are listed in agent.md.']
        }))
      }

      if (allMatches.length > 1 && !type) {
        const types = allMatches.map(m => m.frontmatter.type).join(', ')
        return toAgentResult('delete-memory', toolError(
          'AMBIGUOUS',
          `Multiple memories named "${name}" (types: ${types}). Specify type to disambiguate.`,
          { suggestions: [`Add type parameter: one of ${types}`] }
        ))
      }

      const existing = type
        ? findMemoryByName(projectPath, name, type)
        : allMatches[0]
      if (!existing) {
        return toAgentResult('delete-memory', toolError(
          'NOT_FOUND',
          `Memory not found: "${name}" with type "${type}"`,
          { suggestions: ['Check the memory name and type.'] }
        ))
      }

      return withIndexLock(() => {
        deleteMemoryFile(projectPath, existing.filename)

        const allEntries = listMemoryFiles(projectPath)
        updateAgentMdIndex(projectPath, allEntries)

        // Telemetry §8.2: ledger row for delete.
        appendMemoryLedger(
          projectPath,
          'delete',
          existing.frontmatter.type,
          existing.filename,
          getTurnId?.()
        )

        return toAgentResult('delete-memory', {
          success: true,
          data: {
            message: `Memory deleted: ${name}`,
            totalMemories: allEntries.length
          }
        })
      })
    }
  }
}

export function createMemoryTools(projectPath: string, getTurnId?: () => string | undefined): AgentTool[] {
  return [
    createSaveMemoryTool(projectPath, getTurnId),
    createDeleteMemoryTool(projectPath, getTurnId)
  ]
}
