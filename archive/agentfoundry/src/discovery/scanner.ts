/**
 * Provider Scanner
 *
 * Scan the filesystem for Provider manifest files
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Scan options
 */
export interface ScanOptions {
  /** Whether to scan node_modules */
  scanNodeModules?: boolean
  /** Custom provider directories */
  providerDirs?: string[]
  /** Manifest filename pattern */
  manifestPattern?: string
  /** Packages to exclude */
  excludePackages?: string[]
  /** Maximum scan depth */
  maxDepth?: number
}

/**
 * Default manifest filename
 */
const DEFAULT_MANIFEST_NAME = 'agentfoundry.provider.json'

/**
 * Default excluded directories
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
 * Scan for Provider manifest files
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

  // 1. Scan for manifest in the project root
  const rootManifest = path.join(projectRoot, manifestPattern)
  if (await fileExists(rootManifest)) {
    manifests.push(rootManifest)
  }

  // 2. Scan custom provider directories
  for (const dir of providerDirs) {
    const fullDir = path.isAbsolute(dir) ? dir : path.join(projectRoot, dir)
    const dirManifests = await scanDirectory(fullDir, manifestPattern, maxDepth)
    manifests.push(...dirManifests)
  }

  // 3. Scan node_modules
  if (shouldScanNodeModules) {
    const nodeModulesDir = path.join(projectRoot, 'node_modules')
    const nodeManifests = await scanNodeModulesDir(
      nodeModulesDir,
      manifestPattern,
      excludePackages
    )
    manifests.push(...nodeManifests)
  }

  // Deduplicate
  return [...new Set(manifests)]
}

/**
 * Scan a directory
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
    // Ignore inaccessible directories
  }

  return manifests
}

/**
 * Scan node_modules
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

      // Handle scoped packages (@org/package)
      if (pkgName.startsWith('@')) {
        const scopedManifests = await scanScopedPackages(
          pkgPath,
          manifestPattern,
          excludePackages
        )
        manifests.push(...scopedManifests)
        continue
      }

      // Check if the package is in the exclude list
      if (excludePackages.includes(pkgName)) {
        continue
      }

      // Check if the manifest exists
      const manifestPath = path.join(pkgPath, manifestPattern)
      if (await fileExists(manifestPath)) {
        manifests.push(manifestPath)
      }
    }
  } catch (error) {
    // node_modules does not exist or is not accessible
  }

  return manifests
}

/**
 * Scan scoped packages
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

      // Check if the package is in the exclude list
      if (excludePackages.includes(fullPkgName)) {
        continue
      }

      // Check if the manifest exists
      const manifestPath = path.join(pkgPath, manifestPattern)
      if (await fileExists(manifestPath)) {
        manifests.push(manifestPath)
      }
    }
  } catch (error) {
    // Ignore inaccessible directories
  }

  return manifests
}

/**
 * Check if a file exists
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
 * Extract package info from a manifest path
 */
export function extractPackageInfo(manifestPath: string): {
  packageName: string | null
  packagePath: string
  isNodeModule: boolean
} {
  const packagePath = path.dirname(manifestPath)
  const parts = manifestPath.split(path.sep)

  // Check if it's inside node_modules
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  if (nodeModulesIndex === -1) {
    return {
      packageName: null,
      packagePath,
      isNodeModule: false
    }
  }

  // Extract package name
  const afterNodeModules = parts.slice(nodeModulesIndex + 1)

  // Handle scoped packages
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
