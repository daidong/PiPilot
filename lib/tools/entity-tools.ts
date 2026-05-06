/**
 * Research Pilot Memory V2 Tools (RFC-012)
 *
 * Native pi-mono AgentTool implementations for artifact-create / -update /
 * -search. Replaces the prior ResearchTool + JSON-Schema↔TypeBox adapter
 * shim — these tools now register directly with the agent.
 */

import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { type ArtifactType, type CLIContext } from '../types.js'
import {
  createArtifact,
  searchArtifacts,
  updateArtifact,
  type CreateArtifactInput
} from '../memory-v2/store.js'
import { toAgentResult, toolError } from './tool-utils.js'

const ARTIFACT_TYPE_ENUM = ['note', 'paper', 'data', 'web-content', 'tool-output'] as const

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

export function createArtifactCreateTool(sessionId: string, projectPath: string): AgentTool {
  return {
    name: 'artifact-create',
    label: 'Create artifact',
    description: 'Create an artifact (note, paper, data, web-content, tool-output). This is the canonical persistence API for Research Pilot Memory V2.',
    parameters: Type.Object({
      type: Type.Union(ARTIFACT_TYPE_ENUM.map(v => Type.Literal(v)), { description: 'Artifact type' }),
      title: Type.String({ description: 'Artifact title' }),
      content: Type.Optional(Type.String({ description: 'Content for note or web-content' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Artifact tags' })),
      summary: Type.Optional(Type.String({ description: 'Optional concise summary' })),
      authors: Type.Optional(Type.Array(Type.String(), { description: 'Paper authors' })),
      abstract: Type.Optional(Type.String({ description: 'Paper abstract' })),
      year: Type.Optional(Type.Number({ description: 'Paper year' })),
      venue: Type.Optional(Type.String({ description: 'Paper venue' })),
      citeKey: Type.Optional(Type.String({ description: 'Paper citation key' })),
      doi: Type.Optional(Type.String({ description: 'Paper DOI' })),
      bibtex: Type.Optional(Type.String({ description: 'Paper BibTeX' })),
      url: Type.Optional(Type.String({ description: 'Paper or web URL' })),
      pdfUrl: Type.Optional(Type.String({ description: 'Paper PDF URL' })),
      filePath: Type.Optional(Type.String({ description: 'Data artifact file path' })),
      mimeType: Type.Optional(Type.String({ description: 'Data artifact MIME type' })),
      schemaJson: Type.Optional(Type.String({ description: 'JSON string for data schema' })),
      toolName: Type.Optional(Type.String({ description: 'Tool name for tool-output artifacts' })),
      outputPath: Type.Optional(Type.String({ description: 'Output file path for tool-output artifacts' })),
      outputText: Type.Optional(Type.String({ description: 'Output text for tool-output artifacts' }))
    }),
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as Record<string, unknown>
      const type = String(args.type) as ArtifactType
      const title = String(args.title || '').trim()
      if (!title) {
        return toAgentResult('artifact-create', toolError('MISSING_PARAMETER', 'title is required.', {
          suggestions: ['Provide a non-empty title string for the artifact.']
        }))
      }

      const cliContext: CLIContext = { sessionId, projectPath }

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
        if (!filePath) {
          return toAgentResult('artifact-create', toolError('MISSING_PARAMETER', 'filePath is required for data artifacts.', {
            suggestions: ['Provide a file path (relative to project root or absolute) for the data artifact.']
          }))
        }
        const resolvedFilePath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath)
        if (!existsSync(resolvedFilePath)) {
          return toAgentResult('artifact-create', toolError('FILE_NOT_FOUND', `File not found: ${filePath}`, {
            suggestions: [
              `Check the file path relative to project root: ${projectPath}`,
              'Use the find or glob tool to locate the correct file path.',
            ],
            context: { resolvedPath: resolvedFilePath, projectPath }
          }))
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

      return toAgentResult('artifact-create', {
        success: true,
        data: {
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          filePath
        }
      })
    }
  }
}

export function createArtifactUpdateTool(projectPath: string): AgentTool {
  return {
    name: 'artifact-update',
    label: 'Update artifact',
    description: 'Update fields for an existing artifact by id or id prefix.',
    parameters: Type.Object({
      id: Type.String({ description: 'Artifact id (full or prefix)' }),
      title: Type.Optional(Type.String({ description: 'Updated title' })),
      summary: Type.Optional(Type.String({ description: 'Updated summary' })),
      content: Type.Optional(Type.String({ description: 'Updated note/web content' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Updated tags' })),
      abstract: Type.Optional(Type.String({ description: 'Paper abstract' })),
      year: Type.Optional(Type.Number({ description: 'Paper year' })),
      venue: Type.Optional(Type.String({ description: 'Paper venue' })),
      url: Type.Optional(Type.String({ description: 'Paper/web URL' })),
      doi: Type.Optional(Type.String({ description: 'Paper DOI' })),
      bibtex: Type.Optional(Type.String({ description: 'Paper BibTeX' })),
      pdfUrl: Type.Optional(Type.String({ description: 'Paper PDF URL' }))
    }),
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as Record<string, unknown>
      const id = String(args.id || '')
      if (!id) {
        return toAgentResult('artifact-update', toolError('MISSING_PARAMETER', 'id is required.', {
          suggestions: ['Provide an artifact id (full or prefix). Use artifact-search to find artifact ids.']
        }))
      }

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
        return toAgentResult('artifact-update', toolError('NOT_FOUND', `Artifact not found: ${id}`, {
          suggestions: [
            'Check the artifact id — it may have been deleted or the prefix is ambiguous.',
            'Use artifact-search to find the correct artifact id.',
          ],
          context: { searchedId: id }
        }))
      }

      return toAgentResult('artifact-update', {
        success: true,
        data: {
          id: updated.artifact.id,
          type: updated.artifact.type,
          title: updated.artifact.title,
          filePath: updated.filePath
        }
      })
    }
  }
}

export function createArtifactSearchTool(projectPath: string): AgentTool {
  return {
    name: 'artifact-search',
    label: 'Search artifacts',
    description: 'Search artifacts by query terms and return ranked hits.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      type: Type.Optional(Type.Union(ARTIFACT_TYPE_ENUM.map(v => Type.Literal(v)), {
        description: 'Optional artifact type filter'
      }))
    }),
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as Record<string, unknown>
      const query = String(args.query || '').trim()
      if (!query) {
        return toAgentResult('artifact-search', toolError('MISSING_PARAMETER', 'query is required.', {
          suggestions: ['Provide a non-empty search query string.']
        }))
      }

      const type = typeof args.type === 'string' ? args.type as ArtifactType : undefined
      const hits = searchArtifacts(projectPath, query, type ? [type] : undefined)
      return toAgentResult('artifact-search', {
        success: true,
        data: hits.slice(0, 20).map(hit => ({
          id: hit.artifact.id,
          type: hit.artifact.type,
          title: hit.artifact.title,
          score: hit.score,
          match: hit.match
        }))
      })
    }
  }
}

export function createResearchMemoryTools(params: {
  sessionId: string
  projectPath: string
}): AgentTool[] {
  return [
    createArtifactCreateTool(params.sessionId, params.projectPath),
    createArtifactUpdateTool(params.projectPath),
    createArtifactSearchTool(params.projectPath)
  ]
}
