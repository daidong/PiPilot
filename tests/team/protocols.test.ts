/**
 * Protocol Templates Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  pipeline,
  fanOutFanIn,
  supervisorProtocol,
  criticRefineLoop,
  debate,
  voting,
  raceProtocol,
  gatedPipeline,
  ProtocolRegistry,
  createProtocolRegistry
} from '../../src/team/protocols/templates.js'

describe('Protocol Templates', () => {
  describe('pipeline', () => {
    it('should create sequential flow for stages', () => {
      const flow = pipeline.build({
        agents: { stages: ['agent1', 'agent2', 'agent3'] }
      })

      expect(flow.kind).toBe('seq')
      expect((flow as any).steps.length).toBe(3)
    })

    it('should create single invoke for one stage', () => {
      const flow = pipeline.build({
        agents: { stages: ['agent1'] }
      })

      expect(flow.kind).toBe('invoke')
    })

    it('should throw for empty stages', () => {
      expect(() => pipeline.build({
        agents: { stages: [] }
      })).toThrow()
    })

    it('should throw for missing stages', () => {
      expect(() => pipeline.build({
        agents: {}
      })).toThrow()
    })
  })

  describe('fanOutFanIn', () => {
    it('should create parallel flow with merge', () => {
      const flow = fanOutFanIn.build({
        agents: { workers: ['worker1', 'worker2', 'worker3'] }
      })

      expect(flow.kind).toBe('par')
      expect((flow as any).branches.length).toBe(3)
      expect((flow as any).join.reducerId).toBe('merge')
    })

    it('should use custom reducer', () => {
      const flow = fanOutFanIn.build({
        agents: { workers: ['w1', 'w2'] },
        options: { reducer: 'collect' }
      })

      expect((flow as any).join.reducerId).toBe('collect')
    })
  })

  describe('supervisorProtocol', () => {
    it('should create supervise flow', () => {
      const flow = supervisorProtocol.build({
        agents: {
          supervisor: 'manager',
          workers: ['dev1', 'dev2']
        }
      })

      expect(flow.kind).toBe('supervise')
      expect((flow as any).supervisor.agent).toBe('manager')
    })

    it('should support sequential strategy', () => {
      const flow = supervisorProtocol.build({
        agents: {
          supervisor: 'manager',
          workers: ['dev1', 'dev2']
        },
        options: { strategy: 'sequential' }
      })

      expect(flow.kind).toBe('supervise')
      expect((flow as any).strategy).toBe('sequential')
    })
  })

  describe('criticRefineLoop', () => {
    it('should create loop with producer, critic, refiner', () => {
      const flow = criticRefineLoop.build({
        agents: {
          producer: 'writer',
          critic: 'reviewer',
          refiner: 'editor'
        }
      })

      expect(flow.kind).toBe('seq')
      const steps = (flow as any).steps
      expect(steps.length).toBe(2) // producer + loop
      expect(steps[1].kind).toBe('loop')
    })

    it('should use custom maxIterations', () => {
      const flow = criticRefineLoop.build({
        agents: {
          producer: 'writer',
          critic: 'reviewer',
          refiner: 'editor'
        },
        options: { maxIterations: 5 }
      })

      const loopStep = (flow as any).steps[1]
      expect(loopStep.maxIters).toBe(5)
    })
  })

  describe('debate', () => {
    it('should create parallel debaters + judge', () => {
      const flow = debate.build({
        agents: {
          debaters: ['pro', 'con'],
          judge: 'arbitrator'
        }
      })

      expect(flow.kind).toBe('seq')
      const steps = (flow as any).steps
      expect(steps[0].kind).toBe('par') // debaters
      expect(steps[1].kind).toBe('invoke') // judge
    })

    it('should throw for less than 2 debaters', () => {
      expect(() => debate.build({
        agents: {
          debaters: ['only-one'],
          judge: 'arbitrator'
        }
      })).toThrow()
    })
  })

  describe('voting', () => {
    it('should create parallel voters with vote reducer', () => {
      const flow = voting.build({
        agents: { voters: ['expert1', 'expert2', 'expert3'] }
      })

      expect(flow.kind).toBe('par')
      expect((flow as any).join.reducerId).toBe('vote')
    })

    it('should throw for less than 2 voters', () => {
      expect(() => voting.build({
        agents: { voters: ['only-one'] }
      })).toThrow()
    })
  })

  describe('raceProtocol', () => {
    it('should create race flow', () => {
      const flow = raceProtocol.build({
        agents: { racers: ['fast', 'accurate'] }
      })

      expect(flow.kind).toBe('race')
      expect((flow as any).contenders.length).toBe(2)
      expect((flow as any).winner.type).toBe('firstSuccess')
    })
  })

  describe('gatedPipeline', () => {
    it('should create pipeline with gates', () => {
      const flow = gatedPipeline.build({
        agents: {
          stages: ['stage1', 'stage2', 'stage3'],
          validators: ['validator1']
        }
      })

      expect(flow.kind).toBe('seq')
    })

    it('should work without validators', () => {
      const flow = gatedPipeline.build({
        agents: {
          stages: ['stage1', 'stage2']
        }
      })

      expect(flow.kind).toBe('seq')
    })
  })
})

describe('ProtocolRegistry', () => {
  let registry: ProtocolRegistry

  beforeEach(() => {
    registry = createProtocolRegistry()
  })

  it('should register built-in protocols', () => {
    expect(registry.has('pipeline')).toBe(true)
    expect(registry.has('fan-out-fan-in')).toBe(true)
    expect(registry.has('supervisor')).toBe(true)
    expect(registry.has('critic-refine-loop')).toBe(true)
    expect(registry.has('debate')).toBe(true)
    expect(registry.has('voting')).toBe(true)
    expect(registry.has('race')).toBe(true)
    expect(registry.has('gated-pipeline')).toBe(true)
  })

  it('should list all protocol IDs', () => {
    const ids = registry.list()

    expect(ids).toContain('pipeline')
    expect(ids).toContain('supervisor')
    expect(ids.length).toBeGreaterThanOrEqual(8)
  })

  it('should get protocol by ID', () => {
    const protocol = registry.get('pipeline')

    expect(protocol).toBeDefined()
    expect(protocol?.id).toBe('pipeline')
  })

  it('should build flow from protocol ID', () => {
    const flow = registry.build('pipeline', {
      agents: { stages: ['a', 'b', 'c'] }
    })

    expect(flow.kind).toBe('seq')
  })

  it('should throw for unknown protocol', () => {
    expect(() => registry.build('unknown', { agents: {} })).toThrow('Protocol not found')
  })

  it('should throw for missing required role', () => {
    expect(() => registry.build('pipeline', { agents: {} })).toThrow('requires agent for role')
  })

  it('should throw on duplicate registration', () => {
    expect(() => registry.register(pipeline)).toThrow('already registered')
  })

  it('should allow custom protocol registration', () => {
    registry.register({
      id: 'custom',
      name: 'Custom Protocol',
      description: 'A custom protocol',
      requiredRoles: ['agent'],
      build: (config) => ({
        kind: 'invoke',
        agent: config.agents['agent'] as string,
        input: { ref: 'initial' }
      })
    })

    expect(registry.has('custom')).toBe(true)

    const flow = registry.build('custom', { agents: { agent: 'my-agent' } })
    expect(flow.kind).toBe('invoke')
  })
})
