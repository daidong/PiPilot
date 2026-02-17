import { describe, expect, it } from 'vitest'

import { __private } from '../../examples/yolo-researcher/agents/coordinator.js'

const { normalizeAssets } = __private

describe('coordinator lean asset normalization', () => {
  it('preserves RunRecord and EvidenceLink asset types in lean_v2 mode', () => {
    const normalized = normalizeAssets([
      {
        type: 'RunRecord',
        payload: { runKey: 'rk-1' }
      },
      {
        type: 'EvidenceLink',
        payload: { evidenceId: 'RunRecord-t001-a1-001', claimId: 'Claim-t001-a1-001' }
      }
    ], 'lean_v2')

    expect(normalized).toHaveLength(2)
    expect(normalized[0]?.type).toBe('RunRecord')
    expect(normalized[1]?.type).toBe('EvidenceLink')
  })

  it('still normalizes unknown lean asset types to Note', () => {
    const normalized = normalizeAssets([
      {
        type: 'CustomArtifact',
        payload: { message: 'hello' }
      }
    ], 'lean_v2')

    expect(normalized).toHaveLength(1)
    expect(normalized[0]?.type).toBe('Note')
  })
})
