import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../types.js'

export interface MemoryExplainResult {
  success: boolean
  data?: unknown
  error?: string
}

function readLatestExplainTurn(projectPath: string): unknown {
  const dir = join(projectPath, PATHS.explainDir)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(name => name.endsWith('.turn.json')).sort()
  if (files.length === 0) return null
  const latest = files[files.length - 1]
  return JSON.parse(readFileSync(join(dir, latest), 'utf-8'))
}

export function memoryExplainTurn(projectPath: string): MemoryExplainResult {
  try {
    return {
      success: true,
      data: readLatestExplainTurn(projectPath) ?? { message: 'No turn explanation recorded yet.' }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
