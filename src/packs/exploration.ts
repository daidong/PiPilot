/**
 * exploration - Code Exploration Guide Pack
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { defineGuardPolicy, defineApprovalPolicy } from '../factories/define-policy.js'

/**
 * Suggest exploration before modification policy
 */
const exploreBeforeModify = defineApprovalPolicy({
  id: 'explore-before-modify',
  description: 'Suggest exploring project structure before making modifications',
  priority: 50,
  match: (ctx) => {
    // Check if session has explored
    const hasExplored = ctx.sessionId && (ctx as unknown as { sessionState?: { get: (k: string) => boolean } })
      .sessionState?.get?.('hasExplored')

    return ['edit', 'write'].includes(ctx.tool) && !hasExplored
  },
  message: 'Consider exploring the project structure first with glob("**/*"). Proceed with modification anyway?'
})

/**
 * Discourage bash for exploration policy
 */
const noBashExplore = defineGuardPolicy({
  id: 'no-bash-explore',
  description: 'Discourage using bash for code exploration',
  priority: 30,
  match: (ctx) => {
    if (ctx.tool !== 'bash') return false

    const cmd = (ctx.input as { command?: string })?.command ?? ''
    return /\b(ls|find|tree|grep|rg|cat|head|tail)\b/.test(cmd)
  },
  decide: (ctx) => {
    const cmd = (ctx.input as { command?: string })?.command ?? ''

    // Build alternative suggestion
    let suggestion = ''
    if (/\bls\b/.test(cmd) || /\btree\b/.test(cmd) || /\bfind\b/.test(cmd)) {
      suggestion = 'glob("**/*")'
    } else if (/\bgrep\b|\brg\b/.test(cmd)) {
      suggestion = 'grep({ pattern: "...", path: "." })'
    } else if (/\bcat\b|\bhead\b|\btail\b/.test(cmd)) {
      suggestion = 'read({ path: "..." })'
    }

    return {
      action: 'deny',
      reason: `Please use ${suggestion || 'dedicated tools (glob, grep, read)'} instead of bash commands`
    }
  }
})

/**
 * Exploration Guide Pack
 */
export function exploration(): Pack {
  return definePack({
    id: 'exploration',
    description: 'Code exploration guidance and policies',

    policies: [
      exploreBeforeModify,
      noBashExplore
    ],

    promptFragment: `
## Code Exploration Guide

### Exploration Tools
Use dedicated tools for exploring codebases:

| Need | Use Tool | Don't Use |
|------|----------|-----------|
| List project structure | glob("**/*") | ls, tree, find |
| Search code | grep({ pattern: "...", path: "." }) | grep, rg |
| Read file content | read({ path: "..." }) | cat, head, tail |

### Exploration Workflow
1. Use \`glob("**/*")\` to understand project structure
2. Use \`grep({ pattern: "...", path: "." })\` to find relevant code
3. Use \`read({ path: "..." })\` to read specific files
4. Understand the code before making modifications

### Context Sources
For session history and memory:
- \`ctx.get("session.messages")\` - Recent conversation
- \`ctx.get("session.trace")\` - Operation trace
- \`ctx.get("ctx.catalog")\` - List all available context sources

### Best Practices
1. Explore before modifying unfamiliar code
2. Use glob to find files by pattern
3. Use grep to search for specific patterns
4. Read files to understand implementation details
5. When asked to read/review a specific file, read it directly — do NOT glob or grep first
6. Only use grep when you need to FIND something whose location is unknown
7. If a read result is truncated, re-read with offset/limit — never use grep to recover truncated content
    `.trim()
  })
}
