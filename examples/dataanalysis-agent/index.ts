/**
 * Data Analysis Multi-Agent Team
 *
 * A schema-free multi-agent system for data analysis (RFC-002):
 * - JSON output mode instead of Zod schemas
 * - defineAgent() for tool-capable agents (SQL, Python, file ops)
 * - simpleStep() builder for readable flow definition
 * - Runtime events for observability
 *
 * Team Structure:
 *   Planner → Executor → loop(Reviewer → Executor) → Output
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx examples/dataanalysis-agent/index.ts
 */

import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  loop,
  createAutoTeamRuntime,
  simpleStep,
  simpleBranch,
} from "../../src/team/index.js";
import { defineAgent, packs } from "../../src/index.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULTS = {
  MAX_REVIEW_ITERATIONS: 3,
  MAX_QUERY_ROWS: 1000,
  PLANNER_MAX_STEPS: 10,
  EXECUTOR_MAX_STEPS: 30,
  REVIEWER_MAX_STEPS: 5,
};

// ============================================================================
// Agents (Tool-capable via defineAgent)
// Using JSON output mode instead of Zod schemas
// ============================================================================

const plannerAgent = defineAgent({
  id: "planner",
  name: "Data Analysis Planner",

  identity: `You are a Data Analysis Planning Agent.

Your role is to create structured analysis plans based on user requests.

## Output Format

Return a structured plan as valid JSON:

{
  "id": "plan-<timestamp>",
  "originalRequest": "the user's original question",
  "dataSources": ["source1", "source2"],
  "expectedOutput": "description of expected results",
  "steps": [
    {
      "id": "step-1",
      "type": "sql",
      "description": "Query sales data",
      "command": "SELECT * FROM sales LIMIT 1000"
    },
    {
      "id": "step-2",
      "type": "python",
      "description": "Calculate revenue",
      "command": "df.groupby('product')['revenue'].sum()",
      "dependsOn": ["step-1"]
    }
  ]
}

Step types: sql, python, file, fetch, transform`,

  constraints: [
    "Always output valid JSON plan structure",
    "Each step must have id, type, description, command",
    `SQL queries must include LIMIT ${DEFAULTS.MAX_QUERY_ROWS}`,
    "Never include sensitive data in plans",
  ],

  packs: [packs.safe(), packs.compute()],
  model: { default: "gpt-5.2", maxTokens: 4096 },
  maxSteps: DEFAULTS.PLANNER_MAX_STEPS,
});

const executorAgent = defineAgent({
  id: "executor",
  name: "Data Analysis Executor",

  identity: `You are a Data Analysis Executor Agent.

Your role is to execute analysis plans and return structured results.

## Capabilities

1. SQL: Run via sqlite3, psql, mysql
2. Python: Run via python3 -c "code"
3. File: Read CSV, JSON, Excel
4. Fetch: HTTP requests for remote data

## Output Format

Return results as valid JSON:

{
  "success": true,
  "data": { "rows": [...], "columns": [...] },
  "summary": "Found 100 records with $1.2M revenue",
  "executionTimeMs": 1234,
  "stepResults": [
    { "stepId": "step-1", "success": true, "output": {...}, "durationMs": 500 }
  ]
}

When receiving feedback with issues, address critical issues first and re-execute.`,

  constraints: [
    "NEVER execute destructive SQL (DROP, DELETE, TRUNCATE)",
    `Limit query results to ${DEFAULTS.MAX_QUERY_ROWS} rows`,
    "Always validate file paths before reading",
    "Include execution time in results",
  ],

  packs: [packs.safe(), packs.exec(), packs.network(), packs.kvMemory()],
  model: { default: "gpt-5.2", maxTokens: 8192 },
  maxSteps: DEFAULTS.EXECUTOR_MAX_STEPS,
});

const reviewerAgent = defineAgent({
  id: "reviewer",
  name: "Data Analysis Reviewer",

  identity: `You are a Data Analysis Reviewer Agent.

Your role is to review analysis results for quality and completeness.

## Review Criteria

1. Completeness: Does analysis answer the original question?
2. Correctness: Are calculations accurate?
3. Clarity: Are results understandable?
4. Robustness: Were edge cases handled?

## Issue Severity

- critical: Blocks approval (wrong data, incorrect calculations)
- major: Should be fixed (incomplete, poor performance)
- minor: Can note but doesn't block (style improvements)

## Output Format

Return feedback as valid JSON:

{
  "approved": false,
  "confidence": 0.7,
  "reviewSummary": "Analysis has calculation errors",
  "issues": [
    { "severity": "critical", "message": "Revenue excludes discounts", "stepId": "step-2" }
  ],
  "suggestions": ["Include discounts in calculation"]
}

Approval: approved=true when no critical issues AND confidence >= 0.8`,

  constraints: [
    "Never execute operations - review only",
    "Always return valid JSON feedback",
    "Critical issues must result in approved: false",
    "Provide at least one suggestion",
  ],

  packs: [packs.safe(), packs.compute()],
  model: { default: "gpt-5.2", maxTokens: 4096 },
  maxSteps: DEFAULTS.REVIEWER_MAX_STEPS,
});

// ============================================================================
// Team Definition
// ============================================================================

export interface DataAnalysisConfig {
  apiKey: string;
  projectPath?: string;
  databases?: Record<string, { type: string; path?: string; host?: string }>;
  maxReviewIterations?: number;
}

export function createDataAnalysisTeam(config: DataAnalysisConfig) {
  const {
    apiKey,
    projectPath,
    databases = {},
    maxReviewIterations = DEFAULTS.MAX_REVIEW_ITERATIONS,
  } = config;

  // Create agent instances
  const planner = plannerAgent({ apiKey, projectPath });
  const executor = executorAgent({ apiKey, projectPath });
  const reviewer = reviewerAgent({ apiKey, projectPath });

  // Helper to create a runner for defineAgent-based agents
  // These agents take string input and return string output that needs JSON parsing
  const createAgentRunner = (agent: ReturnType<typeof plannerAgent>) => {
    return async (input: unknown) => {
      const inputStr =
        typeof input === "string" ? input : JSON.stringify(input);
      const result = await agent.run(inputStr);
      return parseJsonOutput(result.output);
    };
  };

  // Define team with schema-free approach
  const team = defineTeam({
    id: "data-analysis-team",
    name: "Data Analysis Team",

    agents: {
      planner: agentHandle("planner", planner, {
        role: "Analysis Planner",
        capabilities: ["planning", "task-decomposition"],
        runner: createAgentRunner(planner),
      }),
      executor: agentHandle("executor", executor, {
        role: "Analysis Executor",
        capabilities: ["sql", "python", "file-io"],
        runner: createAgentRunner(executor),
      }),
      reviewer: agentHandle("reviewer", reviewer, {
        role: "Quality Reviewer",
        capabilities: ["validation", "quality-check"],
        runner: createAgentRunner(reviewer),
      }),
    },

    state: stateConfig.memory("data-analysis"),

    // Schema-free flow using simpleStep
    flow: seq(
      // Step 1: Create analysis plan
      simpleStep("planner").from("initial").to("plan"),

      // Step 2: Execute initial analysis
      simpleStep("executor").from("plan").to("results"),

      // Step 3: Review-refine loop
      loop(
        seq(
          simpleStep("reviewer").from("results").to("feedback"),

          // Refine if not approved
          simpleBranch({
            if: (s: unknown) => (s as any)?.feedback?.approved === false,
            then: simpleStep("executor").from("feedback").to("results"),
            else: { kind: "noop" },
          }),
        ),
        { type: "field-eq", path: "feedback.approved", value: true },
        { maxIters: maxReviewIterations },
      ),
    ),

    defaults: {
      concurrency: 1,
      timeouts: { agentSec: 120, flowSec: 600 },
    },
  });

  // Create runtime - no manual agentInvoker switch needed!
  // Custom runners are provided via agentHandle() above
  const runtime = createAutoTeamRuntime({ team, context: {} });

  return {
    runtime,

    agents: { planner, executor, reviewer },

    // Event subscriptions
    onAgentStarted(handler: (info: { agentId: string; step: number }) => void) {
      return runtime.on("agent.started", handler);
    },

    onAgentCompleted(
      handler: (info: { agentId: string; durationMs: number }) => void,
    ) {
      return runtime.on("agent.completed", handler);
    },

    // Main analysis function
    async analyze(request: string) {
      const result = await runtime.run({
        userRequest: request,
        availableDatabases: Object.keys(databases),
      });

      if (result.success && result.finalState) {
        const stateData = result.finalState["data-analysis"] as
          | Record<string, unknown>
          | undefined;
        const analysisResults = stateData?.results;
        return {
          success: true,
          output: analysisResults,
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

    getState() {
      return runtime.getState().toObject();
    },

    async destroy() {
      await Promise.all([
        planner.destroy(),
        executor.destroy(),
        reviewer.destroy(),
      ]);
    },
  };
}

// ============================================================================
// Utilities
// ============================================================================

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;

  try {
    // Try direct parse
    return JSON.parse(output);
  } catch {
    // Try extracting JSON from markdown
    const match = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return output;
      }
    }
    return output;
  }
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
  console.log("Data Analysis Team (Schema-Free API)");
  console.log("=".repeat(60));
  console.log("");

  const team = createDataAnalysisTeam({
    apiKey,
    projectPath: process.cwd(),
    maxReviewIterations: 3,
  });

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
    const result = await team.analyze(`
      Analyze the following sample data and provide insights:
      - Product A: Q1=$10K, Q2=$12K, Q3=$15K, Q4=$18K
      - Product B: Q1=$8K, Q2=$7K, Q3=$9K, Q4=$11K
      - Product C: Q1=$20K, Q2=$22K, Q3=$19K, Q4=$25K

      Questions:
      1. Which product had the highest total annual revenue?
      2. Which product showed the most consistent growth?
    `);

    console.log("");
    console.log("=".repeat(60));
    console.log("RESULTS");
    console.log("=".repeat(60));
    console.log(`Success: ${result.success}`);
    console.log(`Steps: ${result.steps}`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);

    if (result.output) {
      console.log("");
      console.log("Output:");
      console.log(JSON.stringify(result.output, null, 2));
    }

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
  } catch (error) {
    console.error("Analysis failed:", error);
  } finally {
    await team.destroy();
  }
}

if (process.argv[1]?.includes("dataanalysis-agent")) {
  main().catch(console.error);
}

export default createDataAnalysisTeam;
