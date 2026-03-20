# Team Demo — 多智能体协作示例

展示 AgentFoundry 的 Team 模块：Flow 组合子、协议模板、共享状态。

## 示例

| 文件 | 说明 |
|------|------|
| `pipeline.ts` | 最简团队 — `seq()` 顺序执行 |
| `parallel-research.ts` | 并行研究 — `par()` + reducer 聚合 |
| `critic-loop.ts` | 评审循环 — `loop()` + until 条件退出 |

## 快速开始

```bash
# 这些示例使用 mock agent，不需要 API key
npx tsx pipeline.ts
npx tsx parallel-research.ts
npx tsx critic-loop.ts
```

## 核心概念

```
defineTeam({
  agents: { ... },          // 团队成员
  flow: seq(                // 工作流（组合子 DSL）
    invoke('researcher'),
    invoke('writer')
  ),
  state: { storage: 'memory' }  // 共享黑板
})
```

### Flow 组合子

| 组合子 | 用途 |
|--------|------|
| `seq(...)` | 顺序执行 |
| `par([...], join)` | 并行执行 + 结果聚合 |
| `loop(body, until)` | 循环直到条件满足 |
| `choose(router, branches)` | 条件分支 |
| `race([...], winner)` | 竞争，取最快 |
| `gate(rule, then)` | 条件门控 |
| `supervise(body, supervisor)` | 监督执行 |
| `retry(body, config)` | 失败重试 |
| `fallback([...])` | 降级方案 |

### 协议模板

预置的常见多智能体拓扑：

- `pipeline()` — 顺序管线
- `fanOutFanIn()` — 扇出-扇入
- `criticRefineLoop()` — 评审-修改循环
- `debate()` — 多方辩论
- `voting()` — 投票共识
