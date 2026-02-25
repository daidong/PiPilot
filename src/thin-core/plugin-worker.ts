import vm from 'node:vm'
import { parentPort } from 'node:worker_threads'

type HookName = 'onInit' | 'beforeModel' | 'afterModel' | 'beforeTool' | 'afterTool' | 'onEvent'

interface InitPayload {
  manifest: { id: string; version: string }
  code: string
  pluginDir: string
}

interface WorkerRequest {
  type: 'init' | 'run_tool' | 'run_hook' | 'run_guard' | 'run_context' | 'dispose' | 'ping' | 'host_op_result'
  reqId?: number
  payload?: any
}

interface WorkerResponse {
  type: 'ready' | 'response' | 'host_op' | 'emit'
  reqId?: number
  ok?: boolean
  value?: any
  error?: string
  payload?: any
  op?: string
}

if (!parentPort) {
  throw new Error('plugin-worker requires a parentPort')
}
const port = parentPort

let pluginId = 'unknown'
let initialized = false
let disposeHandler: (() => Promise<void> | void) | undefined

const prompts: string[] = []
const routes: any[] = []
const uiBindings: any[] = []
const guards: Array<(payload: any) => Promise<any> | any> = []
const contexts: Array<{ id: string; handler: (payload: any) => Promise<any> | any }> = []
const tools = new Map<string, { def: any; handler: (args: any, ctx: any) => Promise<any> | any }>()
const hooks: Record<HookName, Array<(payload: any, ctx: any) => Promise<any> | any>> = {
  onInit: [],
  beforeModel: [],
  afterModel: [],
  beforeTool: [],
  afterTool: [],
  onEvent: []
}

let hostCallSeq = 1
const hostPending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>()

function post(msg: WorkerResponse): void {
  port.postMessage(msg)
}

function safeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function hostCall(op: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqId = hostCallSeq
    hostCallSeq += 1
    hostPending.set(reqId, { resolve, reject })
    post({ type: 'host_op', reqId, op, payload })
  })
}

function createApi() {
  const api = {
    tool(def: any, handler: (args: any, ctx: any) => Promise<any> | any) {
      if (!def || typeof def.name !== 'string' || typeof handler !== 'function') {
        throw new Error('api.tool requires (definition, handler)')
      }
      tools.set(def.name, { def, handler })
    },
    prompt(text: string) {
      if (typeof text === 'string' && text.trim().length > 0) {
        prompts.push(text)
      }
    },
    guard(handler: (payload: any) => Promise<any> | any) {
      if (typeof handler !== 'function') {
        throw new Error('api.guard requires a function')
      }
      guards.push(handler)
    },
    context(id: string, handler: (payload: any) => Promise<any> | any) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('api.context requires a context id')
      }
      if (typeof handler !== 'function') {
        throw new Error('api.context requires a function handler')
      }
      contexts.push({ id, handler })
    },
    route(def: any) {
      routes.push(def)
    },
    ui(def: any) {
      uiBindings.push(def)
    },
    hook(name: HookName, handler: (payload: any, ctx: any) => Promise<any> | any) {
      if (!(name in hooks)) {
        throw new Error(`Unsupported hook: ${name}`)
      }
      if (typeof handler !== 'function') {
        throw new Error('api.hook requires a function')
      }
      hooks[name].push(handler)
    },
    emit(type: string, data?: Record<string, unknown>) {
      post({ type: 'emit', payload: { type, data } })
    },
    ops: {
      fs: {
        read: (path: string) => hostCall('fs.read', { path }),
        write: (path: string, content: string) => hostCall('fs.write', { path, content }),
        list: (path: string) => hostCall('fs.list', { path })
      },
      network: {
        fetch: (url: string, init?: Record<string, unknown>) => hostCall('network.fetch', { url, init })
      },
      bash: {
        exec: (command: string, timeoutMs?: number) => hostCall('bash.exec', { command, timeoutMs })
      },
      memory: {
        get: (key: string) => hostCall('memory.get', { key }),
        set: (key: string, value: unknown) => hostCall('memory.set', { key, value }),
        list: (prefix?: string) => hostCall('memory.list', { prefix })
      },
      mcp: {
        call: (server: string, method: string, params?: unknown) => hostCall('mcp.call', { server, method, params })
      }
    }
  }

  return Object.freeze(api)
}

function buildExecContext() {
  return {
    emit: (type: string, data?: Record<string, unknown>) => {
      post({ type: 'emit', payload: { type, data } })
    }
  }
}

function normalizeToolResult(result: any) {
  if (typeof result === 'string') {
    return { ok: true, content: result }
  }

  if (result && typeof result === 'object') {
    if (typeof result.ok === 'boolean' && typeof result.content === 'string') {
      return result
    }
  }

  return {
    ok: true,
    content: JSON.stringify(result ?? {})
  }
}

async function initialize(payload: InitPayload): Promise<any> {
  pluginId = payload.manifest.id

  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    module: { exports: {} },
    exports: {}
  }
  sandbox.exports = (sandbox.module as { exports: unknown }).exports
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox, {
    name: `plugin:${pluginId}`,
    codeGeneration: { strings: true, wasm: false }
  })

  const script = new vm.Script(payload.code, {
    filename: `${payload.pluginDir}/index.ts`
  })

  script.runInContext(context, { timeout: 5_000 })

  const exported = (sandbox.module as { exports: any }).exports
  const register = exported.register ?? exported.default?.register
  disposeHandler = exported.dispose ?? exported.default?.dispose

  if (typeof register !== 'function') {
    throw new Error('Plugin module must export register(api)')
  }

  const api = createApi()
  await register(api)

  for (const hookName of Object.keys(hooks) as HookName[]) {
    const fn = exported[hookName] ?? exported.default?.[hookName]
    if (typeof fn === 'function') {
      hooks[hookName].push(fn)
    }
  }

  initialized = true

  return {
    manifest: payload.manifest,
    prompts,
    tools: [...tools.values()].map(item => {
      const def = item.def ?? {}
      return {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        timeoutMs: def.timeoutMs,
        retries: def.retries
      }
    }),
    hasGuards: guards.length > 0,
    contexts: contexts.map(item => item.id),
    routes,
    ui: uiBindings
  }
}

async function runHook(name: HookName, payload: any): Promise<any> {
  const handlers = hooks[name]
  if (!handlers || handlers.length === 0) return undefined

  let merged: any = undefined
  for (const handler of handlers) {
    const out = await handler(payload, buildExecContext())
    if (out && typeof out === 'object') {
      merged = { ...(merged ?? {}), ...out }
    }
  }
  return merged
}

async function runTool(payload: { toolName: string; args: any; ctx: any }): Promise<any> {
  const entry = tools.get(payload.toolName)
  if (!entry) {
    throw new Error(`Tool not found in plugin ${pluginId}: ${payload.toolName}`)
  }

  const result = await entry.handler(payload.args, {
    ...(payload.ctx ?? {}),
    ...buildExecContext()
  })

  return normalizeToolResult(result)
}

async function runGuard(payload: { toolName: string; args: any; ctx: any }): Promise<any> {
  for (const guard of guards) {
    const out = await guard(payload)
    if (out && typeof out === 'object' && 'allow' in out) {
      return out
    }
  }
  return undefined
}

async function runContext(payload: { prompt: string; messages: any[] }): Promise<any[]> {
  const result: any[] = []
  for (const ctx of contexts) {
    const out = await ctx.handler(payload)
    if (out && typeof out === 'object' && typeof out.content === 'string') {
      result.push(out)
    }
  }
  return result
}

async function handleRequest(message: WorkerRequest): Promise<void> {
  if (message.type === 'host_op_result') {
    if (typeof message.reqId !== 'number') return
    const pending = hostPending.get(message.reqId)
    if (!pending) return
    hostPending.delete(message.reqId)
    if (message.payload?.ok) {
      pending.resolve(message.payload.value)
    } else {
      pending.reject(new Error(message.payload?.error ?? 'host op failed'))
    }
    return
  }

  const reqId = message.reqId

  try {
    if (message.type === 'init') {
      const descriptor = await initialize(message.payload as InitPayload)
      post({ type: 'ready', payload: descriptor })
      return
    }

    if (!initialized) {
      throw new Error('Plugin worker is not initialized')
    }

    switch (message.type) {
      case 'run_tool': {
        const value = await runTool(message.payload)
        post({ type: 'response', reqId, ok: true, value })
        break
      }
      case 'run_hook': {
        const value = await runHook(message.payload.name, message.payload.input)
        post({ type: 'response', reqId, ok: true, value })
        break
      }
      case 'run_guard': {
        const value = await runGuard(message.payload)
        post({ type: 'response', reqId, ok: true, value })
        break
      }
      case 'run_context': {
        const value = await runContext(message.payload)
        post({ type: 'response', reqId, ok: true, value })
        break
      }
      case 'dispose': {
        if (disposeHandler) {
          await disposeHandler()
        }
        post({ type: 'response', reqId, ok: true, value: true })
        break
      }
      case 'ping': {
        post({ type: 'response', reqId, ok: true, value: { ok: true } })
        break
      }
      default:
        throw new Error(`Unknown message type: ${message.type}`)
    }
  } catch (err) {
    post({
      type: 'response',
      reqId,
      ok: false,
      error: safeError(err)
    })
  }
}

port.on('message', (message: WorkerRequest) => {
  void handleRequest(message)
})
