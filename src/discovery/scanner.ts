/**
 * Provider Scanner
 *
 * 扫描文件系统中的 Provider manifest 文件
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * 扫描选项
 */
export interface ScanOptions {
  /** 是否扫描 node_modules */
  scanNodeModules?: boolean
  /** 自定义 provider 目录 */
  providerDirs?: string[]
  /** manifest 文件名模式 */
  manifestPattern?: string
  /** 排除的包 */
  excludePackages?: string[]
  /** 最大扫描深度 */
  maxDepth?: number
}

/**
 * 默认 manifest 文件名
 */
const DEFAULT_MANIFEST_NAME = 'agentfoundry.provider.json'

/**
 * 默认排除的目录
 */
const DEFAULT_EXCLUDES = [
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.cache'
]

/**
 * 扫描 Provider manifest 文件
 */
export async function scanForManifests(
  projectRoot: string,
  options: ScanOptions = {}
): Promise<string[]> {
  const {
    scanNodeModules: shouldScanNodeModules = true,
    providerDirs = [],
    manifestPattern = DEFAULT_MANIFEST_NAME,
    excludePackages = [],
    maxDepth = 3
  } = options

  const manifests: string[] = []

  // 1. 扫描项目根目录的 manifest
  const rootManifest = path.join(projectRoot, manifestPattern)
  if (await fileExists(rootManifest)) {
    manifests.push(rootManifest)
  }

  // 2. 扫描自定义 provider 目录
  for (const dir of providerDirs) {
    const fullDir = path.isAbsolute(dir) ? dir : path.join(projectRoot, dir)
    const dirManifests = await scanDirectory(fullDir, manifestPattern, maxDepth)
    manifests.push(...dirManifests)
  }

  // 3. 扫描 node_modules
  if (shouldScanNodeModules) {
    const nodeModulesDir = path.join(projectRoot, 'node_modules')
    const nodeManifests = await scanNodeModulesDir(
      nodeModulesDir,
      manifestPattern,
      excludePackages
    )
    manifests.push(...nodeManifests)
  }

  // 去重
  return [...new Set(manifests)]
}

/**
 * 扫描目录
 */
async function scanDirectory(
  dir: string,
  manifestPattern: string,
  maxDepth: number,
  currentDepth: number = 0
): Promise<string[]> {
  const manifests: string[] = []

  if (currentDepth > maxDepth) {
    return manifests
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isFile() && entry.name === manifestPattern) {
        manifests.push(fullPath)
      } else if (entry.isDirectory() && !DEFAULT_EXCLUDES.includes(entry.name)) {
        const subManifests = await scanDirectory(
          fullPath,
          manifestPattern,
          maxDepth,
          currentDepth + 1
        )
        manifests.push(...subManifests)
      }
    }
  } catch (error) {
    // 忽略不可访问的目录
  }

  return manifests
}

/**
 * 扫描 node_modules
 */
async function scanNodeModulesDir(
  nodeModulesDir: string,
  manifestPattern: string,
  excludePackages: string[]
): Promise<string[]> {
  const manifests: string[] = []

  try {
    const entries = await fs.readdir(nodeModulesDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const pkgName = entry.name
      const pkgPath = path.join(nodeModulesDir, pkgName)

      // 处理 scoped packages (@org/package)
      if (pkgName.startsWith('@')) {
        const scopedManifests = await scanScopedPackages(
          pkgPath,
          manifestPattern,
          excludePackages
        )
        manifests.push(...scopedManifests)
        continue
      }

      // 检查是否在排除列表中
      if (excludePackages.includes(pkgName)) {
        continue
      }

      // 检查 manifest 是否存在
      const manifestPath = path.join(pkgPath, manifestPattern)
      if (await fileExists(manifestPath)) {
        manifests.push(manifestPath)
      }
    }
  } catch (error) {
    // node_modules 不存在或不可访问
  }

  return manifests
}

/**
 * 扫描 scoped packages
 */
async function scanScopedPackages(
  scopeDir: string,
  manifestPattern: string,
  excludePackages: string[]
): Promise<string[]> {
  const manifests: string[] = []
  const scopeName = path.basename(scopeDir)

  try {
    const entries = await fs.readdir(scopeDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const fullPkgName = `${scopeName}/${entry.name}`
      const pkgPath = path.join(scopeDir, entry.name)

      // 检查是否在排除列表中
      if (excludePackages.includes(fullPkgName)) {
        continue
      }

      // 检查 manifest 是否存在
      const manifestPath = path.join(pkgPath, manifestPattern)
      if (await fileExists(manifestPath)) {
        manifests.push(manifestPath)
      }
    }
  } catch (error) {
    // 忽略不可访问的目录
  }

  return manifests
}

/**
 * 检查文件是否存在
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * 从 manifest 路径提取包信息
 */
export function extractPackageInfo(manifestPath: string): {
  packageName: string | null
  packagePath: string
  isNodeModule: boolean
} {
  const packagePath = path.dirname(manifestPath)
  const parts = manifestPath.split(path.sep)

  // 检查是否在 node_modules 中
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  if (nodeModulesIndex === -1) {
    return {
      packageName: null,
      packagePath,
      isNodeModule: false
    }
  }

  // 提取包名
  const afterNodeModules = parts.slice(nodeModulesIndex + 1)

  // 处理 scoped packages
  if (afterNodeModules[0]?.startsWith('@') && afterNodeModules.length >= 2) {
    return {
      packageName: `${afterNodeModules[0]}/${afterNodeModules[1]}`,
      packagePath,
      isNodeModule: true
    }
  }

  return {
    packageName: afterNodeModules[0] ?? null,
    packagePath,
    isNodeModule: true
  }
}
