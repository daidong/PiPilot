/**
 * Wiki Downloader — arXiv PDF download + markitdown conversion.
 *
 * Rate-limited to 3s between arXiv requests.
 * On failure: returns null; caller marks paper as abstract-fallback.
 */

import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { getWikiRoot } from './types.js'
import { safeReadFile } from './io.js'

// ── Rate gate — same pattern as ProviderRateGate in lib/tools/web-tools.ts ─

const ARXIV_RATE_LIMIT_MS = 3_000
let arxivNextAllowedAt = 0

async function waitForArxivRate(): Promise<void> {
  const now = Date.now()
  if (now < arxivNextAllowedAt) {
    await new Promise(resolve => setTimeout(resolve, arxivNextAllowedAt - now))
  }
  arxivNextAllowedAt = Date.now() + ARXIV_RATE_LIMIT_MS
}

// ── URL derivation ─────────────────────────────────────────────────────────

export function deriveArxivPdfUrl(arxivId: string): string {
  // Strip any URL prefix and version suffix
  const bareId = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
  return `https://arxiv.org/pdf/${bareId}.pdf`
}

// ── Download + conversion ──────────────────────────────────────────────────

/**
 * Download arXiv PDF and convert to Markdown.
 * Returns converted markdown text, or null on failure.
 */
export async function downloadAndConvertArxiv(arxivId: string): Promise<string | null> {
  const root = getWikiRoot()
  const bareId = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
  const safeName = bareId.replace(/[^a-zA-Z0-9.-]/g, '_')

  const pdfDir = join(root, 'raw', 'arxiv')
  const convertedDir = join(root, 'converted')
  const pdfPath = join(pdfDir, `${safeName}.pdf`)
  const mdPath = join(convertedDir, `${safeName}.md`)

  // Return cached conversion if available
  const cached = safeReadFile(mdPath)
  if (cached && cached.trim().length > 100) return cached

  // Download PDF if not cached
  if (!existsSync(pdfPath)) {
    await waitForArxivRate()
    const url = deriveArxivPdfUrl(arxivId)
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ResearchPilot/1.0 (academic research tool)' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return null
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 1000) return null  // too small to be a real PDF
      writeFileSync(pdfPath, buffer)
    } catch {
      return null
    }
  }

  // Convert PDF to Markdown via markitdown CLI
  try {
    const output = execSync(`markitdown "${pdfPath}"`, {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    })
    if (output && output.trim().length > 100) {
      writeFileSync(mdPath, output, 'utf-8')
      return output
    }
    return null
  } catch {
    // markitdown not available or conversion failed
    return null
  }
}
