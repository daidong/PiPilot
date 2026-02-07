import { describe, it, expect } from 'vitest'
import { calculateCost } from '../../src/llm/cost-calculator.js'
import { registerModel } from '../../src/llm/models.js'
import type { DetailedTokenUsage, ModelConfig } from '../../src/llm/provider.types.js'

describe('cost-calculator', () => {
  it('uses model-level cached input pricing when available', () => {
    const usage: DetailedTokenUsage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cacheReadInputTokens: 100
    }

    const cost = calculateCost('gpt-5.2', usage)

    // gpt-5.2 pricing:
    // input: $1.75 / 1M, cached input: $0.175 / 1M, output: $14 / 1M
    expect(cost.promptCost).toBeCloseTo(0.001575, 10)
    expect(cost.cachedReadCost).toBeCloseTo(0.0000175, 10)
    expect(cost.completionCost).toBeCloseTo(0.007, 10)
    expect(cost.totalCost).toBeCloseTo(0.0085925, 10)
  })

  it('falls back to provider discount when model cached input pricing is not defined', () => {
    const model: ModelConfig = {
      id: 'unit-openai-no-cached-price',
      name: 'Unit OpenAI No Cached Price',
      providerID: 'openai',
      api: 'chat',
      capabilities: {
        temperature: true,
        reasoning: false,
        toolcall: true,
        input: ['text'],
        output: ['text']
      },
      cost: { input: 2, output: 4 },
      limit: { maxContext: 16000, maxOutput: 2000 }
    }
    registerModel(model)

    const usage: DetailedTokenUsage = {
      promptTokens: 1000,
      completionTokens: 0,
      totalTokens: 1000,
      cacheReadInputTokens: 100
    }

    const cost = calculateCost(model.id, usage)

    // OpenAI fallback cached discount = 0.5 -> cached input price = $1.00 / 1M
    expect(cost.promptCost).toBeCloseTo(0.0018, 10)
    expect(cost.cachedReadCost).toBeCloseTo(0.0001, 10)
    expect(cost.totalCost).toBeCloseTo(0.0019, 10)
  })
})

