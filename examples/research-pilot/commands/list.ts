/**
 * Artifact listing helpers.
 */

import { type Artifact, type ArtifactType, type DataAttachment, type Literature, type Note, type Provenance } from '../types.js'
import { listArtifacts } from '../memory-v2/store.js'

export interface ArtifactListItem {
  id: string
  type: ArtifactType
  title: string
  tags: string[]
  summary?: string
  updatedAt: string
  provenance?: Provenance
}

export interface NoteListItem {
  id: string
  title: string
  content: string
  tags: string[]
  filePath?: string
  provenance?: Provenance
}

export interface LiteratureListItem {
  id: string
  title: string
  abstract: string
  authors: string[]
  year?: number
  venue?: string
  url?: string
  citeKey: string
  doi?: string
  citationCount?: number
  pdfUrl?: string
  bibtex?: string
  externalSource?: string
  relevanceScore?: number
  enrichmentSource?: string
  enrichedAt?: string
  tags?: string[]
  provenance?: Provenance
}

export interface DataListItem {
  id: string
  name: string
  filePath: string
  rowCount?: number
  tags?: string[]
  runId?: string
  runLabel?: string
}

function toArtifactListItem(artifact: Artifact): ArtifactListItem {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    tags: artifact.tags,
    summary: artifact.summary,
    updatedAt: artifact.updatedAt,
    provenance: artifact.provenance
  }
}

export function listAllArtifacts(projectPath: string, types?: ArtifactType[]): ArtifactListItem[] {
  return listArtifacts(projectPath, types).map(toArtifactListItem)
}

export function listNotes(projectPath: string): NoteListItem[] {
  return listArtifacts(projectPath, ['note'])
    .filter((a): a is Note => a.type === 'note')
    .map(note => ({
      id: note.id,
      title: note.title,
      content: note.content,
      tags: note.tags,
      filePath: note.filePath,
      provenance: note.provenance
    }))
}

export function listLiterature(projectPath: string): LiteratureListItem[] {
  return listArtifacts(projectPath, ['paper'])
    .filter((a): a is Literature => a.type === 'paper')
    .map(paper => ({
      id: paper.id,
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      url: paper.url,
      citeKey: paper.citeKey,
      doi: paper.doi,
      citationCount: paper.citationCount,
      pdfUrl: paper.pdfUrl,
      bibtex: paper.bibtex,
      externalSource: paper.externalSource,
      relevanceScore: paper.relevanceScore,
      enrichmentSource: paper.enrichmentSource,
      enrichedAt: paper.enrichedAt,
      tags: paper.tags,
      provenance: paper.provenance
    }))
}

export function listData(projectPath: string): DataListItem[] {
  return listArtifacts(projectPath, ['data'])
    .filter((a): a is DataAttachment => a.type === 'data')
    .map(data => ({
      id: data.id,
      name: data.title,
      filePath: data.filePath,
      rowCount: data.schema?.rowCount,
      tags: data.tags,
      runId: data.runId,
      runLabel: data.runLabel
    }))
}
