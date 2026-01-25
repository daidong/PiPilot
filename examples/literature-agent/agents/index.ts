/**
 * Literature Agent - Agent Definitions
 *
 * Exports all specialized agents for the literature research team.
 */

// Mock agents (for demo/testing without API keys)
export { createQueryPlannerAgent, type QueryPlannerAgent, type QueryPlan } from './query-planner.js'
export { createSearcherAgent, type SearcherAgent, type SearchRequest, type SearchResults } from './searcher.js'
export { createReviewerAgent, type ReviewerAgent, type ReviewInput, type ReviewResult } from './reviewer.js'
export { createSummarizerAgent, type SummarizerAgent, type SummaryInput, type ResearchSummary } from './summarizer.js'

// LLM-powered agents (real LLM calls + API searches, requires OPENAI_API_KEY)
export {
  createLLMQueryPlannerAgent,
  type LLMQueryPlannerAgent,
  type QueryPlannerConfig,
  type QueryPlan as LLMQueryPlan
} from './llm-query-planner.js'

export {
  createLLMSearcherAgent,
  type LLMSearcherAgent,
  type SearcherConfig,
  type SearchResults as LLMSearchResults
} from './llm-searcher.js'

export {
  createLLMReviewerAgent,
  type LLMReviewerAgent,
  type ReviewerConfig,
  type ReviewResult as LLMReviewResult
} from './llm-reviewer.js'

export {
  createLLMSummarizerAgent,
  type LLMSummarizerAgent,
  type SummarizerConfig,
  type ResearchSummary as LLMResearchSummary
} from './llm-summarizer.js'
