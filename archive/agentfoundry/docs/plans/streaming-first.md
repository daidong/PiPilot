# Streaming-First Architecture Plan

> 让 Agent 执行的一切（文本、工具调用、工具结果、步骤状态）成为一条统一事件流。

## 设计目标

```typescript
// 新 API：流式消费
for await (const event of agent.run(prompt).events()) {
  switch (event.type) {
    case 'text-delta':    process.stdout.write(event.text); break
    case 'tool-call':     console.log(`Calling ${event.tool}...`); break
    case 'tool-result':   console.log(`${event.tool} → ${event.success}`); break
    case 'step-start':    console.log(`Step ${event.step}`); break
    case 'step-finish':   break
    case 'done':          console.log(event.result); break
  }
}

// 旧 API：完全向后兼容（await 的行为不变）
const result = await agent.run(prompt)

// 旧 callback API：内部消费 stream，语法糖保留
createAgent({ onStream: (chunk) => ..., onToolCall: (t, i) => ... })
```

## 核心设计

### 1. AgentEvent 联合类型

```typescript
// src/types/agent-event.ts (新文件)

export type AgentEvent =
  | AgentTextDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentStepStartEvent
  | AgentStepFinishEvent
  | AgentErrorEvent
  | AgentDoneEvent

interface AgentTextDeltaEvent {
  type: 'text-delta'
  text: string
  step: number
}

interface AgentToolCallEvent {
  type: 'tool-call'
  tool: string
  toolCallId: string
  args: unknown
  step: number
}

interface AgentToolResultEvent {
  type: 'tool-result'
  tool: string
  toolCallId: string
  success: boolean
  data?: unknown
  error?: string
  step: number
}

interface AgentStepStartEvent {
  type: 'step-start'
  step: number
}

interface AgentStepFinishEvent {
  type: 'step-finish'
  step: number
  text: string
  toolCallCount: number
}

interface AgentErrorEvent {
  type: 'error'
  error: string
  recoverable: boolean
  step: number
}

interface AgentDoneEvent {
  type: 'done'
  result: AgentRunResult
}
```

### 2. AgentLoop 改造：内部 yield 事件

**当前**：`AgentLoop.run()` → `Promise<AgentRunResult>`
**改造后**：`AgentLoop.runStream()` → `AsyncGenerator<AgentEvent, AgentRunResult>`

关键：**不改 `run()`**。新增 `runStream()` 方法，`run()` 内部调用 `runStream()` 并 collect 到底。

```typescript
// AgentLoop 内部
async *runStream(userPrompt: string): AsyncGenerator<AgentEvent, AgentRunResult> {
  // ... 现有 run() 的所有逻辑，把关键点的 callback 调用改为 yield：

  yield { type: 'step-start', step }

  // LLM streaming — 原来调 onText(text)，现在 yield
  // 但 LLM streaming 是 callback 模式（streamWithCallbacks），
  // 需要用 channel/queue 桥接 → Step 3

  yield { type: 'tool-call', tool: tc.toolName, ... }
  yield { type: 'tool-result', tool: name, success, ... }
  yield { type: 'step-finish', step, text, toolCallCount }

  // 最终
  return result  // AgentRunResult（generator 的 return value）
}

// run() 变成 runStream() 的 consumer
async run(userPrompt: string): Promise<AgentRunResult> {
  const gen = this.runStream(userPrompt)
  let next: IteratorResult<AgentEvent, AgentRunResult>
  do {
    next = await gen.next()
    if (!next.done) {
      // 触发旧 callback（向后兼容）
      this.dispatchToCallbacks(next.value)
    }
  } while (!next.done)
  return next.value
}
```

### 3. Callback → AsyncGenerator 桥接

`streamWithCallbacks()` 的 onText 是 push 模式。要在 `runStream()` 里 yield，需要一个简单的 channel：

```typescript
// src/utils/async-channel.ts (新文件，~30 行)

export function createChannel<T>(): {
  push: (value: T) => void
  done: () => void
  [Symbol.asyncIterator]: () => AsyncIterator<T>
}
```

LLM 调用阶段：
```typescript
const channel = createChannel<AgentEvent>()

streamWithCallbacks(client, opts, {
  onText: (text) => {
    responseText += text
    channel.push({ type: 'text-delta', text, step })
  },
  onToolCall: (tc) => {
    channel.push({ type: 'tool-call', ... })
  },
  onFinish: () => channel.done(),
  onError: (err) => channel.done()
})

// yield 所有 LLM 事件
for await (const event of channel) {
  yield event
}
```

### 4. AgentRunHandle 添加 .events()

```typescript
// agent-run-handle.ts

export class AgentRunHandle implements PromiseLike<AgentRunResult> {
  private _eventStream: AsyncGenerator<AgentEvent, AgentRunResult> | null = null

  // 新方法
  events(): AsyncIterable<AgentEvent> {
    // 惰性创建：第一次调 events() 时启动 stream
    // 如果已经 await 过了（_promise resolved），抛错
    return this._getOrCreateEventStream()
  }

  // 向后兼容：await agent.run(prompt) 仍然工作
  // 内部 consume stream 到底
}
```

**互斥规则**：
- `await handle` 和 `handle.events()` 不能同时使用（两者都 consume 同一个 generator）
- `events()` 返回的 iterable 只能遍历一次
- `steer()` / `followUp()` / `stop()` 在 stream 模式下仍然有效

### 5. createAgent 适配

```typescript
// create-agent.ts 中 agent.run() 的实现

run(prompt, options) {
  return new AgentRunHandle(async (attachLoop, attachStream) => {
    // ... 现有初始化逻辑 ...

    const agentLoop = new AgentLoop({ ... })
    attachLoop(agentLoop)

    // 如果消费者请求了 events()，走 stream 路径
    // 否则走传统 run() 路径（含 callback 分发）
    if (attachStream) {
      return yield* agentLoop.runStream(prompt)  // 不行，这里不是 generator
    }

    return agentLoop.run(prompt)
  })
}
```

实际上 AgentRunHandle 需要两种模式：
- **Promise 模式**（默认）：`executor` 是 async function，返回 Promise
- **Stream 模式**（`events()` 调用时）：`executor` 是 async generator

更好的实现：AgentRunHandle 始终创建 stream，`then()` 内部 consume 到底。

## 实施步骤

### Step 1: AgentEvent 类型定义
- 新建 `src/types/agent-event.ts`
- 在 `src/types/index.ts` 和 `src/index.ts` 中导出
- **纯类型，零运行时改动**

### Step 2: AsyncChannel 工具
- 新建 `src/utils/async-channel.ts`
- 简单的 push/pull 队列，把 callback 桥接到 AsyncIterator
- 写单元测试

### Step 3: AgentLoop.runStream()
- 新增 `runStream()` 方法，AsyncGenerator 签名
- 提取现有 `run()` 的主循环逻辑到内部 `_executeLoop()` generator
- `run()` 调用 `_executeLoop()` 并 collect + dispatch callbacks
- `runStream()` 直接返回 `_executeLoop()`
- 关键改造点：
  - step 循环的入口/出口 → yield step-start/step-finish
  - streamWithCallbacks 的 onText → 通过 channel yield text-delta
  - tool 执行前后 → yield tool-call/tool-result
  - 错误恢复 → yield error（recoverable=true）
  - 最终 → return AgentRunResult

### Step 4: AgentRunHandle.events()
- 添加 `events()` 方法
- 修改 constructor：始终用 generator 模式
- `then()` 在内部 consume generator 到底
- `events()` 返回 generator（如果尚未被 consume）

### Step 5: createAgent 适配
- 修改 `agent.run()` 内的 AgentRunHandle 构造
- 通过 agentLoop.runStream() 获取事件流
- 旧 callback (onStream/onToolCall/onToolResult) 仍然工作：
  在 consume 过程中分发到 callbacks

### Step 6: 测试 & 示例
- `tests/agent/agent-stream.test.ts` — 事件流行为测试
- `examples/hello-world/with-streaming.ts` — 流式消费示例
- 验证旧 API 100% 向后兼容（现有 1529 测试全过）

## 关键约束

1. **向后兼容** — `await agent.run(prompt)` 行为不变，现有 1529 测试必须全过
2. **回调兼容** — `onStream`/`onToolCall`/`onToolResult` 继续工作
3. **不重写 AgentLoop** — 只在现有 `run()` 旁边新增 `runStream()`，提取共享逻辑
4. **steer/followUp/stop** — stream 模式下仍然有效
5. **AgentEvent 是公开 API** — 类型要稳定、语义清晰

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/types/agent-event.ts` | 新建 | AgentEvent 联合类型 |
| `src/types/index.ts` | 修改 | 导出 AgentEvent |
| `src/index.ts` | 修改 | 导出 AgentEvent |
| `src/utils/async-channel.ts` | 新建 | callback→AsyncIterator 桥 |
| `src/agent/agent-loop.ts` | 修改 | 新增 runStream()，提取 _executeLoop() |
| `src/agent/agent-run-handle.ts` | 修改 | 新增 events()，内部改用 generator |
| `src/agent/create-agent.ts` | 修改 | 适配 runStream 路径 |
| `tests/utils/async-channel.test.ts` | 新建 | channel 单元测试 |
| `tests/agent/agent-stream.test.ts` | 新建 | 事件流行为测试 |
| `examples/hello-world/with-streaming.ts` | 新建 | 流式消费示例 |
