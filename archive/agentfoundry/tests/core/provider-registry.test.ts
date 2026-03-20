/**
 * ProviderRegistry tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createTempDir, cleanupTempDir } from '../test-utils.js'
import { ProviderRegistry } from '../../src/core/provider-registry.js'

describe('ProviderRegistry', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir('provider-registry-')
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  it('loads provider from manifest file', async () => {
    const entryPath = path.join(tempDir, 'provider.js')
    const manifestPath = path.join(tempDir, 'agentfoundry.provider.json')

    await fs.writeFile(entryPath, `
export default {
  manifest: {
    id: 'demo.provider',
    name: 'Demo Provider',
    version: '1.0.0'
  },
  createPacks: () => [
    { id: 'demo.pack', description: 'Demo Pack', tools: [] }
  ]
}
`)

    await fs.writeFile(manifestPath, JSON.stringify({
      id: 'demo.provider',
      name: 'Demo Provider',
      version: '1.0.0',
      entry: './provider.js',
      description: 'Demo manifest'
    }, null, 2))

    const registry = new ProviderRegistry()
    const provider = await registry.loadFromFile({ manifestPath })

    expect(provider.manifest.id).toBe('demo.provider')
    expect(provider.manifest.description).toBe('Demo manifest')

    const packs = await registry.collectPacks()
    expect(packs).toHaveLength(1)
    expect(packs[0]?.id).toBe('demo.pack')
  })

  it('rejects entries outside provider root', async () => {
    const manifestPath = path.join(tempDir, 'agentfoundry.provider.json')

    await fs.writeFile(manifestPath, JSON.stringify({
      id: 'demo.provider',
      name: 'Demo Provider',
      version: '1.0.0',
      entry: '../provider.js'
    }, null, 2))

    const registry = new ProviderRegistry()
    await expect(registry.loadFromFile({ manifestPath }))
      .rejects
      .toThrow('Provider entry is outside provider root')
  })

  it('enforces manifest id and version match', async () => {
    const entryPath = path.join(tempDir, 'provider.js')
    const manifestPath = path.join(tempDir, 'agentfoundry.provider.json')

    await fs.writeFile(entryPath, `
export default {
  manifest: {
    id: 'demo.provider.other',
    name: 'Demo Provider',
    version: '2.0.0'
  },
  createPacks: () => []
}
`)

    await fs.writeFile(manifestPath, JSON.stringify({
      id: 'demo.provider',
      name: 'Demo Provider',
      version: '1.0.0',
      entry: './provider.js'
    }, null, 2))

    const registry = new ProviderRegistry()
    await expect(registry.loadFromFile({ manifestPath }))
      .rejects
      .toThrow('Provider id mismatch')
  })
})
