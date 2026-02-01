/**
 * Save Note Command
 *
 * Saves content as a note entity with provenance tracking.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Note, CLIContext } from '../types.js'

export interface SaveNoteResult {
  success: boolean
  note?: Note
  filePath?: string
  error?: string
}

/**
 * Save a note programmatically.
 * Returns structured result instead of console.log.
 */
export function saveNote(
  title: string,
  content: string,
  tags: string[],
  context: CLIContext,
  fromLast: boolean = false,
  messageId?: string,
  pinned: boolean = false
): SaveNoteResult {
  if (!title) return { success: false, error: 'Note title is required.' }
  if (!content) return { success: false, error: 'Note content is required.' }

  const provenance: Note['provenance'] = {
    source: 'user',
    sessionId: context.sessionId,
    extractedFrom: fromLast ? 'agent-response' : 'user-input'
  }
  if (messageId) provenance.messageId = messageId

  const note: Note = {
    id: crypto.randomUUID(),
    type: 'note',
    title,
    content,
    tags,
    pinned,
    selectedForAI: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance
  }

  // Use projectPath if provided, otherwise fall back to relative path
  const notesPath = context.projectPath
    ? join(context.projectPath, PATHS.notes)
    : PATHS.notes

  mkdirSync(notesPath, { recursive: true })
  const filePath = join(notesPath, `${note.id}.json`)
  writeFileSync(filePath, JSON.stringify(note, null, 2))

  return { success: true, note, filePath }
}
