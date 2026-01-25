/**
 * Provider Discovery Module
 *
 * 自动扫描和加载 Provider
 */

// Scanner
export {
  scanForManifests,
  extractPackageInfo,
  type ScanOptions
} from './scanner.js'

// Auto-discovery
export {
  ProviderDiscovery,
  autoDiscoverProviders,
  scanProviders,
  createDiscovery,
  type DiscoveryConfig,
  type DiscoveryResult
} from './auto-discovery.js'
