/**
 * ProviderRegistry - provider registration and loading
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ToolProvider, ToolProviderManifest, ProviderCreateOptions } from '../types/provider.js'
import type { Pack } from '../types/pack.js'

export interface ProviderLoadOptions {
  manifestPath: string
  enforceManifestMatch?: boolean
}

export interface ProviderCollectOptions {
  configByProvider?: Record<string, ProviderCreateOptions>
}

function isToolProvider(value: unknown): value is ToolProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as ToolProvider
  return !!provider.manifest && typeof provider.createPacks === 'function'
}

function validateManifest(manifest: ToolProviderManifest, requireEntry: boolean): void {
  if (!manifest.id) {
    throw new Error('Provider manifest id is required')
  }
  if (!manifest.name) {
    throw new Error('Provider manifest name is required')
  }
  if (!manifest.version) {
    throw new Error('Provider manifest version is required')
  }
  if (requireEntry && !manifest.entry) {
    throw new Error('Provider manifest entry is required')
  }
}

async function loadProviderModule(
  entryPath: string,
  manifest: ToolProviderManifest
): Promise<ToolProvider> {
  const module = await import(pathToFileURL(entryPath).href)

  const candidate = module.default ?? module.provider
  if (isToolProvider(candidate)) {
    return candidate
  }

  if (typeof module.createProvider === 'function') {
    const provider = module.createProvider(manifest)
    if (isToolProvider(provider)) {
      return provider
    }
  }

  throw new Error('Provider entry must export a ToolProvider or createProvider(manifest)')
}

function mergeManifest(
  fileManifest: ToolProviderManifest,
  providerManifest: ToolProviderManifest
): ToolProviderManifest {
  return {
    ...fileManifest,
    ...providerManifest,
    packs: providerManifest.packs ?? fileManifest.packs,
    permissions: providerManifest.permissions ?? fileManifest.permissions,
    budgets: providerManifest.budgets ?? fileManifest.budgets,
    entry: fileManifest.entry ?? providerManifest.entry
  }
}

export class ProviderRegistry {
  private providers = new Map<string, ToolProvider>()

  register(provider: ToolProvider): void {
    if (this.providers.has(provider.manifest.id)) {
      throw new Error(`Provider already registered: ${provider.manifest.id}`)
    }
    this.providers.set(provider.manifest.id, provider)
  }

  registerAll(providers: ToolProvider[]): void {
    for (const provider of providers) {
      this.register(provider)
    }
  }

  unregister(id: string): boolean {
    return this.providers.delete(id)
  }

  get(id: string): ToolProvider | undefined {
    return this.providers.get(id)
  }

  getAll(): ToolProvider[] {
    return Array.from(this.providers.values())
  }

  clear(): void {
    this.providers.clear()
  }

  async loadFromFile(options: ProviderLoadOptions): Promise<ToolProvider> {
    const raw = await fs.readFile(options.manifestPath, 'utf-8')
    const manifest = JSON.parse(raw) as ToolProviderManifest
    validateManifest(manifest, true)

    const providerRoot = path.dirname(options.manifestPath)
    const entryPath = path.resolve(providerRoot, manifest.entry!)
    const relativeEntry = path.relative(providerRoot, entryPath)

    if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
      throw new Error(`Provider entry is outside provider root: ${manifest.entry}`)
    }

    const provider = await loadProviderModule(entryPath, manifest)
    validateManifest(provider.manifest, false)

    if (options.enforceManifestMatch !== false) {
      if (provider.manifest.id !== manifest.id) {
        throw new Error(`Provider id mismatch: ${provider.manifest.id} != ${manifest.id}`)
      }
      if (provider.manifest.version !== manifest.version) {
        throw new Error(`Provider version mismatch: ${provider.manifest.version} != ${manifest.version}`)
      }
    }

    provider.manifest = mergeManifest(manifest, provider.manifest)
    this.register(provider)
    return provider
  }

  async collectPacks(options?: ProviderCollectOptions): Promise<Pack[]> {
    const packs: Pack[] = []

    for (const provider of this.providers.values()) {
      const config = options?.configByProvider?.[provider.manifest.id]
      const providerPacks = await provider.createPacks(config)
      packs.push(...providerPacks)
    }

    return packs
  }
}
