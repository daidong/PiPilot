import { describe, expect, it } from 'vitest'

import { RESEARCH_PILOT_KERNEL_V2_CONFIG } from '../../../examples/research-pilot/config/kernel-v2.js'

describe('Research Pilot kernel config', () => {
  it('runs with minimal profile', () => {
    expect(RESEARCH_PILOT_KERNEL_V2_CONFIG.enabled).toBe(true)
    expect(RESEARCH_PILOT_KERNEL_V2_CONFIG.profile).toBe('minimal')
  })
})
