/**
 * RuntimeIO - Controlled IO Layer
 * All external IO must go through this layer to ensure Policy checks and Trace recording
 *
 * Security features:
 * - realpath boundary validation (prevents symlink escape)
 * - Unified resource budgets (maxBytes/maxLines/maxResults/timeout)
 * - Atomic writes (temp file + rename)
 * - Non-shell grep execution (prevents command injection)
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
 * Default resource limits
 */
const DEFAULT_LIMITS: Required<ResourceLimits> = {
  maxBytes: 10 * 1024 * 1024,      // 10MB
  maxLines: 10000,                  // 10000 lines
  maxResults: 1000,                 // 1000 results
  maxWriteBytes: 5 * 1024 * 1024,  // 5MB
  timeout: 60000                    // 60 seconds
}

/**
 * Default ignore patterns
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

const MAX_EXEC_EVENT_CHUNK_CHARS = 4000

function clipExecChunk(chunk: string): { value: string; truncated: boolean } {
  if (chunk.length <= MAX_EXEC_EVENT_CHUNK_CHARS) {
    return { value: chunk, truncated: false }
  }
  return {
    value: `${chunk.slice(0, MAX_EXEC_EVENT_CHUNK_CHARS)}\n...[chunk truncated]`,
    truncated: true
  }
}

/**
 * RuntimeIO configuration
 */
export interface RuntimeIOConfig {
  projectPath: string
  policyEngine: PolicyEngine
  trace: TraceCollector
  eventBus: EventBus
  agentId: string
  sessionId: string
  getCurrentStep: () => number
  /** Resource limits (can override defaults) */
  limits?: Partial<ResourceLimits>
}

/**
 * Generate a trace ID
 */
function generateTraceId(): string {
  return `io-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Generate a temporary file name
 */
function generateTempFileName(originalPath: string): string {
  const dir = path.dirname(originalPath)
  const ext = path.extname(originalPath)
  const base = path.basename(originalPath, ext)
  const random = randomBytes(8).toString('hex')
  return path.join(dir, `.${base}.${random}.tmp${ext}`)
}

/**
 * RuntimeIO implementation
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
   * Get the resolved project root directory (realpath)
   */
  private async getProjectRoot(): Promise<string> {
    if (!this.resolvedProjectPath) {
      this.resolvedProjectPath = await fs.realpath(this.config.projectPath)
    }
    return this.resolvedProjectPath
  }

  /**
   * Build policy context
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
   * Resolve path and validate boundary (uses realpath to prevent symlink escape)
   */
  private async resolvePath(filePath: string): Promise<string> {
    const projectRoot = await this.getProjectRoot()
    const resolved = path.resolve(projectRoot, filePath)

    // First check if the logical path is within the project directory
    if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
      throw new Error(`Path is outside project directory: ${filePath}`)
    }

    // Check if the file exists; if so, validate via realpath
    try {
      const realResolved = await fs.realpath(resolved)
      if (!realResolved.startsWith(projectRoot + path.sep) && realResolved !== projectRoot) {
        throw new Error(`Path resolves outside project directory (symlink escape): ${filePath}`)
      }
      return realResolved
    } catch (err) {
      // File does not exist; check the parent directory
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // For new files, validate the parent directory
        const parentDir = path.dirname(resolved)
        try {
          const realParent = await fs.realpath(parentDir)
          if (!realParent.startsWith(projectRoot + path.sep) && realParent !== projectRoot) {
            throw new Error(`Parent directory resolves outside project (symlink escape): ${filePath}`)
          }
        } catch {
          // Parent directory also does not exist; use logical path check
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
   * Get resource limits
   */
  getLimits(): Required<ResourceLimits> {
    return { ...this.limits }
  }

  /**
   * Read a file (streams large files)
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

      // Check file size
      const stat = await fs.stat(resolvedPath)
      if (stat.size > this.limits.maxBytes) {
        // Use streaming for large files
        return this.readFileStream(resolvedPath, options, traceId, startTime)
      }

      // Read small files directly
      let content = await fs.readFile(resolvedPath, {
        encoding: options?.encoding ?? 'utf-8'
      })

      let truncated = false

      // Handle offset and limit
      const lines = content.split('\n')
      const offset = options?.offset ?? 0
      const limit = Math.min(options?.limit ?? this.limits.maxLines, this.limits.maxLines)

      if (offset > 0 || limit < lines.length) {
        const sliced = lines.slice(offset, offset + limit)
        content = sliced.join('\n')
        truncated = offset + limit < lines.length
      }

      // Byte limit
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
   * Stream-read large files
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
   * Write a file (atomic write + permission preservation)
   */
  async writeFile(filePath: string, content: string): Promise<IOResult<void>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    // Size limit check
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

      // Check if the file exists and get original permissions
      let existingMode: number | undefined
      let exists = false
      try {
        const stat = await fs.stat(resolvedPath)
        existingMode = stat.mode
        exists = true
      } catch {
        // File does not exist
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })

      // Atomic write: write to temp file first, then rename
      const tempPath = generateTempFileName(resolvedPath)

      try {
        await fs.writeFile(tempPath, content, 'utf-8')

        // If the original file exists, preserve its permissions
        if (existingMode !== undefined) {
          await fs.chmod(tempPath, existingMode)
        }

        // Atomic rename
        await fs.rename(tempPath, resolvedPath)
      } catch (error) {
        // Clean up temp file
        try {
          await fs.unlink(tempPath)
        } catch {
          // Ignore cleanup errors
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
   * Read a directory
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
          // Skip hidden system directories
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

          // Limit the number of results
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
   * Check if a file exists
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
   * Execute a command
   */
  async exec(command: string, options?: ExecOptions): Promise<IOResult<ExecOutput>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    const ctx = this.buildPolicyContext('exec', { command, options }, options?.caller)
    const result = await this.config.policyEngine.evaluateBefore(ctx)

    if (!result.allowed) {
      return { success: false, error: result.reason, traceId }
    }

    // Use potentially mutated input
    const mutatedCommand = (result.input as { command: string })?.command ?? command

    const projectRoot = await this.getProjectRoot()
    const execCwd = await this.resolveCwd(options?.cwd)
    const cwdRel = path.relative(projectRoot, execCwd).replace(/\\/g, '/') || '.'

    return new Promise((resolve) => {
      const timeout = Math.min(options?.timeout ?? this.limits.timeout, this.limits.timeout)

      // Use spawn instead of exec, via shell
      const child = spawn('sh', ['-c', mutatedCommand], {
        cwd: execCwd,
        env: { ...process.env, ...options?.env },
        timeout
      })

      let stdout = ''
      let stderr = ''
      let stdoutTruncated = false
      let stderrTruncated = false

      this.config.eventBus.emit('io:exec:start', {
        traceId,
        command: mutatedCommand,
        cwd: cwdRel,
        caller: options?.caller
      })

      child.stdout?.on('data', (data) => {
        const chunk = data.toString()
        stdout += chunk
        const eventChunk = clipExecChunk(chunk)
        this.config.eventBus.emit('io:exec:chunk', {
          traceId,
          stream: 'stdout',
          chunk: eventChunk.value,
          truncated: eventChunk.truncated,
          caller: options?.caller
        })
        // Limit output size
        if (stdout.length > this.limits.maxBytes) {
          stdout = stdout.slice(0, this.limits.maxBytes)
          stdoutTruncated = true
          child.kill()
        }
      })

      child.stderr?.on('data', (data) => {
        const chunk = data.toString()
        stderr += chunk
        const eventChunk = clipExecChunk(chunk)
        this.config.eventBus.emit('io:exec:chunk', {
          traceId,
          stream: 'stderr',
          chunk: eventChunk.value,
          truncated: eventChunk.truncated,
          caller: options?.caller
        })
        if (stderr.length > this.limits.maxBytes) {
          stderr = stderr.slice(0, this.limits.maxBytes)
          stderrTruncated = true
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

        this.config.eventBus.emit('io:exec:end', {
          traceId,
          exitCode,
          signal: signal ?? undefined,
          durationMs: Date.now() - startTime,
          caller: options?.caller,
          stdoutTruncated,
          stderrTruncated
        })

        resolve({
          success,
          data: { stdout, stderr, exitCode },
          traceId,
          durationMs: Date.now() - startTime
        })
      })

      child.on('error', (error) => {
        this.config.eventBus.emit('io:exec:error', {
          traceId,
          error: error.message,
          durationMs: Date.now() - startTime,
          caller: options?.caller
        })
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
   * Glob file matching
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

      // Merge user ignore patterns with default ignore patterns
      const userIgnore = options?.ignore ?? []
      const mergedIgnore = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...userIgnore])]

      const files = await globFn(pattern, {
        cwd,
        ignore: mergedIgnore,
        dot: options?.dot ?? false,
        nodir: true
      })

      // Apply hard limit
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
   * Grep content search (non-shell execution, uses spawn + argument array)
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
          // Limit output size
          if (stdout.length > this.limits.maxBytes) {
            stdout = stdout.slice(0, this.limits.maxBytes)
            child.kill()
          }
        })

        child.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('close', (code) => {
          // grep returns 1 when there are no matches; this is not an error
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
          // If grep is unavailable, fall back to built-in search
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
   * Grep fallback implementation (pure JS, used when grep is unavailable)
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

    // Get file list
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
        // Ignore unreadable files
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
   * Get file stat information (used by edit to determine if a full read is needed)
   */
  async stat(filePath: string): Promise<IOResult<{ size: number; lines?: number; mtimeMs?: number }>> {
    const traceId = generateTraceId()

    try {
      const resolvedPath = await this.resolvePath(filePath)
      const stat = await fs.stat(resolvedPath)

      return {
        success: true,
        data: { size: stat.size, mtimeMs: stat.mtimeMs },
        traceId
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, traceId }
    }
  }

  /**
   * Read file without limits (for internal edit use only, bypasses autoLimitRead)
   * Note: hard limits still apply for protection
   */
  async readFileForEdit(filePath: string): Promise<IOResult<string>> {
    const startTime = Date.now()
    const traceId = generateTraceId()

    // Bypass policy, but still validate path
    try {
      const resolvedPath = await this.resolvePath(filePath)
      const stat = await fs.stat(resolvedPath)

      // Larger limit specifically for edit operations
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
