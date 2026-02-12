import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createArtifactCreateTool } from '../../../examples/research-pilot/tools/entity-tools.js'

describe('research-pilot artifact-create tool', () => {
  let projectPath: string

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'af-rp-artifact-create-tool-'))
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('accepts project-relative data file paths', async () => {
    const relPath = 'data/sample.csv'
    const absDir = join(projectPath, 'data')
    mkdirSync(absDir, { recursive: true })
    writeFileSync(join(projectPath, relPath), 'a,b\n1,2\n', 'utf-8')

    const tool = createArtifactCreateTool('sess-test', projectPath)
    const result = await tool.execute({
      type: 'data',
      title: 'sample',
      filePath: relPath,
      mimeType: 'text/csv'
    }, {
      runtime: {},
      sessionId: 'sess-test',
      step: 1,
      agentId: 'coordinator'
    } as any)

    expect(result.success).toBe(true)
  })
})
