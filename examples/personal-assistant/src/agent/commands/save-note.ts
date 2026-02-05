/**
 * Save Note Command
 *
 * Saves content as a note or todo entity with provenance tracking.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Note, Todo, CLIContext } from '../types.js'
import { applyProjectCardPolicy } from '../../../../../src/core/project-card-policy.js'

export interface SaveNoteResult {
  success: boolean
  note?: Note | Todo
  filePath?: string
  error?: string
}

/**
 * Generate a simple summary card for an entity (deterministic)
 */
function generateSimpleSummaryCard(title: string, content: string, type: 'note' | 'todo'): string {
  const typeLabel = type === 'todo' ? 'Todo' : 'Note'
  const preview = content.length > 200 ? content.slice(0, 200) + '...' : content
  return `**${typeLabel}: ${title}**\n${preview}`
}

/**
 * Save a note or todo programmatically (RFC-009 compatible).
 * Returns structured result instead of console.log.
 *
 * @param title - Note/todo title
 * @param content - Note/todo content
 * @param tags - Tags for categorization
 * @param context - CLI context with session info
 * @param fromLast - Whether content was extracted from last agent response
 * @param messageId - Optional message ID for provenance
 * @param projectCardOverride - Manual override for Project Card status
 * @param type - Entity type ('note' or 'todo')
 */
export function saveNote(
  title: string,
  content: string,
  tags: string[],
  context: CLIContext,
  fromLast: boolean = false,
  messageId?: string,
  projectCardOverride?: boolean,
  type: 'note' | 'todo' = 'note'
): SaveNoteResult {
  if (!title) return { success: false, error: 'Note title is required.' }
  if (!content) return { success: false, error: 'Note content is required.' }

  const provenance: Note['provenance'] = {
    source: fromLast ? 'agent' : 'user',
    sessionId: context.sessionId,
    extractedFrom: fromLast ? 'agent-response' : 'user-input'
  }
  if (messageId) provenance.messageId = messageId

  // Generate simple summary card (deterministic for short content)
  const summaryCard = generateSimpleSummaryCard(title, content, type)

  const baseEntity = {
    id: crypto.randomUUID(),
    title,
    tags,
    projectCard: false,
    summaryCard,
    summaryCardMethod: 'deterministic' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance
  }

  // Create entity based on type
  const entity: Note | Todo = type === 'todo'
    ? { ...baseEntity, type: 'todo', content, status: 'pending' as const }
    : { ...baseEntity, type: 'note', content }

  if (typeof projectCardOverride === 'boolean') {
    entity.projectCard = projectCardOverride
    entity.projectCardSource = 'manual'
  } else {
    applyProjectCardPolicy([entity])
  }

  // Use projectPath if provided, otherwise fall back to relative path
  const dirPath = type === 'todo' ? PATHS.todos : PATHS.notes
  const entityPath = context.projectPath
    ? join(context.projectPath, dirPath)
    : dirPath

  mkdirSync(entityPath, { recursive: true })
  const filePath = join(entityPath, `${entity.id}.json`)
  writeFileSync(filePath, JSON.stringify(entity, null, 2))

  return { success: true, note: entity, filePath }
}
