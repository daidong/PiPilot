# Plan: MessageStore Extraction ✅ COMPLETED

> 从 agent-loop.ts (1371 行) 中提取消息状态管理到独立的 MessageStore 类
>
> **Status**: All 4 steps completed. 1495/1495 tests pass, build clean.

## 动机

agent-loop.ts 承载了过多职责：LLM 调用循环、工具调度、消息历史管理、
pin/followUp/transformContext/token-trim 等。消息相关逻辑散布在 44 处引用中，
耦合度高，难以单独测试。

提取 MessageStore 的目标：
- **关注点分离**：消息状态管理与执行循环解耦
- **可测试性**：消息逻辑可独立单元测试，不依赖 LLM mock
- **为 View 原语铺路**：MessageStore + ViewPipeline 是第五原语 (View) 的基础

## 风险审计

| 风险 | 严重度 | 缓解措施 |
|------|--------|----------|
| `this.messages` 引用散布 44 处，替换可能遗漏 | 高 | grep 全量扫描 + TypeScript 编译检查 |
| followUp 队列与 run loop 状态耦合 | 中 | 先留在 AgentLoop，Phase 2 再迁移 |
| transformContext 是 async，MessageStore 需处理 | 低 | `buildView()` 返回 Promise |
| pin() 的 buffer 模式 (agent-run-handle.ts) 依赖时序 | 中 | 保持 buffer 在 handle 端，MessageStore 只管 pin 存储 |
| 1483+ 现有测试可能依赖 messages 的内部结构 | 中 | Step 0 先加行为测试锁定当前行为 |

## 执行计划

### Step 0: 行为测试（安全网）

在 `tests/core/message-store.test.ts` 中写 8 个测试，锁定当前行为：

1. `append()` 正确追加消息到历史
2. `pin()` 消息在 `buildView()` 中始终排在最前
3. `buildView()` 应用 transformContext 钩子
4. GAP-6 token trim：超限时丢弃最早的非 pinned 消息
5. pinned 消息不会被 trim 删除
6. followUp 队列 FIFO 顺序
7. `getHistory()` 返回不可变快照（修改不影响内部状态）
8. 空消息列表 + pin 的边界情况

**通过标准**：8/8 测试通过后才进入 Step 1。

### Step 1: 创建 MessageStore

文件：`src/core/message-store.ts` (~80 行)

```typescript
import type { Message } from '../llm/index.js'
import { countTokens } from '../utils/tokenizer.js'

export interface MessageStoreConfig {
  contextWindow?: number
  preCallTrimThreshold?: number
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>
}

export class MessageStore {
  private messages: Message[] = []
  private pinned: Message[] = []
  private config: MessageStoreConfig

  constructor(config: MessageStoreConfig = {}) {
    this.config = config
  }

  /** 追加消息到历史 */
  append(message: Message): void {
    this.messages.push(message)
  }

  /** 追加多条消息 */
  appendAll(messages: Message[]): void {
    this.messages.push(...messages)
  }

  /** 固定消息（永不被 trim） */
  pin(message: Message): void {
    this.pinned.push(message)
  }

  /** 获取历史快照（不可变） */
  getHistory(): readonly Message[] {
    return [...this.messages]
  }

  /** 获取 pinned 消息快照 */
  getPinned(): readonly Message[] {
    return [...this.pinned]
  }

  /** 消息数量 */
  get length(): number {
    return this.messages.length
  }

  /**
   * 构建 LLM 调用视图：pin → transform → trim
   * 这是未来 View 原语的雏形
   */
  async buildView(): Promise<Message[]> {
    // 1. 应用 transformContext
    let view = this.config.transformContext
      ? await this.config.transformContext([...this.messages])
      : [...this.messages]

    // 2. 前置 pinned 消息
    if (this.pinned.length > 0) {
      view = [...this.pinned, ...view]
    }

    // 3. GAP-6 token trim
    if (this.config.contextWindow && view.length > 0) {
      view = this.trimToFit(view)
    }

    return view
  }

  private trimToFit(messages: Message[]): Message[] {
    const threshold = this.config.preCallTrimThreshold ?? 0.85
    const limit = Math.floor(this.config.contextWindow! * threshold)
    const estimated = countTokens(JSON.stringify(messages))

    if (estimated <= limit) return messages

    const pinnedCount = this.pinned.length
    const mutable = messages.slice(pinnedCount)

    while (mutable.length > 1) {
      const reEstimated = countTokens(
        JSON.stringify([...this.pinned, ...mutable])
      )
      if (reEstimated <= limit) break
      mutable.shift()
    }

    return [...this.pinned, ...mutable]
  }
}
```

**通过标准**：Step 0 的 8 个测试全部通过。

### Step 2: 逐步委托

在 agent-loop.ts 中：

1. 用 `this.store = new MessageStore(config)` 替换 `this.messages: Message[] = []` 和 `this.pinnedMessages: Message[] = []`
2. 替换所有 `this.messages.push(...)` → `this.store.append(...)`
3. 替换 `messagesToSend` 构建块 → `await this.store.buildView()`
4. 替换 `this.pinnedMessages` 引用 → `this.store.pin()` / `this.store.getPinned()`
5. 替换 `this.messages` 读取 → `this.store.getHistory()`

**每替换一批后运行全量测试**，不要一次性替换所有 44 处。

建议分 3 个 PR：
- PR-A: 引入 MessageStore + 测试（不改 agent-loop）
- PR-B: agent-loop 委托 append/pin/getHistory
- PR-C: agent-loop 委托 buildView（最关键的一步）

**通过标准**：每个 PR 后 1483+ 测试全部通过 + `npx tsc --noEmit` 无错误。

### Step 3: 验证 & 清理

1. `npm run test:run` — 所有测试通过
2. `npm run build` — 构建干净
3. 手动跑一次 coding-agent 示例确认端到端正常
4. grep 确认 agent-loop.ts 中不再直接操作 `Message[]`
5. 更新 `docs/PI_MONO_IMPROVEMENTS.md` 记录 View 原语的进展

## 不做的事

- **不提取 ViewPipeline 抽象**：transform→pin→trim 只有 ~15 行，不值得单独抽象
- **不迁移 followUp 队列**：它与 run loop 状态高度耦合，强行迁移风险大于收益
- **不改变外部 API**：createAgent 的配置接口保持不变

## 预估

- Step 0: ~1h (8 个测试)
- Step 1: ~30min (MessageStore 类)
- Step 2: ~2h (逐步替换 + 测试)
- Step 3: ~30min (验证)
- **总计: ~4h**
