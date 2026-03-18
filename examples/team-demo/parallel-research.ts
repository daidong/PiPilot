/**
 * 并行研究团队 — par() + 结果聚合
 *
 * 3 个研究员并行工作，结果通过 merge reducer 合并后交给写手。
 *
 * 用法: npx tsx parallel-research.ts
 */

import { defineTeam, agentHandle } from '../../src/team/define-team.js'
import { seq, par } from '../../src/team/flow/combinators.js'
import { createTeamRuntime, createMockInvoker } from '../../src/team/team-runtime.js'
import type { InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

function invoke(agent: string, input: InputRef, outputPath?: string): InvokeSpec {
  return {
    kind: 'invoke',
    agent,
    input,
    outputAs: outputPath ? { path: outputPath } : undefined
  }
}

const input = {
  initial: (): InputRef => ({ ref: 'initial' }),
  prev: (): InputRef => ({ ref: 'prev' }),
  state: (path: string): InputRef => ({ ref: 'state', path })
}

// ── 1. 定义团队 ──────────────────────────────────────────────

const team = defineTeam({
  id: 'research-team',
  name: 'Parallel Research Team',

  agents: {
    webResearcher:    agentHandle('web-researcher', {}, { role: 'Searches the web' }),
    paperResearcher:  agentHandle('paper-researcher', {}, { role: 'Searches academic papers' }),
    dataResearcher:   agentHandle('data-researcher', {}, { role: 'Analyzes datasets' }),
    synthesizer:      agentHandle('synthesizer', {}, { role: 'Synthesizes research findings' })
  },

  flow: seq(
    // 三个研究员并行执行，结果 merge 到 'evidence' 路径
    par(
      [
        invoke('web-researcher', input.initial()),
        invoke('paper-researcher', input.initial()),
        invoke('data-researcher', input.initial())
      ],
      {
        reducerId: 'collect',
        outputAs: { path: 'evidence' }
      }
    ),
    // 综合所有证据
    invoke('synthesizer', input.state('evidence'), 'synthesis')
  ),

  state: { storage: 'memory' }
})

// ── 2. Mock Agents ───────────────────────────────────────────

const mockInvoker = createMockInvoker({
  'web-researcher': (input: unknown) => ({
    source: 'web',
    findings: [`Web result 1 for "${(input as any).topic}"`, 'Web result 2']
  }),
  'paper-researcher': (input: unknown) => ({
    source: 'papers',
    findings: ['Paper: Smith et al. 2024', 'Paper: Jones 2023']
  }),
  'data-researcher': (input: unknown) => ({
    source: 'data',
    findings: ['Dataset analysis: trend is upward', 'Correlation coefficient: 0.87']
  }),
  synthesizer: (input: unknown) => {
    const evidence = input as unknown[]
    return {
      summary: `Synthesized ${Array.isArray(evidence) ? evidence.length : 0} research sources`,
      conclusion: 'All evidence points toward the same conclusion.'
    }
  }
})

// ── 3. 运行 ──────────────────────────────────────────────────

async function main() {
  const runtime = createTeamRuntime({
    team,
    agentInvoker: mockInvoker
  })

  console.log('=== Research Team: Parallel Demo ===\n')

  const result = await runtime.run({
    topic: 'Impact of LLMs on software engineering'
  })

  console.log('Final state:')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(console.error)
