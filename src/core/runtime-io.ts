/**
 * RuntimeIO - 受控 IO 层
 * 所有外部 IO 必须通过此层，确保 Policy 检查和 Trace 记录
 *
 * 安全特性：
 * - realpath 路径边界校验（防止符号链接逃逸）
 * - 统一资源预算（maxBytes/maxLines/maxResults/timeout）
 * - 原子写入（临时文件 + rename）
 * - 非 shell 执行 grep（防止命令注入）
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { glob as globFn } from 'glob'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

import type {
  RuntimeIO as IRuntimeIO,
  IOResult,
  ReadOptions,
  DirEntry,
  ReaddirOptions,
  ExecOptions,
  ExecOutput,
  GlobOptions,
  GrepOptions,
  GrepMatch,
  ResourceLimits
} from '../types/runtime.js'
import type { PolicyContext } from '../types/policy.js'
import type { PolicyEngine } from './policy-engine.js'
import type { TraceCollector } from './trace-collector.js'
import type { EventBus } from './event-bus.js'

/**
 * 默认资源限制
 */
const DEFAULT_LIMITS: Required<ResourceLimits> = {
  maxBytes: 10 * 1024 * 1024,      // 10MB
  maxLines: 10000,                  // 10000 行
  maxResults: 1000,                 // 1000 结果
  maxWriteBytes: 5 * 1024 * 1024,  // 5MB
  timeout: 60000                    // 60 秒
}

/**
 * 默认忽略模式
 */
const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**'
]

/**
 * RuntimeIO 配置
 */
export interface RuntimeIOConfig {
  projectPath: string
  policyEngine: PolicyEngine
  trace: TraceCollector
  eventBus: EventBus
  agentId: string
  sessionId: string
  getCurrentStep: () => number
  /** 资源限制（可覆盖默认值） */
  limits?: Partial<ResourceLimits>
}

/**
 * 生成 trace ID
 */
function generateTraceId(): string {
  return `io-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 生成临时文件名
 */
function generateTempFileName(originalPath: string): string {
  const dir = path.dirname(originalPath)
  const ext = path.extname(originalPath)
  const base = path.basename(originalPath, ext)
  const random = randomBytes(8).toString('hex')
  return path.join(dir, `.${base}.${random}.tmp${ext}`)
}

/**
 * RuntimeIO 实现
 */
export class RuntimeIO implements IRuntimeIO {
  private config: RuntimeIOConfig
  private limits: Required<ResourceLimits>
  private resolvedProjectPath: string | null = null

  constructor(config: RuntimeIOConfig) {
    this.config = config
    this.limits = { ...DEFAULT_LIMITS, ...config.limits }
  }

  /**
   * 获取解析后的项目根目录（realpath）
   */
  private async getProjectRoot(): Promise<string> {
    if (!this.resolvedProjectPath) {
      this.resolvedProjectPath = await fs.realpath(this.config.projectPath)
    }
    return this.resolvedProjectPath
  }

  /**
   * 构建策略上下文
   */
  private buildPolicyContext(
    operation: string,
    params: unknown,
    caller?: string
  ): PolicyContext {
    return {
      tool: 'runtime.io',
      operation,
      input: params,
      params,
      caller,
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      step: this.config.getCurrentStep()
    }
  }

  /**
   * 解析路径并验证边界（使用 realpath 防止符号链接逃逸）
   */
  private async resolvePath(filePath: string): Promise<string> {
    const projectRoot = await this.getProjectRoot()
    const resolved = path.resolve(projectRoot, filePath)

    // 首先检查逻辑路径是否在项目目录内
    if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
      throw new Error(`Path is outside project directory: ${filePath}`)
    }

    // 检查文件是否存在，如果存在则验证 realpath
    try {
      const realResolved = await fs.realpath(resolved)
      if (!realResolved.startsWith(projectRoot + path.sep) && realResolved !== projectRoot) {
        throw new Error(`Path resolves outside project directory (symlink escape): ${filePath}`)
      }
      return realResolved
    } catch (err) {
      // 文件不存在时，检查父目录
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 对于新文件，验证父目录
        const parentDir = path.dirname(resolved)
        try {
          const realParent = await fs.realpath(parentDir)
          if (!realParent.startsWith(projectRoot + path.sep) && realParent !== projectRoot) {
            throw new Error(`Parent directory resolves outside project (symlink escape): ${filePath}`)
          }
        } catch {
          // 父目录也不存在，使用逻辑路径检查
        }
        return resolved
      }
      throw err
    }
  }

  /**
   * Resolve a cwd option to a valid directory path.
   * If the provided path is a file (not a directory), fall back to the project root.
   */
  private async resolveCwd(cwd: string | undefined): Promise<string> {
    const projectRoot = await this.getProjectRoot()
    if (!cwd) return projectRoot

    const resolved = path.resolve(projectRoot, cwd)
    try {
      const stat = await fs.stat(resolved)
      if (!stat.isDirectory()) {
        return projectRoot
      }
    } catch {
      // Path doesn't exist — fall back to project root
      return projectRoot
    }
    return resolved
  }

  /**
   * 获取资源限制
   */
  getLimits(): Required<ResourceLimits> {
    return { ...this.limits }
  }

  /**
   * 读取文件（流式处理大文件）
   */
  async readFile(filePath: string, options?: ReadOptions): Promise<IOResult<string>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    const ctx = this.buildPolicyContext('readFile', { path: filePath, options })
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    try {
      const resolvedPath = await this.resolvePath(filePath)

      // 检查文件大小
      const stat = await fs.stat(resolvedPath)
      if (stat.size > this.limits.maxBytes) {
        // 使用流式读取大文件
        return this.readFileStream(resolvedPath, options, traceId, startTime)
      }

      // 小文件直接读取
      let content = await fs.readFile(resolvedPath, {
        encoding: options?.encoding ?? 'utf-8'
      })

      let truncated = false

      // 处理 offset 和 limit
      const lines = content.split('\n')
      const offset = options?.offset ?? 0
      const limit = Math.min(options?.limit ?? this.limits.maxLines, this.limits.maxLines)

      if (offset > 0 || limit < lines.length) {
        const sliced = lines.slice(offset, offset + limit)
        content = sliced.join('\n')
        truncated = offset + limit < lines.length
      }

      // 字节限制
      if (content.length > this.limits.maxBytes) {
        content = content.slice(0, this.limits.maxBytes)
        truncated = true
      }

      this.config.trace.record({
        type: 'io.readFile',
        data: { path: filePath, size: content.length, truncated, traceId }
      })

      this.config.eventBus.emit('file:read', { path: filePath })

      return {
        success: true,
        data: content,
        traceId,
        durationMs: Date.now() - startTime,
        meta: { truncated, lines: lines.length, bytes: stat.size }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * 流式读取大文件
   */
  private async readFileStream(
    resolvedPath: string,
    options: ReadOptions | undefined,
    traceId: string,
    startTime: number
  ): Promise<IOResult<string>> {
    return new Promise((resolve) => {
      const lines: string[] = []
      const offset = options?.offset ?? 0
      const limit = Math.min(options?.limit ?? this.limits.maxLines, this.limits.maxLines)
      let lineCount = 0
      let bytesRead = 0
      let truncated = false

      const stream = createReadStream(resolvedPath, { encoding: options?.encoding ?? 'utf-8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })

      rl.on('line', (line) => {
        lineCount++

        if (lineCount > offset && lines.length < limit) {
          const newBytes = bytesRead + line.length + 1
          if (newBytes <= this.limits.maxBytes) {
            lines.push(line)
            bytesRead = newBytes
          } else {
            truncated = true
            rl.close()
          }
        }

        if (lines.length >= limit) {
          truncated = true
          rl.close()
        }
      })

      rl.on('close', () => {
        const content = lines.join('\n')

        this.config.trace.record({
          type: 'io.readFile',
          data: { path: resolvedPath, size: content.length, truncated, traceId }
        })

        resolve({
          success: true,
          data: content,
          traceId,
          durationMs: Date.now() - startTime,
          meta: { truncated, lines: lineCount }
        })
      })

      rl.on('error', (error) => {
        resolve({ success: false, error: error.message, traceId })
      })
    })
  }

  /**
   * 写入文件（原子写入 + 权限保留）
   */
  async writeFile(filePath: string, content: string): Promise<IOResult<void>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    // 大小限制检查
    if (content.length > this.limits.maxWriteBytes) {
      return {
        success: false,
        error: `Content size ${content.length} exceeds limit ${this.limits.maxWriteBytes}`,
        traceId
      }
    }

    const ctx = this.buildPolicyContext('writeFile', { path: filePath, content })
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    try {
      const resolvedPath = await this.resolvePath(filePath)

      // 检查文件是否存在，获取原权限
      let existingMode: number | undefined
      let exists = false
      try {
        const stat = await fs.stat(resolvedPath)
        existingMode = stat.mode
        exists = true
      } catch {
        // 文件不存在
      }

      // 确保目录存在
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })

      // 原子写入：先写临时文件再 rename
      const tempPath = generateTempFileName(resolvedPath)

      try {
        await fs.writeFile(tempPath, content, 'utf-8')

        // 如果原文件存在，保留权限
        if (existingMode !== undefined) {
          await fs.chmod(tempPath, existingMode)
        }

        // 原子 rename
        await fs.rename(tempPath, resolvedPath)
      } catch (error) {
        // 清理临时文件
        try {
          await fs.unlink(tempPath)
        } catch {
          // 忽略清理错误
        }
        throw error
      }

      this.config.trace.record({
        type: 'io.writeFile',
        data: { path: filePath, size: content.length, traceId }
      })

      this.config.eventBus.emit(exists ? 'file:write' : 'file:create', { path: filePath })

      return {
        success: true,
        traceId,
        durationMs: Date.now() - startTime
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * 读取目录
   */
  async readdir(dirPath: string, options?: ReaddirOptions): Promise<IOResult<DirEntry[]>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    const ctx = this.buildPolicyContext('readdir', { path: dirPath, options })
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    try {
      const resolvedPath = await this.resolvePath(dirPath)

      const readDirRecursive = async (
        dir: string,
        currentDepth: number,
        maxDepth: number
      ): Promise<DirEntry[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const results: DirEntry[] = []

        for (const entry of entries) {
          // 跳过隐藏的系统目录
          if (entry.name.startsWith('.') && entry.isDirectory()) {
            continue
          }

          const entryPath = path.join(dir, entry.name)
          const stat = await fs.stat(entryPath).catch(() => null)

          results.push({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            size: stat?.size,
            modifiedAt: stat?.mtime
          })

          // 限制结果数量
          if (results.length >= this.limits.maxResults) {
            break
          }

          if (options?.recursive && entry.isDirectory() && currentDepth < maxDepth) {
            const subEntries = await readDirRecursive(entryPath, currentDepth + 1, maxDepth)
            for (const subEntry of subEntries) {
              subEntry.name = path.join(entry.name, subEntry.name)
              results.push(subEntry)
              if (results.length >= this.limits.maxResults) {
                break
              }
            }
          }
        }

        return results
      }

      const maxDepth = options?.depth ?? 10
      const entries = await readDirRecursive(resolvedPath, 0, maxDepth)
      const truncated = entries.length >= this.limits.maxResults

      this.config.trace.record({
        type: 'io.readdir',
        data: { path: dirPath, entries: entries.length, truncated, traceId }
      })

      return {
        success: true,
        data: entries,
        traceId,
        durationMs: Date.now() - startTime,
        meta: { truncated, count: entries.length }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * 检查文件是否存在
   */
  async exists(filePath: string): Promise<IOResult<boolean>> {
    const traceId = generateTraceId()

    try {
      const resolvedPath = await this.resolvePath(filePath)
      await fs.access(resolvedPath)
      return { success: true, data: true, traceId }
    } catch {
      return { success: true, data: false, traceId }
    }
  }

  /**
   * 执行命令
   */
  async exec(command: string, options?: ExecOptions): Promise<IOResult<ExecOutput>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    const ctx = this.buildPolicyContext('exec', { command, options }, options?.caller)
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    // 使用可能被 mutate 的输入
    const mutatedCommand = (result.input as { command: string })?.command ?? command

    const execCwd = await this.resolveCwd(options?.cwd)

    return new Promise((resolve) => {
      const timeout = Math.min(options?.timeout ?? this.limits.timeout, this.limits.timeout)

      // 使用 spawn 而不是 exec，通过 shell
      const child = spawn('sh', ['-c', mutatedCommand], {
        cwd: execCwd,
        env: { ...process.env, ...options?.env },
        timeout
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += data.toString()
        // 限制输出大小
        if (stdout.length > this.limits.maxBytes) {
          stdout = stdout.slice(0, this.limits.maxBytes)
          child.kill()
        }
      })

      child.stderr?.on('data', (data) => {
        stderr += data.toString()
        if (stderr.length > this.limits.maxBytes) {
          stderr = stderr.slice(0, this.limits.maxBytes)
        }
      })

      child.on('close', (code, signal) => {
        // If process was killed by signal (e.g., timeout), use exit code 137 (128 + 9 for SIGKILL)
        // or 143 (128 + 15 for SIGTERM)
        const exitCode = code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 0)
        const success = code === 0 && !signal

        this.config.trace.record({
          type: 'io.exec',
          data: { command: mutatedCommand, exitCode, signal, traceId }
        })

        resolve({
          success,
          data: { stdout, stderr, exitCode },
          traceId,
          durationMs: Date.now() - startTime
        })
      })

      child.on('error', (error) => {
        resolve({
          success: false,
          error: error.message,
          data: { stdout, stderr, exitCode: 1 },
          traceId,
          durationMs: Date.now() - startTime
        })
      })
    })
  }

  /**
   * Glob 文件匹配
   */
  async glob(pattern: string, options?: GlobOptions): Promise<IOResult<string[]>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    const ctx = this.buildPolicyContext('glob', { pattern, options }, options?.caller)
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    try {
      const cwd = await this.resolveCwd(options?.cwd)

      // 合并用户 ignore 和默认 ignore
      const userIgnore = options?.ignore ?? []
      const mergedIgnore = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...userIgnore])]

      const files = await globFn(pattern, {
        cwd,
        ignore: mergedIgnore,
        dot: options?.dot ?? false,
        nodir: true
      })

      // 应用硬限制
      const truncated = files.length > this.limits.maxResults
      const limitedFiles = files.slice(0, this.limits.maxResults)

      this.config.trace.record({
        type: 'io.glob',
        data: { pattern, matches: limitedFiles.length, truncated, traceId }
      })

      return {
        success: true,
        data: limitedFiles,
        traceId,
        durationMs: Date.now() - startTime,
        meta: { truncated, total: files.length, count: limitedFiles.length }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * Grep 内容搜索（非 shell 执行，使用 spawn + 参数数组）
   */
  async grep(pattern: string, options?: GrepOptions): Promise<IOResult<GrepMatch[]>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    const ctx = this.buildPolicyContext('grep', { pattern, options }, options?.caller)
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    try {
      const cwd = await this.resolveCwd(options?.cwd)

      const limit = Math.min(options?.limit ?? 100, this.limits.maxResults)
      const ignoreCase = options?.ignoreCase ?? false

      // Convert Perl regex shortcuts to POSIX equivalents
      // BSD grep (macOS) does not support \s, \d, \w etc.
      const perlToPosixRegex = (p: string): string =>
        p
          .replace(/\\s/g, '[[:space:]]')
          .replace(/\\S/g, '[^[:space:]]')
          .replace(/\\d/g, '[[:digit:]]')
          .replace(/\\D/g, '[^[:digit:]]')
          .replace(/\\w/g, '[[:alnum:]_]')
          .replace(/\\W/g, '[^[:alnum:]_]')

      // Build grep args array (prevents command injection)
      const args: string[] = [
        '-rnE',                             // recursive + line numbers + extended regex
        '--color=never',                    // disable color
        `-m`, String(limit),                // limit matches per file
        ...DEFAULT_IGNORE_PATTERNS.flatMap(p => ['--exclude-dir', p.replace('**/', '').replace('/**', '')])
      ]

      if (ignoreCase) {
        args.push('-i')
      }

      if (options?.type) {
        args.push(`--include=*.${options.type}`)
      }

      // Add pattern and search path
      args.push('-e', perlToPosixRegex(pattern), '.')

      return new Promise((resolve) => {
        const child = spawn('grep', args, {
          cwd,
          timeout: this.limits.timeout
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data) => {
          stdout += data.toString()
          // 限制输出大小
          if (stdout.length > this.limits.maxBytes) {
            stdout = stdout.slice(0, this.limits.maxBytes)
            child.kill()
          }
        })

        child.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('close', (code) => {
          // grep 返回 1 表示没有匹配，不是错误
          if (code !== 0 && code !== 1) {
            resolve({
              success: false,
              error: stderr || `grep exited with code ${code}`,
              traceId,
              durationMs: Date.now() - startTime
            })
            return
          }

          const matches: GrepMatch[] = []
          const lines = stdout.split('\n').filter(Boolean)

          for (const line of lines) {
            if (matches.length >= limit) break

            const match = line.match(/^(.+?):(\d+):(.*)$/)
            if (match) {
              matches.push({
                file: match[1]!.replace(/^\.\//, ''),
                line: parseInt(match[2]!, 10),
                text: match[3]!.trim()
              })
            }
          }

          const truncated = lines.length > limit

          this.config.trace.record({
            type: 'io.grep',
            data: { pattern, matches: matches.length, truncated, traceId }
          })

          resolve({
            success: true,
            data: matches,
            traceId,
            durationMs: Date.now() - startTime,
            meta: { truncated, count: matches.length }
          })
        })

        child.on('error', (error) => {
          // 如果 grep 不可用，降级到内置搜索
          if (error.message.includes('ENOENT')) {
            this.grepFallback(pattern, cwd, options, limit, traceId, startTime)
              .then(resolve)
          } else {
            resolve({
              success: false,
              error: error.message,
              traceId,
              durationMs: Date.now() - startTime
            })
          }
        })
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * Grep 降级实现（纯 JS，用于 grep 不可用时）
   */
  private async grepFallback(
    pattern: string,
    cwd: string,
    options: GrepOptions | undefined,
    limit: number,
    traceId: string,
    startTime: number
  ): Promise<IOResult<GrepMatch[]>> {
    const matches: GrepMatch[] = []
    const regex = new RegExp(pattern, options?.ignoreCase ? 'i' : '')

    // 获取文件列表
    const files = await globFn(options?.type ? `**/*.${options.type}` : '**/*', {
      cwd,
      ignore: DEFAULT_IGNORE_PATTERNS,
      nodir: true
    })

    for (const file of files) {
      if (matches.length >= limit) break

      try {
        const filePath = path.join(cwd, file)
        const content = await fs.readFile(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({
              file,
              line: i + 1,
              text: lines[i]!.trim()
            })
          }
        }
      } catch {
        // 忽略无法读取的文件
      }
    }

    const truncated = matches.length >= limit

    this.config.trace.record({
      type: 'io.grep',
      data: { pattern, matches: matches.length, truncated, fallback: true, traceId }
    })

    return {
      success: true,
      data: matches,
      traceId,
      durationMs: Date.now() - startTime,
      meta: { truncated, count: matches.length, fallback: true }
    }
  }

  /**
   * 获取文件统计信息（用于 edit 判断是否需要完整读取）
   */
  async stat(filePath: string): Promise<IOResult<{ size: number; lines?: number }>> {
    const traceId = generateTraceId()

    try {
      const resolvedPath = await this.resolvePath(filePath)
      const stat = await fs.stat(resolvedPath)

      return {
        success: true,
        data: { size: stat.size },
        traceId
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * 无限制读取文件（仅供 edit 内部使用，绕过 autoLimitRead）
   * 注意：仍然有硬限制保护
   */
  async readFileForEdit(filePath: string): Promise<IOResult<string>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    // 不经过 policy，但仍验证路径
    try {
      const resolvedPath = await this.resolvePath(filePath)
      const stat = await fs.stat(resolvedPath)

      // edit 专用的更大限制
      const editMaxBytes = this.limits.maxBytes * 2 // 20MB for edit

      if (stat.size > editMaxBytes) {
        return {
          success: false,
          error: `File too large for edit: ${stat.size} bytes (max: ${editMaxBytes})`,
          traceId
        }
      }

      const content = await fs.readFile(resolvedPath, 'utf-8')

      return {
        success: true,
        data: content,
        traceId,
        durationMs: Date.now() - startTime,
        meta: { bytes: stat.size, forEdit: true }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }
}
