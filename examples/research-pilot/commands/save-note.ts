/**
 * Legacy compatibility wrapper for note creation.
 * RFC-012 canonical API is artifact.create(type=note).
 */

import { type CLIContext, type Note } from '../types.js'
import { createArtifact } from '../memory-v2/store.js'

export interface SaveNoteResult {
  success: boolean
  note?: Note
  filePath?: string
  error?: string
}

export function saveNote(
  title: string,
  content: string,
  tags: string[],
  context: CLIContext,
  fromLast: boolean = false,
  messageId?: string
): SaveNoteResult {
  if (!title) return { success: false, error: 'Note title is required.' }
  if (!content) return { success: false, error: 'Note content is required.' }

  const { artifact, filePath } = createArtifact({
    type: 'note',
    title,
    content,
    tags,
    provenance: {
      source: fromLast ? 'agent' : 'user',
      sessionId: context.sessionId,
      extractedFrom: fromLast ? 'agent-response' : 'user-input',
      messageId
    }
  }, context)

  if (artifact.type !== 'note') {
    return { success: false, error: 'Failed to create note artifact.' }
  }

  return { success: true, note: artifact, filePath }
}
