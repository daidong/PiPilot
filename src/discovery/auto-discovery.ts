/**
 * Provider Auto-Discovery
 *
 * Automatically discover and load Providers
 */

import type { ToolProvider } from '../types/provider.js'
import { ProviderRegistry } from '../core/provider-registry.js'
import { scanForManifests, extractPackageInfo, type ScanOptions } from './scanner.js'

/**
 * Discovery configuration
 */
export interface DiscoveryConfig extends ScanOptions {
  /** Whether to automatically load discovered providers */
  autoLoad?: boolean
  /** Whether to continue on load failure */
  continueOnError?: boolean
  /** Whether to validate manifests */
  validateManifest?: boolean
}

/**
 * Discovery result
 */
export interface DiscoveryResult {
  /** Discovered manifest paths */
  manifests: string[]
  /** Successfully loaded providers */
  loaded: ToolProvider[]
  /** Records of load failures */
  errors: Array<{
    path: string
    error: Error
    packageName: string | null
  }>
  /** Skipped providers */
  skipped: string[]
}

/**
 * Provider auto-discoverer
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
   * Scan for all possible providers
   */
  async scan(): Promise<string[]> {
    return scanForManifests(this.projectRoot, this.config)
  }

  /**
   * Scan and load all providers
   */
  async discover(): Promise<DiscoveryResult> {
    const registry = new ProviderRegistry()
    return this.loadIntoRegistry(registry)
  }

  /**
   * Load into the specified registry
   */
  async loadIntoRegistry(registry: ProviderRegistry): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      manifests: [],
      loaded: [],
      errors: [],
      skipped: []
    }

    // Scan for manifest files
    result.manifests = await this.scan()

    if (!this.config.autoLoad) {
      return result
    }

    // Load each provider
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
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot
  }

  /**
   * Get the configuration
   */
  getConfig(): DiscoveryConfig {
    return { ...this.config }
  }
}

/**
 * Convenience function: auto-discover and load
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
 * Convenience function: scan only without loading
 */
export async function scanProviders(
  projectRoot: string,
  config?: ScanOptions
): Promise<string[]> {
  return scanForManifests(projectRoot, config)
}

/**
 * Create and return a discoverer
 */
export function createDiscovery(
  projectRoot: string,
  config?: DiscoveryConfig
): ProviderDiscovery {
  return new ProviderDiscovery(projectRoot, config)
}
