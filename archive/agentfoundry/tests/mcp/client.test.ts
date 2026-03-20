/**
 * Tests for MCP Client
 *
 * Covers unit-testable methods: constructor, getState, getCachedTools, getConfig,
 * getServerCapabilities, getServerInfo, createMCPClient factory.
 * Does NOT test connect() as it requires actual transport.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MCPClient, createMCPClient } from '../../src/mcp/client.js'
import type { MCPClientConfig } from '../../src/mcp/client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<MCPClientConfig> = {}): MCPClientConfig {
  return {
    id: 'test-server',
    name: 'Test Server',
    transport: {
      type: 'stdio',
      command: 'echo',
      args: ['hello']
    },
    ...overrides
  }
}

// ===========================================================================
// MCPClient constructor & getConfig
// ===========================================================================

describe('MCPClient', () => {
  describe('constructor', () => {
    it('should create a client with the given config', () => {
      const config = makeConfig()
      const client = new MCPClient(config)
      expect(client).toBeInstanceOf(MCPClient)
    })

    it('should apply default connectTimeout', () => {
      const config = makeConfig()
      const client = new MCPClient(config)
      const retrieved = client.getConfig()
      expect(retrieved.connectTimeout).toBe(10000)
    })

    it('should apply default autoReconnect as false', () => {
      const config = makeConfig()
      const client = new MCPClient(config)
      const retrieved = client.getConfig()
      expect(retrieved.autoReconnect).toBe(false)
    })

    it('should respect explicit connectTimeout', () => {
      const config = makeConfig({ connectTimeout: 30000 })
      const client = new MCPClient(config)
      expect(client.getConfig().connectTimeout).toBe(30000)
    })

    it('should respect explicit autoReconnect', () => {
      const config = makeConfig({ autoReconnect: true })
      const client = new MCPClient(config)
      expect(client.getConfig().autoReconnect).toBe(true)
    })
  })

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('should return "disconnected" initially', () => {
      const client = new MCPClient(makeConfig())
      expect(client.getState()).toBe('disconnected')
    })
  })

  // =========================================================================
  // getCachedTools
  // =========================================================================

  describe('getCachedTools', () => {
    it('should return empty array before connect', () => {
      const client = new MCPClient(makeConfig())
      const tools = client.getCachedTools()
      expect(tools).toEqual([])
    })

    it('should return a copy (not the internal array)', () => {
      const client = new MCPClient(makeConfig())
      const tools1 = client.getCachedTools()
      const tools2 = client.getCachedTools()
      expect(tools1).not.toBe(tools2)
      expect(tools1).toEqual(tools2)
    })
  })

  // =========================================================================
  // getConfig
  // =========================================================================

  describe('getConfig', () => {
    it('should return config values', () => {
      const config = makeConfig({
        id: 'my-server',
        name: 'My Server',
        debug: true
      })
      const client = new MCPClient(config)
      const retrieved = client.getConfig()

      expect(retrieved.id).toBe('my-server')
      expect(retrieved.name).toBe('My Server')
      expect(retrieved.debug).toBe(true)
    })

    it('should return a copy (mutations do not affect client)', () => {
      const client = new MCPClient(makeConfig())
      const config1 = client.getConfig()
      config1.name = 'mutated'

      const config2 = client.getConfig()
      expect(config2.name).toBe('Test Server')
    })

    it('should preserve transport config', () => {
      const config = makeConfig({
        transport: {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer token' }
        }
      })
      const client = new MCPClient(config)
      const retrieved = client.getConfig()

      expect(retrieved.transport.type).toBe('http')
      if (retrieved.transport.type === 'http') {
        expect(retrieved.transport.url).toBe('https://mcp.example.com')
        expect(retrieved.transport.headers).toEqual({ Authorization: 'Bearer token' })
      }
    })
  })

  // =========================================================================
  // getServerCapabilities & getServerInfo
  // =========================================================================

  describe('getServerCapabilities', () => {
    it('should return null before connect', () => {
      const client = new MCPClient(makeConfig())
      expect(client.getServerCapabilities()).toBeNull()
    })
  })

  describe('getServerInfo', () => {
    it('should return null before connect', () => {
      const client = new MCPClient(makeConfig())
      expect(client.getServerInfo()).toBeNull()
    })
  })

  // =========================================================================
  // EventEmitter behavior
  // =========================================================================

  describe('event emitter', () => {
    it('should be an event emitter (has on/emit)', () => {
      const client = new MCPClient(makeConfig())
      expect(typeof client.on).toBe('function')
      expect(typeof client.emit).toBe('function')
      expect(typeof client.removeListener).toBe('function')
    })
  })

  // =========================================================================
  // listTools / callTool when disconnected
  // =========================================================================

  describe('listTools when disconnected', () => {
    it('should throw when not connected and autoReconnect is false', async () => {
      const client = new MCPClient(makeConfig({ autoReconnect: false }))
      await expect(client.listTools()).rejects.toThrow('not connected')
    })
  })

  describe('callTool when disconnected', () => {
    it('should throw when not connected and autoReconnect is false', async () => {
      const client = new MCPClient(makeConfig({ autoReconnect: false }))
      await expect(client.callTool('anything', {})).rejects.toThrow('not connected')
    })
  })
})

// ===========================================================================
// createMCPClient factory
// ===========================================================================

describe('createMCPClient', () => {
  it('should return an MCPClient instance', () => {
    const client = createMCPClient(makeConfig())
    expect(client).toBeInstanceOf(MCPClient)
  })

  it('should pass config through to the client', () => {
    const client = createMCPClient(makeConfig({ id: 'factory-test', name: 'Factory' }))
    const config = client.getConfig()
    expect(config.id).toBe('factory-test')
    expect(config.name).toBe('Factory')
  })
})
