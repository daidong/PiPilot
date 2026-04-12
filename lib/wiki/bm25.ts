/**
 * BM25 — lightweight keyword scorer for the wiki retrieval layer.
 *
 * Index shape:
 *   {
 *     version: 1,
 *     numDocs: number
 *     avgDocLen: number
 *     docLen: Record<slug, number>
 *     idf: Record<token, number>
 *     postings: Record<token, Array<{ slug, tf }>>
 *   }
 *
 * Field weights are baked in at index time — each field's raw tf is
 * multiplied by its weight before being summed into the effective tf.
 * This keeps query-time scoring a single pass over postings.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

export const BM25_K1 = 1.2
export const BM25_B = 0.75

/** Field weights for write-time tf weighting. Higher = more important. */
export const FIELD_WEIGHTS: Record<string, number> = {
  title: 10,
  tldr: 8,
  finding_statement: 7,
  alias: 7,
  dataset_name: 6,
  methods: 5,
  task: 5,
  concept_title: 5,
  heading: 3,
  body: 1,
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'and', 'or', 'but', 'in', 'on', 'at', 'by', 'for', 'with',
  'as', 'from', 'that', 'this', 'these', 'those', 'it', 'its', 'their',
  'we', 'our', 'they', 'them', 'he', 'she', 'his', 'her',
])

export function tokenize(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  // Keep letters, digits, hyphen; split on everything else.
  const raw = lower.split(/[^a-z0-9\-]+/)
  const out: string[] = []
  for (const t of raw) {
    if (!t) continue
    const trimmed = t.replace(/^-+|-+$/g, '')
    if (trimmed.length < 2) continue
    if (STOPWORDS.has(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

// ── Index builder ──────────────────────────────────────────────────────────

export interface Bm25Posting {
  slug: string
  tf: number
}

export interface Bm25Index {
  version: 1
  numDocs: number
  avgDocLen: number
  docLen: Record<string, number>
  idf: Record<string, number>
  postings: Record<string, Bm25Posting[]>
}

export class Bm25Builder {
  // Raw per-document, per-token effective tf (after field weighting).
  private docTokens = new Map<string, Map<string, number>>()
  private docLen = new Map<string, number>()

  /**
   * Add tokens from a specific field to a document. The tokens' raw tf is
   * multiplied by the field's weight (from FIELD_WEIGHTS).
   */
  addField(slug: string, field: string, text: string): void {
    const weight = FIELD_WEIGHTS[field] ?? 1
    const tokens = tokenize(text)
    if (tokens.length === 0) return

    let bucket = this.docTokens.get(slug)
    if (!bucket) {
      bucket = new Map()
      this.docTokens.set(slug, bucket)
    }
    for (const t of tokens) {
      bucket.set(t, (bucket.get(t) ?? 0) + weight)
    }
    this.docLen.set(slug, (this.docLen.get(slug) ?? 0) + tokens.length)
  }

  build(): Bm25Index {
    const numDocs = this.docTokens.size
    let totalLen = 0
    const docLen: Record<string, number> = {}
    for (const [slug, len] of this.docLen) {
      docLen[slug] = len
      totalLen += len
    }
    const avgDocLen = numDocs > 0 ? totalLen / numDocs : 0

    // Build inverted index from docTokens
    const postings: Record<string, Bm25Posting[]> = {}
    const df = new Map<string, number>()
    for (const [slug, bucket] of this.docTokens) {
      for (const [token, tf] of bucket) {
        let list = postings[token]
        if (!list) {
          list = []
          postings[token] = list
        }
        list.push({ slug, tf })
        df.set(token, (df.get(token) ?? 0) + 1)
      }
    }

    // Classic BM25 IDF (Lucene variant): log(1 + (N - df + 0.5) / (df + 0.5))
    const idf: Record<string, number> = {}
    for (const [token, dfVal] of df) {
      idf[token] = Math.log(1 + (numDocs - dfVal + 0.5) / (dfVal + 0.5))
    }

    return { version: 1, numDocs, avgDocLen, docLen, idf, postings }
  }
}

// ── Query scorer ───────────────────────────────────────────────────────────

export interface Bm25Hit {
  slug: string
  score: number
  matchedTokens: string[]
}

export function scoreQuery(
  index: Bm25Index,
  queryTokens: string[],
): Bm25Hit[] {
  if (queryTokens.length === 0) return []

  // slug -> accumulated score
  const scores = new Map<string, number>()
  const matched = new Map<string, Set<string>>()

  for (const token of queryTokens) {
    const postings = index.postings[token]
    if (!postings) continue
    const idf = index.idf[token] ?? 0
    if (idf === 0) continue

    for (const post of postings) {
      const dl = index.docLen[post.slug] ?? index.avgDocLen
      const normLen = index.avgDocLen > 0 ? dl / index.avgDocLen : 1
      const tfComponent =
        (post.tf * (BM25_K1 + 1)) / (post.tf + BM25_K1 * (1 - BM25_B + BM25_B * normLen))
      const contribution = idf * tfComponent
      scores.set(post.slug, (scores.get(post.slug) ?? 0) + contribution)

      let set = matched.get(post.slug)
      if (!set) {
        set = new Set()
        matched.set(post.slug, set)
      }
      set.add(token)
    }
  }

  const hits: Bm25Hit[] = []
  for (const [slug, score] of scores) {
    hits.push({ slug, score, matchedTokens: Array.from(matched.get(slug) ?? []) })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits
}
