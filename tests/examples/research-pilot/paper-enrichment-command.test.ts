import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { CLIContext } from '../../../examples/research-pilot/types.js'
import { savePaper } from '../../../examples/research-pilot/commands/save-paper.js'
import { enrichPaperArtifacts } from '../../../examples/research-pilot/commands/paper-enrichment.js'

describe('paper enrichment command', () => {
  let projectPath: string
  let context: CLIContext

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'af-rp-enrich-command-'))
    context = {
      sessionId: 'sess-test',
      projectPath
    }
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('returns zero counts when no paper artifacts exist', async () => {
    const result = await enrichPaperArtifacts({
      ...context,
      debug: false
    })

    expect(result).toEqual({
      success: true,
      enriched: 0,
      skipped: 0,
      failed: 0
    })
  })

  it('skips already complete papers without making enrichment calls', async () => {
    const saved = savePaper('Complete Metadata Paper', {
      authors: ['Alice Example'],
      year: 2024,
      abstract: 'Ready',
      venue: 'ICML',
      doi: '10.1000/complete',
      citationCount: 42,
      url: 'https://example.org/paper'
    }, context)

    expect(saved.success).toBe(true)
    const events: Array<{ paperId: string; status: string }> = []

    const result = await enrichPaperArtifacts({
      ...context,
      paperIds: [saved.paper!.id],
      debug: false,
      onProgress: (event) => events.push(event)
    })

    expect(result.success).toBe(true)
    expect(result.enriched).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(events).toEqual([{ paperId: saved.paper!.id, status: 'skipped' }])
  })
})
