/**
 * Tests for MCP Tool Adapter
 *
 * Covers: adaptMCPTool, adaptMCPTools, convertJsonSchemaToParameters, validateToolInput
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  adaptMCPTool,
  adaptMCPTools,
  convertJsonSchemaToParameters,
  validateToolInput
} from '../../src/mcp/tool-adapter.js'
import type { MCPToolDefinition, MCPInputSchema } from '../../src/mcp/types.js'
import type { MCPClient } from '../../src/mcp/client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMCPTool(overrides: Partial<MCPToolDefinition> = {}): MCPToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    },
    ...overrides
  }
}

function makeMockClient(callToolResult?: unknown) {
  return {
    callTool: vi.fn().mockResolvedValue(
      callToolResult ?? {
        content: [{ type: 'text', text: 'result' }],
        isError: false
      }
    )
  } as unknown as MCPClient
}

// ===========================================================================
// convertJsonSchemaToParameters
// ===========================================================================

describe('convertJsonSchemaToParameters', () => {
  it('should return empty object for schema with no properties', () => {
    const schema: MCPInputSchema = { type: 'object' }
    expect(convertJsonSchemaToParameters(schema)).toEqual({})
  })

  it('should return empty object for schema with empty properties', () => {
    const schema: MCPInputSchema = { type: 'object', properties: {} }
    expect(convertJsonSchemaToParameters(schema)).toEqual({})
  })

  it('should convert a simple string property', () => {
    const schema: MCPInputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'User name' }
      }
    }
    const params = convertJsonSchemaToParameters(schema)
    expect(params.name).toEqual({
      type: 'string',
      description: 'User name',
      required: false
    })
  })

  it('should mark required fields', () => {
    const schema: MCPInputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'User name' },
        age: { type: 'number', description: 'User age' }
      },
      required: ['name']
    }
    const params = convertJsonSchemaToParameters(schema)
    expect(params.name.required).toBe(true)
    expect(params.age.required).toBe(false)
  })

  it('should handle default values', () => {
    const schema: MCPInputSchema = {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max results', default: 10 }
      }
    }
    const params = convertJsonSchemaToParameters(schema)
    expect(params.limit.default).toBe(10)
    expect(params.limit.type).toBe('number') // integer maps to number
  })

  it('should handle enum values', () => {
    const schema: MCPInputSchema = {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: 'Output format',
          enum: ['json', 'csv', 'xml']
        }
      }
    }
    const params = convertJsonSchemaToParameters(schema)
    expect(params.format.enum).toEqual(['json', 'csv', 'xml'])
  })

  it('should not include default key when not present in schema', () => {
    const schema: MCPInputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' }
      }
    }
    const params = convertJsonSchemaToParameters(schema)
    expect('default' in params.name).toBe(false)
  })

  describe('type mapping', () => {
    const cases: Array<{ schemaType: string; expectedType: string }> = [
      { schemaType: 'string', expectedType: 'string' },
      { schemaType: 'number', expectedType: 'number' },
      { schemaType: 'integer', expectedType: 'number' },
      { schemaType: 'boolean', expectedType: 'boolean' },
      { schemaType: 'array', expectedType: 'array' },
      { schemaType: 'object', expectedType: 'object' }
    ]

    for (const { schemaType, expectedType } of cases) {
      it(`should map '${schemaType}' to '${expectedType}'`, () => {
        const schema: MCPInputSchema = {
          type: 'object',
          properties: {
            field: { type: schemaType as any }
          }
        }
        const params = convertJsonSchemaToParameters(schema)
        expect(params.field.type).toBe(expectedType)
      })
    }
  })

  describe('nested objects', () => {
    it('should convert nested object properties', () => {
      const schema: MCPInputSchema = {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            description: 'Configuration',
            properties: {
              host: { type: 'string', description: 'Host' },
              port: { type: 'integer', description: 'Port' }
            },
            required: ['host']
          }
        },
        required: ['config']
      }
      const params = convertJsonSchemaToParameters(schema)
      expect(params.config.type).toBe('object')
      expect(params.config.required).toBe(true)
      expect(params.config.properties).toBeDefined()
      expect(params.config.properties!.host.type).toBe('string')
      expect(params.config.properties!.host.required).toBe(true)
      expect(params.config.properties!.port.type).toBe('number')
      expect(params.config.properties!.port.required).toBe(false)
    })

    it('should handle object without properties (no sub-properties)', () => {
      const schema: MCPInputSchema = {
        type: 'object',
        properties: {
          data: { type: 'object', description: 'Arbitrary data' }
        }
      }
      const params = convertJsonSchemaToParameters(schema)
      expect(params.data.type).toBe('object')
      expect(params.data.properties).toBeUndefined()
    })
  })

  describe('arrays', () => {
    it('should convert array with items schema', () => {
      const schema: MCPInputSchema = {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            description: 'Tags list',
            items: { type: 'string', description: 'A tag' }
          }
        }
      }
      const params = convertJsonSchemaToParameters(schema)
      expect(params.tags.type).toBe('array')
      expect(params.tags.items).toBeDefined()
      expect(params.tags.items!.type).toBe('string')
      expect(params.tags.items!.description).toBe('A tag')
    })

    it('should convert array with object items', () => {
      const schema: MCPInputSchema = {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' }
              },
              required: ['name']
            }
          }
        }
      }
      const params = convertJsonSchemaToParameters(schema)
      expect(params.users.items!.type).toBe('object')
      expect(params.users.items!.properties).toBeDefined()
      expect(params.users.items!.properties!.name.required).toBe(true)
      expect(params.users.items!.properties!.email.required).toBe(false)
    })

    it('should handle array without items schema', () => {
      const schema: MCPInputSchema = {
        type: 'object',
        properties: {
          items: { type: 'array', description: 'A list' }
        }
      }
      const params = convertJsonSchemaToParameters(schema)
      expect(params.items.type).toBe('array')
      expect(params.items.items).toBeUndefined()
    })
  })

  it('should handle multiple properties with mixed types', () => {
    const schema: MCPInputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' }
      },
      required: ['name', 'count']
    }
    const params = convertJsonSchemaToParameters(schema)
    expect(Object.keys(params)).toHaveLength(5)
    expect(params.name.required).toBe(true)
    expect(params.count.required).toBe(true)
    expect(params.active.required).toBe(false)
    expect(params.tags.required).toBe(false)
    expect(params.metadata.required).toBe(false)
  })
})

// ===========================================================================
// validateToolInput
// ===========================================================================

describe('validateToolInput', () => {
  const schema: MCPInputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'integer', description: 'Max results' },
      format: { type: 'string', enum: ['json', 'csv'] },
      verbose: { type: 'boolean' },
      tags: { type: 'array' },
      config: { type: 'object' }
    },
    required: ['query']
  }

  it('should pass for valid input', () => {
    const result = validateToolInput({ query: 'hello' }, schema)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should fail if input is null', () => {
    const result = validateToolInput(null, schema)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Input must be an object')
  })

  it('should fail if input is a string', () => {
    const result = validateToolInput('hello', schema)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Input must be an object')
  })

  it('should fail if input is undefined', () => {
    const result = validateToolInput(undefined, schema)
    expect(result.valid).toBe(false)
  })

  describe('required field checking', () => {
    it('should report missing required fields', () => {
      const result = validateToolInput({}, schema)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing required field: query')
    })

    it('should report multiple missing required fields', () => {
      const multiReqSchema: MCPInputSchema = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          c: { type: 'string' }
        },
        required: ['a', 'b', 'c']
      }
      const result = validateToolInput({ a: 'x' }, multiReqSchema)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing required field: b')
      expect(result.errors).toContain('Missing required field: c')
      expect(result.errors).toHaveLength(2)
    })

    it('should pass when all required fields are present', () => {
      const result = validateToolInput(
        { query: 'test', limit: 5 },
        schema
      )
      expect(result.valid).toBe(true)
    })
  })

  describe('type checking', () => {
    it('should reject number when string expected', () => {
      const result = validateToolInput({ query: 123 }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Field 'query'") && e.includes('expected string'))).toBe(true)
    })

    it('should reject string when number expected', () => {
      const result = validateToolInput({ query: 'ok', limit: 'ten' }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Field 'limit'") && e.includes('expected number'))).toBe(true)
    })

    it('should reject non-integer when integer expected', () => {
      const result = validateToolInput({ query: 'ok', limit: 1.5 }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('expected integer'))).toBe(true)
    })

    it('should accept integer when integer expected', () => {
      const result = validateToolInput({ query: 'ok', limit: 10 }, schema)
      expect(result.valid).toBe(true)
    })

    it('should reject string when boolean expected', () => {
      const result = validateToolInput({ query: 'ok', verbose: 'yes' }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Field 'verbose'") && e.includes('expected boolean'))).toBe(true)
    })

    it('should reject string when array expected', () => {
      const result = validateToolInput({ query: 'ok', tags: 'a,b,c' }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Field 'tags'") && e.includes('expected array'))).toBe(true)
    })

    it('should accept array when array expected', () => {
      const result = validateToolInput({ query: 'ok', tags: ['a', 'b'] }, schema)
      expect(result.valid).toBe(true)
    })

    it('should reject array when object expected', () => {
      const result = validateToolInput({ query: 'ok', config: [1, 2] }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Field 'config'") && e.includes('expected object'))).toBe(true)
    })

    it('should accept object when object expected', () => {
      const result = validateToolInput({ query: 'ok', config: { a: 1 } }, schema)
      expect(result.valid).toBe(true)
    })
  })

  describe('enum checking', () => {
    it('should accept valid enum value', () => {
      const result = validateToolInput({ query: 'ok', format: 'json' }, schema)
      expect(result.valid).toBe(true)
    })

    it('should reject invalid enum value', () => {
      const result = validateToolInput({ query: 'ok', format: 'yaml' }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('must be one of'))).toBe(true)
    })
  })

  it('should collect multiple errors', () => {
    const result = validateToolInput(
      { limit: 'not-a-number', verbose: 42 },
      schema
    )
    expect(result.valid).toBe(false)
    // Missing required + two type errors
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('should not report errors for unknown fields', () => {
    const result = validateToolInput(
      { query: 'ok', extraField: 'whatever' },
      schema
    )
    expect(result.valid).toBe(true)
  })

  it('should handle schema with no properties', () => {
    const emptySchema: MCPInputSchema = { type: 'object' }
    const result = validateToolInput({ anything: 'ok' }, emptySchema)
    expect(result.valid).toBe(true)
  })

  it('should handle schema with no required array', () => {
    const noReqSchema: MCPInputSchema = {
      type: 'object',
      properties: { name: { type: 'string' } }
    }
    const result = validateToolInput({}, noReqSchema)
    expect(result.valid).toBe(true)
  })
})

// ===========================================================================
// adaptMCPTool
// ===========================================================================

describe('adaptMCPTool', () => {
  let mockClient: MCPClient

  beforeEach(() => {
    mockClient = makeMockClient()
  })

  it('should convert tool name directly without prefix', () => {
    const mcpTool = makeMCPTool({ name: 'search' })
    const tool = adaptMCPTool(mcpTool, mockClient)
    expect(tool.name).toBe('search')
  })

  it('should apply prefix with underscore separator', () => {
    const mcpTool = makeMCPTool({ name: 'search' })
    const tool = adaptMCPTool(mcpTool, mockClient, { prefix: 'github' })
    expect(tool.name).toBe('github_search')
  })

  it('should use MCP tool description', () => {
    const mcpTool = makeMCPTool({ description: 'Searches the web' })
    const tool = adaptMCPTool(mcpTool, mockClient)
    expect(tool.description).toContain('Searches the web')
  })

  it('should generate fallback description when none provided', () => {
    const mcpTool = makeMCPTool({ name: 'my-tool', description: undefined })
    const tool = adaptMCPTool(mcpTool, mockClient)
    expect(tool.description).toContain('MCP tool: my-tool')
  })

  it('should prepend source name when includeSource and sourceName set', () => {
    const mcpTool = makeMCPTool({ description: 'Does stuff' })
    const tool = adaptMCPTool(mcpTool, mockClient, {
      includeSource: true,
      sourceName: 'GitHub'
    })
    expect(tool.description).toBe('[GitHub] Does stuff')
  })

  it('should not prepend source when includeSource is false', () => {
    const mcpTool = makeMCPTool({ description: 'Does stuff' })
    const tool = adaptMCPTool(mcpTool, mockClient, {
      includeSource: false,
      sourceName: 'GitHub'
    })
    expect(tool.description).toBe('Does stuff')
  })

  it('should not prepend source when sourceName is not provided', () => {
    const mcpTool = makeMCPTool({ description: 'Does stuff' })
    const tool = adaptMCPTool(mcpTool, mockClient, { includeSource: true })
    expect(tool.description).toBe('Does stuff')
  })

  it('should convert parameters from inputSchema', () => {
    const mcpTool = makeMCPTool({
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Query' }
        },
        required: ['q']
      }
    })
    const tool = adaptMCPTool(mcpTool, mockClient)
    expect(tool.parameters.q).toBeDefined()
    expect(tool.parameters.q.type).toBe('string')
    expect(tool.parameters.q.required).toBe(true)
  })

  describe('execute', () => {
    it('should call the MCP client with the original tool name', async () => {
      const mcpTool = makeMCPTool({ name: 'search' })
      const tool = adaptMCPTool(mcpTool, mockClient, { prefix: 'gh' })

      await tool.execute({ query: 'test' }, undefined as any)

      expect((mockClient.callTool as any)).toHaveBeenCalledWith(
        'search', // original name, not prefixed
        expect.any(Object)
      )
    })

    it('should return success result with text data', async () => {
      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, mockClient)

      const result = await tool.execute({ query: 'test' }, undefined as any)

      expect(result.success).toBe(true)
      expect(result.data?.text).toBe('result')
      expect(result.data?.contents).toHaveLength(1)
    })

    it('should return error result when MCP returns isError', async () => {
      const client = makeMockClient({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true
      })
      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, client)

      const result = await tool.execute({ query: 'bad' }, undefined as any)

      expect(result.success).toBe(false)
      expect(result.error).toBe('something went wrong')
    })

    it('should return error result when client throws', async () => {
      const client = {
        callTool: vi.fn().mockRejectedValue(new Error('Connection lost'))
      } as unknown as MCPClient
      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, client)

      const result = await tool.execute({ query: 'test' }, undefined as any)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection lost')
    })

    it('should timeout when execution exceeds timeout', async () => {
      const slowClient = {
        callTool: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 5000))
        )
      } as unknown as MCPClient

      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, slowClient, { timeout: 50 })

      const result = await tool.execute({ query: 'test' }, undefined as any)

      expect(result.success).toBe(false)
      expect(result.error).toContain('timeout')
    }, 10000)

    it('should concatenate multiple text content blocks', async () => {
      const client = makeMockClient({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' }
        ],
        isError: false
      })
      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, client)

      const result = await tool.execute({ query: 'test' }, undefined as any)

      expect(result.data?.text).toBe('line 1\nline 2')
    })

    it('should include non-text content in contents array', async () => {
      const client = makeMockClient({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'base64...', mimeType: 'image/png' }
        ],
        isError: false
      })
      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, client)

      const result = await tool.execute({ query: 'test' }, undefined as any)

      expect(result.data?.contents).toHaveLength(2)
      expect(result.data?.contents[1].type).toBe('image')
    })

    it('should set text to undefined when there are no text contents', async () => {
      const client = makeMockClient({
        content: [
          { type: 'image', data: 'base64...', mimeType: 'image/png' }
        ],
        isError: false
      })
      const mcpTool = makeMCPTool()
      const tool = adaptMCPTool(mcpTool, client)

      const result = await tool.execute({ query: 'test' }, undefined as any)

      expect(result.data?.text).toBeUndefined()
    })
  })
})

// ===========================================================================
// adaptMCPTools
// ===========================================================================

describe('adaptMCPTools', () => {
  it('should convert an array of MCP tools', () => {
    const tools = [
      makeMCPTool({ name: 'tool-a' }),
      makeMCPTool({ name: 'tool-b' }),
      makeMCPTool({ name: 'tool-c' })
    ]
    const client = makeMockClient()
    const adapted = adaptMCPTools(tools, client)

    expect(adapted).toHaveLength(3)
    expect(adapted[0].name).toBe('tool-a')
    expect(adapted[1].name).toBe('tool-b')
    expect(adapted[2].name).toBe('tool-c')
  })

  it('should apply options to all tools', () => {
    const tools = [
      makeMCPTool({ name: 'search' }),
      makeMCPTool({ name: 'read' })
    ]
    const client = makeMockClient()
    const adapted = adaptMCPTools(tools, client, { prefix: 'mcp' })

    expect(adapted[0].name).toBe('mcp_search')
    expect(adapted[1].name).toBe('mcp_read')
  })

  it('should return empty array for empty input', () => {
    const client = makeMockClient()
    const adapted = adaptMCPTools([], client)
    expect(adapted).toEqual([])
  })
})
