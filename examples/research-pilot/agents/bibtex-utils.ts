/**
 * BibTeX Generation Utility
 *
 * Provides functions to fetch or generate BibTeX entries for papers.
 * - DBLP: Fetch from their BibTeX export API
 * - arXiv: Generate from arxiv ID using standard format
 * - Others: Generate from metadata (title, authors, year, venue, doi)
 */

/**
 * Paper metadata needed for BibTeX generation
 */
export interface PaperMetadata {
  id: string
  title: string
  authors: string[]
  year: number
  venue?: string | null
  url?: string
  doi?: string | null
  source: string
}

/**
 * Escape special LaTeX characters in a string
 */
function escapeLatex(text: string): string {
  return text
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\$/g, '\\$')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

/**
 * Generate a cite key from authors and year
 */
function generateCiteKey(authors: string[], year: number): string {
  const firstAuthor = authors[0] || 'Unknown'
  // Get last name of first author
  const lastName = firstAuthor.split(' ').pop()?.toLowerCase() || 'unknown'
  // Remove non-alphanumeric characters
  const cleanName = lastName.replace(/[^a-z0-9]/gi, '')
  return `${cleanName}${year || 'nd'}`
}

/**
 * Format authors for BibTeX (Last, First and Last, First and ...)
 */
function formatAuthors(authors: string[]): string {
  return authors
    .slice(0, 10)  // Limit to first 10 authors
    .map(name => {
      const parts = name.trim().split(/\s+/)
      if (parts.length === 1) return escapeLatex(parts[0])
      const lastName = parts.pop()
      const firstNames = parts.join(' ')
      return `${escapeLatex(lastName || '')}, ${escapeLatex(firstNames)}`
    })
    .join(' and ')
}

/**
 * Fetch BibTeX from DBLP API
 *
 * @param dblpKey - The DBLP key (e.g., "journals/corr/abs-2024-12345")
 * @returns BibTeX string or null if fetch fails
 */
export async function fetchDblpBibtex(dblpKey: string): Promise<string | null> {
  try {
    // Clean the key if it has a prefix
    const cleanKey = dblpKey.replace(/^(https?:\/\/dblp\.org\/rec\/)?/, '')

    const url = `https://dblp.org/rec/${cleanKey}.bib`
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'Accept': 'text/plain'
      }
    })

    if (!response.ok) {
      return null
    }

    const bibtex = await response.text()

    // Validate it looks like BibTeX
    if (bibtex.includes('@') && bibtex.includes('{')) {
      return bibtex.trim()
    }

    return null
  } catch {
    return null
  }
}

/**
 * Generate BibTeX for an arXiv paper
 *
 * @param arxivId - The arXiv ID (e.g., "2301.12345")
 * @param paper - Paper metadata
 * @returns BibTeX string
 */
export function generateArxivBibtex(
  arxivId: string,
  paper: PaperMetadata
): string {
  const citeKey = generateCiteKey(paper.authors, paper.year)
  const authors = formatAuthors(paper.authors)
  const title = escapeLatex(paper.title)

  return `@article{${citeKey},
  title = {${title}},
  author = {${authors}},
  journal = {arXiv preprint arXiv:${arxivId}},
  year = {${paper.year || 'n.d.'}},
  url = {https://arxiv.org/abs/${arxivId}},
  note = {arXiv:${arxivId}}
}`
}

/**
 * Generate BibTeX from paper metadata (fallback for non-DBLP sources)
 *
 * @param paper - Paper metadata
 * @returns BibTeX string
 */
export function generateBibtex(paper: PaperMetadata): string {
  // For arXiv papers, use specialized format
  if (paper.source === 'arxiv' && paper.id) {
    const arxivId = paper.id.includes('/') ? paper.id.split('/').pop() : paper.id
    return generateArxivBibtex(arxivId || paper.id, paper)
  }

  const citeKey = generateCiteKey(paper.authors, paper.year)
  const authors = formatAuthors(paper.authors)
  const title = escapeLatex(paper.title)

  // Determine entry type based on venue
  const hasVenue = paper.venue && paper.venue.trim().length > 0
  const entryType = hasVenue ? 'inproceedings' : 'article'

  const lines: string[] = [
    `@${entryType}{${citeKey},`,
    `  title = {${title}},`,
    `  author = {${authors}},`
  ]

  if (hasVenue) {
    lines.push(`  booktitle = {${escapeLatex(paper.venue!)}},`)
  }

  lines.push(`  year = {${paper.year || 'n.d.'}},`)

  if (paper.doi) {
    lines.push(`  doi = {${paper.doi}},`)
  }

  if (paper.url) {
    lines.push(`  url = {${paper.url}},`)
  }

  // Remove trailing comma from last line
  const lastLine = lines[lines.length - 1]
  lines[lines.length - 1] = lastLine.replace(/,$/, '')

  lines.push('}')

  return lines.join('\n')
}

/**
 * Get or generate BibTeX for a paper based on its source
 *
 * @param paper - Paper metadata
 * @returns BibTeX string (may be generated or fetched)
 */
export async function getBibtex(paper: PaperMetadata): Promise<string> {
  // For DBLP papers, try to fetch first
  if (paper.source === 'dblp' && paper.id) {
    const fetched = await fetchDblpBibtex(paper.id)
    if (fetched) return fetched
  }

  // Fall back to generation
  return generateBibtex(paper)
}
