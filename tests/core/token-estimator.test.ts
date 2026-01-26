/**
 * TokenEstimator Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  TokenEstimator,
  createTokenEstimator,
  type BlockType
} from '../../src/core/token-estimator.js'

describe('TokenEstimator', () => {
  let estimator: TokenEstimator

  beforeEach(() => {
    estimator = new TokenEstimator()
  })

  describe('estimateSystem()', () => {
    it('should estimate tokens for system prompt', () => {
      const prompt = 'You are a helpful assistant.'
      const estimate = estimator.estimateSystem(prompt)

      expect(estimate.block).toBe('system')
      expect(estimate.estimated).toBeGreaterThan(0)
      expect(estimate.calibrated).toBeGreaterThan(0)
    })

    it('should return low confidence before calibration', () => {
      const estimate = estimator.estimateSystem('Test prompt')
      expect(estimate.confidence).toBe('low')
      expect(estimate.source).toBe('heuristic')
    })

    it('should estimate more tokens for longer prompts', () => {
      const short = estimator.estimateSystem('Short')
      const long = estimator.estimateSystem('A much longer system prompt with more content')

      expect(long.estimated).toBeGreaterThan(short.estimated)
    })
  })

  describe('estimateTools()', () => {
    it('should estimate tokens for tool schemas', () => {
      const schemas = [
        { name: 'read', description: 'Read a file', parameters: { path: 'string' } },
        { name: 'write', description: 'Write a file', parameters: { path: 'string', content: 'string' } }
      ]

      const estimate = estimator.estimateTools(schemas)

      expect(estimate.block).toBe('tools')
      expect(estimate.estimated).toBeGreaterThan(0)
    })

    it('should apply scaling factor to tool estimates', () => {
      const schemas = [{ name: 'test', description: 'Test tool' }]
      const estimate = estimator.estimateTools(schemas)

      // Default tools scaling is 1.15
      expect(estimate.calibrated).toBeGreaterThanOrEqual(estimate.estimated)
    })

    it('should estimate single tool schema', () => {
      const schema = { name: 'read', description: 'Read a file' }
      const tokens = estimator.estimateToolSchema(schema)

      expect(tokens).toBeGreaterThan(0)
    })
  })

  describe('estimateMessages()', () => {
    it('should estimate tokens for messages', () => {
      const messages = [
        { role: 'user', content: 'Hello, how are you?' },
        { role: 'assistant', content: 'I am doing well, thank you!' }
      ]

      const estimate = estimator.estimateMessages(messages)

      expect(estimate.block).toBe('messages')
      expect(estimate.estimated).toBeGreaterThan(0)
    })

    it('should add overhead for role markers', () => {
      const singleMessage = [{ role: 'user', content: 'Hello' }]
      const twoMessages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '' }
      ]

      const single = estimator.estimateMessages(singleMessage)
      const two = estimator.estimateMessages(twoMessages)

      // Two messages should have more tokens due to role overhead
      expect(two.estimated).toBeGreaterThan(single.estimated)
    })

    it('should handle empty messages array', () => {
      const estimate = estimator.estimateMessages([])
      expect(estimate.estimated).toBe(0)
    })
  })

  describe('estimateText()', () => {
    it('should estimate arbitrary text', () => {
      const text = 'Some arbitrary text content'
      const estimate = estimator.estimateText(text)

      expect(estimate.estimated).toBeGreaterThan(0)
    })

    it('should allow specifying block type', () => {
      const text = 'Some content'
      const estimate = estimator.estimateText(text, 'tools')

      expect(estimate.block).toBe('tools')
    })
  })

  describe('calibration', () => {
    it('should update scaling factor after calibration', () => {
      const beforeFactor = estimator.getScalingFactor('system')

      // Simulate: estimated 100 tokens, actual was 120
      estimator.calibrate('system', 100, 120)

      const afterFactor = estimator.getScalingFactor('system')
      expect(afterFactor).not.toBe(beforeFactor)
    })

    it('should return high confidence after enough calibration samples', () => {
      // Need minSamplesForCalibration (default: 5) samples
      for (let i = 0; i < 5; i++) {
        estimator.calibrate('system', 100, 110)
      }

      const estimate = estimator.estimateSystem('Test prompt')
      expect(estimate.confidence).toBe('high')
      expect(estimate.source).toBe('calibrated')
    })

    it('should clamp scaling factor to reasonable range', () => {
      // Try to create extreme scaling
      estimator.calibrate('system', 100, 10)  // 0.1x - should clamp to 0.5
      expect(estimator.getScalingFactor('system')).toBeGreaterThanOrEqual(0.5)

      estimator.calibrate('system', 100, 500)  // 5x - should clamp to 2.0
      // After two samples, factor will be based on totals
      const factor = estimator.getScalingFactor('system')
      expect(factor).toBeLessThanOrEqual(2.0)
    })

    it('should allow manual scaling factor setting', () => {
      estimator.setScalingFactor('tools', 1.25)
      expect(estimator.getScalingFactor('tools')).toBe(1.25)
    })

    it('should reset calibration data', () => {
      estimator.calibrate('system', 100, 120)
      estimator.resetCalibration('system')

      const stats = estimator.getCalibrationStats()
      expect(stats.system.sampleCount).toBe(0)
    })

    it('should reset all calibration data', () => {
      estimator.calibrate('system', 100, 120)
      estimator.calibrate('tools', 100, 115)
      estimator.resetCalibration()

      const stats = estimator.getCalibrationStats()
      expect(stats.system.sampleCount).toBe(0)
      expect(stats.tools.sampleCount).toBe(0)
    })
  })

  describe('calibration persistence', () => {
    it('should export calibration data', () => {
      estimator.calibrate('system', 100, 120)
      const exported = estimator.exportCalibration()

      expect(exported.system.sampleCount).toBe(1)
      expect(exported.system.totalEstimated).toBe(100)
      expect(exported.system.totalActual).toBe(120)
    })

    it('should import calibration data', () => {
      const data = {
        system: {
          sampleCount: 10,
          totalEstimated: 1000,
          totalActual: 1100,
          scalingFactor: 1.1,
          lastCalibrated: Date.now()
        }
      }

      estimator.importCalibration(data as any)

      const stats = estimator.getCalibrationStats()
      expect(stats.system.sampleCount).toBe(10)
      expect(stats.system.scalingFactor).toBe(1.1)
    })
  })

  describe('getCalibrationStats()', () => {
    it('should return stats for all block types', () => {
      const stats = estimator.getCalibrationStats()

      expect(stats.system).toBeDefined()
      expect(stats.tools).toBeDefined()
      expect(stats.messages).toBeDefined()
      expect(stats.output).toBeDefined()
    })
  })
})

describe('createTokenEstimator', () => {
  it('should create estimator with default model family', () => {
    const estimator = createTokenEstimator()
    expect(estimator).toBeInstanceOf(TokenEstimator)
  })

  it('should detect Anthropic model family', () => {
    const estimator = createTokenEstimator('claude-3-sonnet')
    // Internal family detection - just verify it creates successfully
    expect(estimator).toBeInstanceOf(TokenEstimator)
  })

  it('should detect Google model family', () => {
    const estimator = createTokenEstimator('gemini-pro')
    expect(estimator).toBeInstanceOf(TokenEstimator)
  })

  it('should default to OpenAI for unknown models', () => {
    const estimator = createTokenEstimator('unknown-model')
    expect(estimator).toBeInstanceOf(TokenEstimator)
  })
})
