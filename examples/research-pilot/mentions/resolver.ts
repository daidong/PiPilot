/**
 * Mention Resolver
 *
 * Resolves parsed @-mentions to their content by loading entities,
 * reading files, or fetching URLs.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import type { MentionRef } from './parser.js'
import { PATHS, Entity, Note, Literature, DataAttachment } from '../types.js'
import { getCachedMarkdown } from './document-cache.js'

const MAX_CONTENT_BYTES = 10 * 1024 // 10KB cap

export interface ResolvedMention {
  ref: MentionRef
  label: string
  content: string
  error?: string
}

/**
 * Resolve an array of mention references to their content.
 */
export async function resolveMentions(
  mentions: MentionRef[],
  projectPath: string
): Promise<ResolvedMention[]> {
  return Promise.all(mentions.map(ref => resolveOne(ref, projectPath)))
}

async function resolveOne(ref: MentionRef, projectPath: string): Promise<ResolvedMention> {
  try {
    switch (ref.type) {
      case 'note':
        return resolveEntity(ref, join(projectPath, PATHS.notes), 'note')
      case 'paper':
        return resolveEntity(ref, join(projectPath, PATHS.literature), 'literature')
      case 'data':
        return resolveEntity(ref, join(projectPath, PATHS.data), 'data')
      case 'file':
        return resolveFile(ref, projectPath)
      case 'url':
        return await resolveUrl(ref)
      default:
        return { ref, label: ref.raw, content: '', error: `Unknown mention type: ${ref.type}` }
    }
  } catch (err) {
    return { ref, label: ref.raw, content: '', error: String(err) }
  }
}

/**
 * Resolve an entity mention by scanning JSON files in the directory.
 * Matches by: exact id, id prefix, citeKey (literature), title/name substring.
 */
function resolveEntity(
  ref: MentionRef,
  dir: string,
  entityType: string
): ResolvedMention {
  if (!existsSync(dir)) {
    return { ref, label: ref.raw, content: '', error: `No ${entityType} directory found` }
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  const key = ref.key.toLowerCase()

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8')
      const entity = JSON.parse(raw) as Entity

      // Match by exact id
      if (entity.id === ref.key || entity.id.toLowerCase().startsWith(key)) {
        return { ref, label: entityLabel(entity), content: formatEntityContent(entity) }
      }

      // Match by citeKey for literature
      if (entity.type === 'literature') {
        const lit = entity as Literature
        if (lit.citeKey.toLowerCase() === key || lit.citeKey.toLowerCase().startsWith(key)) {
          return { ref, label: entityLabel(entity), content: formatEntityContent(entity) }
        }
      }

      // Match by title/name substring
      const name = entityName(entity).toLowerCase()
      if (name.includes(key)) {
        return { ref, label: entityLabel(entity), content: formatEntityContent(entity) }
      }
    } catch {
      // skip invalid files
    }
  }

  return { ref, label: ref.raw, content: '', error: `Could not resolve: ${ref.raw}` }
}

// File extensions that require document conversion (binary formats)
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.epub'])

function resolveFile(ref: MentionRef, projectPath: string): ResolvedMention {
  const filePath = resolve(projectPath, ref.key)
  if (!existsSync(filePath)) {
    return { ref, label: `file: ${ref.key}`, content: '', error: `File not found: ${ref.key}` }
  }

  // Check if this is a document that needs conversion
  const ext = ref.key.toLowerCase().match(/\.[^.]+$/)?.[0] || ''
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    const absPath = filePath.startsWith('/') ? filePath : resolve(process.cwd(), filePath)

    // Check if we have a cached markdown version
    const cached = getCachedMarkdown(absPath, projectPath)
    if (cached) {
      // Return cached markdown directly - no need to call convert_to_markdown
      return {
        ref,
        label: `file: ${ref.key}`,
        content: `[Document: ${ref.key}]\n\n${cached}`
      }
    }

    // No cache - instruct coordinator to use convert_to_markdown.
    // The framework auto-resolves relative file:// URIs against the working directory,
    // so we just pass the filename.
    const content = `[Document file: ${ref.key}]\nType: ${ext.slice(1).toUpperCase()}\n\nTo read this document, call: convert_to_markdown({ path: "${ref.key}" }), then use read to access the extracted .md file.`
    return { ref, label: `file: ${ref.key}`, content }
  }

  // For text files, read content directly
  try {
    const buf = readFileSync(filePath)
    const content = buf.slice(0, MAX_CONTENT_BYTES).toString('utf-8')
    const truncated = buf.length > MAX_CONTENT_BYTES ? '\n...(truncated)' : ''
    return { ref, label: `file: ${ref.key}`, content: content + truncated }
  } catch (err) {
    return { ref, label: `file: ${ref.key}`, content: '', error: `Failed to read file: ${err}` }
  }
}

async function resolveUrl(ref: MentionRef): Promise<ResolvedMention> {
  try {
    const resp = await fetch(ref.key, {
      headers: { 'User-Agent': 'ResearchPilot/1.0' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!resp.ok) {
      return { ref, label: `url: ${ref.key}`, content: '', error: `HTTP ${resp.status}` }
    }
    const text = await resp.text()
    // Strip HTML tags for a rough text extraction
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const content = plain.slice(0, MAX_CONTENT_BYTES)
    const truncated = plain.length > MAX_CONTENT_BYTES ? '\n...(truncated)' : ''
    return { ref, label: `url: ${ref.key}`, content: content + truncated }
  } catch (err) {
    return { ref, label: `url: ${ref.key}`, content: '', error: `Fetch failed: ${err}` }
  }
}

// Helpers

function entityName(entity: Entity): string {
  if (entity.type === 'note') return (entity as Note).title
  if (entity.type === 'literature') return (entity as Literature).title
  if (entity.type === 'data') return (entity as DataAttachment).name
  return entity.id
}

function entityLabel(entity: Entity): string {
  return `${entity.type}: ${entityName(entity)}`
}

function formatEntityContent(entity: Entity): string {
  if (entity.type === 'note') {
    const note = entity as Note
    return `Title: ${note.title}\nTags: ${note.tags.join(', ') || 'none'}\n\n${note.content}`
  }
  if (entity.type === 'literature') {
    const lit = entity as Literature
    return `Title: ${lit.title}\nAuthors: ${lit.authors.join(', ')}\nYear: ${lit.year || 'unknown'}\nCiteKey: ${lit.citeKey}\n\n${lit.abstract}`
  }
  if (entity.type === 'data') {
    const data = entity as DataAttachment
    const schema = data.schema?.columns
      ? `\nColumns: ${data.schema.columns.map(c => `${c.name} (${c.type})`).join(', ')}`
      : ''
    // Include a content preview so the LLM sees actual file data, not just metadata
    let preview = ''
    try {
      if (existsSync(data.filePath)) {
        const buf = readFileSync(data.filePath)
        const text = buf.slice(0, MAX_CONTENT_BYTES).toString('utf-8')
        const truncated = buf.length > MAX_CONTENT_BYTES ? '\n...(truncated)' : ''
        preview = `\n\n--- File Content Preview ---\n${text}${truncated}`
      }
    } catch {
      // skip if unreadable
    }
    return `Name: ${data.name}\nFile path (for analysis tools): ${data.filePath}${schema}\n\nNOTE: This is a data entity. The actual data is in the file at the path above. Use that path to read/analyze the data.${preview}`
  }
  return JSON.stringify(entity, null, 2)
}
