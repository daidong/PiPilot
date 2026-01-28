/**
 * Entity Tools
 *
 * Tools for the coordinator to create research entities (notes, papers, data)
 * that properly integrate with the UI's entity list.
 */

import { defineTool } from '../../../src/factories/define-tool.js'
import { saveNote } from '../commands/save-note.js'
import { savePaper } from '../commands/save-paper.js'
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
      }
    },
    execute: async (input) => {
      const { title, content, tags = [] } = input as {
        title: string
        content: string
        tags?: string[]
      }

      const context: CLIContext = {
        sessionId,
        projectPath
      }

      const result = saveNote(title, content, tags, context, false)

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
      }
    },
    execute: async (input) => {
      const { title, authors, abstract, year, venue, url, citeKey } = input as {
        title: string
        authors: string[]
        abstract: string
        year?: number
        venue?: string
        url?: string
        citeKey?: string
      }

      // Generate citeKey if not provided
      const generatedCiteKey = citeKey || generateCiteKey(authors, year, title)

      const result = savePaper({
        title,
        authors,
        abstract,
        year,
        venue,
        url,
        citeKey: generatedCiteKey,
        projectPath,
        sessionId
      })

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
