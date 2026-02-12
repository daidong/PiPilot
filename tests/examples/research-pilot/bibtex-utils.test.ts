import { describe, it, expect, vi } from 'vitest'

import { getBibtex } from '../../../examples/research-pilot/agents/bibtex-utils.js'

describe('bibtex utils', () => {
  it('prefers citation skill resolver when DOI is available', async () => {
    const resolver = vi.fn(async () => '@article{demo2026,\n  title={Demo}\n}')
    const paper = {
      id: 'x',
      title: 'Demo',
      authors: ['Demo Author'],
      year: 2026,
      doi: '10.1000/demo',
      source: 'semantic_scholar'
    }

    const bib = await getBibtex(paper, { resolveDoiBibtex: resolver })
    expect(resolver).toHaveBeenCalledWith('10.1000/demo')
    expect(bib).toContain('@article{demo2026')
  })

  it('falls back to generated BibTeX when resolver does not return entry', async () => {
    const paper = {
      id: 'x',
      title: 'Fallback',
      authors: ['Alice Smith'],
      year: 2025,
      source: 'semantic_scholar'
    }

    const bib = await getBibtex(paper, {
      resolveDoiBibtex: async () => null
    })

    expect(bib).toContain('@article{smith2025')
    expect(bib).toContain('title = {Fallback}')
  })
})
