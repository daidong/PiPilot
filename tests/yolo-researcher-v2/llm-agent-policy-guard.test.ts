import { describe, expect, it } from 'vitest'

import {
  detectDestructivePolicyBlockedBash,
  detectLiteratureSearchUsage
} from '../../examples/yolo-researcher/v2/llm-agent.js'
import type { ToolEventRecord } from '../../examples/yolo-researcher/v2/types.js'

describe('yolo-researcher v2 llm-agent destructive policy guard', () => {
  it('detects bash rm -rf blocked by policy', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'bash',
        input: {
          command: 'mkdir -p workspace/external && rm -rf workspace/external/openevolve && git clone --depth 1 https://github.com/x/y workspace/external/openevolve'
        }
      },
      {
        timestamp: new Date().toISOString(),
        phase: 'result',
        tool: 'bash',
        success: false,
        result: {
          success: false,
          error: 'Repo cloning via bash was blocked by a no-destructive policy (rm -rf)'
        }
      }
    ]

    const blocked = detectDestructivePolicyBlockedBash(events)
    expect(blocked).not.toBeNull()
    expect(blocked?.command).toContain('rm -rf')
    expect(blocked?.errorLine.toLowerCase()).toContain('blocked')
  })

  it('does not flag non-destructive bash failures', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'bash',
        input: {
          command: 'git clone --depth 1 https://github.com/x/y workspace/external/openevolve'
        }
      },
      {
        timestamp: new Date().toISOString(),
        phase: 'result',
        tool: 'bash',
        success: false,
        result: {
          success: false,
          error: '/bin/sh: git: command not found'
        }
      }
    ]

    expect(detectDestructivePolicyBlockedBash(events)).toBeNull()
  })

  it('detects blocked rm -rf when command is only present in result args', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'result',
        tool: 'bash',
        input: {
          command: 'rm -rf tmp/repo && git clone --depth 1 https://github.com/x/y tmp/repo'
        },
        success: false,
        error: 'blocked by policy: destructive command'
      }
    ]

    const blocked = detectDestructivePolicyBlockedBash(events)
    expect(blocked).not.toBeNull()
    expect(blocked?.command).toContain('rm -rf')
  })

  it('detects full sweep through skill-script-run', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'skill-script-run',
        input: {
          skillId: 'literature-search',
          script: 'search-sweep'
        }
      }
    ]

    const usage = detectLiteratureSearchUsage(events)
    expect(usage.invoked).toBe(true)
    expect(usage.fullMode).toBe(true)
    expect(usage.via).toBe('skill-script-run')
  })

  it('flags quick script-based literature search as non-full', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'skill-script-run',
        input: {
          skillId: 'literature-search',
          script: 'search-papers'
        }
      }
    ]

    const usage = detectLiteratureSearchUsage(events)
    expect(usage.invoked).toBe(true)
    expect(usage.fullMode).toBe(false)
    expect(usage.via).toBe('skill-script-run')
  })

  it('detects successful full sweep through literature-search wrapper tool', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'literature-search',
        input: {
          query: 'AlphaEvolve optimization',
          mode: 'sweep'
        }
      },
      {
        timestamp: new Date().toISOString(),
        phase: 'result',
        tool: 'literature-search',
        success: true,
        result: {
          success: true,
          data: {
            mode: 'sweep',
            script: 'search-sweep',
            paperCount: 30,
            jsonPath: 'runs/turn-0001/artifacts/literature/sweep-1.json',
            markdownPath: 'runs/turn-0001/artifacts/literature/sweep-1.md'
          }
        }
      }
    ]

    const usage = detectLiteratureSearchUsage(events)
    expect(usage.invoked).toBe(true)
    expect(usage.fullMode).toBe(true)
    expect(usage.fullModeSuccess).toBe(true)
    expect(usage.via).toBe('literature-search')
  })

  it('detects successful standard literature-study as full bootstrap', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'literature-study',
        input: {
          query: 'AlphaEvolve optimization',
          mode: 'standard'
        }
      },
      {
        timestamp: new Date().toISOString(),
        phase: 'result',
        tool: 'literature-study',
        success: true,
        result: {
          success: true,
          data: {
            mode: 'standard',
            reviewPath: 'runs/turn-0001/artifacts/literature-study/review.md',
            paperListPath: 'runs/turn-0001/artifacts/literature-study/papers.json'
          }
        }
      }
    ]

    const usage = detectLiteratureSearchUsage(events)
    expect(usage.invoked).toBe(true)
    expect(usage.fullMode).toBe(true)
    expect(usage.fullModeSuccess).toBe(true)
    expect(usage.via).toBe('literature-study')
  })

  it('treats failed full sweep as unsatisfied bootstrap', () => {
    const events: ToolEventRecord[] = [
      {
        timestamp: new Date().toISOString(),
        phase: 'call',
        tool: 'skill-script-run',
        input: {
          skillId: 'literature-search',
          script: 'search-sweep',
          args: ['--query', 'alpha', '--out-dir', 'runs/turn-0001/artifacts/lit']
        }
      },
      {
        timestamp: new Date().toISOString(),
        phase: 'result',
        tool: 'skill-script-run',
        input: {
          skillId: 'literature-search',
          script: 'search-sweep'
        },
        success: false,
        result: {
          success: false,
          error: 'Script exited with code 2',
          data: {
            stderr: 'search-sweep.py: error: unrecognized arguments: --out-dir runs/turn-0001/artifacts/lit'
          }
        }
      }
    ]

    const usage = detectLiteratureSearchUsage(events)
    expect(usage.invoked).toBe(true)
    expect(usage.fullMode).toBe(true)
    expect(usage.fullModeSuccess).toBe(false)
    expect(usage.argError).toBe(true)
    expect(usage.lastError).toContain('Script exited with code 2')
  })

})
