/**
 * List Commands - Return structured data for notes and docs.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, Note, Doc, type Provenance } from '../types.js'

export interface NoteListItem {
  id: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  selectedForAI: boolean
  provenance?: Provenance
}

export interface DocListItem {
  id: string
  title: string
  filePath: string
  mimeType?: string
  description?: string
  pinned: boolean
  selectedForAI: boolean
  tags?: string[]
  provenance?: Provenance
}

/** List all notes, returning structured data */
export function listNotes(projectPath: string): NoteListItem[] {
  const notesDir = join(projectPath, PATHS.notes)
  if (!existsSync(notesDir)) return []

  const files = readdirSync(notesDir).filter(f => f.endsWith('.json'))
  const items: NoteListItem[] = []

  for (const file of files) {
    try {
      const content = readFileSync(join(notesDir, file), 'utf-8')
      const note = JSON.parse(content) as Note
      items.push({
        id: note.id,
        title: note.title,
        content: note.content,
        tags: note.tags,
        pinned: note.pinned,
        selectedForAI: note.selectedForAI,
        provenance: note.provenance
      })
    } catch {
      // Skip invalid files
    }
  }

  return items
}

/** List all docs, returning structured data */
export function listDocs(projectPath: string): DocListItem[] {
  const docsDir = join(projectPath, PATHS.docs)
  if (!existsSync(docsDir)) return []

  const files = readdirSync(docsDir).filter(f => f.endsWith('.json'))
  const items: DocListItem[] = []

  for (const file of files) {
    try {
      const content = readFileSync(join(docsDir, file), 'utf-8')
      const doc = JSON.parse(content) as Doc
      items.push({
        id: doc.id,
        title: doc.title,
        filePath: doc.filePath,
        mimeType: doc.mimeType,
        description: doc.description,
        pinned: doc.pinned,
        selectedForAI: doc.selectedForAI,
        tags: doc.tags,
        provenance: doc.provenance
      })
    } catch {
      // Skip invalid files
    }
  }

  return items
}
