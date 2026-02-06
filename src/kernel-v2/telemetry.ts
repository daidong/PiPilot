import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { KernelV2ResolvedConfig, KernelV2TelemetryEvent } from './types.js'

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export class KernelV2Telemetry {
  private chain: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(
    projectPath: string,
    private readonly config: KernelV2ResolvedConfig,
    private readonly debug = false
  ) {
    this.filePath = path.isAbsolute(config.telemetry.filePath)
      ? config.telemetry.filePath
      : path.join(projectPath, config.telemetry.filePath)
  }

  emit(event: KernelV2TelemetryEvent): void {
    if (!this.config.telemetry.baselineAlwaysOn) return

    const mode = this.config.telemetry.mode
    const prefix = this.debug ? '[KernelV2:debug]' : '[KernelV2]'

    if (mode === 'stderr' || mode === 'stderr+file') {
      console.error(`${prefix} ${event.message}`)
    }

    if (mode === 'file' || mode === 'stderr+file') {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event: event.event,
        message: event.message,
        payload: event.payload
      }) + '\n'
      this.chain = this.chain.then(async () => {
        await ensureDir(this.filePath)
        await fs.appendFile(this.filePath, line, 'utf-8')
      }).catch(() => {
        // Best effort telemetry sink.
      })
    }
  }

  async flush(): Promise<void> {
    await this.chain
  }
}
