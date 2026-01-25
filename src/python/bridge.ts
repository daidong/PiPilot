/**
 * PythonBridge - Python 长驻服务
 */

import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * PythonBridge 配置
 */
export interface PythonBridgeConfig {
  /** Python 脚本路径 */
  script: string
  /** 模式：脚本（一次性）或服务（长驻） */
  mode?: 'script' | 'service'
  /** 服务端口（服务模式） */
  port?: number
  /** Python 解释器 */
  python?: string
  /** 工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 启动超时（毫秒） */
  startupTimeout?: number
}

/**
 * 调用结果
 */
export interface CallResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Python 桥接
 */
export class PythonBridge extends EventEmitter {
  private config: PythonBridgeConfig
  private process: ChildProcess | null = null
  private ready = false
  private pending = new Map<string, {
    resolve: (result: CallResult) => void
    reject: (error: Error) => void
  }>()

  constructor(config: PythonBridgeConfig) {
    super()
    this.config = {
      ...config,
      mode: config.mode ?? 'script',
      python: config.python ?? 'python3',
      startupTimeout: config.startupTimeout ?? 30000
    }
  }

  /**
   * 启动 Python 进程（服务模式）
   */
  async start(): Promise<void> {
    if (this.config.mode !== 'service') {
      throw new Error('start() is only available in service mode')
    }

    if (this.process) {
      throw new Error('Python bridge already started')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Python bridge startup timeout'))
      }, this.config.startupTimeout)

      // 启动 Python 进程
      this.process = spawn(this.config.python!, [this.config.script], {
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      // 处理标准输出
      this.process.stdout?.on('data', (data: Buffer) => {
        const message = data.toString().trim()

        // 检查启动消息
        if (message.includes('READY')) {
          clearTimeout(timeout)
          this.ready = true
          this.emit('ready')
          resolve()
          return
        }

        // 处理响应
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
            pending.resolve({
              success: response.success,
              data: response.data,
              error: response.error
            })
          }
        } catch {
          this.emit('output', message)
        }
      })

      // 处理标准错误
      this.process.stderr?.on('data', (data: Buffer) => {
        this.emit('error', data.toString())
      })

      // 处理进程退出
      this.process.on('exit', (code) => {
        this.ready = false
        this.process = null
        this.emit('exit', code)

        // 拒绝所有待处理的请求
        for (const [_, pending] of this.pending) {
          pending.reject(new Error('Python process exited'))
        }
        this.pending.clear()
      })

      // 处理错误
      this.process.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  /**
   * 停止 Python 进程
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return
    }

    return new Promise((resolve) => {
      this.process?.on('exit', () => {
        resolve()
      })

      // 发送退出命令
      this.process?.stdin?.write(JSON.stringify({ type: 'exit' }) + '\n')

      // 强制终止超时
      setTimeout(() => {
        this.process?.kill('SIGKILL')
        resolve()
      }, 5000)
    })
  }

  /**
   * 调用 Python 方法
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<CallResult<T>> {
    if (this.config.mode === 'service') {
      return this.callService<T>(method, params)
    } else {
      return this.callScript<T>(method, params)
    }
  }

  /**
   * 服务模式调用
   */
  private async callService<T>(method: string, params?: unknown): Promise<CallResult<T>> {
    if (!this.ready || !this.process) {
      throw new Error('Python bridge not started')
    }

    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`

      // 设置超时
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Call timeout'))
      }, 60000)

      // 注册回调
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

      // 发送请求
      const request = JSON.stringify({ id, method, params })
      this.process?.stdin?.write(request + '\n')
    })
  }

  /**
   * 脚本模式调用
   */
  private async callScript<T>(method: string, params?: unknown): Promise<CallResult<T>> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.python!, [
        this.config.script,
        method,
        JSON.stringify(params ?? {})
      ], {
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env }
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('exit', (code) => {
        if (code !== 0) {
          resolve({
            success: false,
            error: stderr || `Process exited with code ${code}`
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
        reject(error)
      })
    })
  }

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this.ready
  }
}
