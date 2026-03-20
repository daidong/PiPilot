# AgentFoundry V1.0 Roadmap

> 设计公理：最小纪律保证不死 + 证据驱动逐步变强

## 现状评估（v0.1.0）

| 维度 | 分数 | 状态 |
|------|------|------|
| 架构设计 | 9/10 | 三轴正交，干净优雅 |
| 类型安全 | 9/10 | 严格 TS + 判别联合 + Zod |
| 核心实现 | 9/10 | 成熟，生产级质量 |
| 多智能体 | 9/10 | Flow 组合子 DSL 非常强 |
| 技能系统 | 8/10 | token 懒加载优化巧妙 |
| 测试覆盖 | 4/10 | 核心模块有严重空白 |
| 文档 | 6/10 | README 好，独立指南缺失 |
| 示例 | 5/10 | 两个重型应用，没有入门级示例 |
| CLI/开发体验 | 4/10 | 工具链太弱 |

## V1.0 目标

将 AgentFoundry 从"架构优秀但门槛高"提升到"架构优秀且易上手"。

核心指标：
- 核心模块测试覆盖率 ≥ 70%
- 新用户 5 分钟内跑通第一个 agent
- 所有公共 API 有独立文档
- CLI 支持项目脚手架

---

## 第一梯队：v1.0 之前必须做

### 1.1 补齐核心模块测试

**目标**：核心模块覆盖率从 ~20% → 70%+

**当前缺口**：

| 模块 | 现有测试 | 需补 | 优先级 |
|------|---------|------|--------|
| Context Sources (12个) | 0 | 全部 | P0 |
| Factories (define*) (5个) | 0 | 全部 | P0 |
| Policies (6个) | 1 | 5个 | P0 |
| MCP (6文件) | 0 | 核心3个 | P0 |
| Tools (22个) | 5 | 10+个 | P1 |
| Packs (15+个) | 1 | 核心5个 | P1 |
| Skills (SkillManager, Registry) | 4 | 2个 | P1 |
| Agent creation | 2 | 2个 | P1 |

**具体任务**：

- [ ] 安装 `@vitest/coverage-v8`，配置覆盖率门槛
- [ ] `tests/factories/` — defineTool, definePolicy, definePack, defineContextSource, defineSkill
- [ ] `tests/context-sources/` — memory-get, memory-search, memory-list, docs-index, docs-search, docs-open, ctx-catalog, ctx-describe, session-trace, todo-list, todo-get
- [ ] `tests/policies/` — no-destructive, no-secret-files, auto-limit, normalize-paths, audit-all
- [ ] `tests/mcp/` — mcp-provider, client, tool-adapter
- [ ] `tests/tools/` — 补齐 memory-put, memory-update, memory-delete, todo-add, todo-update, todo-complete, llm-expand, skill-create 等
- [ ] `tests/packs/` — safe, exec, network, compute, standard/full/strict 组合
- [ ] `tests/skills/` — skill-manager 生命周期, skill-registry 查询
- [ ] CI 中接入覆盖率报告，设置门槛

### 1.2 安装测试覆盖率工具

```bash
npm install -D @vitest/coverage-v8
```

在 `vitest.config.ts` 中添加：
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  include: ['src/**/*.ts'],
  exclude: ['src/types/**', 'src/index.ts'],
  thresholds: {
    statements: 70,
    branches: 60,
    functions: 70,
    lines: 70
  }
}
```

### 1.3 创建最简示例

**目标**：新用户 5 分钟跑通

- [ ] `examples/hello-world/` — 单文件 CLI agent（<50 行）
- [ ] `examples/chat-cli/` — 交互式 CLI 聊天（带工具调用）
- [ ] `examples/team-demo/` — 多智能体团队协作示例（展示 flow 组合子）

### 1.4 拆分文档

**目标**：从 72KB README 中提取独立指南

| 文档 | 内容来源 | 状态 |
|------|---------|------|
| `docs/API.md` | README API 部分 + 代码注释 | 需创建 |
| `docs/CLI.md` | README CLI 部分 | 需创建 |
| `docs/PROVIDERS.md` | README Provider 部分 + src/llm/ | 需创建 |
| `docs/MCP-GUIDE.md` | README MCP 部分 + src/mcp/ | 需创建 |
| `docs/CONTEXT-SOURCES.md` | README Context 部分 | 需创建 |
| `docs/POLICIES-GUIDE.md` | README Policy 部分 | 需创建 |
| `docs/TESTING.md` | 新写 | 需创建 |
| `docs/TROUBLESHOOTING.md` | 新写 | 需创建 |

---

## 第二梯队：广泛推广前做

### 2.1 多智能体团队示例

- [ ] `examples/research-team/` — 文献调研团队（researcher → analyst → writer）
- [ ] 展示 `seq`, `par`, `loop`, `choose` 组合子
- [ ] 展示 `criticRefineLoop`, `fanOutFanIn` 协议模板
- [ ] 展示 Blackboard 共享状态和 Channel 通信

### 2.2 CLI 脚手架

- [ ] `agent-foundry init` — 生成项目结构、agent.yaml、基础工具
- [ ] `agent-foundry run` — 直接运行 agent
- [ ] `agent-foundry test` — 运行 agent 测试
- [ ] `agent-foundry add-tool <name>` — 添加工具模板

### 2.3 提取桌面应用共享 IPC

- [ ] 分析 research-pilot-desktop 和 personal-assistant 的 ipc.ts 重叠部分
- [ ] 创建 `examples/shared-electron/` 基础 IPC handler 工厂
- [ ] 两个应用迁移到共享 IPC 基础上

### 2.4 集成测试

- [ ] 创建 mock LLM client（返回预设响应）
- [ ] 端到端测试：createAgent → agent.run() → 验证工具调用和输出
- [ ] 团队测试：createTeamRuntime → team.run() → 验证流程执行

---

## 第三梯队：锦上添花

### 3.1 HTTP 服务器示例
- [ ] `examples/api-server/` — Express/Fastify 包装 agent 为 REST API
- [ ] WebSocket 流式响应

### 3.2 深度验证命令
- [ ] `agent-foundry validate --deep` — 检查 API key、MCP 连通性、工具可用性

### 3.3 迁移指南
- [ ] `docs/MIGRATION.md` — deprecated API 升级路径（如 promptFragment → skills）

### 3.4 共享 UI 组件目录
- [ ] shared-ui Storybook 或 Ladle 组件浏览器

---

## 时间线估算

| 阶段 | 范围 | 里程碑 |
|------|------|--------|
| 第一梯队 | 测试 + 覆盖率 + 最简示例 + 文档拆分 | v0.5.0 |
| 第二梯队 | 团队示例 + CLI + 共享IPC + 集成测试 | v0.8.0 |
| 第三梯队 | HTTP示例 + 深度验证 + 迁移指南 | v1.0.0 |

---

## 验收标准

### v1.0 必须满足：
1. `npm run test:coverage` 核心模块 ≥ 70%
2. `examples/hello-world/` 可在 5 分钟内跑通
3. 所有公共 factory 函数（defineTool, definePolicy, definePack, defineSkill, defineAgent）有独立测试
4. 所有 docs/ 指南与实现代码一致
5. CI 流水线包含覆盖率门槛检查
6. 至少一个多智能体团队示例
7. CLI 支持 `init` 和 `run` 命令
