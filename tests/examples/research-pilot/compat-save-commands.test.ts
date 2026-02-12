import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { CLIContext } from '../../../examples/research-pilot/types.js'
import { savePaper } from '../../../examples/research-pilot/commands/save-paper.js'
import { saveData } from '../../../examples/research-pilot/commands/save-data.js'
import { artifactList } from '../../../examples/research-pilot/commands/artifact.js'

describe('research-pilot save command compatibility wrappers', () => {
  let projectPath: string
  let context: CLIContext

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'af-rp-save-compat-'))
    context = {
      sessionId: 'sess-test',
      projectPath
    }
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('saveData creates data artifact via canonical artifact surface', () => {
    const csvPath = join(projectPath, 'sample.csv')
    writeFileSync(csvPath, 'a,b\n1,2\n', 'utf-8')

    const result = saveData('sample', { filePath: csvPath, mimeType: 'text/csv' }, context)
    expect(result.success).toBe(true)
    expect(result.filePath && existsSync(result.filePath)).toBe(true)

    const artifacts = artifactList(projectPath, ['data'])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.type).toBe('data')
    expect(artifacts[0]?.title).toBe('sample')
  })

  it('savePaper deduplicates by DOI and updates existing artifact', () => {
    const first = savePaper('Agent Systems', {
      authors: ['Jane Doe'],
      year: 2026,
      abstract: 'first',
      doi: '10.1234/example.doi'
    }, context)

    expect(first.success).toBe(true)
    const firstId = first.paper?.id
    expect(firstId).toBeTruthy()

    const second = savePaper('Agent Systems', {
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
})
