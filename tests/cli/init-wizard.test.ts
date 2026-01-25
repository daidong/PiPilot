/**
 * InitWizard 测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the LLM client creation
const mockCreateLLMClient = vi.fn(() => ({
  generate: vi.fn()
}))

const mockDetectProvider = vi.fn((key: string) => {
  if (key.startsWith('sk-ant')) return 'anthropic'
  if (key.startsWith('sk-')) return 'openai'
  return null
})

vi.mock('../../src/llm/index.js', () => ({
  createLLMClient: mockCreateLLMClient,
  detectProviderFromApiKey: mockDetectProvider
}))

describe('InitWizard API Key Resolution', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    // Clear mock call history
    mockCreateLLMClient.mockClear()
    mockDetectProvider.mockClear()
    process.env = { ...originalEnv }
    // Clear relevant env vars
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should prioritize explicit apiKey parameter', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key'

    const { InitWizard } = await import('../../src/cli/init-wizard.js')

    new InitWizard('explicit-key')

    expect(mockCreateLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { apiKey: 'explicit-key' }
      })
    )
  })

  it('should use OPENAI_API_KEY from environment when no explicit key', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key'

    const { InitWizard } = await import('../../src/cli/init-wizard.js')

    new InitWizard()

    expect(mockCreateLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { apiKey: 'env-openai-key' }
      })
    )
  })

  it('should use ANTHROPIC_API_KEY when OPENAI_API_KEY is not set', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key'

    const { InitWizard } = await import('../../src/cli/init-wizard.js')

    new InitWizard()

    expect(mockCreateLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { apiKey: 'env-anthropic-key' }
      })
    )
  })

  it('should prefer OPENAI_API_KEY over ANTHROPIC_API_KEY', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key'
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key'

    const { InitWizard } = await import('../../src/cli/init-wizard.js')

    new InitWizard()

    expect(mockCreateLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { apiKey: 'env-openai-key' }
      })
    )
  })

  it('should not create LLM client when no key is available', async () => {
    const { InitWizard } = await import('../../src/cli/init-wizard.js')

    new InitWizard()

    expect(mockCreateLLMClient).not.toHaveBeenCalled()
  })
})
