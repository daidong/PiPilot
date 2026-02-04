/**
 * Save Note Command
 *
 * Saves content as a note or todo entity with provenance tracking.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Note, Todo, CLIContext } from '../types.js'

export interface SaveNoteResult {
  success: boolean
  note?: Note | Todo
  filePath?: string
  error?: string
}

/**
 * Save a note or todo programmatically.
 * Returns structured result instead of console.log.
 */
export function saveNote(
  title: string,
  content: string,
  tags: string[],
  context: CLIContext,
  fromLast: boolean = false,
  messageId?: string,
  pinned: boolean = false,
  type: 'note' | 'todo' = 'note'
): SaveNoteResult {
  if (!title) return { success: false, error: 'Note title is required.' }
  if (!content) return { success: false, error: 'Note content is required.' }

  const provenance: Note['provenance'] = {
    source: 'user',
    sessionId: context.sessionId,
    extractedFrom: fromLast ? 'agent-response' : 'user-input'
  }
  if (messageId) provenance.messageId = messageId

  const baseEntity = {
    id: crypto.randomUUID(),
    title,
    tags,
    pinned,
    selectedForAI: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance
  }

  // Create entity based on type
  const entity: Note | Todo = type === 'todo'
    ? { ...baseEntity, type: 'todo', content, status: 'pending' as const }
    : { ...baseEntity, type: 'note', content }

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
