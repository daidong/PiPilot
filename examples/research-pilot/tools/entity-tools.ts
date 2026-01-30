/**
 * Entity Tools
 *
 * Tools for the coordinator to create research entities (notes, papers, data)
 * that properly integrate with the UI's entity list.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { defineTool } from '../../../src/factories/define-tool.js'
import { saveNote } from '../commands/save-note.js'
import { savePaper } from '../commands/save-paper.js'
import { togglePin } from '../commands/pin.js'
import { PATHS, Entity, Note } from '../types.js'
import type { CLIContext } from '../types.js'

/**
 * Create a save-note tool that properly saves notes as JSON entities
 */
export function createSaveNoteTool(sessionId: string, projectPath: string) {
  return defineTool({
    name: 'save-note',
    description: 'Save content as a research note. Creates a proper note entity that appears in the Notes list. Use this instead of write when saving research notes, summaries, or extracted insights.',
    parameters: {
      title: {
        type: 'string',
        description: 'Title of the note',
        required: true
      },
      content: {
        type: 'string',
        description: 'Content of the note (markdown supported)',
        required: true
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for categorization',
        required: false
      },
    },
    execute: async (input) => {
      const { title, content, tags = [] } = input as {
        title: string
        content: string
        tags?: string[]
      }
      // All agent-created notes are pinned by default — forces discipline
      const pinned = true

      const context: CLIContext = {
        sessionId,
        projectPath
      }

      const result = saveNote(title, content, tags, context, false, undefined, pinned)

      if (result.success) {
        return {
          success: true,
          data: {
            id: result.note!.id,
            title: result.note!.title,
            filePath: result.filePath,
            tags: result.note!.tags
          }
        }
      } else {
        return {
          success: false,
          error: result.error || 'Failed to save note'
        }
      }
    }
  })
}

/**
 * Create a save-paper tool that properly saves literature references
 */
export function createSavePaperTool(sessionId: string, projectPath: string) {
  return defineTool({
    name: 'save-paper',
    description: 'Save a literature reference (paper, article). Creates a proper literature entity that appears in the Literature list. Use this when saving paper metadata from search results.',
    parameters: {
      title: {
        type: 'string',
        description: 'Title of the paper',
        required: true
      },
      authors: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of author names',
        required: true
      },
      abstract: {
        type: 'string',
        description: 'Abstract or summary of the paper',
        required: true
      },
      year: {
        type: 'number',
        description: 'Publication year',
        required: false
      },
      venue: {
        type: 'string',
        description: 'Publication venue (journal, conference)',
        required: false
      },
      url: {
        type: 'string',
        description: 'URL to the paper',
        required: false
      },
      citeKey: {
        type: 'string',
        description: 'Citation key (e.g., smith2024deep). If not provided, one will be generated.',
        required: false
      },
      doi: {
        type: 'string',
        description: 'DOI of the paper (e.g., 10.1234/example)',
        required: false
      },
      bibtex: {
        type: 'string',
        description: 'BibTeX citation entry for the paper',
        required: false
      }
    },
    execute: async (input) => {
      const { title, authors, abstract, year, venue, url, citeKey, doi, bibtex } = input as {
        title: string
        authors: string[]
        abstract: string
        year?: number
        venue?: string
        url?: string
        citeKey?: string
        doi?: string
        bibtex?: string
      }

      // Generate citeKey if not provided
      const generatedCiteKey = citeKey || generateCiteKey(authors, year, title)

      const context: CLIContext = {
        sessionId,
        projectPath
      }

      const result = savePaper(
        title,
        {
          authors,
          abstract,
          year,
          venue,
          url,
          citeKey: generatedCiteKey,
          doi,
          bibtex
        },
        context
      )

      if (result.success) {
        return {
          success: true,
          data: {
            id: result.paper!.id,
            title: result.paper!.title,
            citeKey: result.paper!.citeKey,
            filePath: result.filePath
          }
        }
      } else {
        return {
          success: false,
          error: result.error || 'Failed to save paper'
        }
      }
    }
  })
}

/**
 * Create an update-note tool that updates an existing note by ID
 */
export function createUpdateNoteTool(projectPath: string) {
  return defineTool({
    name: 'update-note',
    description: 'Update an existing note by ID. Use this instead of save-note when a note on the same topic already exists. You can update title, content, tags, and/or pinned status. Only provided fields are changed.',
    parameters: {
      id: {
        type: 'string',
        description: 'ID of the note to update (full UUID or prefix)',
        required: true
      },
      title: {
        type: 'string',
        description: 'New title (omit to keep current)',
        required: false
      },
      content: {
        type: 'string',
        description: 'New content (markdown). Replaces the entire content.',
        required: false
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'New tags (replaces existing tags)',
        required: false
      },
      pinned: {
        type: 'boolean',
        description: 'Set pinned status',
        required: false
      }
    },
    execute: async (input) => {
      const { id, title, content, tags, pinned } = input as {
        id: string
        title?: string
        content?: string
        tags?: string[]
        pinned?: boolean
      }

      // Find the note file
      const notesDir = join(projectPath, PATHS.notes)
      if (!existsSync(notesDir)) {
        return { success: false, error: `Notes directory not found` }
      }

      const files = readdirSync(notesDir).filter(f => f.endsWith('.json'))
      let notePath: string | null = null
      let note: Note | null = null

      for (const file of files) {
        const filePath = join(notesDir, file)
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const entity = JSON.parse(raw) as Note
          if (entity.id === id || entity.id.startsWith(id)) {
            notePath = filePath
            note = entity
            break
          }
        } catch {
          // skip
        }
      }

      if (!notePath || !note) {
        return { success: false, error: `Note not found: ${id}` }
      }

      // Apply updates
      if (title !== undefined) note.title = title
      if (content !== undefined) note.content = content
      if (tags !== undefined) note.tags = tags
      if (pinned !== undefined) note.pinned = pinned
      note.updatedAt = new Date().toISOString()

      writeFileSync(notePath, JSON.stringify(note, null, 2))

      return {
        success: true,
        data: {
          id: note.id,
          title: note.title,
          pinned: note.pinned
        }
      }
    }
  })
}

/**
 * Create a toggle-pin tool that pins/unpins any entity by ID
 */
export function createTogglePinTool() {
  return defineTool({
    name: 'toggle-pin',
    description: 'Toggle the pinned status of any entity (note, paper, or data). Pinned entities are always included in your context. Use this to unpin notes that are no longer critical, or to pin important ones.',
    parameters: {
      id: {
        type: 'string',
        description: 'ID of the entity to pin/unpin (full UUID or prefix)',
        required: true
      }
    },
    execute: async (input) => {
      const { id } = input as { id: string }
      const result = togglePin(id)

      if (result.success) {
        return {
          success: true,
          data: {
            type: result.entityType,
            title: result.title,
            pinned: result.pinned
          }
        }
      } else {
        return { success: false, error: result.error }
      }
    }
  })
}

/**
 * Generate a citation key from authors, year, and title
 */
function generateCiteKey(authors: string[], year?: number, title?: string): string {
  // Get first author's last name
  const firstAuthor = authors[0] || 'unknown'
  const lastName = firstAuthor.split(/\s+/).pop()?.toLowerCase() || 'unknown'

  // Get year or use 'nd' for no date
  const yearStr = year?.toString() || 'nd'

  // Get first significant word from title
  const titleWords = (title || '').toLowerCase().split(/\s+/)
  const stopWords = new Set(['a', 'an', 'the', 'on', 'in', 'of', 'for', 'to', 'and', 'with'])
  const firstWord = titleWords.find(w => w.length > 2 && !stopWords.has(w)) || 'paper'

  return `${lastName}${yearStr}${firstWord}`
}
