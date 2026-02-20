下面是把我之前那版 RFC 完整融合你最新两条约束（验收必须由用户 UI 审核、完全禁止时间触发）后的 Research Assistant Mode（RAM）v0.2 完整版 RFC。你可以直接丢进 repo 作为 RFC-RAM-001.md 使用。

⸻

RFC-RAM-001：Research Assistant Mode（RAM）v0.2

Status: Proposed
Owner: runtime / research-assistant
Audience: 单用户研究协作（系统方向为主，兼容一般科研）
Core Idea: 用户主导方向与验收；助手主导探索与执行；系统用“审阅包 + 证据链 + 事件触发”提供可靠、负责的协作体验。

⸻

0. 摘要

RAM 不是全自动 researcher，而是 research 助手：
  • 用户提供题目/方向/偏好/约束，并对关键节点做决策与验收；
  • 助手持续探索与推进：检索、阅读、编码、运行、数据分析、整理产物；
  • 助手在达到“可审阅状态”或“需要用户决策”时主动沟通；
  • 验收只由用户在 UI 中完成（Approve / Request changes / Reject），助手不自我验收；
  • 无任何基于时间的触发机制：所有沟通与审阅均由事件触发。

⸻

1. 目标与非目标

1.1 目标（MUST）
  1.  最大化用户减负：助手能完成复杂编码、实验运行、数据分析、图表生成、文献矩阵整理。
  2.  可靠的协作体验：每次找用户都带可审阅材料（Review Packet），可追溯、可复现、可对比。
  3.  用户验收 Gate：任何“完成/通过”必须由用户在 UI 操作确认。
  4.  事件驱动沟通：只在关键事件发生时发起沟通与审阅请求。
  5.  动态任务板：任务随用户反馈与探索结果持续更新、拆分、合并、关闭，状态透明。
  6.  证据优先：结论与建议必须绑定证据（日志、数据、脚本、commit、引用）。

1.2 非目标（v0.2 不做或不承诺）
  • 完全无人监督地改变研究方向或贡献叙事（方向变更必须请求用户决策）。
  • 自动化“最终正确性判定”（助手只能做 preflight 检查，不做验收结论）。
  • 多用户/权限复杂协作系统（先单用户跑通协议与闭环）。
  • 无限检索/无限成本实验（需要预算约束与用户批准）。

⸻

2. 核心原则

2.1 可靠感来源（Normative）
  • 可追溯（Traceable）：每个结论/建议都能点到证据对象。
  • 可复现（Reproducible）：每个结果包必须提供一键复现入口（命令、环境、参数）。
  • 可审阅（Reviewable）：每次提交必须是“审阅包”，用户能快速看到变更、证据、风险与所需决策。
  • 不越权（Non-self-accepting）：助手不做“通过/完成”的最终判定，只做准备与预检。
  • 事件驱动（Event-driven）：不基于时间打扰用户；只有事件触发才沟通。

2.2 角色边界
  • User（验收者/研究 owner）：决定方向、预算、关键选择；在 UI 里验收。
  • Assistant（执行者/推进者）：自主探索、执行任务、打包材料、提出选项与推荐、请求必要决策。
  • System（协作协议载体）：维护 taskboard、decision log、evidence registry、review queue 与 UI。

⸻

3. 核心对象与账本（Three Ledgers）

RAM 必须持久化三类“账本”，这是可靠感的工程化基础：
  1.  Taskboard：taskboard.yaml
  2.  Decisions Log：decisions.md（或 decisions.jsonl）
  3.  Evidence Registry：evidence/registry.json

此外引入一个一等公民对象：
  4.  Review Packet：review_packets/CP-*.json + 对应产物目录（results、plots、diff）

⸻

4. 系统工作流（Two Loops, Review-Gated）

4.1 Explore Loop（助手自主推进）

输入：用户题目/方向、当前任务板、已有证据、用户上一次反馈
输出：新证据、新产物、新任务变更、新审阅包（若达到可审阅状态）

核心约束：
  • 每次推进必须产生至少一种“可持久化产物”或“可复现证据”；
  • 任何会影响方向/成本/不可逆的动作在执行前必须触发对齐事件（见 §6）。

4.2 Align/Review Loop（用户审阅与决策）

触发：事件发生（见 §6）
输出：用户在 UI 做出 Approve / Request changes / Reject 或 Decision
系统动作：
  • Approve：将相关任务从 IN_REVIEW → DONE（或进入下一阶段任务）
  • Request changes：将任务退回 DOING 并记录用户评论为强制约束
  • Reject：将任务 DROPPED，并要求助手给替代方案（可选）

重要：任务完成必须通过 IN_REVIEW + Approve 路径，助手不能直接把任务标 DONE。

⸻

5. 状态机与任务状态（No Time Trigger）

5.1 Agent Runtime 状态（Project-level）
  • IDLE：等待用户输入或反馈
  • SCOPING：把题目落成可执行计划（不问卷式追问，先产出草案审阅包）
  • EXECUTING：执行/探索中（可能产生多个子任务）
  • AWAITING_REVIEW：已提交审阅包，等待用户动作
  • AWAITING_DECISION：需要用户做关键选择才能继续
  • BLOCKED：被阻塞（权限、数据、环境、矛盾证据）
  • DELIVERING：整理最终交付包（论文素材、复现包、报告）

5.2 Taskboard 状态（Task-level）

建议最小五态（MUST）：
  • TODO
  • DOING
  • BLOCKED
  • IN_REVIEW  ← 进入审阅队列，等待用户 UI 操作
  • DONE / DROPPED

⸻

6. 事件触发机制（Event-driven Only）

禁止时间触发：系统不得以 “每 N 分钟/小时” 为理由自动打扰用户或强制 checkpoint。

6.1 必须触发 Review/沟通的事件（MUST）
  1.  Reviewable Artifact Ready
产生可审阅的交付物：代码变更、实验结果包、图表包、相关工作矩阵、设计 memo。
  2.  Decision Required
下一步存在方向性选择 / 高成本 / 不可逆操作 / 引入重依赖。
  3.  Blocked
缺权限、缺数据、环境不通、实验异常无法自修复。
  4.  Preflight Failed
自动预检失败且需要用户决定是否绕过/降级/换路线。
  5.  Contradictory Evidence
新证据与当前假设或既有结论冲突，需要用户决定是否 pivot。
  6.  Scope Drift Detected
助手检测到任务目标与用户近期意图明显偏离，必须提示并请求对齐。

6.2 允许（但不强制）的事件（SHOULD）
  • Milestone Completed：完成一个用户明确标记的里程碑，可生成审阅包通知用户。
  • Risk Escalation：风险从 low→high（例如指标不稳定、实现成本暴涨）可提示用户。

⸻

7. Review Packet：审阅包协议（User Acceptance Gate）

Review Packet 是 UI 中“用户要审核的最小单元”。
所有请求用户审阅的内容必须封装为 Review Packet。

7.1 Review Packet 的固定展示结构（UI MUST 支持）
  • Summary：这次做了什么、为什么做
  • What Changed：变更范围（文件、模块、数据、参数）
  • Deliverables：新增/更新的产物列表（路径可点）
  • Evidence：证据链接（日志、csv、图、引用）
  • Reproduce：一键复现命令与环境信息
  • Preflight：自动预检结果（pass/fail + 链接日志）
  • Risks/Unknowns：已知风险与不确定性
  • Ask：需要用户做的最小决策（1–3 个）
  • Recommendation（可选）：助手建议用户点哪个按钮或选哪个 option（建议不等于验收）
  • Rollback Plan：回退/清理方式（代码/数据）

7.2 Review Packet 最小 schema（JSON 示例）

{
  "packet_id": "CP-0003",
  "type": "experiment_result",
  "title": "Lustre openat replay curve + eBPF breakdown (v1)",
  "scope": {
    "repo_changes": false,
    "data_paths": ["results/lustre/replay_curve.csv", "results/lustre/plots/curve.png"],
    "env": "clusterA:/mnt/lustre",
    "cost": { "cpu_hours": 3.2, "cloud_usd": 0 }
  },
  "deliverables": [
    { "path": "results/lustre/replay_curve.csv", "kind": "data" },
    { "path": "results/lustre/plots/curve.png", "kind": "figure" },
    { "path": "scripts/run_replay_curve.sh", "kind": "script" },
    { "path": "scripts/ebpf_openat_lat.bt", "kind": "script" }
  ],
  "evidence_refs": ["E-2026-02-20-001", "E-2026-02-20-002"],
  "reproduce": {
    "commands": [
      "bash scripts/run_replay_curve.sh --mount /mnt/lustre --rounds 10",
      "sudo bpftrace scripts/ebpf_openat_lat.bt > results/lustre/bpftrace.txt"
    ],
    "environment_capture": "evidence/env/clusterA_2026-02-20.json"
  },
  "preflight": {
    "status": "pass",
    "checks": [
      { "name": "script_dry_run", "status": "pass", "log": "evidence/preflight/CP-0003_dryrun.log" },
      { "name": "data_schema", "status": "pass", "log": "evidence/preflight/CP-0003_schema.log" }
    ]
  },
  "risks": [
    "eBPF probes depend on kernel config; portability unknown",
    "tail latency improvement may be confounded by directory tree shape"
  ],
  "ask": [
    {
      "question": "更希望把这项工作导向论文叙事还是工程补丁？",
      "type": "choice",
      "options": ["paper_mechanism", "engineering_patch"]
    }
  ],
  "recommendation": {
    "suggested_user_action": "approve",
    "rationale": "现象已被固化且可复现，足以进入下一轮定位实验。"
  },
  "rollback_plan": [
    "All changes are additive under results/ and scripts/. No destructive ops."
  ]
}


⸻

8. Preflight Checks：助手预检（Not Acceptance）

Preflight 的目的：让用户审阅更轻松、减少低级错误。
Preflight 不得输出“通过/完成”的验收结论，只能输出检查结果。

8.1 推荐的预检集合（按类型）
  • 代码变更：format/lint/test/build、依赖锁定、静态分析（可选）
  • 实验结果：脚本 dry-run、输出文件存在性、schema 校验、关键指标范围 sanity check
  • 图表包：图可复现（脚本 + 数据）、图与数据一致性 hash、版本记录
  • 文献矩阵：引用格式检查、去重、关键字段完备性（作者/年份/贡献/评估）

⸻

9. 简单 UI 规范（Very Simple UI）

目标：让用户 30 秒内完成“看懂 + 点按钮 + 留评论”。

9.1 必备视图（MUST）
  1.  Review Inbox（待审阅队列）
列表项字段：packet_id / title / type / risk / scope summary / ask summary
  2.  Packet View（审阅包详情）
按 §7.1 固定结构展示。
  3.  Artifact Viewer（产物查看）
  • code diff（文件折叠）
  • markdown diff
  • 图表（png/pdf）+ 数据表（csv预览）
  • 日志（log 预览）
  4.  Decision Bar（验收按钮 + 评论）
  • ✅ Approve
  • 🔁 Request changes（必须输入 comment 或勾选原因模板）
  • ⛔ Reject（必须输入理由，可选要求替代方案）

9.2 可选增强（SHOULD）
  • Taskboard 看板（五列状态）
  • Evidence 浏览（按 eid 查询、按 packet 聚合）
  • “Blocking reason” 快捷输入模板（权限、数据、环境、冲突证据）

9.3 UI 实现建议（非强制）
  • v0.2 推荐先做 本地 Web 极简 UI 或 CLI/TUI，但必须满足上述四视图能力。
  • UI 只负责展示与按钮动作，不承担复杂分析逻辑。

⸻

10. Taskboard：任务定义与自动更新规则（LLM 可更新，但需遵守约束）

10.1 Task schema（YAML 示例）

project:
  title: "Lustre openat acceleration study"
  topic: "metadata path caching / replay effects"
  constraints:
    budget:
      max_cloud_cost_usd: 20
      max_cpu_hours_per_batch: 8
    env:
      allowed_exec: ["local", "vm", "docker", "cluster"]
      forbidden_ops: ["delete_raw_data"]
tasks:
  - id: T-001
    title: "固化现象：openat replay curve 一键复现"
    status: IN_REVIEW
    owner: agent
    priority: P0
    estimate: { time_hours: 3, risk: medium }
    depends_on: []
    accept_criteria:
      - "Review Packet CP-0003 approved by user"
    outputs:
      - "scripts/run_replay_curve.sh"
      - "results/lustre/replay_curve.csv"
      - "results/lustre/plots/curve.png"
    blockers: []
    notes: ""

10.2 自动更新硬规则（MUST）
  1.  任何任务必须有 accept_criteria（且必须能由用户审阅动作闭环）
  2.  任务完成必须经过 IN_REVIEW 并被用户 Approve
  3.  大任务自动拆分：预计成本高或风险 high → 先拆成 spike + full
  4.  任务必须可关闭：DONE 或 DROPPED，不得长期悬挂无解释
  5.  用户评论是强约束：Request changes 的 comment 必须转写到任务 notes/criteria 并影响下一轮产物
  6.  证据绑定：只要产生新结论（claim），必须新增/关联 evidence id（无 evidence 的 claim 只能标 speculative）

⸻

11. Evidence Registry：证据索引（可追溯与复现的基础）

11.1 Evidence schema（JSON 示例）

[
  {
    "eid": "E-2026-02-20-001",
    "type": "experiment_log",
    "title": "lustre replay curve run_001",
    "path": "results/lustre/run_001/log.txt",
    "provenance": {
      "commit": "abc123",
      "cmd": "bash scripts/run_replay_curve.sh --rounds 10",
      "env_capture": "evidence/env/clusterA_2026-02-20.json"
    },
    "packet_id": "CP-0003",
    "timestamp": "2026-02-20T10:15:00-05:00"
  }
]


⸻

12. Decisions Log：用户决策记录（防止方向漂移与反复横跳）

每次用户在 UI 做出关键选择（尤其 Reject / Pivot / 预算/方向选择）必须记录：
  • Decision ID
  • 时间
  • 选择项与理由
  • 关联 packet/task/evidence
  • 影响（例如关闭哪些任务、创建哪些新任务）

⸻

13. 沟通协议（Assistant → User）——以 Review Packet 为中心

RAM 的沟通不是闲聊式同步，而是 “我已经准备好你需要审核的材料/或我需要你做一个决策”。

13.1 标准消息模板（事件触发）
  • 事件类型：Reviewable Artifact Ready / Decision Required / Blocked / Preflight Failed / Contradictory Evidence / Scope Drift
  • 我提交了什么：packet_id + 标题
  • 你要做什么：Approve / Request changes / Reject 或回答 1–3 个 ask
  • 如果你不做会怎样：明确说明阻塞点或风险
  • 我建议你怎么做：可选（不越权）

⸻

14. Repo 目录结构（建议）

project/
  taskboard.yaml
  decisions.md
  review_packets/
    CP-0001.json
    CP-0002.json
  evidence/
    registry.json
    env/
    preflight/
  scripts/
  results/
  notes/
  ui/               # 可选：本地 web 或 TUI


⸻

15. 安全与边界（必要但轻量）
  • 禁止危险操作（删除原始数据、破坏性命令）除非用户明确批准并在 decisions log 记录。
  • 所有外部成本（云费用、长时间占用集群）必须触发 Decision Required 事件。
  • 任何不可逆操作必须附 rollback plan 并进入审阅包。

⸻

16. MVP 交付标准（Definition of Done for RAM v0.2）

满足以下条件即可认为 RAM v0.2 可用：
  1.  能维护 taskboard / evidence / decisions 三账本
  2.  能生成 Review Packet 并推入 Review Inbox
  3.  UI 支持四视图与三按钮验收（Approve/Request changes/Reject）
  4.  无时间触发：所有对用户的请求来自事件触发
  5.  任务完成严格经 IN_REVIEW + Approve 闭环
  6.  每个审阅包提供 reproduce 命令与 preflight 结果链接

⸻

17. 示例：一次典型事件触发链（无时间机制）
  1.  助手完成实验与图表 → 触发 Reviewable Artifact Ready
  2.  系统生成 CP-0007 审阅包入队 → task 进入 IN_REVIEW
  3.  用户在 UI 查看图表/数据/脚本 → 点击 Request changes 并留言 “增加置信区间、补 baseline B”
  4.  系统记录 decision/comment → task 回到 DOING，新建子任务 T-xxx baseline B
  5.  助手补做并重新提交 CP-0008
  6.  用户 Approve → task DONE，证据归档，推进下一阶段

⸻

18. 关键设计结论（供实现时对齐）
  • RAM 的“可靠”来自 用户审阅 Gate 与 审阅包协议，不是来自 LLM 自评。
  • RAM 的“少打扰”来自 纯事件触发，不是来自固定时间节奏。
  • LLM 的核心职责是：把复杂工作做完 + 把材料整理到可审阅 + 把下一步变成少量选项。
