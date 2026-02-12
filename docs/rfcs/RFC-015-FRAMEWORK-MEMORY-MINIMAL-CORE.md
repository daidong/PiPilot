# RFC-015: Framework Memory Minimal Core
## 将记忆语义下沉到应用层，Framework 仅保留能力原语

Status: Draft  
Author: AgentFoundry Team  
Created: 2026-02-12  
Updated: 2026-02-12  
Supersedes: RFC-012 (for Research Pilot runtime strategy)

---

## 1. Decision

Framework 默认不再内置重语义记忆策略（Task Anchor / Facts / Evidence Cards）。
Framework 仅保留可复用能力原语：

1. turn history + budget/compaction
2. artifact registry interface
3. session summary interface
4. context assembly hooks

具体“记忆语义”由应用层或可选 plugin/packs 决定。

---

## 2. Why Now

当前存在明显语义错位：

1. Research Pilot 目标已是 `Artifacts + Session Summaries`。
2. KernelV2 默认路径仍会注入 task/memory/evidence 结构。
3. 这会带来额外 prompt token 和维护复杂度。
4. 同一个项目中出现两套认知模型，导致行为和文档不一致。

结论：复杂记忆管理不应成为 Framework 默认行为，而应成为“按问题定制”的上层策略。

---

## 3. Scope

### 3.1 In Scope

1. 新增 `kernelV2.profile`（如 `minimal | legacy`），默认 `minimal`（新应用）。
2. 将以下能力改为可选 plugin/packs：
   - task-state / task-anchor injection
   - facts write gate + memory cards retrieval
   - evidence cards assembly
3. Research Pilot 切到 `minimal`，仅使用：
   - protected recent turns
   - selectedContext（mentions + session summary）
   - artifact tools（持久化）

### 3.2 Out of Scope

1. 不移除 Artifact API。
2. 不强制其他应用立即迁移（可继续使用 `legacy`）。
3. 不在本 RFC 中重做向量检索。

---

## 4. Migration Plan

### Phase A (Compatibility First)

1. 引入 profile 开关，不破坏现有接口。
2. `legacy` 保持现状；`minimal` 关闭 task/memory/evidence 注入。
3. 增加遥测字段，区分 profile 及上下文块来源。

### Phase B (Research Pilot Switch)

1. Research Pilot 默认启用 `kernelV2.profile = minimal`。
2. 删除/禁用与 Task Anchor/Facts 相关的 coordinator 假设。
3. 更新 README 与调试日志文案，统一为 Session Summary 语义。

### Phase C (Deprecation)

1. 将 RFC-012 标记为 Deprecated（Research Pilot runtime）。
2. 发布迁移说明：如何从 `legacy` 迁到 `minimal`。
3. 观察两个 release 周期后，评估是否下线 legacy 默认。

---

## 5. Backward Compatibility

1. Personal Assistant 或其他依赖 facts/task 的应用可继续使用 `legacy`。
2. `kernelV2.profile` 为显式配置，避免隐式行为变化。
3. 对外工具接口保持稳定，优先避免 breaking changes。

---

## 6. Risks and Mitigations

1. 风险：失去“默认长程记忆”能力。  
   缓解：提供 `legacy-memory-pack` 可选加载。

2. 风险：不同应用迁移节奏不同导致分叉。  
   缓解：统一 profile 与能力边界，文档按 profile 组织。

3. 风险：上下文减少后回答质量波动。  
   缓解：保留 protected turns + summary；以基准任务回归验证。

---

## 7. Success Criteria

1. Research Pilot 的 system/context token 显著下降（目标 20%+）。
2. 不再出现与旧语义相关的调试日志（task-anchor injected, memory/evidence cards）。
3. 文档、日志、运行行为三者一致。
4. legacy 应用无回归。

---

## 8. Rollback

若出现质量退化或关键功能缺失：

1. 通过配置回切 `kernelV2.profile = legacy`。
2. 保留 plugin 化后的能力模块，可按应用逐项恢复。

---

## 9. Open Questions

1. `minimal` 是否应成为全局默认，还是仅新建应用默认？
2. legacy 模块的维护窗口（N 个版本）如何定义？
3. 是否将 Session Summary 生成器上提为 Framework 标准插件？
