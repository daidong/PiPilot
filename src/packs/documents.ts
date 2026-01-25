/**
 * documents - Document Processing Pack
 *
 * Provides document extraction and conversion via MarkItDown MCP.
 * Supports: PDF, Word, Excel, PowerPoint, Images, Audio, HTML, YouTube, ZIP, EPUB
 */

import { createStdioMCPProvider } from '../mcp/index.js'
import type { Pack } from '../types/pack.js'

export interface DocumentsPackOptions {
  /** Tool name prefix. Default: none */
  toolPrefix?: string
  /** Request timeout in ms. Default: 60000 (MarkItDown needs time to init Python venv) */
  timeout?: number
}

/**
 * Creates a document processing pack using MarkItDown MCP server.
 *
 * Supported formats:
 * - Documents: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx)
 * - Images: PNG, JPG, GIF, BMP, TIFF, WEBP (with OCR)
 * - Audio: MP3, WAV (requires FFmpeg for transcription)
 * - Web: HTML, YouTube URLs
 * - Other: ZIP (processes contents), EPUB, CSV, JSON, XML
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   packs: [packs.safe(), await packs.documents()]
 * })
 * ```
 */
export async function documents(options: DocumentsPackOptions = {}): Promise<Pack> {
  const { toolPrefix, timeout = 60000 } = options

  const provider = createStdioMCPProvider({
    id: 'markitdown',
    name: 'MarkItDown',
    command: 'npx',
    args: ['-y', 'markitdown-mcp-npx'],
    toolPrefix,
    timeout  // MarkItDown needs extra time to initialize Python venv
  })

  const packs = await provider.createPacks()

  const pack = packs[0]
  if (!pack) {
    throw new Error('Failed to create MarkItDown MCP pack')
  }

  return pack
}
