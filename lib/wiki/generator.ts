/**
 * Wiki Generator — LLM page generation + idempotent concept updates.
 *
 * Uses callLlm from WikiAgentConfig (configured at app startup).
 * All functions accept shouldContinue for interruption safety.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { loadPrompt } from '../agents/prompts/index.js'
import { getWikiRoot, canonicalKeyToSlug, isValidArxivId, type FulltextStatus } from './types.js'
import { safeWriteFile, safeReadFile } from './io.js'
import type { PaperArtifact } from '../types.js'

type CallLlm = (systemPrompt: string, userContent: string) => Promise<string>

// ── Delay helper ───────────────────────────────────────────────────────────

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Paper page generation ──────────────────────────────────────────────────

export async function generatePaperPage(
  artifact: PaperArtifact,
  slug: string,
  fulltext: string | null,
  existingConceptSlugs: string[],
  callLlm: CallLlm,
  interCallDelayMs: number,
  shouldContinue: () => boolean,
): Promise<{ content: string; fulltextStatus: FulltextStatus } | null> {
  if (!shouldContinue()) return null

  const promptKey = fulltext ? 'wiki-paper-fulltext' : 'wiki-paper-abstract'
  const systemPrompt = loadPrompt(promptKey)

  const userContent = buildPaperUserContent(artifact, fulltext, existingConceptSlugs)

  const content = await callLlm(systemPrompt, userContent)
  if (!content || !shouldContinue()) return null

  // Only mark as abstract-fallback (retryable) if the arXiv ID is genuine.
  // Bogus IDs (e.g., "803") would cause infinite retry loops.
  const hasRealArxiv = artifact.arxivId && isValidArxivId(artifact.arxivId)
  const fulltextStatus: FulltextStatus = fulltext ? 'fulltext' : (hasRealArxiv ? 'abstract-fallback' : 'abstract-only')

  return { content, fulltextStatus }
}

// Exported for the hash-isolation regression test (lib/wiki/hash-isolation.test.ts).
// Consumers in the app still get it transitively via generatePaperPage.
export function buildPaperUserContent(
  artifact: PaperArtifact,
  fulltext: string | null,
  existingConceptSlugs: string[],
): string {
  // IMPORTANT: this function builds the SHARED page body prompt. It must
  // consume canonical paper fields only. keyFindings / relevanceJustification
  // / subTopic are per-project lenses and belong in the sidecar
  // (project_lenses), NOT in the body prose — mixing them produced pages
  // that read as if written from one particular project's point of view.
  // Lenses are derived separately by lib/wiki/lens-deriver.ts and stored in
  // the <!-- WIKI-META --> sidecar block; readers/tools render them as an
  // independent perspectives panel at display time. See RFC-005 §4 on the
  // source/memory/decision layering.
  const parts: string[] = []

  parts.push(`Title: ${artifact.title}`)
  parts.push(`Authors: ${artifact.authors?.join(', ') || 'Unknown'}`)
  if (artifact.year) parts.push(`Year: ${artifact.year}`)
  if (artifact.venue) parts.push(`Venue: ${artifact.venue}`)
  if (artifact.doi) parts.push(`DOI: ${artifact.doi}`)
  if (artifact.arxivId) parts.push(`arXiv: ${artifact.arxivId}`)

  parts.push(`\nAbstract:\n${artifact.abstract || '(no abstract)'}`)

  if (fulltext) {
    // Truncate fulltext to ~30k chars to stay within token limits
    const truncated = fulltext.length > 30_000
      ? fulltext.slice(0, 30_000) + '\n\n[... truncated for length ...]'
      : fulltext
    parts.push(`\nFull Text:\n${truncated}`)
  }

  if (existingConceptSlugs.length > 0) {
    parts.push(`\nExisting concept pages in wiki (use [[slug]] to link):\n${existingConceptSlugs.map(s => `- [[${s}]]`).join('\n')}`)
  }

  return parts.join('\n')
}

// ── Concept identification ─────────────────────────────────────────────────

export interface IdentifiedConcept {
  slug: string
  name: string
  description: string
}

export async function identifyConcepts(
  paperContent: string,
  paperTitle: string,
  existingConceptSlugs: string[],
  callLlm: CallLlm,
  interCallDelayMs: number,
  shouldContinue: () => boolean,
): Promise<IdentifiedConcept[]> {
  if (!shouldContinue()) return []

  await delay(interCallDelayMs)
  if (!shouldContinue()) return []

  const systemPrompt = loadPrompt('wiki-concept-identify')
  const userContent = `Paper title: ${paperTitle}\n\nPaper wiki page:\n${paperContent}\n\nExisting concepts: ${existingConceptSlugs.join(', ') || '(none)'}`

  const response = await callLlm(systemPrompt, userContent)
  if (!response || !shouldContinue()) return []

  try {
    // Extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []
    const concepts = JSON.parse(jsonMatch[0]) as IdentifiedConcept[]

    // Validate and normalize slugs
    return concepts
      .filter(c => c.slug && c.name)
      .map(c => ({
        slug: c.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60),
        name: c.name,
        description: c.description || '',
      }))
      .slice(0, 5)
  } catch {
    return []
  }
}

// ── Concept page generation / update (idempotent) ──────────────────────────

export async function generateAndUpdateConceptPages(
  concepts: IdentifiedConcept[],
  paperSlug: string,
  paperTitle: string,
  paperContent: string,
  callLlm: CallLlm,
  interCallDelayMs: number,
  shouldContinue: () => boolean,
): Promise<string[]> {
  const updatedSlugs: string[] = []
  const conceptsDir = join(getWikiRoot(), 'concepts')

  for (const concept of concepts) {
    if (!shouldContinue()) break

    await delay(interCallDelayMs)
    if (!shouldContinue()) break

    // Generate the paper's contribution section for this concept
    const systemPrompt = loadPrompt('wiki-concept-generate')
    const userContent = `Concept: ${concept.name}\nDescription: ${concept.description}\n\nPaper: ${paperTitle}\nPaper content:\n${paperContent.slice(0, 5000)}`

    const section = await callLlm(systemPrompt, userContent)
    if (!section || !shouldContinue()) continue

    // Wrap in markers
    const markedSection = `<!-- paper:${paperSlug} -->\n${section.trim()}\n<!-- /paper:${paperSlug} -->`

    // Read or create concept page
    const conceptPath = join(conceptsDir, `${concept.slug}.md`)
    let pageContent = safeReadFile(conceptPath)

    if (!pageContent) {
      // Create new concept page
      pageContent = `# ${concept.name}\n\n${concept.description}\n\n## Contributing Papers\n\n${markedSection}\n`
    } else {
      // Idempotent update: replace existing section or append
      const startMarker = `<!-- paper:${paperSlug} -->`
      const endMarker = `<!-- /paper:${paperSlug} -->`
      const startIdx = pageContent.indexOf(startMarker)
      const endIdx = pageContent.indexOf(endMarker)

      if (startIdx >= 0 && endIdx > startIdx) {
        // Replace existing section
        pageContent = pageContent.slice(0, startIdx) + markedSection + pageContent.slice(endIdx + endMarker.length)
      } else {
        // Append new section
        pageContent = pageContent.trimEnd() + '\n\n' + markedSection + '\n'
      }
    }

    safeWriteFile(conceptPath, pageContent)
    updatedSlugs.push(concept.slug)
  }

  return updatedSlugs
}

// ── List existing concept slugs ────────────────────────────────────────────

export function listExistingConceptSlugs(): string[] {
  const dir = join(getWikiRoot(), 'concepts')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => f.replace('.md', ''))
  } catch {
    return []
  }
}
