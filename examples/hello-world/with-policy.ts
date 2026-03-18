/**
 * AgentFoundry — 安全策略示例
 *
 * 展示三阶段策略管线：Guard（守卫）→ Mutate（变换）→ Observe（观察）
 *
 * 用法:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx with-policy.ts
 */

import {
  createAgent,
  defineTool,
  definePack,
  defineGuardPolicy,
  defineObservePolicy,
  packs
} from '../../src/index.js'

// 1. 一个写文件的工具（模拟）
const writeNoteTool = defineTool({
  name: 'write-note',
  description: 'Write a note to a file',
  parameters: {
    filename: { type: 'string', description: 'File name', required: true },
    content: { type: 'string', description: 'Note content', required: true }
  },
  execute: async (input) => {
    console.log(`  [write-note] Writing to ${input.filename}`)
    return { success: true, data: `Wrote ${(input.content as string).length} chars to ${input.filename}` }
  }
})

// 2. Guard 策略：禁止写 .env 文件
const noEnvWrites = defineGuardPolicy({
  id: 'no-env-writes',
  description: 'Block writes to .env files',
  match: (ctx) => ctx.tool === 'write-note',
  decide: (ctx) => {
    const filename = ctx.input?.filename as string
    if (filename?.includes('.env')) {
      return { action: 'deny', reason: 'Writing to .env files is not allowed' }
    }
    return { action: 'allow' }
  }
})

// 3. Observe 策略：记录所有写操作
const logWrites = defineObservePolicy({
  id: 'log-writes',
  description: 'Log all write operations',
  match: (ctx) => ctx.tool === 'write-note',
  decide: (ctx) => {
    console.log(`  [audit] write-note called with filename=${ctx.input?.filename}`)
    return { action: 'log', metadata: { filename: ctx.input?.filename } }
  }
})

// 4. 打包
const notesPack = definePack({
  id: 'notes',
  description: 'Note-taking with security policies',
  tools: [writeNoteTool],
  policies: [noEnvWrites, logWrites]
})

// 5. 运行
async function main() {
  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [packs.safe(), notesPack],
    identity: 'You are a note-taking assistant. Use write-note to save notes.',
    constraints: ['When asked to write a note, use the write-note tool.'],
    trace: { export: { enabled: false } }
  })

  // 这个请求会被 Guard 策略拦截
  console.log('\n--- Test 1: Try to write .env (should be blocked) ---')
  const r1 = await agent.run('Write my API key "sk-123" to .env file')
  console.log(r1.response)

  // 这个请求会正常执行，并被 Observe 策略记录
  console.log('\n--- Test 2: Write a normal note (should succeed) ---')
  const r2 = await agent.run('Write a note called "todo.txt" with content "Buy groceries"')
  console.log(r2.response)
}

main().catch(console.error)
