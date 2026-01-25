/**
 * Provider Auto-Discovery
 *
 * 自动发现和加载 Provider
 */

import type { ToolProvider } from '../types/provider.js'
import { ProviderRegistry } from '../core/provider-registry.js'
import { scanForManifests, extractPackageInfo, type ScanOptions } from './scanner.js'

/**
 * 发现配置
 */
export interface DiscoveryConfig extends ScanOptions {
  /** 是否自动加载发现的 provider */
  autoLoad?: boolean
  /** 加载失败时是否继续 */
  continueOnError?: boolean
  /** 是否验证 manifest */
  validateManifest?: boolean
}

/**
 * 发现结果
 */
export interface DiscoveryResult {
  /** 发现的 manifest 路径 */
  manifests: string[]
  /** 成功加载的 provider */
  loaded: ToolProvider[]
  /** 加载失败的记录 */
  errors: Array<{
    path: string
    error: Error
    packageName: string | null
  }>
  /** 跳过的 provider */
  skipped: string[]
}

/**
 * Provider 自动发现器
 */
export class ProviderDiscovery {
  private projectRoot: string
  private config: DiscoveryConfig

  constructor(projectRoot: string, config: DiscoveryConfig = {}) {
    this.projectRoot = projectRoot
    this.config = {
      scanNodeModules: true,
      autoLoad: true,
      continueOnError: true,
      validateManifest: true,
      ...config
    }
  }

  /**
   * 扫描所有可能的 provider
   */
  async scan(): Promise<string[]> {
    return scanForManifests(this.projectRoot, this.config)
  }

  /**
   * 扫描并加载所有 provider
   */
  async discover(): Promise<DiscoveryResult> {
    const registry = new ProviderRegistry()
    return this.loadIntoRegistry(registry)
  }

  /**
   * 加载到指定的 registry
   */
  async loadIntoRegistry(registry: ProviderRegistry): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      manifests: [],
      loaded: [],
      errors: [],
      skipped: []
    }

    // 扫描 manifest 文件
    result.manifests = await this.scan()

    if (!this.config.autoLoad) {
      return result
    }

    // 加载每个 provider
    for (const manifestPath of result.manifests) {
      const packageInfo = extractPackageInfo(manifestPath)

      try {
        const provider = await registry.loadFromFile({
          manifestPath,
          enforceManifestMatch: this.config.validateManifest
        })

        result.loaded.push(provider)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))

        if (this.config.continueOnError) {
          result.errors.push({
            path: manifestPath,
            error: err,
            packageName: packageInfo.packageName
          })
        } else {
          throw err
        }
      }
    }

    return result
  }

  /**
   * 获取项目根目录
   */
  getProjectRoot(): string {
    return this.projectRoot
  }

  /**
   * 获取配置
   */
  getConfig(): DiscoveryConfig {
    return { ...this.config }
  }
}

/**
 * 便捷函数：自动发现并加载
 */
export async function autoDiscoverProviders(
  projectRoot: string,
  registry: ProviderRegistry,
  config?: DiscoveryConfig
): Promise<DiscoveryResult> {
  const discovery = new ProviderDiscovery(projectRoot, config)
  return discovery.loadIntoRegistry(registry)
}

/**
 * 便捷函数：仅扫描不加载
 */
export async function scanProviders(
  projectRoot: string,
  config?: ScanOptions
): Promise<string[]> {
  return scanForManifests(projectRoot, config)
}

/**
 * 创建发现器并返回
 */
export function createDiscovery(
  projectRoot: string,
  config?: DiscoveryConfig
): ProviderDiscovery {
  return new ProviderDiscovery(projectRoot, config)
}
