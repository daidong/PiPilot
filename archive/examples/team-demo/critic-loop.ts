/**
 * 评审循环 — loop() + until 条件退出
 *
 * Writer 写初稿，Critic 评审，Writer 根据反馈修改，循环直到评审通过（最多 3 轮）。
 *
 * 用法: npx tsx critic-loop.ts
 */

import { defineTeam, agentHandle } from '../../src/team/define-team.js'
import { seq, loop } from '../../src/team/flow/combinators.js'
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
  id: 'critic-loop-team',
  name: 'Writer-Critic Loop',

  agents: {
    writer: agentHandle('writer', {}, { role: 'Writes and revises articles' }),
    critic: agentHandle('critic', {}, { role: 'Reviews articles and provides feedback' })
  },

  flow: seq(
    // 写初稿
    invoke('writer', input.initial(), 'draft'),

    // 评审循环：critic 评审 → writer 修改，直到 approved 或 maxIters
    loop(
      seq(
        invoke('critic', input.state('draft'), 'review'),
        invoke('writer', input.state('review'), 'draft')
      ),
      {
        kind: 'until',
        field: 'review.approved',
        operator: 'eq',
        value: true
      },
      { maxIters: 3 }
    )
  ),

  state: { storage: 'memory' }
})

// ── 2. Mock Agents（模拟 3 轮后通过）────────────────────────

let criticCallCount = 0

const mockInvoker = createMockInvoker({
  writer: (input: unknown) => {
    const review = input as any
    if (review?.feedback) {
      console.log(`  [writer] Revising based on feedback: "${review.feedback}"`)
      return {
        article: `[Revision ${review.revision + 1}] Improved article addressing: ${review.feedback}`,
        revision: (review.revision || 0) + 1
      }
    }
    console.log('  [writer] Writing first draft...')
    return {
      article: 'First draft of the article about AI agents.',
      revision: 1
    }
  },
  critic: (input: unknown) => {
    criticCallCount++
    const draft = input as any
    const revision = draft?.revision || 1

    if (revision >= 3) {
      console.log(`  [critic] Revision ${revision}: APPROVED`)
      return {
        approved: true,
        score: 9,
        feedback: null,
        revision
      }
    }

    const issues = [
      'Needs more specific examples',
      'Conclusion is weak, add call to action'
    ]
    console.log(`  [critic] Revision ${revision}: NEEDS WORK — ${issues[revision - 1]}`)
    return {
      approved: false,
      score: 5 + revision,
      feedback: issues[revision - 1] || 'Minor improvements needed',
      revision
    }
  }
})

// ── 3. 运行 ──────────────────────────────────────────────────

async function main() {
  const runtime = createTeamRuntime({
    team,
    agentInvoker: mockInvoker
  })

  console.log('=== Critic Loop Demo ===\n')

  const result = await runtime.run({
    topic: 'Building reliable AI agents',
    requirements: 'Must include examples and a strong conclusion'
  })

  console.log(`\nCompleted after ${criticCallCount} review rounds`)
  console.log('\nFinal state:')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(console.error)
