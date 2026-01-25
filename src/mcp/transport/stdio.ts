/**
 * MCP STDIO Transport
 *
 * 通过子进程的 stdin/stdout 与本地 MCP server 通信
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type {
  MCPStdioConfig,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse
} from '../types.js'
import { MCPTransport, type TransportConfig } from './base.js'

/**
 * STDIO 传输配置
 */
export interface StdioTransportConfig extends TransportConfig {
  /** STDIO 配置 */
  stdio: MCPStdioConfig
  /** 启动超时（毫秒） */
  startTimeout?: number
}

/**
 * STDIO 传输实现
 *
 * 使用子进程的 stdin/stdout 进行 JSON-RPC 通信
 */
export class StdioTransport extends MCPTransport {
  private stdioConfig: MCPStdioConfig
  private process: ChildProcess | null = null
  private readline: ReadlineInterface | null = null
  private startTimeout: number
  private buffer = ''

  constructor(config: StdioTransportConfig) {
    super(config)
    this.stdioConfig = config.stdio
    this.startTimeout = config.startTimeout ?? 10000
  }

  /**
   * 启动子进程并建立连接
   */
  async start(): Promise<void> {
    if (this.ready) {
      return
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop().catch(() => {})
        reject(new Error(`Start timeout after ${this.startTimeout}ms`))
      }, this.startTimeout)

      try {
        // 启动子进程
        this.process = spawn(this.stdioConfig.command, this.stdioConfig.args ?? [], {
          cwd: this.stdioConfig.cwd,
          env: {
            ...process.env,
            ...this.stdioConfig.env
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })

        // 处理进程错误
        this.process.on('error', (error) => {
          clearTimeout(timer)
          this.handleError(error)
          reject(error)
        })

        // 处理进程退出
        this.process.on('exit', (code, signal) => {
          if (this.config.debug) {
            console.debug(`[MCP] Process exited with code ${code}, signal ${signal}`)
          }
          this.handleClose()
        })

        // 处理 stderr
        if (this.process.stderr) {
          this.process.stderr.on('data', (data: Buffer) => {
            if (this.config.debug) {
              console.debug('[MCP] stderr:', data.toString())
            }
          })
        }

        // 设置 stdout 读取
        if (this.process.stdout) {
          this.readline = createInterface({
            input: this.process.stdout,
            crlfDelay: Infinity
          })

          this.readline.on('line', (line) => {
            this.handleLine(line)
          })

          this.readline.on('close', () => {
            this.handleClose()
          })
        }

        // 标记就绪
        this.ready = true
        clearTimeout(timer)
        resolve()
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /**
   * 停止传输并关闭子进程
   */
  async stop(): Promise<void> {
    this.ready = false

    if (this.readline) {
      this.readline.close()
      this.readline = null
    }

    if (this.process) {
      // 尝试优雅关闭
      this.process.stdin?.end()

      // 等待进程退出或强制终止
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (this.process) {
          this.process.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })

          // 发送 SIGTERM
          this.process.kill('SIGTERM')
        } else {
          clearTimeout(timer)
          resolve()
        }
      })

      this.process = null
    }

    this.handleClose()
  }

  /**
   * 发送消息到子进程
   */
  protected async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.process?.stdin || !this.ready) {
      throw new Error('Transport is not ready')
    }

    const data = JSON.stringify(message) + '\n'

    return new Promise<void>((resolve, reject) => {
      this.process!.stdin!.write(data, 'utf-8', (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * 处理收到的一行数据
   */
  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    try {
      const message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification
      this.handleMessage(message)
    } catch (error) {
      if (this.config.debug) {
        console.debug('[MCP] Failed to parse line:', trimmed, error)
      }
      // 可能是多行 JSON，尝试缓冲
      this.buffer += trimmed
      try {
        const message = JSON.parse(this.buffer) as JsonRpcResponse | JsonRpcNotification
        this.buffer = ''
        this.handleMessage(message)
      } catch {
        // 继续缓冲
      }
    }
  }

  /**
   * 获取子进程 PID
   */
  getPid(): number | undefined {
    return this.process?.pid
  }

  /**
   * 检查子进程是否存活
   */
  isProcessAlive(): boolean {
    return this.process !== null && !this.process.killed
  }
}

/**
 * 创建 STDIO 传输
 */
export function createStdioTransport(
  config: MCPStdioConfig,
  options?: Omit<StdioTransportConfig, 'stdio'>
): StdioTransport {
  return new StdioTransport({
    ...options,
    stdio: config
  })
}
