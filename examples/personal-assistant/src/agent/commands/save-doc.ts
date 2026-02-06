/**
 * Legacy save-doc wrapper.
 * Canonical persistence API is artifact.create(type=doc).
 */

import { type CLIContext, type Doc } from '../types.js'
import { artifactCreate } from './artifact.js'

export interface SaveDocResult {
  success: boolean
  doc?: Doc
  filePath?: string
  error?: string
}

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

  const created = artifactCreate({
    type: 'doc',
    title,
    filePath: opts.filePath,
    content: opts.content,
    mimeType: opts.mimeType,
    description: opts.description,
    tags: opts.tags,
    summary: opts.description ?? opts.content?.slice(0, 220),
    provenance: {
      source: 'user',
      extractedFrom: 'user-input'
    }
  }, context)

  if (!created.success || !created.artifact) {
    return {
      success: false,
      error: created.error ?? 'Failed to save document.'
    }
  }

  if (created.artifact.type !== 'doc') {
    return { success: false, error: 'Unexpected artifact type after save-doc.' }
  }

  return {
    success: true,
    doc: created.artifact,
    filePath: created.filePath
  }
}
