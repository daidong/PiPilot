/**
 * defineProvider - provider definition helper
 */

import type { ToolProvider, ToolProviderConfig } from '../types/provider.js'

/**
 * Define provider
 */
export function defineProvider(config: ToolProviderConfig): ToolProvider {
  if (!config.manifest?.id) {
    throw new Error('Provider manifest id is required')
  }

  if (!config.manifest?.name) {
    throw new Error('Provider manifest name is required')
  }

  if (!config.manifest?.version) {
    throw new Error('Provider manifest version is required')
  }

  if (!config.createPacks) {
    throw new Error('Provider createPacks is required')
  }

  return {
    manifest: config.manifest,
    createPacks: config.createPacks
  }
}
