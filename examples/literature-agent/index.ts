/**
 * Literature Research Multi-Agent Team
 *
 * A contract-first multi-agent system for academic literature research:
 * - Zod schemas for typed input/output contracts
 * - defineLLMAgent() for type-safe LLM agents
 * - step() builder for readable flow definition
 * - mapInput() for edge transformations
 * - Runtime events for observability
 *
 * Team Structure:
 *   Planner (LLM) → Searcher (APIs) → loop(Reviewer → Searcher) → Summarizer (LLM)
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx examples/literature-agent/index.ts
 */

import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";

import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  loop,
  createAutoTeamRuntime,
  step,
  state,
  mapInput,
  branch,
  noop,
  until,
} from "../../src/team/index.js";

import {
  defineLLMAgent,
  type LLMAgent,
  type LLMAgentContext,
} from "../../src/agent/define-llm-agent.js";

import {
  SearchMetadataSchema,
  boundedArray,
  type SearchMetadata,
  type SourceQueryResult,
  buildSearchMetadata,
} from "../../src/llm/schema-utils.js";

// ============================================================================
// Schemas (Contracts)
// ============================================================================

// Paper schema - shared across agents (bounded arrays prevent token explosion)
const PaperSchema = z.object({
  id: z.string(),
  title: z.string(),
  authors: boundedArray(z.string(), 20), // Max 20 authors per paper
  abstract: z.string(),
  year: z.number(),
  venue: z.string().optional(),
  citationCount: z.number().optional(),
  url: z.string(),
  source: z.enum(["semantic_scholar", "arxiv", "openalex"]),
  doi: z.string().optional(),
  pdfUrl: z.string().optional(),
  relevanceScore: z.number().optional(),
});

type Paper = z.infer<typeof PaperSchema>;

// Query Planner
const QueryPlanInputSchema = z.object({
  userRequest: z.string(),
});

const QueryPlanOutputSchema = z.object({
  originalRequest: z.string(),
  searchQueries: boundedArray(z.string(), 3, 1), // 1-3 search queries
  searchStrategy: z.object({
    focusAreas: boundedArray(z.string(), 5), // Max 5 focus areas
    suggestedSources: boundedArray(
      z.enum(["semantic_scholar", "arxiv", "openalex"]),
      3,
    ),
    timeRange: z.object({ start: z.number(), end: z.number() }).optional(),
  }),
  expectedTopics: boundedArray(z.string(), 8), // Max 8 expected topics
});

type QueryPlan = z.infer<typeof QueryPlanOutputSchema>;

// Search Results (with metadata for observability)
const SearchResultsSchema = z.object({
  papers: z.array(PaperSchema),
  totalFound: z.number(),
  queriesUsed: z.array(z.string()),
  metadata: SearchMetadataSchema,
});

type SearchResults = z.infer<typeof SearchResultsSchema>;

// Review Result (bounded to prevent token explosion in loop)
const ReviewResultSchema = z.object({
  approved: z.boolean(),
  relevantPapers: boundedArray(PaperSchema, 20), // Max 20 relevant papers
  confidence: z.number().min(0).max(1),
  coverage: z.object({
    score: z.number().min(0).max(1),
    coveredTopics: boundedArray(z.string(), 10), // Max 10 covered topics
    missingTopics: boundedArray(z.string(), 10), // Max 10 missing topics
  }),
  issues: boundedArray(z.string(), 10), // Max 10 issues
  additionalQueries: boundedArray(z.string(), 3).optional(), // Max 3 additional queries
});

type ReviewResult = z.infer<typeof ReviewResultSchema>;

// Research Summary (bounded outputs for predictable token usage)
const ResearchSummarySchema = z.object({
  title: z.string(),
  overview: z.string(),
  papers: boundedArray(
    z.object({
      title: z.string(),
      authors: z.string(),
      year: z.number(),
      summary: z.string(),
      url: z.string(),
    }),
    15,
  ), // Max 15 paper summaries
  themes: boundedArray(
    z.object({
      name: z.string(),
      papers: boundedArray(z.string(), 10), // Max 10 paper refs per theme
      insight: z.string(),
    }),
    6,
  ), // Max 6 themes
  keyFindings: boundedArray(z.string(), 8), // Max 8 key findings
  researchGaps: boundedArray(z.string(), 5), // Max 5 research gaps
});

type ResearchSummary = z.infer<typeof ResearchSummarySchema>;

// ============================================================================
// LLM Agents (Contract-First)
// ============================================================================

const planner = defineLLMAgent({
  id: "planner",
  description: "Query Planning Specialist for academic literature research",
  inputSchema: QueryPlanInputSchema,
  outputSchema: QueryPlanOutputSchema,
  system: `You are a Query Planning Specialist for academic literature research.
Analyze research requests and create optimized search strategies.
Generate 2-3 diverse search queries covering different aspects.
Use academic terminology and consider synonyms, acronyms, and related concepts.`,
  buildPrompt: ({ userRequest }) =>
    `Analyze this research request and create a search strategy:\n\n"${userRequest}"`,
});

const reviewer = defineLLMAgent({
  id: "reviewer",
  description: "Research Quality Reviewer who evaluates search results",
  inputSchema: SearchResultsSchema,
  outputSchema: ReviewResultSchema,
  system: `You are a Research Quality Reviewer who evaluates academic paper search results.
Assess relevance (0-10 scale), analyze topic coverage, and decide if results are sufficient.
Approve if at least 3 relevant papers (score >= 7) AND coverage >= 0.7.
Only suggest additionalQueries if not approved.`,
  buildPrompt: (results) => {
    const paperSummaries = results.papers
      .slice(0, 15)
      .map(
        (p, i) =>
          `Paper ${i + 1}: "${p.title}" (${p.year}) - ${p.abstract.slice(0, 200)}...`,
      )
      .join("\n");
    return `Review these ${results.papers.length} papers:\n\n${paperSummaries}\n\nQueries used: ${results.queriesUsed.join(", ")}`;
  },
});

const summarizer = defineLLMAgent({
  id: "summarizer",
  description: "Research Synthesizer who creates comprehensive summaries",
  inputSchema: ReviewResultSchema,
  outputSchema: ResearchSummarySchema,
  system: `You are a Research Synthesis Specialist who creates comprehensive literature review summaries.
Create an insightful, well-organized summary with overview, top papers, themes, key findings, and research gaps.
Be objective and scholarly in tone.`,
  buildPrompt: (review) => {
    const paperDetails = review.relevantPapers
      .slice(0, 12)
      .map(
        (p, i) =>
          `Paper ${i + 1}: "${p.title}" by ${p.authors.slice(0, 3).join(", ")} (${p.year})\nAbstract: ${p.abstract.slice(0, 350)}`,
      )
      .join("\n\n");
    return `Create a literature review summary from these papers:\n\n${paperDetails}\n\nCovered topics: ${review.coverage.coveredTopics.join(", ")}`;
  },
});

// ============================================================================
// Searcher Agent (Tool-based, not LLM)
// ============================================================================

interface SearcherInput {
  queries: string[];
  sources: string[];
}

// Searcher is a tool agent - it calls APIs, not LLM
function createSearcherAgent() {
  return {
    id: "searcher",
    kind: "tool-agent" as const,

    async run(input: SearcherInput): Promise<{ output: SearchResults }> {
      const { queries, sources = ["semantic_scholar", "arxiv", "openalex"] } =
        input;
      const startTime = Date.now();

      if (queries.length === 0) {
        const metadata: SearchMetadata = {
          sourcesTried: [],
          sourcesSucceeded: [],
          sourcesFailed: [],
          perSourceStats: [],
          perQueryResults: [],
          totalDurationMs: 0,
          allSourcesSucceeded: true,
          hasResults: false,
        };
        return {
          output: { papers: [], totalFound: 0, queriesUsed: [], metadata },
        };
      }

      console.log(`  [Searcher] Searching: ${queries.join(", ")}`);

      const allPapers: Paper[] = [];
      const queryResults: SourceQueryResult[] = [];

      for (const query of queries) {
        for (const source of sources) {
          const queryStart = Date.now();
          try {
            const papers = await searchSource(source, query, 8);
            allPapers.push(...papers);
            queryResults.push({
              source,
              query,
              success: true,
              resultCount: papers.length,
              error: null,
              durationMs: Date.now() - queryStart,
            });
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.log(`  [Searcher] ${source} failed: ${errorMsg}`);
            queryResults.push({
              source,
              query,
              success: false,
              resultCount: 0,
              error: errorMsg,
              durationMs: Date.now() - queryStart,
            });
          }
        }
      }

      const uniquePapers = deduplicatePapers(allPapers);
      const totalDurationMs = Date.now() - startTime;
      const metadata = buildSearchMetadata(queryResults, totalDurationMs);

      console.log(`  [Searcher] Found ${uniquePapers.length} unique papers`);
      if (!metadata.allSourcesSucceeded) {
        console.log(
          `  [Searcher] Failed sources: ${metadata.sourcesFailed.join(", ")}`,
        );
      }

      return {
        output: {
          papers: uniquePapers,
          totalFound: uniquePapers.length,
          queriesUsed: queries,
          metadata,
        },
      };
    },
  };
}

// ============================================================================
// Search Utilities (Simplified)
// ============================================================================

async function searchSource(
  source: string,
  query: string,
  limit: number,
): Promise<Paper[]> {
  const encodedQuery = encodeURIComponent(query);
  let url: string;
  // arxiv API is slower, use longer timeout (60s)
  let timeoutMs = source === "arxiv" ? 60000 : 15000;

  switch (source) {
    case "semantic_scholar":
      url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${limit}&fields=paperId,title,abstract,year,venue,citationCount,url,authors`;
      break;
    case "arxiv":
      url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&max_results=${limit}`;
      break;
    case "openalex":
      url = `https://api.openalex.org/works?search=${encodedQuery}&per-page=${limit}`;
      break;
    default:
      return [];
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return [];

  if (source === "arxiv") {
    return parseArxiv(await response.text());
  }

  const data = await response.json();
  return source === "semantic_scholar"
    ? parseSemanticScholar(data)
    : parseOpenAlex(data);
}

function parseSemanticScholar(data: {
  data?: Array<Record<string, unknown>>;
}): Paper[] {
  return (data.data || []).map(
    (p): Paper => ({
      id: String(p.paperId || ""),
      title: String(p.title || "Unknown"),
      // Truncate to 20 authors to match schema bounds
      authors: ((p.authors as Array<{ name: string }>) || [])
        .slice(0, 20)
        .map((a) => a.name),
      abstract: String(p.abstract || ""),
      year: Number(p.year) || 0,
      venue: p.venue as string | undefined,
      citationCount: p.citationCount as number | undefined,
      url: String(
        p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
      ),
      source: "semantic_scholar",
    }),
  );
}

function parseArxiv(xml: string): Paper[] {
  const papers: Paper[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const id = entry.match(/<id>([^<]+)<\/id>/)?.[1] || "";
    const title = entry.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || "";
    const summary =
      entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || "";
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || "";

    const authors: string[] = [];
    const authorRegex =
      /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1]);
    }

    papers.push({
      id: id.split("/abs/")[1] || id,
      title,
      authors: authors.slice(0, 20),  // Truncate to 20 authors
      abstract: summary,
      year: parseInt(published.slice(0, 4)) || 0,
      url: id,
      source: "arxiv",
    });
  }

  return papers;
}

function parseOpenAlex(data: {
  results?: Array<Record<string, unknown>>;
}): Paper[] {
  return (data.results || []).map((w): Paper => {
    let abstract = "";
    const inverted = w.abstract_inverted_index as
      | Record<string, number[]>
      | undefined;
    if (inverted) {
      const words: [string, number][] = [];
      for (const [word, positions] of Object.entries(inverted)) {
        for (const pos of positions) words.push([word, pos]);
      }
      words.sort((a, b) => a[1] - b[1]);
      abstract = words.map((w) => w[0]).join(" ");
    }

    return {
      id: String(w.id),
      title: String(w.title || "Unknown"),
      // Truncate to 20 authors to match schema bounds
      authors: (
        (w.authorships as Array<{ author: { display_name: string } }>) || []
      )
        .slice(0, 20)
        .map((a) => a.author.display_name),
      abstract,
      year: Number(w.publication_year) || 0,
      venue: (w.primary_location as { source?: { display_name: string } })
        ?.source?.display_name,
      citationCount: w.cited_by_count as number | undefined,
      url: String(w.id),
      source: "openalex",
    };
  });
}

function deduplicatePapers(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>();
  for (const paper of papers) {
    const key =
      paper.doi || paper.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (
      !seen.has(key) ||
      (paper.citationCount || 0) > (seen.get(key)!.citationCount || 0)
    ) {
      seen.set(key, paper);
    }
  }
  return Array.from(seen.values());
}

// ============================================================================
// Team Definition (Contract-First)
// ============================================================================

export function createLiteratureTeam(config: {
  apiKey: string;
  model?: string;
  maxReviewIterations?: number;
}) {
  const { apiKey, model = "gpt-4o-mini", maxReviewIterations = 2 } = config;

  if (!apiKey) throw new Error("API key is required");

  // Create OpenAI model
  const openai = createOpenAI({ apiKey });
  const languageModel = openai(model);

  // Create searcher agent
  const searcherAgent = createSearcherAgent();

  // Define the team with contract-first approach
  const team = defineTeam({
    id: "literature-research",
    name: "Literature Research Team (Contract-First)",

    agents: {
      planner: agentHandle("planner", planner),
      searcher: agentHandle("searcher", searcherAgent),
      reviewer: agentHandle("reviewer", reviewer),
      summarizer: agentHandle("summarizer", summarizer),
    },

    state: stateConfig.memory("literature"),

    // Flow using step() builder and mapInput()
    flow: seq(
      // Step 1: Plan search strategy
      step(planner)
        .in(state.initial<{ userRequest: string }>())
        .name("Create search strategy")
        .out(state.path<QueryPlan>("plan")),

      // Step 2: Execute search (with input transformation)
      step(searcherAgent)
        .in(
          mapInput(
            state.path<QueryPlan>("plan"),
            (plan): SearcherInput => ({
              queries: plan.searchQueries,
              sources: plan.searchStrategy.suggestedSources,
            }),
          ),
        )
        .name("Execute search")
        .out(state.path<SearchResults>("search")),

      // Step 3: Review loop
      loop(
        seq(
          step(reviewer)
            .in(state.path<SearchResults>("search"))
            .name("Review results")
            .out(state.path<ReviewResult>("review")),

          // Refine search if not approved
          branch({
            when: (s: any) =>
              s.review?.approved === false &&
              s.review?.additionalQueries?.length > 0,
            then: step(searcherAgent)
              .in(
                mapInput(
                  state.path<ReviewResult>("review"),
                  (review): SearcherInput => ({
                    queries: review.additionalQueries || [],
                    sources: ["semantic_scholar", "arxiv", "openalex"],
                  }),
                ),
              )
              .name("Refine search")
              .out(state.path<SearchResults>("search")),
            else: noop,
          }),
        ),
        { type: "field-eq", path: "review.approved", value: true },
        { maxIters: maxReviewIterations },
      ),

      // Step 4: Synthesize findings
      step(summarizer)
        .in(state.path<ReviewResult>("review"))
        .name("Synthesize findings")
        .out(state.path<ResearchSummary>("summary")),
    ),

    defaults: {
      concurrency: 1,
      timeouts: { agentSec: 120, flowSec: 600 },
    },
  });

  // Create LLM agent context - passed to all agents via createAutoTeamRuntime
  const agentContext: LLMAgentContext = {
    getLanguageModel: () => languageModel,
  };

  // Create runtime - no manual agentInvoker switch needed!
  // agentHandle() auto-creates runners for agents with run() methods
  const runtime = createAutoTeamRuntime({ team, context: agentContext });

  return {
    runtime,

    // Subscribe to events for observability
    onAgentStarted(handler: (info: { agentId: string; step: number }) => void) {
      return runtime.on("agent.started", handler);
    },

    onAgentCompleted(
      handler: (info: { agentId: string; durationMs: number }) => void,
    ) {
      return runtime.on("agent.completed", handler);
    },

    // Main research function
    async research(request: string): Promise<{
      success: boolean;
      summary?: ResearchSummary;
      error?: string;
      steps: number;
      durationMs: number;
    }> {
      const result = await runtime.run({ userRequest: request });

      if (result.success && result.finalState) {
        const stateData = result.finalState["literature"] as
          | Record<string, unknown>
          | undefined;
        const summary = stateData?.summary as ResearchSummary | undefined;
        return {
          success: true,
          summary,
          steps: result.steps,
          durationMs: result.durationMs,
        };
      }

      return {
        success: false,
        error: result.error,
        steps: result.steps,
        durationMs: result.durationMs,
      };
    },
  };
}

// ============================================================================
// Main (Example Usage)
// ============================================================================

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY required");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("Literature Research Team (Contract-First)");
  console.log("=".repeat(60));
  console.log("");
  console.log("This version uses:");
  console.log("  - Zod schemas for typed contracts");
  console.log("  - defineLLMAgent() for type-safe LLM agents");
  console.log("  - step() builder for readable flow");
  console.log("  - mapInput() for edge transformations");
  console.log("");

  const team = createLiteratureTeam({ apiKey, maxReviewIterations: 2 });

  // Subscribe to events
  team.onAgentStarted(({ agentId, step }) => {
    console.log(`[Step ${step}] Starting ${agentId}...`);
  });

  team.onAgentCompleted(({ agentId, durationMs }) => {
    console.log(
      `[✓] ${agentId} completed in ${(durationMs / 1000).toFixed(1)}s`,
    );
  });

  try {
    const result = await team.research(
      "Find recent papers about retrieval augmented generation (RAG) for large language models. Focus on techniques for improving retrieval quality.",
    );

    console.log("");
    console.log("=".repeat(60));
    console.log("RESULTS");
    console.log("=".repeat(60));
    console.log(`Success: ${result.success}`);
    console.log(`Steps: ${result.steps}`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);

    if (result.summary) {
      console.log("");
      console.log(`Title: ${result.summary.title}`);
      console.log("");
      console.log("Overview:");
      console.log(`  ${result.summary.overview}`);

      console.log("");
      console.log("-".repeat(60));
      console.log("Papers:");
      result.summary.papers.forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.title}`);
        console.log(`     Authors: ${p.authors}`);
        console.log(`     Year: ${p.year}`);
        console.log(`     Summary: ${p.summary}`);
        console.log("");
      });

      console.log("-".repeat(60));
      console.log("Themes:");
      result.summary.themes.forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.name}`);
        console.log(`     Papers: ${t.papers.join(", ")}`);
        console.log(`     Insight: ${t.insight}`);
        console.log("");
      });

      console.log("-".repeat(60));
      console.log("Key Findings:");
      result.summary.keyFindings.forEach((f) => console.log(`  • ${f}`));

      console.log("");
      console.log("-".repeat(60));
      console.log("Research Gaps:");
      result.summary.researchGaps.forEach((g) => console.log(`  • ${g}`));
    }

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
  } catch (error) {
    console.error("Research failed:", error);
  }
}

if (process.argv[1]?.includes("literature-agent")) {
  main().catch(console.error);
}

export default createLiteratureTeam;
