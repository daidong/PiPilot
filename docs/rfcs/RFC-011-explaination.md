# RFC-011 解释文档（面向初级工程师）

> 对应主文档：`docs/rfc/RFC-011-LONG-HORIZON-MEMORY-STABILITY.md`  
> 目标：用更容易理解的中文，解释设计背景、取舍逻辑、正确性依据和必要性。

---

## 1. 这份文档是给谁看的

这份文档主要给两类同学：

1. 刚接触 AgentFoundry 的初级工程师。
2. 知道“要做什么”，但不清楚“为什么要这么做”的实现同学。

你可以把它当成 RFC-011 的“教学版注释”。

---

## 2. 先讲最重要的一句话

RFC-011 的核心不是“加新功能”，而是“把系统改成单一路径、可预测、可恢复、可长期运行”。

这背后的工程目标是：

1. 不丢最近关键上下文。
2. 不让系统在长会话里目标漂移。
3. 不让记忆无限膨胀失控。
4. 出问题时可定位、可恢复。
5. 让几个月跨度的大项目仍然能继续推进。

---

## 3. 背景知识：为什么 LLM Agent 会在长任务里变差

### 3.1 Context Window 不是“越大越无脑安全”

模型有 token 上限。即使窗口很大，也会出现两类问题：

1. 成本问题：每轮都塞很多内容，推理成本会爆炸。
2. 注意力问题：信息太长时，模型更容易忽略中间内容（lost in the middle）。

这就是为什么 RFC-011 强调：

1. 只把高信号内容放进 prompt。
2. 给“最近对话”和“当前目标”保留硬保护区。

### 3.2 什么是“逻辑 turn”

在 RFC-011 里，turn 不是单条消息，而是：

1. 一条 user 消息。
2. 从这条 user 消息开始，到下一条 user 消息之前的所有 assistant/tool 消息。

这样定义的意义是：不在一个任务回合中间把上下文切断。

### 3.3 为什么“文件是权威，索引只是加速”

索引（向量/BM25）可能损坏、丢失、重建。文件（jsonl/md）是可审计、可备份、可版本管理的。

所以 RFC-011 规定：

1. 权威数据在文件层。
2. 索引可删可重建。

---

## 4. 为什么要“全量重写”，不是“局部修补”

### 4.1 V1 的核心问题

V1 不只是某个算法不够好，而是路径太多：

1. 多套 budget 逻辑并存。
2. 多套短期记忆面并存。
3. 会话历史、压缩、扩展路径耦合复杂。
4. project/workingset 等概念重叠。

结果是：

1. 调试很难。
2. 保证项很难写成严格不变量。
3. 长会话下行为不可预测。

### 4.2 重写的工程价值

重写后可以做到：

1. 只有一条 context 组装路径。
2. 只有一个预算权威。
3. 所有 durable memory 写入必须经过同一个 gate。
4. 所有压缩都满足 replay contract。

这是“可长期运行”的基础。

---

## 5. 架构总览：你可以这样理解 V2

V2 的主循环可以记成 10 个字：

“装上下文 -> 控预算 -> 执行 -> 持久化 -> 整理”

细化成每回合流程：

1. 保存 user turn。
2. 解析项目和任务状态。
3. 检索候选 memory/evidence。
4. 按固定区块组装 context。
5. 预算裁剪。
6. 执行模型与工具。
7. 保存 assistant/tool turn。
8. 通过 MemoryWriteGate 写 durable memory。
9. 判断是否触发 compaction。
10. 触发时先 pre-flush，再 compaction。

这个流程最大的优点是“确定性”：同样输入，行为路径一致。

---

## 6. 关键设计一：Context 固定区块 + 保护区

### 6.1 区块顺序为什么这样排

RFC-011 的固定顺序是：

1. System identity + constraints。
2. Tool schemas。
3. Memory cards。
4. Evidence cards。
5. Non-protected historical turns。
6. Optional expansions。
7. Protected recent turns。
8. Tail task anchor。

这个顺序背后的认知逻辑：

1. 先给规则和能力边界。
2. 再给事实与证据。
3. 可选历史放中间。
4. 把最不能丢的“最近回合”和“当前任务锚点”放在末尾高注意区域。

### 6.2 为什么 protected zone 是硬约束

如果不保护最近回合，常见坏结果是：

1. 用户刚刚纠正了需求，下一轮又忘了。
2. 工具刚刚失败了原因，下一轮重复同样错误。

所以 RFC-011 明确：

1. 默认保护最近 K=3 个逻辑 turn。
2. 默认包含工具消息。
3. 只有进入 FailSafeMode 才允许降级保护，且最少保留 1 个完整 turn。

### 6.3 Task Anchor 为什么必须在尾部

Task Anchor 的作用不是“多一段文本”，而是“防目标漂移”。

它持续回答四个问题：

1. 当前目标是什么。
2. 正在做什么。
3. 被什么阻塞。
4. 下一步是什么。

没有这个锚点，长任务里模型容易被中间信息带偏。

---

## 7. 关键设计二：预算规划器为什么是“唯一权威”

### 7.1 双预算系统会造成什么问题

如果一个模块决定“保留谁”，另一个模块又二次裁剪，最终会出现：

1. 你以为保住了 protected turns，实际上被后续阶段挤掉。
2. 线上行为和日志解释对不上。

### 7.2 V2 的预算原则

预算先后顺序必须和 context 固定区顺序一致，并且有硬预留：

1. 先预留输出。
2. 再预留固定成本（system/tools）。
3. 对 protected turns + task anchor 做最小 token 预留。
4. 其余部分按降级顺序删减。

这保证“关键不变量”不会被后续阶段意外破坏。

---

## 8. 关键设计三：MemoryWriteGate 为什么必须强制

### 8.1 没有 write gate 的风险

如果任何路径都能随便写 durable memory，会出现：

1. 重复写。
2. 冲突写。
3. 无来源写（无法审计）。

最后你不知道“这个记忆是谁写的、何时写的、是否可信”。

### 8.2 WriteGate 的职责

它做四件事：

1. 候选提取与 key 规范化。
2. 查询同 key 旧值。
3. 决定动作（PUT/REPLACE/SUPERSEDE/IGNORE）。
4. 只有带 provenance 的写入才能落盘。

### 8.3 为什么写入要限流

长会话可能出现“过度积极写入”：

1. 每一步都写很多细碎事实。
2. MemoryStore 和索引快速膨胀。

所以 V2 有三道保护：

1. 每 turn 普通写入上限。
2. 每 session 总写入上限。
3. preflush 使用单独保留配额，不和普通 per-turn 互相踩踏。

### 8.4 正确性例子

场景：一个回合产生 60 条候选记忆。

V2 行为：

1. 先按 active/proposed 优先级筛选。
2. 仅最多接受普通写入上限（默认 20）。
3. 超出部分标记 rate_limited 并出 telemetry。

结果：系统不会被一次异常回合拖垮。

---

## 9. 关键设计四：Memory Lifecycle（整理、衰减、归档）

### 9.1 为什么要 lifecycle

只写不清理会导致：

1. 过期事实长期污染检索。
2. token 花在低价值历史上。

### 9.2 为什么把语义合并放在线下

在线路径要确定性和低延迟，语义合并（尤其 LLM merge）有不稳定性。

因此 V2 选择：

1. 在线写入：key-based、确定性。
2. 离线维护：weekly/on-demand consolidation + decay + archive。

这样既可控又能长期瘦身。

---

## 10. 关键设计五：Compaction + Pre-Compaction Flush

### 10.1 compaction 解决什么

当上下文逼近上限时，不压缩会溢出；乱压缩会丢信息。

V2 的原则是：

1. 压缩内容可以。
2. 引用键不能丢（path/url/id）。

### 10.2 为什么先 pre-flush

如果先压缩再决定“记什么”，模型可能已经看不到关键细节。

所以先做一轮“保存高价值 durable memory”的静默回合，再压缩。

### 10.3 preflush 和限流冲突怎么处理

RFC-011 明确了交互规则：

1. preflush 写入计入 session cap。
2. preflush 有单独 writeReserve。
3. 同 key 双路径写入会去重并按规则决策。

这避免了“该存的没存”或者“双重写污染”。

---

## 11. 关键设计六：Replay Contract 为什么是硬门槛

### 11.1 没有 replay 的压缩是不可逆黑盒

如果压缩后只有一段摘要，缺少源引用，你以后就无法还原证据链。

### 11.2 Replay Contract 的工程意义

每个 compact segment 必须至少保留一种稳定引用（path/url/id）。

带来的收益：

1. 线上结果可追溯。
2. 错误可回放。
3. 审计和调试成本降低。

---

## 12. 关键设计七：检索为什么要 fallback 链

### 12.1 单一检索策略不够稳

只靠 hybrid 可能因为索引缺失失效；只靠 lexical 可能在大文件下性能差。

### 12.2 V2 fallback 链

顺序是：

1. hybrid。
2. lexical。
3. vector-only。
4. raw-file-scan（有 token 上限）。

这条链保证“即使索引坏了，也还能有兜底结果”。

---

## 13. 关键设计八：项目与会话连续性

### 13.1 为什么要 ProjectResolver

用户可能在同 workspace 做多个项目。

如果不做项目绑定，会出现：

1. 记忆串项目。
2. 任务状态注入错误。

### 13.2 会话恢复的最小闭环

新 session 启动时，至少加载：

1. activeProjectId 绑定。
2. 活动任务。
3. 前几个 session 的 continuity summary。

这样用户不用每次“重讲一遍历史”。

### 13.3 为什么 daily aggregation 是可选

有些团队只需要 session 粒度，有些团队要“按天复盘”。

所以设计成：

1. daily markdown 是可选能力。
2. 通过 DailySummaryIndexRecord 建索引，不改变权威层原则。

---

## 14. 关键设计九：错误保留（Error Retention）

### 14.1 不是记录所有报错，而是记录“可复用失败模式”

V2 记录 normalized failure signature，比如：

1. tool 名称。
2. error 类型。
3. 参数哈希。
4. 尝试次数。

### 14.2 作用

当下一次准备调用相似参数时，系统可以提前注入提醒：

1. 上次这样失败过。
2. 先改参数，不要盲重试。

这会明显降低“重复犯同样错误”的概率。

---

## 15. 关键设计十：可观测性与恢复

### 15.1 非 debug 也要有基础 telemetry

这是为了回答线上最现实的问题：

1. 为什么这轮丢了上下文。
2. 为什么这条 memory 没写进去。
3. 是否进入了 failsafe。
4. 存储有没有损坏。

### 15.2 存储损坏恢复为什么要写进 RFC

很多系统只写“happy path”，但生产里最贵的是“异常恢复”。

V2 明确了：

1. `verifyIntegrity` 能扫出问题。
2. 可回退到最后有效 JSONL 边界。
3. 索引可由权威文件重建。
4. 恢复操作必须有审计记录。

---

## 16. 一个完整例子：为什么这套设计是“必要”的

场景：你在做一个 3 个月项目，今天是第 46 天。

1. 用户继续昨天任务，系统先通过 session binding 找到当前项目。
2. 注入最近 continuity summary + active tasks。
3. Context 组装时保留最近 3 个完整 turn，尾部放 task anchor。
4. 本轮工具返回超长日志，预算器先删 optional 区，不动 protected + anchor。
5. MemoryWriteGate 写入关键结论并限流，避免噪声写爆。
6. 接近窗口上限时触发 preflush，先保存高价值事实，再做压缩。
7. 压缩后的 segment 仍保留 path/url/id，可回放原始证据。
8. 第二天开新 session，系统能恢复到“上次做到哪”。

如果没有这套机制，通常会在第 30~50 天出现：

1. 目标漂移。
2. 重复试错。
3. 历史不可追溯。
4. 记忆膨胀导致检索质量下降。

---

## 17. 给初级工程师的实现建议

### 17.1 先守不变量，再做优化

优先级建议：

1. 先实现并测试不变量（protected zone、write gate、replay）。
2. 再做性能优化（索引、并行、缓存）。

### 17.2 先打“失败测试”

先写这些负向用例：

1. 索引全坏时 fallback 是否还能返回结果。
2. 连续写入 1000 条时是否被限流并可观测。
3. compaction 后 replay 引用是否完整。
4. 存储损坏后 verify + recovery 是否可走通。

### 17.3 不要跳过 provenance

短期看 provenance 很烦，长期看它是你定位线上问题的生命线。

---

## 18. 常见疑问（FAQ）

### Q1：为什么不把所有历史都直接塞进 prompt？

因为 token 成本和注意力衰减会让效果更差，不是更好。

### Q2：为什么不把所有 memory 都自动 merge 成一条？

在线全自动 merge 容易引入不可解释错误。V2 选择在线确定性 + 离线整理。

### Q3：FailSafeMode 会不会破坏“最近回合神圣不可侵犯”？

会在极端情况下降级，但仍保证至少 1 个完整逻辑 turn，不会完全丢失最近上下文。

### Q4：为什么要同时有 session continuity 和 daily aggregation？

两者用途不同：

1. session continuity 解决“下一次对话怎么接上”。
2. daily aggregation 解决“今天整体进展怎么复盘”。

---

## 19. 如何判断你真的实现对了

你可以用这份快速检查单：

1. 任何 durable memory 写入是否都经过同一个 gate。
2. 最近 K turns 是否在压力下仍被保住。
3. task anchor 是否总在 prompt 尾部。
4. compaction 后是否总能 replay。
5. 写入超限是否有明确拒绝与 telemetry。
6. 存储损坏是否可 verify + recover。
7. 跨 session 是否能自动接续任务。

只要这 7 条稳定成立，这套系统基本就具备长期可用性。

---

## 20. 总结

RFC-011 的价值可以浓缩成三点：

1. 把复杂系统收敛成单一路径，减少偶然行为。
2. 把“长期可用”从口号变成可验证不变量。
3. 把异常与恢复纳入一等公民，而不是事后补丁。

这就是为什么它不是“重构代码”，而是“重建运行时契约”。

---

## 21. 运行时执行细则（面向实现）

这一章回答你提出的核心问题：系统在哪些地方需要“解析、理解、组合记忆”，以及每一步到底谁来做、什么时候做、怎么做。

### 21.1 先给一张“谁做什么”的总表

| 环节 | 主执行模块 | 是否依赖 LLM | 主要输入 | 主要输出 |
|---|---|---|---|---|
| 解析项目与任务状态 | `ProjectResolverV2` + `TaskResolverV2` | 规则优先，歧义时可选 LLM | 当前消息、session binding、TaskStore | `activeProjectId`、当前任务、任务状态 patch |
| 检索候选 memory/evidence | `RetrieverV2` | 可选（query rewrite） | 用户消息、Tail Anchor、最近 turns | Memory cards / Evidence cards 候选 |
| 生成 Tail Task Anchor | `TaskStateUpdater` | 混合 | TaskStore + 最新工具结果 +用户新意图 | 四字段锚点块 |
| Durable memory 写入 | `MemoryWriteGateV2` | 候选提取可用 LLM，落库决策规则化 | 最新 turn、tool 结果、旧 memory | `PUT/REPLACE/SUPERSEDE/IGNORE` 决策 |
| 历史压缩（compaction） | `CompactionEngineV2` | 通常会用（摘要） | 非保护历史 turns | `CompactSegment` + `replayRefs` |
| 会话交接摘要 | `ContinuityWriter` | 可用 LLM 归纳，规则补充 | session 内 turn/task/memory 变化 | `ContinuityRecord` |

一句话记忆：LLM 负责“理解与摘要”，规则模块负责“落库与约束”。

### 21.2 “解析项目和任务状态”在做什么

目标是回答两个问题：

1. 这条消息属于哪个项目？
2. 这条消息推动哪个任务？

推荐实现顺序：

1. 项目解析（`ProjectResolverV2`）
2. 任务解析（`TaskResolverV2`）
3. 任务状态更新（`TaskStateUpdater`）

项目解析优先级（从强到弱）：

1. 显式命令：`/project switch <name|id>`。
2. session 绑定：`projects/session-bindings/<sessionId>.json`。
3. 路径线索：`.git`、`package.json`、`pyproject.toml`。
4. first-goal：从消息语义推断。

任务解析优先级（从强到弱）：

1. 消息显式引用 taskId。
2. 与 active task 的关键词、文件路径、模块名匹配度最高。
3. 无匹配则创建候选任务（通常 `pending` 或 `in_progress`）。

示例：

用户说：“继续修 auth refresh token 过期逻辑，先看 server/auth.ts。”

系统可做：

1. 从路径 `server/auth.ts` 命中项目 A。
2. 在项目 A 的任务列表中匹配 `auth refresh token` 任务。
3. 更新 `nowDoing=排查过期逻辑`，`nextAction=阅读并定位 auth.ts 分支`。

### 21.3 “检索候选 memory/evidence”怎么检索

检索不是“拿用户原话做全文搜索”这么简单。需要构造查询意图。

查询特征来源（建议至少三类）：

1. 当前用户消息：显式目标、对象、路径、报错。
2. Tail Anchor：当前目标、当前动作、阻塞、下一步。
3. 最近 K turns：新出现的实体（文件名、函数名、错误码、工具失败签名）。

从哪里检索：

1. `memory/facts.jsonl`、`memory/cards.jsonl`（语义事实）。
2. `artifacts/refs.jsonl` + history segment 的 `replayRefs`（证据路径）。
3. index 层（lexical/vector）仅加速，权威仍是文件层。

fallback 链（务必按顺序）：

1. `hybrid`。
2. `lexical`。
3. `vector-only`。
4. `raw-file-scan`（带 token 上限）。

为什么要这样：

1. 避免某一种索引失效时系统直接瘫痪。
2. 保证“最坏情况下也能给可用答案”。

### 21.4 Memory cards 和 Evidence cards 谁生成，怎么生成

`Memory cards` 和 `Evidence cards` 都不是手写常量，而是运行时产物。

Memory cards 生成逻辑：

1. 来自 `MemoryFact`。
2. 由 `CardBuilder` 转成 prompt 友好的短卡片（摘要 + provenance）。
3. 常包含：key、简述、置信/状态、来源引用。

Evidence cards 生成逻辑：

1. 来自 artifact 引用和 compact segment 的 `replayRefs`。
2. 由 `EvidenceBuilder` 生成“可追溯证据卡”。
3. 常包含：证据摘要、path/url/id、最近更新时间。

实用建议：

1. 卡片尽量短（高信号）。
2. 每张卡必须可追溯到原始引用。
3. 不要把整段原文塞卡片，细节用 `ctx-expand/read` 按需展开。

### 21.5 Tail Task Anchor 是谁生成的，什么时候生成

Tail Anchor 不是“临时 prompt 文案”，而是 `TaskState` 的投影。

生成时机：

1. 每轮请求前：读取当前 `TaskState`，注入 Anchor。
2. 每轮请求后：根据用户消息、工具结果、assistant 行为更新 `TaskState`。

谁生成：

1. 结构和字段由规则模块固定。
2. 字段内容可由规则提取；歧义高时可让 LLM 提议 patch，再由规则校验后写入。

它持续回答四个问题：

1. 当前目标是什么（`CurrentGoal`）。
2. 正在做什么（`NowDoing`）。
3. 被什么阻塞（`BlockedBy`）。
4. 下一步是什么（`NextAction`）。

正确性关键点：

1. Anchor 必须位于 prompt 末尾热区。
2. Anchor 来源必须可追踪到 TaskStore，不允许凭空改写。

### 21.6 “通过 MemoryWriteGate 写 durable memory”是在写什么

写入对象是 `MemoryFact`，它是“长期可复用事实”，不是每条聊天记录。

应该写的：

1. 用户长期偏好（语言、格式、输出要求）。
2. 项目稳定决策（架构、约束、关键参数）。
3. 工具验证过的结论（某命令/测试结果）。
4. 对后续回合有价值的任务事实（关键阻塞、明确下一步）。

不该写的：

1. 一次性中间噪声。
2. 没来源、没证据的猜测。
3. 与历史同义重复且无新增信息的内容。

### 21.7 为什么 WriteGate 必须做三步

RFC 里的三步不是“流程装饰”，而是防错核心。

第一步：候选提取与 key 规范化

1. 把自然语言事实变成统一键空间（`namespace/key`）。
2. 解决同义词和表述差异导致的重复写入。

第二步：查询同 key 旧值

1. 不查旧值就无法判断是新增还是更新。
2. 也无法判断是否冲突、是否应该 supersede。

第三步：动作决策（PUT/REPLACE/SUPERSEDE/IGNORE）

1. `PUT`：新 key。
2. `REPLACE`：同 key 新值替换（通常同语义更准）。
3. `SUPERSEDE`：新事实使旧事实过时，但保留历史版本。
4. `IGNORE`：噪声或重复。

这样做的收益：

1. 幂等：同一事实重复出现不会无限膨胀。
2. 可审计：每个变化有来源和动作理由。
3. 可回溯：不会“悄悄覆盖”历史。

### 21.8 compaction 的规则到底是什么，LLM 是否参与

触发条件：

1. prompt token 接近窗口上限。

压缩对象：

1. 非保护历史 turns（绝不先动 protected zone 和 tail anchor）。

压缩产物：

1. `CompactSegment` 摘要。
2. 必须附带 `replayRefs`（path/url/id 至少一个）。

LLM 是否参与：

1. 可以参与摘要（推荐）。
2. 但 replay 引用保留是硬规则，不可省略。
3. 如果 LLM 摘要失败，最差也要保住结构化引用键。

这保证“压缩可逆、调试可回放”。

### 21.9 pre-flush 在什么时候做，和 write limit 怎么配合

执行时机：

1. 判断即将 compaction 时，先执行 pre-flush。

作用：

1. 在压缩前抢救高价值 durable memory。

与限流关系（实现要点）：

1. pre-flush 写入计入 session cap。
2. pre-flush 使用独立 `writeReserve`，不占普通 per-turn 配额。
3. 与同回合普通写入冲突时按确定性规则去重。

否则常见故障：

1. 关键信息本该保存，结果被普通配额挤掉。
2. 同 key 被两条路径重复写污染。

### 21.10 离线维护（consolidation/decay/archive）怎么做

离线维护是“长期健康机制”，不是在线回合逻辑。

Consolidation（合并）：

1. 周期或手动触发。
2. 对同前缀或语义重复项合并。
3. 保留 canonical 项，其余标 `superseded`。

Decay（衰减）：

1. 长期未被引用或更新的项标 `deprecated`。
2. 不立即删除，先降权。

Archive（归档）：

1. 将 `deprecated` 移到 `memory/archive.jsonl`。
2. 默认不注入 prompt，但可按需恢复。

初级同学常犯错误：

1. 直接删除旧项，导致历史断裂。
2. 离线合并不写 provenance，后续无法解释。

### 21.11 “前几个 session 的 continuity summary”是什么

它是会话交接记录，帮助新 session 立刻接续。

建议字段：

1. 本 session 核心进展。
2. 当前 active tasks。
3. 关键 blocker。
4. 建议 next actions。

谁维护：

1. `ContinuityWriter` 在 session 结束、切项目、或长空闲时写入。

数据来源：

1. `HistoryStore` 的 turns/segments。
2. `TaskStore` 的状态变化。
3. `MemoryWriteGate` 的关键写入结果。
4. 工具执行摘要与失败签名。

注意：

1. continuity summary 是“交接摘要”，不是完整历史替代品。
2. 需要和 replay 引用配合，确保可追溯。

### 21.12 给初级工程师的落地顺序（建议）

建议按以下顺序实现，能最快形成闭环：

1. 先做数据层：`TaskStore/MemoryStore/ContinuityStore` 基础读写。
2. 再做 `ProjectResolver + TaskStateUpdater`（先规则版）。
3. 接入 `ContextAssembler + BudgetPlanner`，先跑通固定区块与保护区。
4. 接入 `MemoryWriteGate`（先不做 LLM 提取，用规则候选也可）。
5. 接入 `CompactionEngine` + `replayRefs`。
6. 最后补离线维护、telemetry、integrity/recovery。

每一步都要有可验证测试：

1. 不变量测试（protected zone、tail anchor、write gate mandatory）。
2. 退化测试（索引坏、存储坏、超限写入）。
3. 回放测试（compaction 后可 replay）。

### 21.13 最后给你一个“最短判断标准”

如果一个实现同时满足下面 6 条，基本可以认为做对了：

1. 新会话能自动恢复项目和任务上下文。
2. 最近关键回合在压力下仍保住。
3. Tail Anchor 每轮都更新并位于尾部。
4. Durable memory 写入可解释、可限流、可审计。
5. 压缩后任一关键信息都能通过引用回放。
6. 索引或文件异常时有明确 fallback 与恢复路径。
