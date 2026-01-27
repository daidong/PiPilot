/**
 * List Commands - Return structured data for notes, literature, and data files.
 * Extracted from index.ts for Ink UI compatibility.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, Note, Literature, DataAttachment } from '../types.js'

export interface NoteListItem {
  id: string
  title: string
  tags: string[]
  pinned: boolean
  selectedForAI: boolean
}

export interface LiteratureListItem {
  id: string
  title: string
  authors: string[]
  year?: number
  citeKey: string
  pinned: boolean
  selectedForAI: boolean
}

export interface DataListItem {
  id: string
  name: string
  rowCount?: number
  pinned: boolean
  selectedForAI: boolean
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
        tags: note.tags,
        pinned: note.pinned,
        selectedForAI: note.selectedForAI
      })
    } catch {
      // Skip invalid files
    }
  }

  return items
}

/** List all literature, returning structured data */
export function listLiterature(projectPath: string): LiteratureListItem[] {
  const litDir = join(projectPath, PATHS.literature)
  if (!existsSync(litDir)) return []

  const files = readdirSync(litDir).filter(f => f.endsWith('.json'))
  const items: LiteratureListItem[] = []

  for (const file of files) {
    try {
      const content = readFileSync(join(litDir, file), 'utf-8')
      const lit = JSON.parse(content) as Literature
      items.push({
        id: lit.id,
        title: lit.title,
        authors: lit.authors,
        year: lit.year,
        citeKey: lit.citeKey,
        pinned: lit.pinned,
        selectedForAI: lit.selectedForAI
      })
    } catch {
      // Skip invalid files
    }
  }

  return items
}

/** List all data files, returning structured data */
export function listData(projectPath: string): DataListItem[] {
  const dataDir = join(projectPath, PATHS.data)
  if (!existsSync(dataDir)) return []

  const files = readdirSync(dataDir).filter(f => f.endsWith('.json'))
  const items: DataListItem[] = []

  for (const file of files) {
    try {
      const content = readFileSync(join(dataDir, file), 'utf-8')
      const data = JSON.parse(content) as DataAttachment
      items.push({
        id: data.id,
        name: data.name,
        rowCount: data.schema?.rowCount,
        pinned: data.pinned,
        selectedForAI: data.selectedForAI
      })
    } catch {
      // Skip invalid files
    }
  }

  return items
}
