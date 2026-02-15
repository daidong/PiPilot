# RFC-003: YOLO Researcher v2 (Lean Progress Mode)

**Status**: Draft (Proposed)  
**Author**: AgentFoundry team  
**Date**: 2026-02-15  
**Target**: 快速推进研究主题、降低系统脆弱性与认知负担

## 1. 背景与问题

在真实运行中，我们观察到 v1 的核心问题不是“能力不够多”，而是“控制结构过多且过脆”：

1. 研究过程被流程对象牵引，而不是被研究问题牵引。  
2. 资产类型过多，LLM 一旦轻微偏离 schema（如单复数、命名漂移）就会触发假失败。  
3. 用户需要同时理解太多视图（timeline/branches/assets/evidence/system/events），无法快速判断系统在做什么、下一步要什么。  
4. 复杂 gate 与评审链路在高度不确定研究早期会抑制推进速度。  

核心结论：**v1 更像“研究流程管理系统”，不是“研究推进引擎”。**

## 2. v2 设计目标

v2 的唯一北极星：

1. 以最少控制机制，最快得到可验证的瓶颈结论与下一步优化方向。

优先级顺序：

1. 研究推进速度，  
2. 用户可理解性，  
3. 可审计性，  
4. 结构完备性。

## 3. 设计原则（瘦身原则）

1. `progress-first`：默认推进，不默认阻断。  
2. `few-objects`：把资产模型压缩到最小可用集合。  
3. `hard-check-minimum`：只保留极少数硬校验，其余都降级为提示。  
4. `single-pane`：默认一个主视图回答三个问题：现在在做什么、为什么、下一步要用户做什么。  
5. `contract-over-taxonomy`：用清晰输入输出契约替代复杂术语体系。  

## 4. v2 最小运行模型

### 4.1 用户可见阶段（替代 S1-S5 心智负担）

对用户只暴露 3 段：

1. `Define`：澄清问题与测量边界。  
2. `Request`：生成可执行实验需求并等待外部结果。  
3. `Digest`：吸收上传结果并形成结论/下一步。  

说明：内部可保留 S1-S5 兼容层，但 UI 与文档默认不再要求用户理解 S1-S5。

### 4.2 最小状态机

1. `IDLE`  
2. `RUNNING`  
3. `WAITING_EXTERNAL`  
4. `PAUSED`  
5. `DONE`  
6. `FAILED`

`WAITING_FOR_USER` 合并入 `RUNNING/WAITING_EXTERNAL` 场景内问题卡，不单独暴露复杂状态分支。

### 4.3 每回合主动作（可探索）

每个 turn 必须声明一个主动作，可从下列 4 项选择：

1. `explore`（纯信息收集；不改变核心资产，仅产出 `Note`）  
2. `refine_question`  
3. `issue_experiment_request`  
4. `digest_uploaded_results`

每个主动作必须附带“为什么做这个动作”的一句解释。

### 4.4 工具能力基线（v2 必须具备）

v2 默认需要以下可调用能力，且在运行日志中可见：

1. `local investigation`：本地代码/脚本/命令调查（含 `bash`）。  
2. `literature investigation`：文献与网页检索（search/fetch + 文档转 Markdown/提取）。  
3. `literature subagent`：内置本地移植版 literature team（planner/searcher/reviewer/summarizer）做结构化文献研究（不依赖跨-app import）。  
4. `data analysis subagent`：内置本地移植版 Python 数据分析 agent（schema 推断、代码生成、执行、结果清单）。  
5. `writing subagent`：内置本地写作工具（`writing-outline` / `writing-draft`）。  
6. `local skills pack`：内置 writing/literature/data skills + default project skills（如 `citation-management`、`matplotlib`）用于 lazy guidance 与脚本能力。  

约束：

1. 文献检索能力是 v2 主路径能力，不是可有可无的扩展。  
2. 若外部检索凭证缺失，系统必须明确降级为 `local-only` 模式并在 UI 告知，不得静默缺失。  
3. tool-call 事件必须在 Mission Board 可见（至少显示：调用了什么工具、为何调用、结果摘要）。  
4. 文献检索结果中的高相关 paper（含 enrichment 字段）必须持久化到本地 paper 库，供后续 run 复用。  

## 5. 资产模型瘦身

v2 默认只要求 3 个核心资产：

1. `ResearchQuestion`  
2. `ExperimentRequest`  
3. `ResultInsight`

可选扩展资产（不参与硬阻断）：

1. `Note`（自由笔记）  
2. `Decision`（用户关键决策）  
3. `AttachmentManifest`（上传文件清单）

v1 中 `Claim/EvidenceLink/RiskRegister/Hypothesis/...` 等资产不删除，但降级为“兼容层或可选衍生”，不再作为主流程硬依赖。

## 6. Gate 与评审瘦身

只保留 2 个硬校验：

1. `G-Min-1`：`ExperimentRequest` 必须可执行（目标、方法、期望结果、所需上传文件齐全）。  
2. `G-Min-2`：`ResultInsight` 必须明确绑定到某个 `ExperimentRequest` 与上传清单。  

其余检查（因果充分性、写作质量、完整可复现三元组、persona 评审分歧等）全部改为 `advisory`，只提示不阻断。

语义评审策略：

1. 保留 reviewer 机制，  
2. 默认仅输出“风险提示 + 建议下一步”，  
3. 不再直接驱动 `FAILED` 或长链路阻断。

## 7. UI 瘦身

默认只保留一个主界面（Mission Board），包含三块：

1. `Current Focus`：当前动作 + 一句话理由。  
2. `Need From You`：如果在 `WAITING_EXTERNAL`，明确告诉用户上传什么、为什么、完成标准是什么。  
3. `Latest Insight`：最新结论、置信度、下一步建议。  

高级视图（branches/assets/events/system）移到 “Advanced” 抽屉，默认折叠。

默认用户路径：

1. 填目标 -> 启动 -> 看 `Need From You` -> 上传 -> 看 `Latest Insight`。

## 8. 切换策略（v2 clean start）

### 8.1 clean-start 原则

1. v2 不迁移旧 session；新 run 按 v2 contract 启动。  
2. v1 运行能力保留，但作为 legacy 模式，不进入 v2 主路径。  
3. 旧 UI tab 可保留在 Advanced（用于排障），不阻塞 v2 落地。

### 8.2 失败降级策略

当输出不满足严格 schema 时：

1. 先做自动归一化（命名修复、单复数修复、字段别名映射），  
2. 再进入最小硬校验，  
3. 仍失败则进入 `Need From You` 提问，不直接 `FAILED`（除非运行时异常）。

## 9. 实施计划（建议）

1. `M1 Core Contract`：先实现 v2 三核心资产契约与输出归一化（不做旧 session 映射层）。  
2. `M1.5 Tool Baseline`：接入并默认启用本地调查 + 文献检索工具链，补齐凭证检查与降级提示。  
3. `M2 Runtime Simplification`：接入四动作回合模型与两条硬校验。  
4. `M3 UI Simplification`：默认单页 Mission Board，旧页面放 Advanced。  
5. `M4 Policy Tuning`：将 reviewer/gate 其余逻辑全部降级为 advisory。  

## 10. 验收指标（以推进为中心）

1. `time_to_first_request`：从启动到首个 `ExperimentRequest` <= 3 turns。  
2. `time_upload_to_insight`：从用户上传到首个 `ResultInsight` <= 1 turn。  
3. `ui_focus`：默认界面可在 10 秒内回答“当前在做什么/需要我做什么”。  
4. `user_action_clarity`：进入 `WAITING_EXTERNAL` 后，用户可在 30 秒内明确“要上传什么、为什么上传、何时算完成”。  
5. `stall_rate`：同阶段无实质推进的连续回合 <= 2。  
6. `schema_resilience`：常见命名漂移不应导致硬失败。  
7. `tool_usage_visibility`：当回合目标涉及背景调研/文献对齐时，timeline 中可见对应 literature tool 调用记录与结果摘要。  

## 11. 非目标（明确不做）

1. 不把 v2 做成“系统实验编排平台”。  
2. 不把所有研究方法学约束都做成 runtime 硬规则。  
3. 不追求一开始就覆盖所有论文写作规范。  

## 12. 决策请求

请先审查以下三点是否认同：

1. 以 `ResearchQuestion/ExperimentRequest/ResultInsight` 作为 v2 默认主模型；  
2. 硬 gate 缩减为 2 条，其余全面 advisory；  
3. 默认 UI 收敛到单页 Mission Board，复杂视图降级 Advanced。

若三点通过，再进入代码级重构实施。
