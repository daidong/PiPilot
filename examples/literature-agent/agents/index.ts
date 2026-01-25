/**
 * Literature Agent - Agent Definitions
 *
 * Exports LLM-powered agents for the literature research team.
 */

// LLM-powered agents (requires OPENAI_API_KEY)
export {
  createLLMQueryPlannerAgent,
  type LLMQueryPlannerAgent,
  type QueryPlannerConfig,
  type QueryPlan
} from './llm-query-planner.js'

export {
  createLLMSearcherAgent,
  type LLMSearcherAgent,
  type SearcherConfig,
  type SearchResults
} from './llm-searcher.js'

export {
  createLLMReviewerAgent,
  type LLMReviewerAgent,
  type ReviewerConfig,
  type ReviewResult
} from './llm-reviewer.js'

export {
  createLLMSummarizerAgent,
  type LLMSummarizerAgent,
  type SummarizerConfig,
  type ResearchSummary
} from './llm-summarizer.js'
