/**
 * 测试工具函数
 */

import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * 创建临时目录并返回规范化的真实路径
 * 在 macOS 上，/var 是 /private/var 的符号链接
 * 使用 realpathSync 确保路径一致
 */
export async function createTempDir(prefix: string): Promise<string> {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix))
  // 规范化路径，解析符号链接
  return fs.realpathSync(tmpDir)
}

/**
 * 规范化路径（解析符号链接）
 */
export function normalizePath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * 清理临时目录
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  await fsPromises.rm(dir, { recursive: true, force: true })
}
