/**
 * PythonBridge - Python long-running service and script executor
 */

import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createPythonError, classifyError } from '../core/errors.js'
import type { AgentError } from '../core/errors.js'

/**
 * PythonBridge configuration
 */
export interface PythonBridgeConfig {
  /** Path to the Python script */
  script: string
  /** Mode: script (one-shot) or service (long-running) */
  mode?: 'script' | 'service'
  /** Service port (service mode only) */
  port?: number
  /** Python interpreter path */
  python?: string
  /** Working directory */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Startup timeout in milliseconds (service mode) */
  startupTimeout?: number
  /** Execution timeout in milliseconds (script mode, default 120000) */
  executionTimeout?: number
  /** Grace period before SIGKILL after SIGTERM (milliseconds, default 5000) */
  gracePeriod?: number
}

/**
 * Call result
 */
export interface CallResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /** Structured error info (RFC-005) */
  agentError?: AgentError
}

/**
 * Python bridge - executes Python scripts or communicates with long-running Python services
 */
export class PythonBridge extends EventEmitter {
  private config: PythonBridgeConfig
  private process: ChildProcess | null = null
  private ready = false
  private pending = new Map<string, {
    resolve: (result: CallResult) => void
    reject: (error: Error) => void
  }>()
  /** Tracks active child processes for orphan cleanup */
  private activeChildren = new Set<ChildProcess>()
  private cleanupHandlersRegistered = false

  constructor(config: PythonBridgeConfig) {
    super()
    this.config = {
      ...config,
      mode: config.mode ?? 'script',
      python: config.python ?? 'python3',
      startupTimeout: config.startupTimeout ?? 30000,
      executionTimeout: config.executionTimeout ?? 120000,
      gracePeriod: config.gracePeriod ?? 5000
    }
  }

  /**
   * Register process-level cleanup handlers to kill orphan child processes
   */
  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered) return
    this.cleanupHandlersRegistered = true

    const cleanup = () => {
      for (const child of this.activeChildren) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
      this.activeChildren.clear()
    }

    process.on('exit', cleanup)
    process.on('SIGINT', () => {
      cleanup()
      process.exit(130)
    })
    process.on('SIGTERM', () => {
      cleanup()
      process.exit(143)
    })
  }

  /**
   * Start the Python process (service mode only)
   */
  async start(): Promise<void> {
    if (this.config.mode !== 'service') {
      throw new Error('start() is only available in service mode')
    }

    if (this.process) {
      throw new Error('Python bridge already started')
    }

    this.registerCleanupHandlers()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Python bridge startup timeout'))
      }, this.config.startupTimeout)

      // Spawn Python process
      this.process = spawn(this.config.python!, [this.config.script], {
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      this.activeChildren.add(this.process)

      // Handle stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const message = data.toString().trim()

        // Check for startup ready message
        if (message.includes('READY')) {
          clearTimeout(timeout)
          this.ready = true
          this.emit('ready')
          resolve()
          return
        }

        // Handle JSON responses
        try {
          const response = JSON.parse(message) as {
            id: string
            success: boolean
            data?: unknown
            error?: string
          }

          const pending = this.pending.get(response.id)
          if (pending) {
            this.pending.delete(response.id)
            const callResult: CallResult = {
              success: response.success,
              data: response.data,
              error: response.error
            }
            // Attach structured error for failed service calls (RFC-005)
            if (!response.success && response.error) {
              callResult.agentError = createPythonError(response.error)
            }
            pending.resolve(callResult)
          }
        } catch {
          this.emit('output', message)
        }
      })

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        this.emit('error', data.toString())
      })

      // Handle process exit
      this.process.on('exit', (code) => {
        this.ready = false
        if (this.process) this.activeChildren.delete(this.process)
        this.process = null
        this.emit('exit', code)

        // Reject all pending requests
        for (const [_, pending] of this.pending) {
          pending.reject(new Error('Python process exited'))
        }
        this.pending.clear()
      })

      // Handle spawn errors
      this.process.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  /**
   * Stop the Python process
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return
    }

    return new Promise((resolve) => {
      this.process?.on('exit', () => {
        resolve()
      })

      // Send exit command
      this.process?.stdin?.write(JSON.stringify({ type: 'exit' }) + '\n')

      // Force kill after timeout
      setTimeout(() => {
        this.process?.kill('SIGKILL')
        resolve()
      }, 5000)
    })
  }

  /**
   * Call a Python method
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<CallResult<T>> {
    if (this.config.mode === 'service') {
      return this.callService<T>(method, params)
    } else {
      return this.callScript<T>(method, params)
    }
  }

  /**
   * Service mode call
   */
  private async callService<T>(method: string, params?: unknown): Promise<CallResult<T>> {
    if (!this.ready || !this.process) {
      throw new Error('Python bridge not started')
    }

    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`

      // Set timeout — creates AgentError with category 'timeout' (RFC-005)
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        const agentError = classifyError('Call timeout', 'python')
        reject(Object.assign(new Error('Call timeout'), { agentError }))
      }, 60000)

      // Register callback
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result as CallResult<T>)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })

      // Send request
      const request = JSON.stringify({ id, method, params })
      this.process?.stdin?.write(request + '\n')
    })
  }

  /**
   * Script mode call — spawns a one-shot Python process with streaming and graceful timeout
   */
  private async callScript<T>(method: string, params?: unknown): Promise<CallResult<T>> {
    this.registerCleanupHandlers()

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.python!, [
        this.config.script,
        method,
        JSON.stringify(params ?? {})
      ], {
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env }
      })

      this.activeChildren.add(proc)

      let stdout = ''
      let stderr = ''
      let timedOut = false

      // Graceful timeout: SIGTERM first, then SIGKILL after grace period
      const execTimeout = this.config.executionTimeout ?? 120000
      const grace = this.config.gracePeriod ?? 5000
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
        }, grace)
      }, execTimeout)

      // Stream stdout line-by-line
      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stdout += chunk
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.emit('stdout', line)
        }
      })

      // Stream stderr line-by-line
      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.emit('stderr', line)
        }
      })

      proc.on('exit', (code) => {
        clearTimeout(timer)
        this.activeChildren.delete(proc)

        if (timedOut) {
          const msg = `Python script timed out after ${execTimeout / 1000}s`
          const agentError = createPythonError(msg)
          resolve({ success: false, error: msg, agentError })
          return
        }

        if (code !== 0) {
          const agentError = createPythonError(stderr || `Process exited with code ${code}`, code ?? undefined)
          resolve({
            success: false,
            error: stderr || `Process exited with code ${code}`,
            agentError
          })
          return
        }

        try {
          const result = JSON.parse(stdout) as T
          resolve({ success: true, data: result })
        } catch {
          resolve({ success: true, data: stdout as unknown as T })
        }
      })

      proc.on('error', (error) => {
        clearTimeout(timer)
        this.activeChildren.delete(proc)
        reject(error)
      })
    })
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.ready
  }
}
