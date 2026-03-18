# Hello World — AgentFoundry 最简示例

5 分钟跑通你的第一个 AI Agent。

## 快速开始

```bash
# 1. 设置 API Key（任选其一）
export OPENAI_API_KEY=sk-xxx
# 或
export ANTHROPIC_API_KEY=sk-ant-xxx

# 2. 运行
npx tsx index.ts
```

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.ts` | 最简 agent — 只用 `createAgent` + 默认 safe pack |
| `with-custom-tool.ts` | 自定义工具 — 展示 `defineTool` + `definePack` |
| `with-policy.ts` | 添加策略 — 展示 Guard 策略管线 |

## 核心概念

```
createAgent() → agent.run("你的指令") → AgentRunResult
```

- **Agent** = Tools + Policies + Context Sources（三轴正交）
- **Pack** = 打包好的 Tools + Policies + Context Sources
- **默认 Pack** = `standard()`，包含文件读写、glob、grep、bash

## 下一步

- 看 `with-custom-tool.ts` 学习自定义工具
- 看 `with-policy.ts` 学习安全策略
- 看 `docs/AGENT_DEV_GUIDE.md` 了解框架设计哲学
- 看 `examples/research-pilot-desktop/` 了解完整桌面应用
