/**
 * Entity Tools
 *
 * Tools for the coordinator to create and manage entities (notes, docs)
 * that properly integrate with the UI's entity list.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { defineTool } from '@framework/factories/define-tool.js'
import { saveNote } from '../commands/save-note.js'
import { saveDoc } from '../commands/save-doc.js'
import { togglePin } from '../commands/pin.js'
import { toggleTodoComplete } from '../commands/toggle-todo-complete.js'
import { PATHS, Entity, Note, Todo } from '../types.js'
import type { CLIContext } from '../types.js'

/**
 * Create a save-note tool that properly saves notes or todos as JSON entities
 */
export function createSaveNoteTool(sessionId: string, projectPath: string) {
  return defineTool({
    name: 'save-note',
    description: 'Save content as a note or todo. Creates a proper entity that appears in the Notes or Todos list. Use type="todo" for actionable tasks the user needs to track.',
    parameters: {
      title: {
        type: 'string',
        description: 'Title of the note or todo',
        required: true
      },
      content: {
        type: 'string',
        description: 'Content of the note or description of the todo (markdown supported)',
        required: true
      },
      type: {
        type: 'string',
        enum: ['note', 'todo'],
        description: 'Entity type: "note" for information, "todo" for actionable tasks',
        required: false
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for categorization',
        required: false
      },
    },
    execute: async (input) => {
      const { title, content, type = 'note', tags = [] } = input as {
        title: string
        content: string
        type?: 'note' | 'todo'
        tags?: string[]
      }
      // All agent-created notes are pinned by default
      const pinned = true

      const context: CLIContext = {
        sessionId,
        projectPath
      }

      const result = saveNote(title, content, tags, context, false, undefined, pinned, type)

      if (result.success) {
        return {
          success: true,
          data: {
            id: result.note!.id,
            type: result.note!.type,
            title: result.note!.title,
            filePath: result.filePath,
            tags: result.note!.tags,
            ...(type === 'todo' && { status: (result.note as Todo).status })
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
 * Create a save-doc tool that properly saves document references
 */
export function createSaveDocTool(sessionId: string, projectPath: string) {
  return defineTool({
    name: 'save-doc',
    description: 'Save a document reference. Creates a proper doc entity that appears in the Docs list. Use this when saving references to files, converted documents, or external resources.',
    parameters: {
      title: {
        type: 'string',
        description: 'Title of the document',
        required: true
      },
      filePath: {
        type: 'string',
        description: 'Path to the document file',
        required: true
      },
      content: {
        type: 'string',
        description: 'Extracted or summary content of the document',
        required: false
      },
      mimeType: {
        type: 'string',
        description: 'MIME type of the document (e.g. application/pdf)',
        required: false
      },
      description: {
        type: 'string',
        description: 'Brief description of the document',
        required: false
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for categorization',
        required: false
      }
    },
    execute: async (input) => {
      const { title, filePath, content, mimeType, description, tags = [] } = input as {
        title: string
        filePath: string
        content?: string
        mimeType?: string
        description?: string
        tags?: string[]
      }

      const context: CLIContext = {
        sessionId,
        projectPath
      }

      const result = saveDoc(
        title,
        { filePath, content, mimeType, description, tags },
        context
      )

      if (result.success) {
        return {
          success: true,
          data: {
            id: result.doc!.id,
            title: result.doc!.title,
            filePath: result.filePath
          }
        }
      } else {
        return {
          success: false,
          error: result.error || 'Failed to save document'
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
    description: 'Toggle the pinned status of any entity (note or doc). Pinned entities are always included in your context. Use this to unpin notes that are no longer critical, or to pin important ones.',
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
 * Create a toggle-complete tool that toggles todo completion status
 */
export function createToggleCompleteTool(projectPath: string) {
  return defineTool({
    name: 'toggle-complete',
    description: 'Toggle a todo between pending and completed status. Use this when the user completes a task or wants to reopen a completed one.',
    parameters: {
      id: {
        type: 'string',
        description: 'ID of the todo to toggle (full UUID or prefix)',
        required: true
      }
    },
    execute: async (input) => {
      const { id } = input as { id: string }
      const result = toggleTodoComplete(id, projectPath)

      if (result.success && result.todo) {
        return {
          success: true,
          data: {
            id: result.todo.id,
            title: result.todo.title,
            status: result.todo.status,
            completedAt: result.todo.completedAt
          }
        }
      } else {
        return { success: false, error: result.error || 'Failed to toggle todo' }
      }
    }
  })
}
