import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CLIContext } from '../../../examples/research-pilot/types.js'
import {
  addFocusEntry,
  createArtifact,
  findExistingPaperArtifact,
  listArtifacts,
  pruneExpiredFocusAtTurnBoundary
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

  it('applies turn-boundary expiry and cooldown for auto focus entries', () => {
    const now = new Date('2026-01-01T10:00:00.000Z')
    const add = addFocusEntry(projectPath, {
      sessionId: context.sessionId,
      refType: 'artifact',
      refId: 'art_123',
      reason: 'auto mention',
      score: 0.8,
      source: 'auto',
      ttl: '30m',
      now
    })

    expect(add.ok).toBe(true)

    const prune = pruneExpiredFocusAtTurnBoundary(
      projectPath,
      context.sessionId,
      new Date('2026-01-01T10:31:00.000Z'),
      15
    )

    expect(prune.expired).toBe(1)
    expect(prune.kept).toBe(0)

    const blockedAuto = addFocusEntry(projectPath, {
      sessionId: context.sessionId,
      refType: 'artifact',
      refId: 'art_123',
      reason: 'auto repromote',
      score: 0.7,
      source: 'auto',
      ttl: '30m',
      now: new Date('2026-01-01T10:35:00.000Z')
    })

    expect(blockedAuto.ok).toBe(false)
    expect(blockedAuto.reason).toContain('cooldown-active-until')

    const allowedManual = addFocusEntry(projectPath, {
      sessionId: context.sessionId,
      refType: 'artifact',
      refId: 'art_123',
      reason: 'manual override',
      score: 1,
      source: 'manual',
      ttl: '2h',
      now: new Date('2026-01-01T10:35:00.000Z')
    })

    expect(allowedManual.ok).toBe(true)
  })
})
