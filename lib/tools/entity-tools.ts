/**
 * Research Pilot Memory V2 Tools (RFC-012)
 *
 * Rewritten to use simple ResearchTool interface instead of AgentFoundry's defineTool.
 * Tool execution logic (createArtifact, updateArtifact, searchArtifacts) is unchanged.
 */

import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { type ArtifactType, type NoteArtifact, type CLIContext, AGENT_MD_ID } from '../types.js'
import {
  createArtifact,
  findArtifactById,
  searchArtifacts,
  updateArtifact,
  type CreateArtifactInput
} from '../memory-v2/store.js'
import { toolError } from './tool-utils.js'

/**
 * Simple tool interface for research tools.
 * These will be adapted to pi-mono's AgentTool format by the coordinator.
 */
export interface ResearchTool {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  execute: (input: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>
}

function generateCiteKey(authors: string[], year?: number, title?: string): string {
  const firstAuthor = authors[0] || 'unknown'
  const lastName = firstAuthor.split(/\s+/).pop()?.toLowerCase() || 'unknown'
  const yearStr = year?.toString() || 'nd'
  const titleWords = (title || '').toLowerCase().split(/\s+/)
  const stopWords = new Set(['a', 'an', 'the', 'on', 'in', 'of', 'for', 'to', 'and', 'with'])
  const firstWord = titleWords.find(w => w.length > 2 && !stopWords.has(w)) || 'paper'
  return `${lastName}${yearStr}${firstWord}`
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function createArtifactCreateTool(sessionId: string, projectPath: string): ResearchTool {
  return {
    name: 'artifact-create',
    description: 'Create an artifact (note, paper, data, web-content, tool-output). This is the canonical persistence API for Research Pilot Memory V2.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['note', 'paper', 'data', 'web-content', 'tool-output'],
          description: 'Artifact type'
        },
        title: { type: 'string', description: 'Artifact title' },
        content: { type: 'string', description: 'Content for note or web-content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Artifact tags' },
        summary: { type: 'string', description: 'Optional concise summary' },
        authors: { type: 'array', items: { type: 'string' }, description: 'Paper authors' },
        abstract: { type: 'string', description: 'Paper abstract' },
        year: { type: 'number', description: 'Paper year' },
        venue: { type: 'string', description: 'Paper venue' },
        citeKey: { type: 'string', description: 'Paper citation key' },
        doi: { type: 'string', description: 'Paper DOI' },
        bibtex: { type: 'string', description: 'Paper BibTeX' },
        url: { type: 'string', description: 'Paper or web URL' },
        pdfUrl: { type: 'string', description: 'Paper PDF URL' },
        filePath: { type: 'string', description: 'Data artifact file path' },
        mimeType: { type: 'string', description: 'Data artifact MIME type' },
        schemaJson: { type: 'string', description: 'JSON string for data schema' },
        toolName: { type: 'string', description: 'Tool name for tool-output artifacts' },
        outputPath: { type: 'string', description: 'Output file path for tool-output artifacts' },
        outputText: { type: 'string', description: 'Output text for tool-output artifacts' }
      },
      required: ['type', 'title']
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const type = String(args.type) as ArtifactType
      const title = String(args.title || '').trim()
      if (!title) return toolError('MISSING_PARAMETER', 'title is required.', {
        suggestions: ['Provide a non-empty title string for the artifact.']
      })

      const cliContext: CLIContext = {
        sessionId,
        projectPath
      }

      let payload: CreateArtifactInput
      if (type === 'note') {
        payload = {
          type,
          title,
          content: String(args.content || ''),
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'agent-response' }
        }
      } else if (type === 'paper') {
        const authors = ((args.authors as string[] | undefined) ?? []).filter(Boolean)
        const year = typeof args.year === 'number' ? args.year : undefined
        const citeKey = (typeof args.citeKey === 'string' && args.citeKey.trim())
          ? args.citeKey
          : generateCiteKey(authors.length > 0 ? authors : ['unknown'], year, title)
        const doi = (typeof args.doi === 'string' && args.doi.trim()) ? args.doi : `unknown:${citeKey}`
        const bibtex = (typeof args.bibtex === 'string' && args.bibtex.trim())
          ? args.bibtex
          : `@article{${citeKey},\n  title = {${title}}\n}`

        payload = {
          type,
          title,
          authors: authors.length > 0 ? authors : ['Unknown'],
          abstract: typeof args.abstract === 'string' ? args.abstract : '',
          year,
          venue: typeof args.venue === 'string' ? args.venue : undefined,
          url: typeof args.url === 'string' ? args.url : undefined,
          citeKey,
          doi,
          bibtex,
          pdfUrl: typeof args.pdfUrl === 'string' ? args.pdfUrl : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'agent-response', agentId: 'coordinator' }
        }
      } else if (type === 'data') {
        const filePath = typeof args.filePath === 'string' ? args.filePath : ''
        if (!filePath) return toolError('MISSING_PARAMETER', 'filePath is required for data artifacts.', {
          suggestions: ['Provide a file path (relative to project root or absolute) for the data artifact.']
        })
        const resolvedFilePath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
        if (!existsSync(resolvedFilePath)) {
          return toolError('FILE_NOT_FOUND', `File not found: ${filePath}`, {
            suggestions: [
              `Check the file path relative to project root: ${projectPath}`,
              'Use the find or glob tool to locate the correct file path.',
            ],
            context: { resolvedPath: resolvedFilePath, projectPath }
          })
        }

        payload = {
          type,
          title,
          filePath,
          mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
          schema: typeof args.schemaJson === 'string' ? parseJsonSafely(args.schemaJson) as never : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'agent-response' }
        }
      } else if (type === 'web-content') {
        payload = {
          type,
          title,
          url: typeof args.url === 'string' ? args.url : '',
          content: typeof args.content === 'string' ? args.content : '',
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      } else {
        payload = {
          type: 'tool-output',
          title,
          toolName: typeof args.toolName === 'string' ? args.toolName : 'unknown',
          outputPath: typeof args.outputPath === 'string' ? args.outputPath : undefined,
          outputText: typeof args.outputText === 'string' ? args.outputText : undefined,
          tags: (args.tags as string[] | undefined) ?? [],
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          provenance: { source: 'agent', extractedFrom: 'tool-output' }
        }
      }

      const { artifact, filePath } = createArtifact(payload, cliContext)

      return {
        success: true,
        data: {
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          filePath
        }
      }
    }
  }
}

export function createArtifactUpdateTool(projectPath: string): ResearchTool {
  return {
    name: 'artifact-update',
    description: 'Update fields for an existing artifact by id or id prefix.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id (full or prefix)' },
        title: { type: 'string', description: 'Updated title' },
        summary: { type: 'string', description: 'Updated summary' },
        content: { type: 'string', description: 'Updated note/web content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Updated tags' },
        abstract: { type: 'string', description: 'Paper abstract' },
        year: { type: 'number', description: 'Paper year' },
        venue: { type: 'string', description: 'Paper venue' },
        url: { type: 'string', description: 'Paper/web URL' },
        doi: { type: 'string', description: 'Paper DOI' },
        bibtex: { type: 'string', description: 'Paper BibTeX' },
        pdfUrl: { type: 'string', description: 'Paper PDF URL' }
      },
      required: ['id']
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const id = String(args.id || '')
      if (!id) return toolError('MISSING_PARAMETER', 'id is required.', {
        suggestions: ['Provide an artifact id (full or prefix). Use artifact-search to find artifact ids.']
      })

      const updated = updateArtifact(projectPath, id, {
        title: typeof args.title === 'string' ? args.title : undefined,
        summary: typeof args.summary === 'string' ? args.summary : undefined,
        content: typeof args.content === 'string' ? args.content : undefined,
        tags: (args.tags as string[] | undefined) ?? undefined,
        abstract: typeof args.abstract === 'string' ? args.abstract : undefined,
        year: typeof args.year === 'number' ? args.year : undefined,
        venue: typeof args.venue === 'string' ? args.venue : undefined,
        url: typeof args.url === 'string' ? args.url : undefined,
        doi: typeof args.doi === 'string' ? args.doi : undefined,
        bibtex: typeof args.bibtex === 'string' ? args.bibtex : undefined,
        pdfUrl: typeof args.pdfUrl === 'string' ? args.pdfUrl : undefined
      })

      if (!updated) {
        return toolError('NOT_FOUND', `Artifact not found: ${id}`, {
          suggestions: [
            'Check the artifact id — it may have been deleted or the prefix is ambiguous.',
            'Use artifact-search to find the correct artifact id.',
          ],
          context: { searchedId: id }
        })
      }

      return {
        success: true,
        data: {
          id: updated.artifact.id,
          type: updated.artifact.type,
          title: updated.artifact.title,
          filePath: updated.filePath
        }
      }
    }
  }
}

export function createArtifactSearchTool(projectPath: string): ResearchTool {
  return {
    name: 'artifact-search',
    description: 'Search artifacts by query terms and return ranked hits.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        type: {
          type: 'string',
          enum: ['note', 'paper', 'data', 'web-content', 'tool-output'],
          description: 'Optional artifact type filter'
        }
      },
      required: ['query']
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const query = String(args.query || '').trim()
      if (!query) return toolError('MISSING_PARAMETER', 'query is required.', {
        suggestions: ['Provide a non-empty search query string.']
      })

      const type = typeof args.type === 'string' ? args.type as ArtifactType : undefined
      const hits = searchArtifacts(projectPath, query, type ? [type] : undefined)
      return {
        success: true,
        data: hits.slice(0, 20).map(hit => ({
          id: hit.artifact.id,
          type: hit.artifact.type,
          title: hit.artifact.title,
          score: hit.score,
          match: hit.match
        }))
      }
    }
  }
}

export function createUpdateMemoryTool(projectPath: string): ResearchTool {
  return {
    name: 'update-memory',
    description:
      'Write to the "## Agent Memory" section of agent.md — your persistent memory across sessions. ' +
      'Use this to save: user preferences, project context, key decisions, important findings. ' +
      'The content you provide REPLACES the entire Agent Memory section (User Instructions section is preserved automatically). ' +
      'Keep it concise (<5000 chars total). Consolidate and remove outdated entries rather than appending.',
    parameters: {
      type: 'object',
      properties: {
        memory: {
          type: 'string',
          description: 'The full content for the "## Agent Memory" section. Markdown format.'
        }
      },
      required: ['memory']
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const memory = String(args.memory || '').trim()
      if (!memory) return toolError('MISSING_PARAMETER', 'memory content is required.', {
        suggestions: ['Provide the content to save in the Agent Memory section.']
      })

      // Read current agent.md to preserve User Instructions
      const record = findArtifactById(projectPath, AGENT_MD_ID)
      const currentContent = record?.artifact?.type === 'note'
        ? (record.artifact as NoteArtifact).content || ''
        : ''

      // Extract User Instructions section (everything before ## Agent Memory)
      const agentMemoryMarker = '## Agent Memory'
      const markerIdx = currentContent.indexOf(agentMemoryMarker)
      const userInstructions = markerIdx >= 0
        ? currentContent.slice(0, markerIdx).trimEnd()
        : currentContent.split('\n').filter(l => !l.startsWith('## Agent Memory')).join('\n').trimEnd()

      // Rebuild content: User Instructions + Agent Memory
      const newContent = `${userInstructions}\n\n${agentMemoryMarker}\n\n${memory}\n`

      const updated = updateArtifact(projectPath, AGENT_MD_ID, { content: newContent })
      if (!updated) {
        return toolError('UPDATE_FAILED', 'Failed to update agent.md.', {
          suggestions: ['agent.md may not exist. Try opening a project folder first.']
        })
      }

      return {
        success: true,
        data: { message: 'Agent memory updated.', charCount: newContent.length }
      }
    }
  }
}

export function createResearchMemoryTools(params: {
  sessionId: string
  projectPath: string
}): ResearchTool[] {
  return [
    createArtifactCreateTool(params.sessionId, params.projectPath),
    createArtifactUpdateTool(params.projectPath),
    createArtifactSearchTool(params.projectPath),
    createUpdateMemoryTool(params.projectPath)
  ]
}
