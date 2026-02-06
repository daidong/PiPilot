/**
 * Legacy save-note wrapper.
 * Canonical persistence API is artifact.create(type=note|todo).
 */

import { type CLIContext, type Note, type Todo } from '../types.js'
import { artifactCreate } from './artifact.js'

export interface SaveNoteResult {
  success: boolean
  note?: Note | Todo
  filePath?: string
  error?: string
}

export function saveNote(
  title: string,
  content: string,
  tags: string[],
  context: CLIContext,
  fromLast: boolean = false,
  messageId?: string,
  _projectCardOverride?: boolean,
  type: 'note' | 'todo' = 'note'
): SaveNoteResult {
  if (!title) return { success: false, error: 'Note title is required.' }
  if (!content) return { success: false, error: 'Note content is required.' }

  const created = artifactCreate({
    type,
    title,
    content,
    tags,
    summary: content.length > 220 ? `${content.slice(0, 220)}...` : content,
    provenance: {
      source: fromLast ? 'agent' : 'user',
      extractedFrom: fromLast ? 'agent-response' : 'user-input',
      messageId
    }
  }, context)

  if (!created.success || !created.artifact) {
    return {
      success: false,
      error: created.error ?? 'Failed to save note.'
    }
  }

  if (created.artifact.type !== 'note' && created.artifact.type !== 'todo') {
    return { success: false, error: 'Unexpected artifact type after save-note.' }
  }

  return {
    success: true,
    note: created.artifact,
    filePath: created.filePath
  }
}
