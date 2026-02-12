import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CLIContext } from '../../../examples/research-pilot/types.js'
import {
  createArtifact,
  findExistingPaperArtifact,
  listArtifacts,
  migrateLegacyArtifacts,
  readArtifactFromFile
} from '../../../examples/research-pilot/memory-v2/store.js'

describe('research-pilot memory-v2 store', () => {
  let projectPath: string
  let context: CLIContext

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'af-rp-v2-'))
    context = {
      sessionId: 'sess-test',
      projectPath
    }
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('creates and lists paper artifacts in canonical paper type', () => {
    const created = createArtifact({
      type: 'paper',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani'],
      abstract: 'Transformer paper',
      citeKey: 'vaswani2017attention',
      doi: '10.5555/3295222.3295349',
      bibtex: '@inproceedings{vaswani2017attention, title={Attention Is All You Need}}'
    }, context)

    expect(created.artifact.type).toBe('paper')

    const artifacts = listArtifacts(projectPath, ['paper'])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.type).toBe('paper')
    expect(artifacts[0]?.title).toContain('Attention')

    const dedupHit = findExistingPaperArtifact(projectPath, {
      doi: 'https://doi.org/10.5555/3295222.3295349',
      title: 'Attention Is All You Need',
      citeKey: 'vaswani2017attention',
      year: 2017
    })

    expect(dedupHit?.id).toBe(created.artifact.id)
  })

  it('migrates legacy literature/data artifact shapes in place', () => {
    const papersDir = join(projectPath, '.research-pilot', 'artifacts', 'papers')
    const dataDir = join(projectPath, '.research-pilot', 'artifacts', 'data')
    mkdirSync(papersDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    const legacyPaperPath = join(papersDir, 'legacy-paper.json')
    writeFileSync(legacyPaperPath, JSON.stringify({
      id: 'legacy-paper',
      type: 'literature',
      title: 'Legacy Paper',
      tags: [],
      provenance: { source: 'user', sessionId: 's' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      authors: ['A'],
      abstract: '',
      citeKey: 'a2026',
      doi: 'unknown:a2026',
      bibtex: '@article{a2026,title={Legacy Paper}}'
    }, null, 2), 'utf-8')

    const legacyDataPath = join(dataDir, 'legacy-data.json')
    writeFileSync(legacyDataPath, JSON.stringify({
      id: 'legacy-data',
      type: 'data',
      name: 'Legacy Data',
      tags: [],
      provenance: { source: 'user', sessionId: 's' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      filePath: 'data.csv'
    }, null, 2), 'utf-8')

    const migration = migrateLegacyArtifacts(projectPath)
    expect(migration.updatedFiles).toBe(2)
    expect(migration.convertedLiteratureType).toBe(1)
    expect(migration.removedDataNameField).toBe(1)

    const migratedPaper = readArtifactFromFile(legacyPaperPath)
    expect(migratedPaper?.type).toBe('paper')

    const migratedDataRaw = JSON.parse(readFileSync(legacyDataPath, 'utf-8'))
    expect(migratedDataRaw.title).toBe('Legacy Data')
    expect(migratedDataRaw.name).toBeUndefined()
  })
})
