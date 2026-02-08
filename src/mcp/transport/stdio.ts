/**
 * MCP STDIO Transport
 *
 * Communicates with a local MCP server via stdin/stdout of a child process
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
 * STDIO transport configuration
 */
export interface StdioTransportConfig extends TransportConfig {
  /** STDIO configuration */
  stdio: MCPStdioConfig
  /** Startup timeout (ms) */
  startTimeout?: number
}

/**
 * STDIO transport implementation
 *
 * Uses stdin/stdout of a child process for JSON-RPC communication
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
   * Start the child process and establish the connection
   */
  async start(): Promise<void> {
    if (this.ready) {
      return
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          fn()
        }
      }

      const timer = setTimeout(() => {
        this.stop().catch(() => {})
        settle(() => reject(new Error(`Start timeout after ${this.startTimeout}ms`)))
      }, this.startTimeout)

      try {

        // Spawn child process
        this.process = spawn(this.stdioConfig.command, this.stdioConfig.args ?? [], {
          cwd: this.stdioConfig.cwd,
          env: {
            ...process.env,
            ...this.stdioConfig.env
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })

        // Handle process spawn errors (e.g., command not found)
        this.process.on('error', (error) => {
          this.handleError(error)
          settle(() => reject(error))
        })

        // Collect stderr for diagnostics
        const stderrChunks: string[] = []

        // Handle early exit before the process is ready
        this.process.on('exit', (code, signal) => {
          if (this.config.debug) {
            console.debug(`[MCP] Process exited with code ${code}, signal ${signal}`)
          }
          if (!this.ready) {
            // Process died before becoming ready
            settle(() =>
              reject(
                new Error(
                  `MCP server process exited with code ${code} before becoming ready` +
                  (stderrChunks.length ? `\nstderr: ${stderrChunks.join('')}` : '')
                )
              )
            )
          }
          this.handleClose()
        })
        if (this.process.stderr) {
          this.process.stderr.on('data', (data: Buffer) => {
            const text = data.toString()
            stderrChunks.push(text)
            if (this.config.debug) {
              console.debug('[MCP] stderr:', text)
            }
          })
        }

        // Set up stdout reading
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

        // Wait briefly to confirm the process doesn't exit immediately,
        // then mark as ready. If the process dies within this window,
        // the 'exit' handler above will reject the promise instead.
        const readyDelay = 200 // ms
        setTimeout(() => {
          if (this.process && !this.process.killed && this.process.exitCode === null) {
            this.ready = true
            settle(() => resolve())
          }
          // If process already exited, the 'exit' handler will settle.
        }, readyDelay)
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /**
   * Stop the transport and close the child process
   */
  async stop(): Promise<void> {
    this.ready = false

    if (this.readline) {
      this.readline.close()
      this.readline = null
    }

    if (this.process) {
      // Attempt graceful shutdown
      this.process.stdin?.end()

      // Wait for process to exit or force kill
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

          // Send SIGTERM
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
   * Send a message to the child process
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
   * Handle a received line of data
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
      // Might be multi-line JSON, try buffering
      this.buffer += trimmed
      try {
        const message = JSON.parse(this.buffer) as JsonRpcResponse | JsonRpcNotification
        this.buffer = ''
        this.handleMessage(message)
      } catch {
        // Continue buffering
      }
    }
  }

  /**
   * Get the child process PID
   */
  getPid(): number | undefined {
    return this.process?.pid
  }

  /**
   * Check if the child process is alive
   */
  isProcessAlive(): boolean {
    return this.process !== null && !this.process.killed
  }
}

/**
 * Create a STDIO transport
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
