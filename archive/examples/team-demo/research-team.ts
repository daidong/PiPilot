/**
 * Research Team - Real Multi-Agent Example with LLM Agents
 *
 * A three-agent pipeline that takes a research topic and produces
 * a structured report:
 *
 *   Researcher  -->  Analyst  -->  Writer
 *   (gather)       (analyze)     (report)
 *
 * Each agent uses defineAgent (schema-free) with JSON output mode.
 * The team uses simpleStep/simpleSeq for clean flow definition
 * and createAutoTeamRuntime for zero-boilerplate agent invocation.
 *
 * ## How to Run
 *
 *   # Set one of these:
 *   export OPENAI_API_KEY=sk-...
 *   # or
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *
 *   # Run:
 *   npx tsx examples/team-demo/research-team.ts
 *   npx tsx examples/team-demo/research-team.ts "quantum computing"
 */

import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'

import {
  defineAgent,
  createAgentContext,
  type Agent,
  type AgentContext
} from '../../src/agent/define-simple-agent.js'

import {
  defineTeam,
  agentHandle,
  stateConfig
} from '../../src/team/define-team.js'

import { simpleStep, simpleSeq } from '../../src/team/flow/simple-step.js'
import { createAutoTeamRuntime } from '../../src/team/team-runtime.js'

// ============================================================================
// 1. Detect LLM Provider
// ============================================================================

function resolveLanguageModel(): LanguageModel {
  const openaiKey = process.env.OPENAI_API_KEY?.trim()
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()

  if (openaiKey) {
    console.log('[config] Using OpenAI (gpt-4o)')
    const openai = createOpenAI({ apiKey: openaiKey })
    return openai.chat('gpt-4o')
  }

  if (anthropicKey) {
    console.log('[config] Using Anthropic (claude-sonnet-4-5-20250929)')
    const anthropic = createAnthropic({ apiKey: anthropicKey })
    return anthropic('claude-sonnet-4-5-20250929')
  }

  console.error(
    '\nError: No API key found.\n\n' +
    'Set one of the following environment variables:\n' +
    '  export OPENAI_API_KEY=sk-...\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n'
  )
  process.exit(1)
}

// ============================================================================
// 2. Define Agents (schema-free, JSON output mode)
// ============================================================================

/**
 * Researcher: gathers key facts and sources on a topic.
 *
 * Input:  { topic: string }
 * Output: { findings: string[], sources: string[], summary: string }
 */
const researcher = defineAgent({
  id: 'researcher',
  description: 'Gathers key facts, findings, and sources on a research topic',
  system: `You are an expert research assistant. Given a topic, produce a thorough
research brief with key findings, supporting evidence, and source references.

Output JSON:
{
  "findings": ["finding 1", "finding 2", ...],
  "sources": ["source 1", "source 2", ...],
  "summary": "A 2-3 sentence summary of the research landscape"
}

Be specific and factual. Include at least 5 findings and 3 sources.`,
  prompt: (input) => {
    const topic = typeof input === 'string'
      ? input
      : (input as Record<string, unknown>)?.topic ?? JSON.stringify(input)
    return `Research the following topic thoroughly:\n\n${topic}`
  },
  temperature: 0.5,
  maxTokens: 2000
})

/**
 * Analyst: takes research findings and produces structured analysis.
 *
 * Input:  { findings, sources, summary }  (researcher output)
 * Output: { themes: [...], gaps: [...], keyInsights: [...], recommendation: string }
 */
const analyst = defineAgent({
  id: 'analyst',
  description: 'Analyzes research findings to identify themes, gaps, and insights',
  system: `You are a senior research analyst. Given raw research findings,
identify patterns, themes, gaps in knowledge, and key insights.

Output JSON:
{
  "themes": [
    { "name": "theme name", "description": "brief description", "evidence": ["supporting finding"] }
  ],
  "gaps": ["gap 1", "gap 2"],
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "recommendation": "A one-paragraph recommendation for further research or action"
}

Be analytical and critical. Identify at least 3 themes and 2 gaps.`,
  prompt: (input) => {
    const data = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return `Analyze the following research findings:\n\n${data}`
  },
  temperature: 0.3,
  maxTokens: 2000
})

/**
 * Writer: composes a final research report from the analysis.
 *
 * Input:  { themes, gaps, keyInsights, recommendation }  (analyst output)
 * Output: { title: string, sections: [...], conclusion: string }
 */
const writer = defineAgent({
  id: 'writer',
  description: 'Writes a structured research report from analysis results',
  system: `You are a professional technical writer. Given structured analysis,
compose a clear, well-organized research report.

Output JSON:
{
  "title": "Report title",
  "sections": [
    { "heading": "Section heading", "content": "Section body text (2-4 paragraphs)" }
  ],
  "conclusion": "A concise concluding paragraph with actionable takeaways"
}

Write clearly and professionally. Include at least 3 sections.
Each section should be substantive (at least 2 paragraphs).`,
  prompt: (input) => {
    const data = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return `Write a research report based on this analysis:\n\n${data}`
  },
  temperature: 0.7,
  maxTokens: 3000
})

// ============================================================================
// 3. Create Runner Functions
//
// The team system calls runner(input, context) for each agent.
// We bridge to defineAgent's agent.run(input, agentContext) here.
// ============================================================================

function createRunner(agent: Agent, getModel: () => LanguageModel) {
  return async (input: unknown, _ctx: unknown): Promise<unknown> => {
    const agentCtx: AgentContext = createAgentContext(
      () => getModel(),
      {
        trace: (event) => {
          if (event.type === 'agent.retry') {
            console.log(`  [retry] ${agent.id}: attempt ${event.attempt}`)
          }
        }
      }
    )

    const result = await agent.run(input, agentCtx)

    if (!result.success) {
      throw new Error(`Agent '${agent.id}' failed: ${result.error}`)
    }

    console.log(
      `  [done] ${agent.id}: ${result.usage.totalTokens} tokens, ` +
      `${result.durationMs}ms, ${result.attempts} attempt(s)`
    )

    // Return just the output (the team flow stores this in state via .to())
    // Token usage is logged above per-agent; team-level tracking would require
    // returning the full AgentResult, but the flow system expects plain data.
    return result.output
  }
}

// ============================================================================
// 4. Define the Team
//
// Uses simpleStep().from().to() for clean state wiring:
//   researcher reads initial input -> writes to 'research'
//   analyst   reads 'research'     -> writes to 'analysis'
//   writer    reads 'analysis'     -> writes to 'report'
// ============================================================================

function buildTeam(getModel: () => LanguageModel) {
  const researcherRunner = createRunner(researcher, getModel)
  const analystRunner = createRunner(analyst, getModel)
  const writerRunner = createRunner(writer, getModel)

  const team = defineTeam({
    id: 'research-team',
    name: 'Research Team',
    description: 'Researcher -> Analyst -> Writer pipeline',

    agents: {
      researcher: agentHandle('researcher', researcher, {
        role: 'Gathers facts and sources on a topic',
        runner: researcherRunner
      }),
      analyst: agentHandle('analyst', analyst, {
        role: 'Identifies themes, gaps, and insights',
        runner: analystRunner
      }),
      writer: agentHandle('writer', writer, {
        role: 'Writes the final structured report',
        runner: writerRunner
      })
    },

    // Sequential pipeline: researcher -> analyst -> writer
    flow: simpleSeq(
      simpleStep('researcher').to('research'),
      simpleStep('analyst').from('research').to('analysis'),
      simpleStep('writer').from('analysis').to('report')
    ),

    state: stateConfig.memory('research-team')
  })

  return team
}

// ============================================================================
// 5. Run the Team
// ============================================================================

async function main() {
  // Get topic from CLI args or use default
  const topic = process.argv[2] || 'The current state and future of large language model agents'

  console.log('=== Research Team: Real LLM Agent Pipeline ===\n')
  console.log(`Topic: "${topic}"\n`)

  // Resolve LLM provider
  const model = resolveLanguageModel()
  const getModel = () => model

  // Build team
  const team = buildTeam(getModel)

  // Create runtime with auto-invocation (no manual switch needed)
  const runtime = createAutoTeamRuntime({
    team,
    context: {},  // Runners handle their own context

    // Progress monitoring
    onProgress: ({ step, agentId, status }) => {
      if (agentId) {
        console.log(`\n[step ${step}] ${status} ${agentId}...`)
      }
    }
  })

  // Subscribe to events for detailed monitoring
  runtime.on('agent.started', ({ agentId }) => {
    console.log(`  [start] ${agentId}`)
  })

  runtime.on('agent.failed', ({ agentId, error }) => {
    console.error(`  [fail] ${agentId}: ${error.message}`)
  })

  runtime.on('team.completed', ({ durationMs, totalTokens }) => {
    console.log(`\n[team] Completed in ${(durationMs / 1000).toFixed(1)}s`)
    if (totalTokens) {
      console.log(
        `[team] Total tokens: ${totalTokens.totalTokens} ` +
        `(prompt: ${totalTokens.promptTokens}, completion: ${totalTokens.completionTokens})`
      )
    }
  })

  // Run the team
  const startTime = Date.now()
  const result = await runtime.run({ topic })
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // Print results
  console.log('\n' + '='.repeat(60))

  if (!result.success) {
    console.error(`\nTeam failed: ${result.error}`)
    process.exit(1)
  }

  // Extract the report from final state or direct output
  // (simpleStep().to('report') stores it in state; result.output is the last step's return)
  const raw = (result.finalState?.report ?? result.output) as Record<string, unknown> | undefined
  const report = raw as {
    title?: string
    sections?: Array<{ heading: string; content: string }>
    conclusion?: string
  } | undefined

  if (report?.title) {
    console.log(`\n# ${report.title}\n`)

    if (report.sections) {
      for (const section of report.sections) {
        console.log(`## ${section.heading}\n`)
        console.log(`${section.content}\n`)
      }
    }

    if (report.conclusion) {
      console.log(`## Conclusion\n`)
      console.log(`${report.conclusion}\n`)
    }
  } else {
    // Fallback: print raw output
    console.log('\nFinal output:')
    console.log(JSON.stringify(result.output, null, 2))
  }

  // Print usage summary
  console.log('='.repeat(60))
  console.log(`\nRun ID: ${result.runId}`)
  console.log(`Steps:  ${result.steps}`)
  console.log(`Time:   ${elapsed}s`)

  if (result.usage) {
    console.log(`Tokens: ${result.usage.totalTokens.totalTokens} total`)
    for (const [agentId, stats] of Object.entries(result.usage.perAgent)) {
      console.log(
        `  ${agentId}: ${stats.tokens.totalTokens} tokens, ` +
        `${stats.calls} call(s), ${Math.round(stats.avgDurationMs)}ms avg`
      )
    }
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err.message ?? err)
  process.exit(1)
})
