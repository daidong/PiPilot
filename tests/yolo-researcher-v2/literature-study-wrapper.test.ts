import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createYoloToolWrapperPack } from '../../examples/yolo-researcher/v2/tool-wrappers.js'
import { cleanupTempDir, createTempDir } from '../test-utils.js'

describe('yolo-researcher literature-study wrapper integration', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => cleanupTempDir(dir)))
    tempDirs.length = 0
  })

  it('executes literature-study and writes canonical artifacts under current turn artifacts', async () => {
    const projectPath = await createTempDir('yolo-v2-literature-study-live-')
    tempDirs.push(projectPath)

    const pack = createYoloToolWrapperPack(projectPath)
    const tool = (pack.tools ?? []).find((entry) => entry.name === 'literature-study')
    expect(tool).toBeTruthy()

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL) => {
      const link = String(url)
      if (link.includes('semanticscholar.org')) {
        return new Response(JSON.stringify({
          data: [{
            paperId: 's2-001',
            title: 'Agentic optimization survey',
            abstract: 'Survey for agentic optimization.',
            year: 2024,
            venue: 'NeurIPS',
            citationCount: 120,
            url: 'https://www.semanticscholar.org/paper/s2-001',
            authors: [{ name: 'Ada' }, { name: 'Turing' }],
            externalIds: { DOI: '10.1000/s2-001' }
          }]
        }), { status: 200 })
      }
      if (link.includes('export.arxiv.org')) {
        return new Response(
          '<feed><entry><id>http://arxiv.org/abs/2401.00001</id><title>ArXiv Agent Paper</title><summary>agentic methods</summary><published>2024-01-01T00:00:00Z</published><author><name>Lin</name></author></entry></feed>',
          { status: 200 }
        )
      }
      if (link.includes('api.openalex.org')) {
        return new Response(JSON.stringify({
          results: [{
            id: 'https://openalex.org/W1',
            title: 'OpenAlex Agent Paper',
            abstract_inverted_index: { agentic: [0], optimization: [1] },
            publication_year: 2023,
            cited_by_count: 80,
            doi: 'https://doi.org/10.1000/openalex-1',
            authorships: [{ author: { display_name: 'Open' } }],
            primary_location: { source: { display_name: 'ICLR' } }
          }]
        }), { status: 200 })
      }
      if (link.includes('dblp.org')) {
        return new Response(JSON.stringify({
          result: {
            hits: {
              hit: [{
                '@id': 'dblp-1',
                info: {
                  '@key': 'conf/test/Agentic1',
                  title: 'DBLP Agent Paper',
                  year: '2022',
                  venue: 'ICML',
                  ee: 'https://dblp.org/rec/conf/test/Agentic1',
                  doi: '10.1000/dblp-1',
                  authors: { author: [{ text: 'Knuth' }] }
                }
              }]
            }
          }
        }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      const result = await (tool as any).execute({
        query: 'agentic optimization',
        mode: 'quick'
      }, undefined)

      expect(result.success).toBe(true)
      expect(result.data?.mode).toBe('quick')
      expect(result.data?.reviewPath).toBe('runs/turn-0001/artifacts/literature-study/review.md')
      expect(result.data?.paperListPath).toBe('runs/turn-0001/artifacts/literature-study/papers.json')

      await expect(fs.access(path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'literature-study', 'plan.json'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'literature-study', 'review.md'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'literature-study', 'papers.json'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'literature-study', 'coverage.json'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(projectPath, 'runs', 'turn-0001', 'artifacts', 'literature-study', 'summary.json'))).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
