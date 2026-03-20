/**
 * AgentFoundry Hello World — 最简示例
 *
 * 用法:
 *   export OPENAI_API_KEY=sk-xxx   # 或 ANTHROPIC_API_KEY
 *   npx tsx index.ts
 */

import { createAgent } from '../../src/index.js'

async function main() {
  // createAgent() 默认加载 standard() pack（文件读写、glob、grep、bash）
  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    identity: 'You are a helpful assistant that can read and analyze files.',
    constraints: ['Be concise. Answer in 2-3 sentences.'],
    trace: { export: { enabled: false } }
  })

  const prompt = process.argv[2] || 'List the files in the current directory and describe what this project is.'

  console.log(`\n> ${prompt}\n`)

  const result = await agent.run(prompt)

  console.log(result.response)
  console.log(`\n--- ${result.steps} steps, ${result.tokensUsed} tokens ---`)
}

main().catch(console.error)
