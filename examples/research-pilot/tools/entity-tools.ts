/**
 * Research Pilot Memory V2 Tools (RFC-012)
 */

import { existsSync } from 'fs'
import { defineTool } from '../../../src/factories/define-tool.js'
import type { Tool } from '../../../src/types/tool.js'
import { type ArtifactType, type CLIContext } from '../types.js'
import {
  createArtifact,
  searchArtifacts,
  updateArtifact,
  type CreateArtifactInput
} from '../memory-v2/store.js'

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

async function maybeRegisterArtifactInKernel(
  runtime: { kernelV2?: unknown },
  params: {
    sessionId: string
    type: ArtifactType
    title: string
    path: string
    summary?: string
  }
): Promise<void> {
  const kernel = runtime.kernelV2 as {
    addArtifact?: (input: {
      sessionId: string
      type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content'
      path: string
      mimeType: string
      summary: string
      sourceRef: string
    }) => Promise<void>
  } | undefined

  if (!kernel?.addArtifact) return

  let type: 'document' | 'tool-output' | 'file-snapshot' | 'web-content' = 'document'
  if (params.type === 'tool-output') type = 'tool-output'
  if (params.type === 'data') type = 'file-snapshot'
  if (params.type === 'web-content') type = 'web-content'

  await kernel.addArtifact({
    sessionId: params.sessionId,
    type,
    path: params.path,
    mimeType: 'application/json',
    summary: params.summary ?? params.title,
    sourceRef: `artifact:${params.type}:${params.title}`
  })
}

export function createArtifactCreateTool(sessionId: string, projectPath: string): Tool {
  return defineTool({
    name: 'artifact-create',
    description: 'Create an artifact (note, paper, data, web-content, tool-output). This is the canonical persistence API for Research Pilot Memory V2.',
    parameters: {
      type: {
        type: 'string',
        enum: ['note', 'paper', 'data', 'web-content', 'tool-output'],
        required: true,
        description: 'Artifact type'
      },
      title: {
        type: 'string',
        required: true,
        description: 'Artifact title'
      },
      content: {
        type: 'string',
        required: false,
        description: 'Content for note or web-content'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        required: false,
        description: 'Artifact tags'
      },
      summary: {
        type: 'string',
        required: false,
        description: 'Optional concise summary'
      },
      authors: {
        type: 'array',
        items: { type: 'string' },
        required: false,
        description: 'Paper authors'
      },
      abstract: {
        type: 'string',
        required: false,
        description: 'Paper abstract'
      },
      year: {
        type: 'number',
        required: false,
        description: 'Paper year'
      },
      venue: {
        type: 'string',
        required: false,
        description: 'Paper venue'
      },
      citeKey: {
        type: 'string',
        required: false,
        description: 'Paper citation key'
      },
      doi: {
        type: 'string',
        required: false,
        description: 'Paper DOI'
      },
      bibtex: {
        type: 'string',
        required: false,
        description: 'Paper BibTeX'
      },
      url: {
        type: 'string',
        required: false,
        description: 'Paper or web URL'
      },
      pdfUrl: {
        type: 'string',
        required: false,
        description: 'Paper PDF URL'
      },
      filePath: {
        type: 'string',
        required: false,
        description: 'Data artifact file path'
      },
      mimeType: {
        type: 'string',
        required: false,
        description: 'Data artifact MIME type'
      },
      schemaJson: {
        type: 'string',
        required: false,
        description: 'JSON string for data schema'
      },
      toolName: {
        type: 'string',
        required: false,
        description: 'Tool name for tool-output artifacts'
      },
      outputPath: {
        type: 'string',
        required: false,
        description: 'Output file path for tool-output artifacts'
      },
      outputText: {
        type: 'string',
        required: false,
        description: 'Output text for tool-output artifacts'
      }
    },
    execute: async (input, context) => {
      const args = input as Record<string, unknown>
      const type = String(args.type) as ArtifactType
      const title = String(args.title || '').trim()
      if (!title) return { success: false, error: 'title is required' }

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
        if (!filePath) return { success: false, error: 'filePath is required for data artifacts' }
        if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` }

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
      await maybeRegisterArtifactInKernel(context.runtime, {
        sessionId,
        type: artifact.type,
        title: artifact.title,
        path: filePath,
        summary: artifact.summary
      })

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
  })
}

export function createArtifactUpdateTool(projectPath: string): Tool {
  return defineTool({
    name: 'artifact-update',
    description: 'Update fields for an existing artifact by id or id prefix.',
    parameters: {
      id: { type: 'string', required: true, description: 'Artifact id (full or prefix)' },
      title: { type: 'string', required: false, description: 'Updated title' },
      summary: { type: 'string', required: false, description: 'Updated summary' },
      content: { type: 'string', required: false, description: 'Updated note/web content' },
      tags: { type: 'array', items: { type: 'string' }, required: false, description: 'Updated tags' },
      abstract: { type: 'string', required: false, description: 'Paper abstract' },
      year: { type: 'number', required: false, description: 'Paper year' },
      venue: { type: 'string', required: false, description: 'Paper venue' },
      url: { type: 'string', required: false, description: 'Paper/web URL' },
      doi: { type: 'string', required: false, description: 'Paper DOI' },
      bibtex: { type: 'string', required: false, description: 'Paper BibTeX' },
      pdfUrl: { type: 'string', required: false, description: 'Paper PDF URL' }
    },
    execute: async (input, context) => {
      const args = input as Record<string, unknown>
      const id = String(args.id || '')
      if (!id) return { success: false, error: 'id is required' }

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
        return { success: false, error: `Artifact not found: ${id}` }
      }

      await maybeRegisterArtifactInKernel(context.runtime, {
        sessionId: context.sessionId,
        type: updated.artifact.type,
        title: updated.artifact.title,
        path: updated.filePath,
        summary: updated.artifact.summary
      })

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
  })
}

export function createArtifactSearchTool(projectPath: string): Tool {
  return defineTool({
    name: 'artifact-search',
    description: 'Search artifacts by query terms and return ranked hits.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
      type: {
        type: 'string',
        enum: ['note', 'paper', 'data', 'web-content', 'tool-output'],
        required: false,
        description: 'Optional artifact type filter'
      }
    },
    execute: async (input) => {
      const args = input as Record<string, unknown>
      const query = String(args.query || '').trim()
      if (!query) return { success: false, error: 'query is required' }

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
  })
}

export function createResearchMemoryTools(params: {
  sessionId: string
  projectPath: string
}): Tool[] {
  return [
    createArtifactCreateTool(params.sessionId, params.projectPath),
    createArtifactUpdateTool(params.projectPath),
    createArtifactSearchTool(params.projectPath)
  ]
}
