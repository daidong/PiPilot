/**
 * AgentFoundry — 自定义工具示例
 *
 * 展示如何用 defineTool + definePack 创建自定义能力。
 *
 * 用法:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx with-custom-tool.ts
 */

import { createAgent, defineTool, definePack, packs } from '../../src/index.js'

// 1. 定义一个自定义工具
const weatherTool = defineTool({
  name: 'get-weather',
  description: 'Get the current weather for a city',
  parameters: {
    city: { type: 'string', description: 'City name', required: true }
  },
  execute: async (input) => {
    // 真实场景中这里会调 API
    const forecasts: Record<string, string> = {
      'beijing': '晴，25°C',
      'tokyo': 'Cloudy, 18°C',
      'new york': 'Rainy, 12°C'
    }
    const city = (input.city as string).toLowerCase()
    const weather = forecasts[city] || `No data for ${input.city}`
    return { success: true, data: weather }
  }
})

// 2. 打包成 Pack
const weatherPack = definePack({
  id: 'weather',
  description: 'Weather information tools',
  tools: [weatherTool]
})

// 3. 创建 Agent，加载自定义 Pack + 默认 safe Pack
async function main() {
  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [packs.safe(), weatherPack],
    identity: 'You are a weather assistant. Use the get-weather tool to answer questions about weather.',
    constraints: ['Always use the get-weather tool before answering weather questions.'],
    trace: { export: { enabled: false } }
  })

  const prompt = process.argv[2] || 'What is the weather like in Beijing?'

  console.log(`\n> ${prompt}\n`)

  const result = await agent.run(prompt)
  console.log(result.response)
}

main().catch(console.error)
