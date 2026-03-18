/**
 * 最简多智能体团队 — 顺序管线
 *
 * Researcher → Writer → Editor
 *
 * 用法: npx tsx pipeline.ts
 */

import { defineTeam, agentHandle } from '../../src/team/define-team.js'
import { seq } from '../../src/team/flow/combinators.js'
import { createTeamRuntime, createMockInvoker } from '../../src/team/team-runtime.js'
import type { InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

// Helper: build invoke AST node
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
  id: 'writing-team',
  name: 'Writing Team',
  description: 'A team that researches, writes, and edits articles',

  agents: {
    researcher: agentHandle('researcher', {}, { role: 'Gathers information on a topic' }),
    writer:     agentHandle('writer', {}, { role: 'Writes articles from research' }),
    editor:     agentHandle('editor', {}, { role: 'Polishes and improves articles' })
  },

  // 顺序管线：research → write → edit
  flow: seq(
    invoke('researcher', input.initial(), 'research'),
    invoke('writer', input.state('research'), 'draft'),
    invoke('editor', input.state('draft'), 'final')
  ),

  state: { storage: 'memory' }
})

// ── 2. Mock Agents（真实场景替换为 LLM Agent）─────────────────

const mockInvoker = createMockInvoker({
  researcher: (input: unknown) => ({
    findings: `Research on "${(input as any).topic}": Found 3 key facts about the topic.`,
    sources: ['source-1', 'source-2', 'source-3']
  }),
  writer: (input: unknown) => ({
    article: `Article based on: ${(input as any).findings}\n\nThis is a well-structured article...`,
    wordCount: 500
  }),
  editor: (input: unknown) => ({
    article: `[Edited] ${(input as any).article}`,
    changes: ['Fixed grammar', 'Improved flow', 'Added conclusion']
  })
})

// ── 3. 运行 ──────────────────────────────────────────────────

async function main() {
  const runtime = createTeamRuntime({
    team,
    agentInvoker: mockInvoker
  })

  console.log('=== Writing Team: Pipeline Demo ===\n')

  const result = await runtime.run({
    topic: 'The future of AI agents'
  })

  console.log('Final state:')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(console.error)
