import type { AuditGraph, GraphNode } from '../types.js'
import type { Claim, ClaimAnchor } from './types.js'

export interface Deliverable {
  id: string
  claimsSource: string | null
  products: string[]
  text: string
}

interface Block {
  kind: Claim['blockKind']
  text: string
}

// Anchors locate a claim in the graph, so we only extract tokens that can name
// a node: file paths and citation/figure/page references. Bare numbers are NOT
// anchors — they are the value being verified, not a locator (node search text
// carries no numbers anyway). A claim that names no such token cannot be
// anchored, which is exactly the signal we use to route it to not_checkable.
const FILE_PATH = /(?:^|[\s(["'`])((?:\.{1,2}\/|\/|~\/)?[A-Za-z0-9_@%+=:,./-]+\.(?:md|txt|json|jsonl|csv|tsv|yaml|yml|py|ts|tsx|js|jsx|html|css|pdf|png|jpg|jpeg|svg|bib|tex|docx|pptx|xlsx))/gi

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flushParagraph = () => {
    const text = normalizeText(paragraph.join(' '))
    if (text) blocks.push({ kind: 'paragraph', text })
    paragraph = []
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      flushParagraph()
      continue
    }
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'heading', text: normalizeText(line.replace(/^#{1,6}\s+/, '')) })
      continue
    }
    if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'bullet', text: normalizeText(line.replace(/^(?:[-*+]|\d+\.)\s+/, '')) })
      continue
    }
    if (/^\|.*\|$/.test(line)) {
      flushParagraph()
      if (!/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) {
        blocks.push({ kind: 'table-row', text: normalizeText(line.replace(/^\||\|$/g, '').replace(/\|/g, ' | ')) })
      }
      continue
    }
    if (/^(?:Figure|Fig\.|Table)\s+\d+[:.]/i.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'caption', text: normalizeText(line) })
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}

function extractFileTokens(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.matchAll(FILE_PATH)) {
    const token = normalizeText(match[1] ?? '').replace(/[),.;:]+$/, '')
    if (token) out.add(token)
  }
  return [...out]
}

function extractCitationTokens(text: string): string[] {
  const out = new Set<string>()
  const rx = /\((?:[A-Z][A-Za-z'`-]+(?:\s+et\s+al\.)?\s*,?\s*(?:19|20)\d{2}(?:[a-z])?)\)|\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b|\barXiv:\d{4}\.\d{4,5}(?:v\d+)?\b|\b(?:Figure|Fig\.|Table|page|p\.)\s+\d+\b/gi
  for (const match of text.matchAll(rx)) out.add(match[0].replace(/[().,;:]+$/g, '').trim())
  return [...out]
}

// Author surnames are the strongest provenance anchor for citation claims:
// evidence files are usually named after the author (`mereghetti2020.md`,
// `nicastro_b2.png`), while the literal "(Author, Year)" / "Figure N" strings
// never appear in a file path. We pull the surname when it is followed by a
// citation cue — "Surname et al.", "Surname and X", "Surname (… 19xx/20xx)".
function extractAuthorTokens(text: string): string[] {
  const out = new Set<string>()
  const rx = /\b([A-Z][A-Za-z'`-]{2,})\b(?=\s+(?:et\s+al\.|and\s+[A-Z]|&\s*[A-Z])|[\s,]*\((?:[^)]*\b(?:19|20)\d{2}))/g
  for (const match of text.matchAll(rx)) out.add(match[1].toLowerCase())
  return [...out]
}

function nodeSearchText(n: GraphNode): string {
  return [
    n.id,
    n.label,
    n.path,
    n.title,
    n.artifactId,
  ].filter(Boolean).join('\n').toLowerCase()
}

function tokenMatchesNode(token: string, n: GraphNode): boolean {
  const t = token.toLowerCase()
  const hay = nodeSearchText(n)
  if (hay.includes(t)) return true
  const base = t.split('/').filter(Boolean).at(-1)
  return !!base && base.length >= 3 && hay.includes(base)
}

export function extractClaims(
  deliverableText: string,
  graph: AuditGraph,
  opts: { inputNodes?: Set<string>; productNodes?: Set<string> } = {},
): Claim[] {
  const inputNodes = opts.inputNodes ?? new Set(graph.nodes.filter(n => n.kind !== 'tool' && n.kind !== 'step').map(n => n.id))
  const productNodes = opts.productNodes ?? new Set<string>()
  const nodes = graph.nodes.filter(n => n.kind === 'file' || n.kind === 'artifact' || n.kind === 'dir')

  return markdownBlocks(deliverableText).map((block, i): Claim => {
    // Anchoring runs on every claim regardless of kind — the typing table that
    // used to gate this is gone. We extract every groundable token (file paths
    // + citation/figure/page refs) and match each against the graph. Whether a
    // claim is "action" vs "citation" is now metadata the judge emits, not a
    // program decision; presence of an anchor (not a guessed type) is what
    // routes a claim into the LLM judge vs straight to not_checkable.
    const tokens = [...extractFileTokens(block.text), ...extractCitationTokens(block.text), ...extractAuthorTokens(block.text)]
    const anchors: ClaimAnchor[] = []
    for (const token of tokens) {
      const match =
        nodes.find(n => productNodes.has(n.id) && tokenMatchesNode(token, n)) ??
        nodes.find(n => inputNodes.has(n.id) && tokenMatchesNode(token, n)) ??
        nodes.find(n => tokenMatchesNode(token, n))
      if (match) {
        anchors.push({ token, nodeId: match.id, side: productNodes.has(match.id) ? 'product' : 'input' })
      }
    }
    return {
      id: `claim_${i + 1}`,
      text: block.text,
      blockKind: block.kind,
      anchors,
    }
  }).filter(c => c.text.length > 0)
}

export function extractResponseTextFromStep(step: GraphNode | undefined): string {
  const raw = step?.rawEvents?.find(e => e.name === 'pipilot.chat.response_text')?.body
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map(block => {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      }).filter(Boolean).join('\n\n')
    }
    if (typeof parsed === 'string') return parsed
  } catch {
    return raw
  }
  return raw
}
