import { createHash } from 'node:crypto'
import { exec as execCb } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { URL, fileURLToPath } from 'node:url'
import type {
  DynamicPluginHandle,
  PluginDescriptor,
  PluginManifest,
  PluginPermissions,
  SessionEvent,
  StateStore,
  ToolRunContext,
  GuardDecision,
  ContextFragment,
  PluginToolResult,
  PluginLifecycleHooks
} from './types.js'
import { createEvent } from './state-store.js'

const exec = promisify(execCb)

type WorkerMessage = {
  type: 'ready' | 'response' | 'host_op' | 'emit'
  reqId?: number
  ok?: boolean
  value?: any
  error?: string
  payload?: any
  op?: string
}

interface LoaderConfig {
  projectPath: string
  store: StateStore
}

interface CompiledPlugin {
  manifest: PluginManifest
  pluginDir: string
  entryPath: string
  sourcePath: string
  code: string
  hash: string
}

export interface LoadedDynamicPlugin {
  id: string
  version: string
  sourcePath: string
  descriptor: PluginDescriptor
  handle: DynamicPluginHandle
  hash: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function isAllowedPath(targetPath: string, allowed: string[] | undefined, projectPath: string): boolean {
  if (!allowed || allowed.length === 0) return false
  const absTarget = resolve(projectPath, targetPath)
  return allowed.some(pattern => {
    const absAllowed = resolve(projectPath, pattern)
    return absTarget === absAllowed || absTarget.startsWith(`${absAllowed}/`)
  })
}

function assertFsPermission(manifest: PluginManifest, mode: 'read' | 'write', path: string, projectPath: string): void {
  const fsPermissions = manifest.permissions?.fs
  const list = mode === 'read' ? fsPermissions?.read : fsPermissions?.write
  if (!isAllowedPath(path, list, projectPath)) {
    throw new Error(`Plugin ${manifest.id} denied ${mode} access to path: ${path}`)
  }
}

function assertNetworkPermission(manifest: PluginManifest, url: string): void {
  const domains = manifest.permissions?.network?.domains
  if (!domains || domains.length === 0) {
    throw new Error(`Plugin ${manifest.id} network access denied: no domains whitelisted`)
  }

  const host = new URL(url).hostname
  if (!domains.includes('*') && !domains.includes(host)) {
    throw new Error(`Plugin ${manifest.id} network access denied to domain: ${host}`)
  }
}

function assertBashPermission(manifest: PluginManifest, command: string): void {
  const commands = manifest.permissions?.bash?.commands
  if (!commands || commands.length === 0) {
    throw new Error(`Plugin ${manifest.id} bash access denied: no commands whitelisted`)
  }

  const first = command.trim().split(/\s+/)[0] ?? ''
  if (!commands.includes('*') && !commands.includes(first)) {
    throw new Error(`Plugin ${manifest.id} bash command denied: ${first}`)
  }
}

async function resolveEntry(pluginDir: string, manifest: PluginManifest): Promise<string> {
  const candidates = [
    manifest.entry,
    'index.ts',
    'index.js',
    'src/index.ts',
    'src/index.js'
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)

  for (const candidate of candidates) {
    const full = resolve(pluginDir, candidate)
    try {
      await readFile(full, 'utf8')
      return full
    } catch {
      // try next candidate
    }
  }

  throw new Error(`No plugin entry file found in ${pluginDir}`)
}

async function transpileSource(source: string, fileName: string): Promise<string> {
  const ts = await import('typescript')
  const out = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: false,
      sourceMap: false,
      declaration: false
    },
    fileName
  })

  return out.outputText
}

class WorkerPluginHandle implements DynamicPluginHandle {
  readonly descriptor: PluginDescriptor
  readonly manifest: PluginManifest
  readonly sourcePath: string

  private readonly worker: Worker
  private readonly projectPath: string
  private readonly store: StateStore
  private reqSeq = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>()
  private inFlightOps = 0

  constructor(params: {
    descriptor: PluginDescriptor
    manifest: PluginManifest
    sourcePath: string
    worker: Worker
    projectPath: string
    store: StateStore
  }) {
    this.descriptor = params.descriptor
    this.manifest = params.manifest
    this.sourcePath = params.sourcePath
    this.worker = params.worker
    this.projectPath = params.projectPath
    this.store = params.store

    this.worker.on('message', (msg: WorkerMessage) => {
      void this.onWorkerMessage(msg)
    })

    this.worker.on('error', (err) => {
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(err)
        this.pending.delete(id)
      }
    })

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`Plugin worker exited with code ${code}`)
        for (const [id, pending] of this.pending.entries()) {
          pending.reject(error)
          this.pending.delete(id)
        }
      }
    })
  }

  private get permissions(): PluginPermissions {
    return this.manifest.permissions ?? {}
  }

  private async audit(action: string, data?: Record<string, unknown>): Promise<void> {
    const event: SessionEvent = createEvent('plugin.audit', this.manifest.id, {
      action,
      pluginId: this.manifest.id,
      ...data
    })
    await this.store.append(event)
  }

  private get timeoutMs(): number {
    return Math.max(100, this.permissions.limits?.timeoutMs ?? 20_000)
  }

  private get maxConcurrentOps(): number {
    return Math.max(1, this.permissions.limits?.maxConcurrentOps ?? 4)
  }

  private async withOpSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlightOps >= this.maxConcurrentOps) {
      throw new Error(`Plugin ${this.manifest.id} exceeded maxConcurrentOps=${this.maxConcurrentOps}`)
    }

    this.inFlightOps += 1
    try {
      return await fn()
    } finally {
      this.inFlightOps -= 1
    }
  }

  private async onWorkerMessage(message: WorkerMessage): Promise<void> {
    if (message.type === 'response') {
      const reqId = message.reqId
      if (typeof reqId !== 'number') return
      const pending = this.pending.get(reqId)
      if (!pending) return
      this.pending.delete(reqId)
      if (message.ok) {
        pending.resolve(message.value)
      } else {
        pending.reject(new Error(message.error ?? 'Unknown worker error'))
      }
      return
    }

    if (message.type === 'emit') {
      const payload = isObject(message.payload) ? message.payload : {}
      const type = typeof payload.type === 'string' ? payload.type : 'plugin.event'
      const data = isObject(payload.data) ? payload.data : undefined
      await this.store.append(createEvent(type, this.manifest.id, data))
      return
    }

    if (message.type === 'host_op') {
      const reqId = message.reqId
      if (typeof reqId !== 'number') return

      try {
        const value = await this.withOpSlot(async () => this.handleHostOp(message.op ?? '', message.payload ?? {}))
        this.worker.postMessage({
          type: 'host_op_result',
          reqId,
          payload: {
            ok: true,
            value
          }
        })
      } catch (err) {
        this.worker.postMessage({
          type: 'host_op_result',
          reqId,
          payload: {
            ok: false,
            error: toError(err).message
          }
        })
      }
    }
  }

  private async handleHostOp(op: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.audit('host_op', { op })

    switch (op) {
      case 'fs.read': {
        const path = String(payload.path ?? '')
        assertFsPermission(this.manifest, 'read', path, this.projectPath)
        const full = resolve(this.projectPath, path)
        const content = await readFile(full, 'utf8')
        return { path, content }
      }

      case 'fs.write': {
        const path = String(payload.path ?? '')
        const content = String(payload.content ?? '')
        assertFsPermission(this.manifest, 'write', path, this.projectPath)
        const full = resolve(this.projectPath, path)
        await mkdir(resolve(full, '..'), { recursive: true })
        await writeFile(full, content, 'utf8')
        return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') }
      }

      case 'fs.list': {
        const path = String(payload.path ?? '.')
        assertFsPermission(this.manifest, 'read', path, this.projectPath)
        const full = resolve(this.projectPath, path)
        const entries = await readdir(full, { withFileTypes: true })
        return entries.map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file'
        }))
      }

      case 'network.fetch': {
        const url = String(payload.url ?? '')
        assertNetworkPermission(this.manifest, url)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
          const response = await fetch(url, {
            method: typeof payload.init === 'object' && payload.init && typeof (payload.init as any).method === 'string'
              ? (payload.init as any).method
              : 'GET',
            signal: controller.signal
          })
          const text = await response.text()
          return {
            status: response.status,
            statusText: response.statusText,
            body: text.slice(0, 64_000)
          }
        } finally {
          clearTimeout(timer)
        }
      }

      case 'bash.exec': {
        const command = String(payload.command ?? '')
        const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : this.timeoutMs
        assertBashPermission(this.manifest, command)
        const result = await exec(command, {
          cwd: this.projectPath,
          timeout: timeoutMs,
          maxBuffer: 512 * 1024
        })
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: 0
        }
      }

      case 'memory.get': {
        const key = String(payload.key ?? '')
        return this.store.getMemory(key)
      }

      case 'memory.set': {
        const key = String(payload.key ?? '')
        await this.store.setMemory(key, payload.value)
        return { ok: true }
      }

      case 'memory.list': {
        const prefix = typeof payload.prefix === 'string' ? payload.prefix : undefined
        return this.store.listMemory(prefix)
      }

      case 'mcp.call': {
        throw new Error('mcp.call is not enabled in thin-core MVP; use mcp plugin package')
      }

      default:
        throw new Error(`Unsupported host operation: ${op}`)
    }
  }

  private callWorker(type: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolvePromise, rejectPromise) => {
      const reqId = this.reqSeq
      this.reqSeq += 1
      this.pending.set(reqId, { resolve: resolvePromise, reject: rejectPromise })

      const timer = setTimeout(() => {
        const pending = this.pending.get(reqId)
        if (pending) {
          this.pending.delete(reqId)
          pending.reject(new Error(`Plugin ${this.manifest.id} request timed out`))
        }
      }, this.timeoutMs)

      const resolve = (value: any) => {
        clearTimeout(timer)
        resolvePromise(value)
      }
      const reject = (reason: Error) => {
        clearTimeout(timer)
        rejectPromise(reason)
      }

      this.pending.set(reqId, { resolve, reject })
      this.worker.postMessage({ type, reqId, payload })
    })
  }

  async runHook<TInput, TOutput>(name: keyof PluginLifecycleHooks, input: TInput): Promise<TOutput | void> {
    return this.callWorker('run_hook', { name, input })
  }

  async runGuard(toolName: string, args: unknown, ctx: ToolRunContext): Promise<GuardDecision | void> {
    return this.callWorker('run_guard', {
      toolName,
      args,
      ctx: {
        runId: ctx.runId,
        step: ctx.step,
        projectPath: ctx.projectPath
      }
    })
  }

  async runContext(prompt: string, messages: any[]): Promise<ContextFragment[]> {
    const out = await this.callWorker('run_context', { prompt, messages })
    return Array.isArray(out) ? out as ContextFragment[] : []
  }

  async runTool(toolName: string, args: unknown, ctx: ToolRunContext): Promise<PluginToolResult> {
    const out = await this.callWorker('run_tool', {
      toolName,
      args,
      ctx: {
        runId: ctx.runId,
        step: ctx.step,
        projectPath: ctx.projectPath
      }
    })
    return out as PluginToolResult
  }

  async dispose(): Promise<void> {
    try {
      await this.callWorker('dispose', {})
    } finally {
      await this.audit('worker_dispose')
      await this.worker.terminate()
    }
  }

  async ping(): Promise<void> {
    await this.callWorker('ping', {})
  }
}

export class PluginLoader {
  private readonly projectPath: string
  private readonly store: StateStore

  constructor(config: LoaderConfig) {
    this.projectPath = config.projectPath
    this.store = config.store
  }

  private async compileFromPath(path: string): Promise<CompiledPlugin> {
    const pluginDir = resolve(this.projectPath, path)
    const manifestPath = join(pluginDir, 'plugin.json')
    const rawManifest = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(rawManifest) as PluginManifest

    if (!manifest.id || !manifest.version) {
      throw new Error(`Invalid plugin manifest at ${manifestPath}: id/version are required`)
    }

    const entryPath = await resolveEntry(pluginDir, manifest)
    const source = await readFile(entryPath, 'utf8')
    const code = await transpileSource(source, entryPath)
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 12)

    const cacheDir = resolve(this.projectPath, '.agentfoundry', 'plugin-cache', manifest.id)
    await mkdir(cacheDir, { recursive: true })
    const sourcePath = join(cacheDir, `plugin-${hash}.cjs`)
    await writeFile(sourcePath, code, 'utf8')

    return {
      manifest,
      pluginDir,
      entryPath,
      sourcePath,
      code,
      hash
    }
  }

  private async createWorkerHandle(compiled: CompiledPlugin): Promise<WorkerPluginHandle> {
    const jsWorkerUrl = new URL('./plugin-worker.js', import.meta.url)
    const tsWorkerUrl = new URL('./plugin-worker.ts', import.meta.url)
    const useTsWorker = !existsSync(fileURLToPath(jsWorkerUrl))

    const worker = new Worker(useTsWorker ? tsWorkerUrl : jsWorkerUrl, {
      execArgv: useTsWorker ? ['--import=tsx'] : undefined,
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(16, compiled.manifest.permissions?.limits?.maxMemoryMb ?? 128)
      }
    })

    const descriptor = await new Promise<PluginDescriptor>((resolveDescriptor, rejectDescriptor) => {
      const onMessage = (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          worker.off('message', onMessage)
          resolveDescriptor(msg.payload as PluginDescriptor)
        }
      }

      const onError = (err: Error) => {
        worker.off('message', onMessage)
        rejectDescriptor(err)
      }

      worker.on('message', onMessage)
      worker.once('error', onError)

      worker.postMessage({
        type: 'init',
        payload: {
          manifest: compiled.manifest,
          code: compiled.code,
          pluginDir: compiled.pluginDir
        }
      })
    })

    await this.store.append(createEvent('plugin.audit', compiled.manifest.id, {
      action: 'worker_initialized',
      hash: compiled.hash,
      entry: compiled.entryPath
    }))

    return new WorkerPluginHandle({
      descriptor,
      manifest: compiled.manifest,
      sourcePath: compiled.sourcePath,
      worker,
      projectPath: this.projectPath,
      store: this.store
    })
  }

  async testPath(path: string): Promise<Record<string, unknown>> {
    const compiled = await this.compileFromPath(path)
    const handle = await this.createWorkerHandle(compiled)
    try {
      await handle.ping()
      return {
        ok: true,
        id: compiled.manifest.id,
        version: compiled.manifest.version,
        hash: compiled.hash,
        tools: handle.descriptor.tools.map(t => t.name)
      }
    } finally {
      await handle.dispose()
    }
  }

  async loadPath(path: string): Promise<LoadedDynamicPlugin> {
    const compiled = await this.compileFromPath(path)
    const handle = await this.createWorkerHandle(compiled)

    return {
      id: compiled.manifest.id,
      version: compiled.manifest.version,
      sourcePath: resolve(this.projectPath, path),
      descriptor: handle.descriptor,
      handle,
      hash: compiled.hash
    }
  }

  async runPreflight(path: string): Promise<Record<string, unknown>> {
    const base = resolve(this.projectPath, path)
    const manifestPath = join(base, 'plugin.json')
    const testResult = await this.testPath(path)

    return {
      ok: true,
      manifestPath,
      test: testResult
    }
  }
}

export function createPluginScaffold(id: string): { manifest: string; index: string } {
  const manifest = {
    id,
    version: '0.1.0',
    capabilities: ['memory'],
    permissions: {
      memory: {},
      limits: {
        timeoutMs: 10_000,
        maxConcurrentOps: 2,
        maxMemoryMb: 64
      }
    }
  }

  const index = `export async function register(api) {
  api.prompt('This plugin is loaded and ready.');

  api.tool({
    name: '${id}.ping',
    description: 'Return plugin runtime status',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }, async () => ({ ok: true, content: 'pong from ${id}' }));
}

export async function dispose() {
  // optional cleanup
}
`

  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    index
  }
}
