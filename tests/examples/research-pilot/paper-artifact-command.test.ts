import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { CLIContext } from '../../../examples/research-pilot/types.js'
import { artifactCreate, artifactList } from '../../../examples/research-pilot/commands/artifact.js'
import { upsertPaperArtifact } from '../../../examples/research-pilot/commands/paper-artifact.js'

describe('research-pilot paper artifact commands', () => {
  let projectPath: string
  let context: CLIContext

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'af-rp-paper-artifact-'))
    context = {
      sessionId: 'sess-test',
      projectPath
    }
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('upsertPaperArtifact deduplicates by DOI and updates existing artifact', () => {
    const first = upsertPaperArtifact('Agent Systems', {
      authors: ['Jane Doe'],
      year: 2026,
      abstract: 'first',
      doi: '10.1234/example.doi'
    }, context)

    expect(first.success).toBe(true)
    const firstId = first.paper?.id
    expect(firstId).toBeTruthy()

    const second = upsertPaperArtifact('Agent Systems', {
      authors: ['Jane Doe'],
      year: 2026,
      abstract: 'updated abstract',
      doi: 'https://doi.org/10.1234/example.doi'
    }, context)

    expect(second.success).toBe(true)
    expect(second.paper?.id).toBe(firstId)
    expect(second.paper?.abstract).toBe('updated abstract')

    const artifacts = artifactList(projectPath, ['paper'])
    expect(artifacts).toHaveLength(1)
  })

  it('creates data artifact through canonical artifact surface', () => {
    const csvRelPath = 'sample.csv'
    const csvPath = join(projectPath, csvRelPath)
    writeFileSync(csvPath, 'a,b\n1,2\n', 'utf-8')

    const result = artifactCreate({
      type: 'data',
      title: 'sample',
      filePath: csvRelPath,
      mimeType: 'text/csv'
    }, context)

    expect(result.success).toBe(true)
    const artifacts = artifactList(projectPath, ['data'])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.type).toBe('data')
    expect(artifacts[0]?.title).toBe('sample')
  })

  it('rejects data artifact when file does not exist', () => {
    const result = artifactCreate({
      type: 'data',
      title: 'missing',
      filePath: 'missing.csv',
      mimeType: 'text/csv'
    }, context)

    expect(result.success).toBe(false)
    expect(result.error).toContain('File not found')
  })
})
