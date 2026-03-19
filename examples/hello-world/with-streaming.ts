/**
 * AgentFoundry — Streaming-First 示例
 *
 * 展示两种 agent.run() 消费模式：
 * 1. 传统 await 模式 — 等待完成后获取结果
 * 2. 流式 events() 模式 — 实时消费每个事件
 *
 * 用法:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx with-streaming.ts
 */

import { createAgent, packs } from '../../src/index.js'

// ---------------------------------------------------------------------------
// 模式 1：传统 await（向后兼容，行为不变）
// ---------------------------------------------------------------------------
async function classicMode() {
  console.log('=== Mode 1: Classic await ===\n')

  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [packs.safe()],
    identity: 'You are a helpful assistant.',
    constraints: ['Be concise. One sentence.'],
    trace: { export: { enabled: false } }
  })

  const result = await agent.run('What files are in this directory?')
  console.log(result.response)
  console.log(`\n--- ${result.steps} steps ---\n`)
}

// ---------------------------------------------------------------------------
// 模式 2：流式消费（streaming-first）
// ---------------------------------------------------------------------------
async function streamingMode() {
  console.log('=== Mode 2: Streaming events ===\n')

  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [packs.safe()],
    identity: 'You are a helpful assistant.',
    constraints: ['Be concise.'],
    trace: { export: { enabled: false } }
  })

  const handle = agent.run('List the TypeScript files in this directory and count them.')

  // 实时消费事件流
  for await (const event of handle.events()) {
    switch (event.type) {
      case 'step-start':
        console.log(`\n[Step ${event.step}]`)
        break

      case 'text-delta':
        // 逐字输出 LLM 文本
        process.stdout.write(event.text)
        break

      case 'tool-call':
        console.log(`  → calling ${event.tool}(${JSON.stringify(event.args).slice(0, 60)})`)
        break

      case 'tool-result':
        if (event.success) {
          console.log(`  ← ${event.tool} ✓ (${event.durationMs}ms)`)
        } else {
          console.log(`  ← ${event.tool} ✗ ${event.error}`)
        }
        break

      case 'step-finish':
        if (event.toolCallCount > 0) {
          console.log(`  [${event.toolCallCount} tool calls completed]`)
        }
        break

      case 'error':
        console.log(`  ⚠ ${event.error} (recoverable: ${event.recoverable})`)
        break

      case 'done':
        console.log(`\n\n--- Done: ${event.result.steps} steps, success: ${event.result.success} ---`)
        break
    }
  }
}

// ---------------------------------------------------------------------------
// 模式 3：流式 + 中途转向（streaming + steer）
// ---------------------------------------------------------------------------
async function streamWithSteer() {
  console.log('\n=== Mode 3: Streaming + mid-run steer ===\n')

  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [packs.safe()],
    identity: 'You are a helpful assistant.',
    constraints: ['Be concise.'],
    trace: { export: { enabled: false } }
  })

  const handle = agent.run('Read the package.json file.')

  // 在第一个工具完成后注入转向
  let steered = false
  for await (const event of handle.events()) {
    if (event.type === 'text-delta') {
      process.stdout.write(event.text)
    }
    if (event.type === 'tool-result' && !steered) {
      steered = true
      handle.steer('Now also check what test framework is used.')
    }
    if (event.type === 'done') {
      console.log(`\n--- ${event.result.steps} steps ---`)
    }
  }
}

// Run all modes
async function main() {
  const mode = process.argv[2] || 'stream'

  switch (mode) {
    case 'classic':
      await classicMode()
      break
    case 'stream':
      await streamingMode()
      break
    case 'steer':
      await streamWithSteer()
      break
    default:
      console.log('Usage: npx tsx with-streaming.ts [classic|stream|steer]')
  }
}

main().catch(console.error)
