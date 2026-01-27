/**
 * Personal Email Assistant
 *
 * An interactive email assistant demonstrating the Context Assembly Pipeline:
 * - Uses PINNED memory for schema and user feedback (auto-loaded by pinned phase)
 * - First run: discovers schema via describe_table, stores with tags: ['pinned']
 * - Subsequent runs: schema auto-loaded from pinned memory (no describe_table calls)
 * - User corrections (e.g., "internal_date is ms not s") stored as pinned
 *
 * Context Pipeline Features Demonstrated:
 * - Pinned Phase: Auto-loads items with tags: ['pinned']
 * - ctx-expand Tool: Retrieve compressed history on demand
 * - Token Budget: Shows allocation across phases in debug mode
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx examples/personal-email-assistant/index.ts
 *   npx tsx examples/personal-email-assistant/index.ts --debug  # Show token details
 *
 * Optional environment variables:
 *   EMAIL_DB_PATH - Path to SQLite email database
 */

import * as readline from 'node:readline'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  createAgent,
  createStdioMCPProvider,
  packs,
  mergePacks,
  type Agent,
  type Pack
} from '../../src/index.js'

// ============================================================================
// Configuration
// ============================================================================

const IDENTITY = `You are a personal email assistant that helps users manage their inbox efficiently.

## Capabilities
- Read and summarize emails (read-only database access)
- Find specific emails by sender, date, subject
- Analyze attachments (PDF, Word, Excel, images)
- Learn and remember user preferences

## Context Pipeline Integration

This assistant uses the Context Assembly Pipeline for efficient context management:
- **Pinned Context**: Critical information is stored with tags: ["pinned"] and auto-loaded
- **Schema Discovery**: When you discover table schemas, store them as pinned
- **User Corrections**: When user provides corrections, store them as pinned
- **History Compression**: Long conversations are compressed, use ctx-expand to retrieve

## Schema Discovery Workflow

First time running a query on a table:
1. Call sqlite_list_tables to see available tables
2. Call sqlite_describe_table to get column details
3. Store a CONDENSED summary using memory-put with tags: ["pinned"]
4. Future sessions will have this schema auto-loaded (no need to call describe_table again)

**CRITICAL: Store CONDENSED summaries, NOT raw output!**
- The "value" field must be a JSON STRING (not an object) - stringify your data
- Put the human-readable summary in "valueText" (this is what gets displayed)
- DO NOT store the full describe_table output - it's too large and will cause errors

Example storing schema (CONDENSED):
\`\`\`json
{
  "namespace": "project",
  "key": "schema.messages",
  "value": "{\\"table\\": \\"messages\\", \\"columns\\": \\"id, thread_id, sender, subject, internal_date, body\\"}",
  "valueText": "messages table columns: id (PRIMARY KEY), thread_id, sender, subject, internal_date (milliseconds since epoch), body, snippet, label_ids, is_read, is_starred, has_attachments",
  "tags": ["pinned"],
  "overwrite": true
}
\`\`\`

## Learning from User Feedback

When user provides corrections (e.g., "internal_date is in milliseconds, not seconds"):
1. Store the correction using memory-put with tags: ["pinned"]
2. Use key like "feedback.<topic>" or "correction.<topic>"

Example storing correction:
\`\`\`json
{
  "namespace": "project",
  "key": "correction.internal_date_format",
  "value": "{\\"column\\": \\"internal_date\\", \\"unit\\": \\"milliseconds\\"}",
  "valueText": "internal_date is in MILLISECONDS (not seconds). Use internal_date/1000 for epoch seconds.",
  "tags": ["pinned"],
  "overwrite": true
}
\`\`\`

## IMPORTANT: Check Pinned Context First

Before calling sqlite_describe_table:
1. Check the "Pinned Context" section above for existing schema
2. Only call describe_table if the schema is NOT already in pinned context
3. This saves tokens and improves response time`

const CONSTRAINTS = [
  // Pinned memory usage
  'ALWAYS store discovered schemas with memory-put using tags: ["pinned"]',
  'ALWAYS store user corrections/feedback with memory-put using tags: ["pinned"]',
  'CHECK Pinned Context section BEFORE calling sqlite_describe_table',
  'Use key format: "schema.<table_name>" for schemas, "correction.<topic>" for feedback',
  'CRITICAL: Store CONDENSED summaries in memory-put, NOT raw tool output. Keep "value" small, put details in "valueText"',

  // Database query safety
  'Only execute read-only queries on the email database',
  'ALWAYS use LIMIT (e.g., LIMIT 20) to avoid result overflow',
  'NEVER use SELECT * - always select specific columns',

  // Privacy and UX
  'Respect user privacy - never share email content externally',
  'Remember user preferences using memory-put with tags: ["pinned"]'
]

// ============================================================================
// Types
// ============================================================================

export interface PersonalAssistantConfig {
  /** OpenAI API key */
  apiKey: string
  /** Model to use (default: gpt-5.2, can be set via MODEL env var) */
  model?: string
  /** Path to SQLite email database */
  emailDbPath?: string
  /** Project path for memory storage */
  projectPath?: string
  /** Enable debug logging (shows token usage and context planning) */
  debug?: boolean
}

// ============================================================================
// Utilities
// ============================================================================

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

// ============================================================================
// Agent Factory
// ============================================================================

export async function createPersonalAssistant(config: PersonalAssistantConfig): Promise<{
  agent: Agent
  cleanup: () => Promise<void>
}> {
  const {
    apiKey,
    model = 'gpt-5.2',  // GPT-5.2 with SDK 6 (strict mode disabled by default)
    emailDbPath = '~/Library/Application Support/ChatMail/local-email.db',
    projectPath = process.cwd(),
    debug = false
  } = config

  if (!apiKey) {
    throw new Error('API key is required')
  }

  const dbPath = expandPath(emailDbPath)

  if (debug) {
    console.log('[Debug] Configuration:')
    console.log(`  Email DB path: ${dbPath}`)
    console.log(`  Project path: ${projectPath}`)
    console.log(`  Model: ${model}`)
    console.log('')
  }

  // Create MCP provider for SQLite
  const sqliteProvider = createStdioMCPProvider({
    id: 'sqlite',
    name: 'SQLite Email Database',
    command: 'npx',
    args: ['-y', 'mcp-server-sqlite-npx', dbPath],
    toolPrefix: 'sqlite'
  })

  // Connect MCP providers and get packs
  let mcpPacks: Pack[] = []

  // SQLite MCP for email database (read-only)
  try {
    if (debug) {
      console.log('[Debug] Connecting to SQLite MCP server...')
    }
    const sqlitePacks = await sqliteProvider.createPacks()
    mcpPacks.push(...sqlitePacks)
    if (debug) {
      console.log(`[Debug] SQLite MCP connected, got ${sqlitePacks.length} pack(s)`)
    }
  } catch (error) {
    console.error('Warning: Failed to connect to SQLite MCP server:', error)
    console.error('The agent will work without email database access.')
    console.error('Make sure the email database exists at:', dbPath)
  }

  // Documents pack (MarkItDown) for attachment analysis
  try {
    if (debug) {
      console.log('[Debug] Loading documents pack (MarkItDown)...')
    }
    const documentsPack = await packs.documents({ toolPrefix: 'doc' })
    mcpPacks.push(documentsPack)
    if (debug) {
      console.log('[Debug] Documents pack loaded')
    }
  } catch (error) {
    console.error('Warning: Failed to load documents pack:', error)
    console.error('The agent will work without document processing capabilities.')
  }

  // Merge all packs:
  // - safe: basic file operations
  // - kvMemory: provides memory-put, memory-delete tools for storing pinned items
  // - sessionHistory: conversation history viewing
  // - contextPipeline: CRITICAL - enables pinned phase and ctx-expand tool
  // - MCP packs: sqlite, markitdown
  const allPacks = mergePacks(
    packs.safe(),
    packs.kvMemory(),           // Provides memory-put for storing pinned items
    packs.sessionHistory(),     // Provides session.messages, session.trace
    packs.contextPipeline(),    // CRITICAL: Enables pinned phase + ctx-expand tool
    ...mcpPacks
  )

  if (debug) {
    console.log('')
    console.log('[Debug] Context Pipeline Configuration:')
    console.log('  Phases: system (100) → pinned (90) → selected (80) → session (50) → index (30)')
    console.log('  Pinned Budget: 2000 tokens (reserved)')
    console.log('  Session Budget: remaining tokens')
    console.log('  Index Budget: 500 tokens (fixed)')
    console.log('')
    console.log('[Debug] Pinned memory items will be auto-loaded from:')
    console.log(`  ${projectPath}/.agent-foundry/memory/`)
    console.log('')
  }

  // Track tool calls for debug output
  let toolCallCount = 0
  let memoryPutCount = 0
  let describeTableCount = 0

  // Create the agent
  const agent = createAgent({
    apiKey,
    model,
    projectPath,  // Memory stored at .agent-foundry/memory/
    packs: [allPacks],
    identity: IDENTITY,
    constraints: CONSTRAINTS,
    // Note: No initialContext needed - pinned phase auto-loads pinned items!
    skipConfigFile: true,
    // Always stream output for better UX
    onStream: (chunk) => process.stdout.write(chunk),
    onToolCall: (tool, input) => {
      toolCallCount++

      if (debug) {
        console.log(`\n[Tool ${toolCallCount}] ${tool}`)
        if (tool === 'memory-put') {
          memoryPutCount++
          const tags = (input as any)?.tags || []
          const isPinned = tags.includes('pinned')
          console.log(`  Key: ${(input as any)?.namespace}:${(input as any)?.key}`)
          console.log(`  Pinned: ${isPinned ? 'YES (will auto-load next session)' : 'no'}`)
          if ((input as any)?.valueText) {
            console.log(`  Summary: ${(input as any).valueText.slice(0, 100)}...`)
          }
        } else if (tool === 'sqlite_describe_table') {
          describeTableCount++
          console.log(`  Table: ${(input as any)?.table_name}`)
          console.log(`  Note: This could be avoided if schema was pinned!`)
        } else {
          // Show abbreviated input for other tools
          const inputStr = JSON.stringify(input, null, 2)
          if (inputStr.length > 200) {
            console.log(`  Input: ${inputStr.slice(0, 200)}...`)
          } else {
            console.log(`  Input: ${inputStr}`)
          }
        }
      }
    },
    onToolResult: debug ? (tool, result) => {
      const resultStr = JSON.stringify(result, null, 2)
      if (resultStr.length > 300) {
        console.log(`  Result: ${resultStr.slice(0, 300)}...`)
      } else {
        console.log(`  Result: ${resultStr}`)
      }
    } : undefined
  })

  const cleanup = async () => {
    try {
      await agent.destroy()
      await sqliteProvider.destroy()
    } catch (error) {
      console.error('Cleanup error:', error)
    }
  }

  return { agent, cleanup }
}

// ============================================================================
// Interactive REPL
// ============================================================================

async function main() {
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    console.error('Usage: export OPENAI_API_KEY=sk-xxx')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const debug = args.includes('--debug') || args.includes('-d')

  console.log('='.repeat(70))
  console.log('Personal Email Assistant - Context Pipeline Demo')
  console.log('='.repeat(70))
  console.log('')
  console.log('This assistant demonstrates the Context Assembly Pipeline:')
  console.log('')
  console.log('  1. PINNED MEMORY: Schema and user corrections are stored with')
  console.log('     tags: ["pinned"] and auto-loaded in future sessions')
  console.log('')
  console.log('  2. SCHEMA DISCOVERY: First query on a table triggers describe_table.')
  console.log('     Schema is then stored as pinned - no describe_table next time!')
  console.log('')
  console.log('  3. USER FEEDBACK: Tell the agent corrections (e.g., "internal_date')
  console.log('     is in milliseconds") and it will pin them for future reference.')
  console.log('')
  console.log('  4. HISTORY COMPRESSION: Long conversations are compressed.')
  console.log('     Use ctx-expand tool to retrieve specific segments.')
  console.log('')
  console.log('-'.repeat(70))
  console.log('Commands: exit/quit, help')
  if (debug) {
    console.log('')
    console.log('[DEBUG MODE] Token usage and context planning will be shown.')
  }
  console.log('='.repeat(70))
  console.log('')

  let assistant: Awaited<ReturnType<typeof createPersonalAssistant>> | null = null
  let turnCount = 0

  try {
    const model = process.env['MODEL'] || 'gpt-5.2'
    console.log(`Initializing assistant with model: ${model}...`)
    assistant = await createPersonalAssistant({
      apiKey,
      model,
      emailDbPath: process.env['EMAIL_DB_PATH'],
      projectPath: path.dirname(new URL(import.meta.url).pathname),
      debug
    })
    console.log('Ready! (Pinned items will be auto-loaded from memory)\n')

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    const prompt = () => {
      rl.question('You: ', async (input) => {
        const trimmed = input.trim()

        if (!trimmed) {
          prompt()
          return
        }

        if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
          console.log('\nGoodbye!')
          if (assistant) await assistant.cleanup()
          rl.close()
          process.exit(0)
        }

        if (trimmed.toLowerCase() === 'help') {
          console.log(`
Usage Tips:
-----------
1. First Query: "What tables are in my email database?"
   → Agent discovers schema, stores with tags: ["pinned"]
   → Next session: schema auto-loaded, no describe_table call!

2. User Correction: "Remember that internal_date is in milliseconds"
   → Agent stores as pinned correction
   → Future queries will use correct format

3. Check Pinned Memory: "What do you have pinned?"
   → Shows all auto-loaded context

4. Search Emails: "Find emails from john@example.com this week"

5. Summarize: "Summarize my unread emails"

6. Analyze Attachments: "Read the PDF at /path/to/file.pdf"

Context Pipeline Features:
--------------------------
- Pinned Phase: Items with tags: ["pinned"] auto-load
- ctx-expand: Retrieve compressed history segments
- Token Budget: ~2000 tokens reserved for pinned items

Debug Mode (--debug):
--------------------
Shows tool calls, memory operations, and whether items are pinned.

Commands:
---------
exit/quit  - Exit the assistant
help       - Show this help message
`)
          prompt()
          return
        }

        turnCount++

        try {
          if (debug) {
            console.log('')
            console.log(`[Turn ${turnCount}] Processing...`)
            console.log('-'.repeat(50))
          }

          process.stdout.write('\nAssistant: ')
          const startTime = Date.now()
          const result = await assistant!.agent.run(trimmed)
          const durationMs = Date.now() - startTime

          if (!result.success) {
            // Only print error - success output was already streamed
            console.log(`\nError: ${result.error}`)
          }

          if (debug) {
            console.log('')
            console.log('-'.repeat(50))
            console.log(`[Turn ${turnCount} Summary]`)
            console.log(`  Steps: ${result.steps}`)
            console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`)
            console.log(`  Success: ${result.success}`)
            console.log('-'.repeat(50))
          }

          console.log('')
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.log(`Error: ${errorMessage}\n`)
        }

        prompt()
      })
    }

    rl.on('close', async () => {
      console.log('\nGoodbye!')
      if (assistant) await assistant.cleanup()
      process.exit(0)
    })

    process.on('SIGINT', async () => {
      console.log('\n\nInterrupted. Cleaning up...')
      if (assistant) {
        assistant.agent.stop()
        await assistant.cleanup()
      }
      process.exit(0)
    })

    prompt()

  } catch (error) {
    console.error('Failed to initialize assistant:', error)
    if (assistant) await assistant.cleanup()
    process.exit(1)
  }
}

// Run if executed directly
if (process.argv[1]?.includes('personal-email-assistant')) {
  main().catch(console.error)
}

export default createPersonalAssistant
