# RFC-004: Planner / Reviewer / Coordinator Capability Upgrade (Lean v2.1)

**Status**: Draft (Proposed)  
**Author**: AgentFoundry team  
**Date**: 2026-02-15  
**Target**: 在不增加流程复杂度的前提下，显著提升研究推进能力

## 1. 背景

当前 v2 虽然在“瘦身”方向正确，但 `planner`、`reviewer`、`coordinator` 仍存在能力短板：

1. `planner` 容易产出泛化流程话术，难以形成可执行的单回合推进计划。  
2. `reviewer` 反馈偏“判分”，缺少可落地的修复方案。  
3. `coordinator` 相比 research-pilot 的主动工具调度能力更弱，意图路由和上下文编译不足。  

## 2. 设计目标

1. 不改变 v2 主方向（单页 Mission Board + 三核心资产）。  
2. 提升 agent 的“问题推进能力”，不是增加管理层。  
3. 把能力增强收敛到三件事：  
   1. 更强的结构化 prompt 契约，  
   2. 更稳的工具路由策略，  
   3. 更严格的上下文裁剪与预算控制。  

## 3. 非目标

1. 不恢复 v1 的重门控链路（claim/evidence/risk 作为主阻断）。  
2. 不引入新的复杂资产家族。  
3. 不把系统演化为“通用研究管理平台”。  

## 4. 总体方案

### 4.1 Planner 升级（Plan-as-Contract）

把 planner 从“文本建议器”升级为“单回合执行合同生成器”。

每回合必须产出：

1. `current_focus`（本回合聚焦）  
2. `why_now`（为何现在做）  
3. `action`（四选一：explore/refine/issue/digest）  
4. `tool_plan`（最多 3 步，明确工具与预期产物）  
5. `expected_output`（本回合预期生成的资产）  
6. `need_from_user`（若需外部输入，明确提交要求）  
7. `done_definition`（何时算完成）  

### 4.2 Reviewer 升级（Critique-to-Fix）

把 reviewer 从“抽象评审”升级为“修复驱动审查”。

每回合输出：

1. `verdict`（pass / revise / block）  
2. `critical_issues`（最多 3 条关键问题）  
3. `fix_plan`（逐条可执行修复动作）  
4. `rewrite_patch`（对 planner/coordinator 输出的结构化改写建议）  
5. `confidence`（0-1）  

### 4.3 Coordinator 升级（Intent + Context Compiler）

保留现有 runTurn 框架，增强三项：

1. `intent routing`：规则优先 + LLM fallback，决定 literature/data/writing/local 的工具优先级。  
2. `context compiler`：只组装当前回合必要上下文（Current Focus + 最近相关资产 + 最新洞察）。  
3. `failure fallback`：工具失败或预算触顶时，自动降级为明确 `Need From You` 请求，而非空转。  

## 5. Agent 契约（JSON Schema）

以下 schema 作为 v2.1 实现契约；字段可扩展，但 required 字段不可缺失。

### 5.1 Planner Output Schema

```json
{
  "$id": "yolo.planner.output.v2_1",
  "type": "object",
  "required": [
    "current_focus",
    "why_now",
    "action",
    "tool_plan",
    "expected_output",
    "need_from_user",
    "done_definition",
    "risk_flags"
  ],
  "properties": {
    "current_focus": { "type": "string", "minLength": 8 },
    "why_now": { "type": "string", "minLength": 8 },
    "action": {
      "type": "string",
      "enum": [
        "explore",
        "refine_question",
        "issue_experiment_request",
        "digest_uploaded_results"
      ]
    },
    "tool_plan": {
      "type": "array",
      "minItems": 1,
      "maxItems": 3,
      "items": {
        "type": "object",
        "required": ["step", "tool", "goal", "output_contract"],
        "properties": {
          "step": { "type": "integer", "minimum": 1 },
          "tool": { "type": "string" },
          "goal": { "type": "string" },
          "output_contract": { "type": "string" }
        }
      }
    },
    "expected_output": {
      "type": "array",
      "items": { "type": "string" }
    },
    "need_from_user": {
      "type": "object",
      "required": ["required", "request"],
      "properties": {
        "required": { "type": "boolean" },
        "request": { "type": "string" },
        "required_files": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "done_definition": { "type": "string", "minLength": 8 },
    "risk_flags": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 5
    }
  }
}
```

### 5.2 Reviewer Output Schema

```json
{
  "$id": "yolo.reviewer.output.v2_1",
  "type": "object",
  "required": [
    "verdict",
    "critical_issues",
    "fix_plan",
    "rewrite_patch",
    "confidence",
    "notes_for_user"
  ],
  "properties": {
    "verdict": { "type": "string", "enum": ["pass", "revise", "block"] },
    "critical_issues": {
      "type": "array",
      "maxItems": 3,
      "items": {
        "type": "object",
        "required": ["id", "severity", "message"],
        "properties": {
          "id": { "type": "string" },
          "severity": { "type": "string", "enum": ["high", "medium", "low"] },
          "message": { "type": "string" }
        }
      }
    },
    "fix_plan": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["issue_id", "action"],
        "properties": {
          "issue_id": { "type": "string" },
          "action": { "type": "string" }
        }
      }
    },
    "rewrite_patch": {
      "type": "object",
      "required": ["apply", "target", "patch"],
      "properties": {
        "apply": { "type": "boolean" },
        "target": { "type": "string", "enum": ["planner_output", "coordinator_output"] },
        "patch": { "type": "object" }
      }
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "notes_for_user": { "type": "string" }
  }
}
```

### 5.3 Coordinator Turn Output Schema

```json
{
  "$id": "yolo.coordinator.turn_output.v2_1",
  "type": "object",
  "required": [
    "action",
    "actionRationale",
    "summary",
    "assets",
    "askUser",
    "execution_trace"
  ],
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "explore",
        "refine_question",
        "issue_experiment_request",
        "digest_uploaded_results"
      ]
    },
    "actionRationale": { "type": "string" },
    "summary": { "type": "string" },
    "assets": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "payload"],
        "properties": {
          "type": { "type": "string" },
          "payload": { "type": "object" },
          "supersedes": { "type": "string" }
        }
      }
    },
    "askUser": {
      "type": "object",
      "required": ["required", "question", "blocking"],
      "properties": {
        "required": { "type": "boolean" },
        "question": { "type": "string" },
        "blocking": { "type": "boolean" },
        "required_files": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "execution_trace": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["tool", "reason", "result_summary"],
        "properties": {
          "tool": { "type": "string" },
          "reason": { "type": "string" },
          "result_summary": { "type": "string" }
        }
      }
    }
  }
}
```

## 6. 示例输入输出

以下示例围绕目标：
`"分析 Claude Code/Codex 类 agent 的本地工具调用延迟并提出优化方向"`。

### 6.1 Planner 示例

Input（简化）：

```json
{
  "stage": "S2",
  "goal": "定位本地工具调用链路中的主要延迟来源",
  "latest_insight": "已有问题定义，但缺少可执行实验需求",
  "available_tools": ["literature-search", "data-analyze", "writing-outline", "bash"]
}
```

Output（示例）：

```json
{
  "current_focus": "生成一份可由外部执行者直接实施的延迟分解实验需求",
  "why_now": "当前最大瓶颈是没有可执行实验合同，导致研究无法进入可验证阶段",
  "action": "issue_experiment_request",
  "tool_plan": [
    {
      "step": 1,
      "tool": "literature-search",
      "goal": "确认现有 agent tool-runner 延迟分解维度",
      "output_contract": "给出 3-5 个可比较的延迟分段术语"
    },
    {
      "step": 2,
      "tool": "writing-draft",
      "goal": "生成面向 junior PhD 的实验执行说明",
      "output_contract": "产出包含 setup/method/metrics/upload checklist 的草案"
    }
  ],
  "expected_output": ["ExperimentRequest"],
  "need_from_user": {
    "required": true,
    "request": "请在本地执行实验并上传原始 trace 与聚合统计结果",
    "required_files": ["raw_traces.jsonl", "summary_percentiles.csv", "env_info.txt"]
  },
  "done_definition": "ExperimentRequest 可被独立执行者直接运行且上传要求明确",
  "risk_flags": ["env_variance", "insufficient_sample_size"]
}
```

### 6.2 Reviewer 示例

Input（简化）：

```json
{
  "stage": "S2",
  "planner_output": {
    "action": "issue_experiment_request",
    "expected_output": ["ExperimentRequest"]
  },
  "draft_assets": [
    { "type": "ExperimentRequest", "payload": { "method": "run benchmark" } }
  ]
}
```

Output（示例）：

```json
{
  "verdict": "revise",
  "critical_issues": [
    {
      "id": "exp_req_missing_controls",
      "severity": "high",
      "message": "缺少对照组定义，无法归因隔离层与 I/O 管道差异"
    },
    {
      "id": "upload_contract_ambiguous",
      "severity": "high",
      "message": "未明确上传文件字段与命名规则"
    }
  ],
  "fix_plan": [
    {
      "issue_id": "exp_req_missing_controls",
      "action": "补充 baseline/control/treatment 三组定义，并固定 run 次数与 warmup 规则"
    },
    {
      "issue_id": "upload_contract_ambiguous",
      "action": "增加 required_files 列表与每个文件的 schema 说明"
    }
  ],
  "rewrite_patch": {
    "apply": true,
    "target": "planner_output",
    "patch": {
      "done_definition": "包含可复现实验步骤、控制组与明确上传清单"
    }
  },
  "confidence": 0.86,
  "notes_for_user": "修订后可直接外包执行，不需要额外系统内实验编排"
}
```

### 6.3 Coordinator 示例

Input（简化）：

```json
{
  "turnSpec": {
    "stage": "S2",
    "objective": "修复实验需求可执行性缺陷"
  },
  "planner_output": {
    "action": "issue_experiment_request"
  },
  "reviewer_output": {
    "verdict": "revise"
  }
}
```

Output（示例）：

```json
{
  "action": "issue_experiment_request",
  "actionRationale": "reviewer 指出高优先级缺陷，先修复实验合同再进入外部执行",
  "summary": "已重写 ExperimentRequest，明确控制组、指标与上传格式",
  "assets": [
    {
      "type": "ExperimentRequest",
      "payload": {
        "objective": "分离 isolation/pty/streaming 对工具调用延迟的贡献",
        "method": "按 baseline/control/treatment 执行 30 runs",
        "required_files": ["raw_traces.jsonl", "summary_percentiles.csv", "env_info.txt"]
      }
    }
  ],
  "askUser": {
    "required": true,
    "question": "请按 ExperimentRequest 执行并上传 3 份文件",
    "blocking": true,
    "required_files": ["raw_traces.jsonl", "summary_percentiles.csv", "env_info.txt"]
  },
  "execution_trace": [
    {
      "tool": "writing-draft",
      "reason": "将 reviewer 修复意见转为可执行实验说明",
      "result_summary": "生成可外包执行的实验需求草案"
    }
  ]
}
```

## 7. 实施计划（最小改造）

### M1: Prompt 与输出契约升级

1. 升级 `planner.ts` prompt 与输出 parser。  
2. 升级 `reviewer.ts` prompt 与输出 parser。  
3. 保持 runtime 结构不变，仅调整字段映射。  

### M2: Coordinator 路由升级

1. 增加 intent routing（规则优先）。  
2. 增加 context compiler（强裁剪）。  
3. 增加 failure fallback（自动 ask_user 模板）。  

### M3: 验收与灰度

1. 用 5 个真实研究任务回放评估。  
2. 对比 v2 与 v2.1 的推进率、用户行动清晰度、非进展回合占比。  

## 8. 验收指标

1. `topic_progress_rate`：连续 3 回合中 >=2 回合有实质推进。  
2. `user_action_clarity`：进入 WAITING_EXTERNAL 后用户 30 秒内能理解下一步。  
3. `tool_relevance_rate`：工具调用与意图匹配率提升。  
4. `non_progress_turn_ratio`：空转回合占比下降。  

## 9. 开放问题

1. reviewer 的 `block` 是否只保留给结构性缺失（而非内容分歧）？  
2. `execution_trace` 在 UI 默认视图是否显示前 2 条即可？  
3. planner 的 `tool_plan` 是否允许 0 步（纯总结回合）？当前建议不允许。  
