/**
 * Provider Discovery Module
 *
 * Automatically scan and load Providers
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
