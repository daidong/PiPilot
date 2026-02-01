/**
 * Save Doc Command
 *
 * Saves a document entity with provenance tracking.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Doc, CLIContext } from '../types.js'

export interface SaveDocResult {
  success: boolean
  doc?: Doc
  filePath?: string
  error?: string
}

/**
 * Save a document reference programmatically.
 */
export function saveDoc(
  title: string,
  opts: {
    filePath: string
    content?: string
    mimeType?: string
    description?: string
    tags?: string[]
  },
  context: CLIContext
): SaveDocResult {
  if (!title) return { success: false, error: 'Document title is required.' }
  if (!opts.filePath) return { success: false, error: 'Document filePath is required.' }

  const doc: Doc = {
    id: crypto.randomUUID(),
    type: 'doc',
    title,
    filePath: opts.filePath,
    content: opts.content,
    mimeType: opts.mimeType,
    description: opts.description,
    tags: opts.tags ?? [],
    pinned: false,
    selectedForAI: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      source: 'user',
      sessionId: context.sessionId,
      extractedFrom: 'user-input'
    }
  }

  const docsPath = context.projectPath
    ? join(context.projectPath, PATHS.docs)
    : PATHS.docs

  mkdirSync(docsPath, { recursive: true })
  const entityFilePath = join(docsPath, `${doc.id}.json`)
  writeFileSync(entityFilePath, JSON.stringify(doc, null, 2))

  return { success: true, doc, filePath: entityFilePath }
}
