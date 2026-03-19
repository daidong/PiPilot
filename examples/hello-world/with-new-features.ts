/**
 * AgentFoundry — 新特性演示（Batch 2 & 3）
 *
 * 展示以下能力：
 *   - transformContext  每次 LLM 调用前注入上下文（GAP-9）
 *   - pinnedMessages    固定消息，永不被修剪（GAP-10）
 *   - contextWindow     启用 token 预估修剪（GAP-6）
 *   - per-tool timeout  工具级超时（GAP-17）
 *   - handle.stop()     立即中止（触发 AbortSignal，GAP-18）
 *   - handle.pin()      运行中动态固定消息（GAP-10）
 *
 * 用法:
 *   export ANTHROPIC_API_KEY=sk-ant-xxx   # 或 OPENAI_API_KEY
 *   npx tsx with-new-features.ts
 */

import { createAgent, defineTool, definePack, packs } from '../../src/index.js'

// GAP-17: 带超时的自定义工具 — 超过 5 秒自动失败
const slowTool = defineTool({
  name: 'slow-operation',
  description: 'Simulates a slow operation (intentionally delayed)',
  timeout: 5_000, // 5 s hard cap
  parameters: {
    delayMs: { type: 'number', description: 'How long to sleep (ms)', required: true }
  },
  execute: async (input) => {
    await new Promise(resolve => setTimeout(resolve, input.delayMs as number))
    return { success: true, data: `Completed after ${input.delayMs}ms` }
  }
})

async function main() {
  // ── GAP-10: 静态固定消息 ──────────────────────────────────────────────
  // 这条消息出现在每次 LLM 调用的最前面，永不被 compaction 或 token 修剪删除
  const pinnedSystemNote = {
    role: 'user' as const,
    content: '[PINNED] You are helping with a demo project. Always be concise.'
  }

  // ── GAP-9: transformContext — 每轮注入动态上下文 ──────────────────────
  // 实际项目中这里可以做 RAG 检索、session 状态注入等
  let callCount = 0
  const transformContext = (messages: typeof pinnedSystemNote[]) => {
    callCount++
    // 在消息尾部追加一条隐式提示（不写入历史，只影响本次 LLM 调用）
    return [
      ...messages,
      { role: 'user' as const, content: `[context] This is LLM call #${callCount} in this session.` }
    ]
  }

  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [
      packs.safe(),
      definePack({ id: 'slow-tools', description: 'Slow tools demo', tools: [slowTool] })
    ],
    identity: 'You are a demo assistant showcasing AgentFoundry features.',
    trace: { export: { enabled: false } },

    // GAP-9: 每次 LLM 调用前自动注入上下文
    transformContext,

    // GAP-10: 静态固定消息（比 transformContext 早一步，始终在最前面）
    pinnedMessages: [pinnedSystemNote],

    // GAP-6: 启用 token 预估修剪（接近 85% 时主动丢弃旧消息）
    contextWindow: 128_000,
    preCallTrimThreshold: 0.85,
  })

  // ── GAP-18: stop() + AbortSignal ────────────────────────────────────────
  // 演示中断：启动 agent，3 秒后强制中止
  console.log('\n[demo] Starting agent with 3s abort timer...\n')
  const handle = agent.run(
    'Call the slow-operation tool with delayMs=10000, then summarize what happened.'
  )

  // GAP-10: 动态 pin — 在 run 开始后追加固定消息
  handle.pin({
    role: 'user' as const,
    content: '[PINNED DYNAMIC] If aborted, report that the run was cancelled.'
  })

  const abortTimer = setTimeout(() => {
    console.log('[demo] Aborting run after 3s...')
    handle.stop() // GAP-18: 发送 SIGTERM 到 in-flight bash/exec，立即停止
  }, 3_000)

  const result = await handle
  clearTimeout(abortTimer)

  console.log('\n[result]', result.response || '(no response — aborted)')
  console.log(`[stats] steps=${result.steps} | tokens=${result.tokensUsed} | llmCalls=${callCount}`)
}

main().catch(console.error)
