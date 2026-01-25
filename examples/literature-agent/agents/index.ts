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

// LLM-powered agents (real LLM calls, requires API key)
export { createLLMQueryPlannerAgent, type LLMQueryPlannerAgent } from './llm-query-planner.js'
export { createLLMSearcherAgent, type LLMSearcherAgent } from './llm-searcher.js'
export { createLLMReviewerAgent, type LLMReviewerAgent } from './llm-reviewer.js'
export { createLLMSummarizerAgent, type LLMSummarizerAgent } from './llm-summarizer.js'
