/**
 * Searcher Agent
 *
 * Executes search queries across multiple academic sources.
 * Handles the actual API calls and paper collection.
 */

import type { Paper } from '../types.js'
import { LITERATURE_DEFAULTS } from '../types.js'

export interface SearchRequest {
  queries: string[]
  sources?: string[]
  maxPerSource?: number
  timeRange?: { start: number; end: number }
}

export interface SearchResults {
  papers: Paper[]
  totalFound: number
  sourcesSearched: string[]
  sourcesSucceeded: string[]
  sourcesFailed: string[]
  queriesUsed: string[]
}

export interface SearcherAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

// Simulated paper database for demo
const MOCK_PAPERS: Paper[] = [
  {
    id: 'paper-1',
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    authors: ['Patrick Lewis', 'Ethan Perez', 'et al.'],
    abstract: 'We explore a general-purpose fine-tuning recipe for retrieval-augmented generation (RAG). RAG models combine pre-trained parametric and non-parametric memory for language generation.',
    year: 2020,
    venue: 'NeurIPS',
    citationCount: 3500,
    url: 'https://arxiv.org/abs/2005.11401',
    source: 'arxiv'
  },
  {
    id: 'paper-2',
    title: 'Dense Passage Retrieval for Open-Domain Question Answering',
    authors: ['Vladimir Karpukhin', 'Barlas Oguz', 'et al.'],
    abstract: 'Open-domain question answering relies on efficient passage retrieval to select candidate contexts. We show that retrieval can be practically implemented using dense representations alone.',
    year: 2020,
    venue: 'EMNLP',
    citationCount: 2800,
    url: 'https://arxiv.org/abs/2004.04906',
    source: 'semantic_scholar'
  },
  {
    id: 'paper-3',
    title: 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',
    authors: ['Akari Asai', 'Zeqiu Wu', 'et al.'],
    abstract: 'We introduce Self-RAG, a framework that trains a single LM to adaptively retrieve passages on-demand and generate and critique its own generation.',
    year: 2023,
    venue: 'arXiv',
    citationCount: 450,
    url: 'https://arxiv.org/abs/2310.11511',
    source: 'arxiv'
  },
  {
    id: 'paper-4',
    title: 'REPLUG: Retrieval-Augmented Black-Box Language Models',
    authors: ['Weijia Shi', 'Sewon Min', 'et al.'],
    abstract: 'We introduce REPLUG, a retrieval-augmented language modeling framework that treats the language model as a black box and augments it with a tunable retrieval model.',
    year: 2023,
    venue: 'NAACL',
    citationCount: 320,
    url: 'https://arxiv.org/abs/2301.12652',
    source: 'semantic_scholar'
  },
  {
    id: 'paper-5',
    title: 'Active Retrieval Augmented Generation',
    authors: ['Zhengbao Jiang', 'Frank Xu', 'et al.'],
    abstract: 'We propose FLARE, Forward-Looking Active REtrieval augmented generation, which iteratively uses a prediction of the upcoming sentence to anticipate future content.',
    year: 2023,
    venue: 'EMNLP',
    citationCount: 280,
    url: 'https://arxiv.org/abs/2305.06983',
    source: 'openalex'
  },
  {
    id: 'paper-6',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'et al.'],
    abstract: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
    year: 2017,
    venue: 'NeurIPS',
    citationCount: 85000,
    url: 'https://arxiv.org/abs/1706.03762',
    source: 'arxiv'
  },
  {
    id: 'paper-7',
    title: 'BERT: Pre-training of Deep Bidirectional Transformers',
    authors: ['Jacob Devlin', 'Ming-Wei Chang', 'et al.'],
    abstract: 'We introduce BERT, designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context.',
    year: 2019,
    venue: 'NAACL',
    citationCount: 72000,
    url: 'https://arxiv.org/abs/1810.04805',
    source: 'semantic_scholar'
  },
  {
    id: 'paper-8',
    title: 'Lost in the Middle: How Language Models Use Long Contexts',
    authors: ['Nelson F. Liu', 'Kevin Lin', 'et al.'],
    abstract: 'We analyze how language models use information in long contexts. We find that performance degrades when relevant information is in the middle of the context.',
    year: 2023,
    venue: 'TACL',
    citationCount: 520,
    url: 'https://arxiv.org/abs/2307.03172',
    source: 'arxiv'
  }
]

/**
 * Create a Searcher Agent
 *
 * This is a mock implementation using simulated data.
 * In production, this would call actual academic APIs.
 */
export function createSearcherAgent(): SearcherAgent {
  let searchCount = 0

  return {
    id: 'searcher',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      searchCount++
      console.log(`  [Searcher] Search #${searchCount}, processing request...`)

      let request: SearchRequest
      try {
        const parsed = JSON.parse(input)
        // Handle both QueryPlan and direct SearchRequest
        if (parsed.searchQueries) {
          request = {
            queries: parsed.searchQueries,
            sources: parsed.searchStrategy?.suggestedSources,
            timeRange: parsed.searchStrategy?.timeRange
          }
        } else if (parsed.additionalQueries) {
          // Feedback from reviewer
          request = {
            queries: parsed.additionalQueries,
            sources: parsed.sources
          }
        } else {
          request = parsed as SearchRequest
        }
      } catch {
        return { success: false, output: JSON.stringify({ error: 'Invalid input format' }) }
      }

      console.log(`  [Searcher] Searching with queries: ${request.queries.join(', ')}`)

      // Simulate search by filtering mock papers
      const queryTerms = request.queries.flatMap(q => q.toLowerCase().split(/\s+/))
      let matchedPapers = MOCK_PAPERS.filter(paper => {
        const paperText = `${paper.title} ${paper.abstract}`.toLowerCase()
        return queryTerms.some(term => paperText.includes(term))
      })

      // Apply time range filter if specified
      if (request.timeRange) {
        matchedPapers = matchedPapers.filter(p =>
          p.year >= request.timeRange!.start && p.year <= request.timeRange!.end
        )
      }

      // Limit results
      const maxPapers = (request.maxPerSource || LITERATURE_DEFAULTS.maxPapersPerSource) * 3
      matchedPapers = matchedPapers.slice(0, maxPapers)

      const results: SearchResults = {
        papers: matchedPapers,
        totalFound: matchedPapers.length,
        sourcesSearched: request.sources || ['semantic_scholar', 'arxiv', 'openalex'],
        sourcesSucceeded: ['semantic_scholar', 'arxiv', 'openalex'],
        sourcesFailed: [],
        queriesUsed: request.queries
      }

      console.log(`  [Searcher] Found ${results.papers.length} papers`)

      return { success: true, output: JSON.stringify(results) }
    },

    async destroy() {
      // Cleanup if needed
    }
  }
}
