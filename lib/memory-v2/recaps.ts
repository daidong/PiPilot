/**
 * Auto-recap persistence.
 *
 * We keep exactly ONE recap per session on disk (latest wins) at
 * `.research-pilot/memory-v2/recaps/{sessionId}.json`. The recap is generated
 * after every assistant turn, so the file always holds "the recap for the most
 * recent response" — which is exactly what the renderer shows on project
 * reopen. Overwriting (rather than appending a history) is intentional: the
 * product only ever surfaces the latest recap, so older ones would be dead
 * weight. See lib/types.ts `RecapRecord` and lib/agents/coordinator.ts
 * `generateRecap`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS, type RecapRecord } from '../types.js'

export function writeLatestRecap(projectPath: string, recap: RecapRecord): void {
  const dir = join(projectPath, PATHS.recaps)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${recap.sessionId}.json`), JSON.stringify(recap, null, 2), 'utf-8')
}

export function readLatestRecap(projectPath: string, sessionId: string): RecapRecord | null {
  const file = join(projectPath, PATHS.recaps, `${sessionId}.json`)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as RecapRecord
    if (!parsed || (typeof parsed.did !== 'string' && typeof parsed.next !== 'string')) return null
    return parsed
  } catch {
    return null
  }
}
