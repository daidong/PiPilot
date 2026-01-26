/**
 * Personal Email Assistant
 *
 * An interactive email assistant agent that:
 * - Reads emails from local SQLite database (ChatMail) via MCP
 * - Uses kv-memory for persistent knowledge (schema, preferences)
 * - Maintains long-term memory across sessions
 *
 * This example demonstrates using the SQLite MCP server which is now
 * integrated into AgentFoundry's MCP catalog (see mcp-catalog.yaml).
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx examples/personal-assistant/index.ts
 *
 * Optional environment variables:
 *   EMAIL_DB_PATH - Path to SQLite email database (default: ~/Library/Application Support/ChatMail/local-email.db)
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

## CRITICAL: Use Pre-loaded Schema

Database schema is provided in "Pre-loaded Context" section below.
- USE the column names from pre-loaded schema EXACTLY as shown
- Do NOT call sqlite_describe_table unless the column you need is not in pre-loaded schema
- If pre-loaded schema is empty, then discover using sqlite_list_tables and sqlite_describe_table

## Schema Discovery (only if no pre-loaded schema)
If you need to discover schema:
1. Call sqlite_describe_table to get column names
2. Save discoveries using memory-set with key like "schema:<table_name>"
3. Future sessions will have this schema pre-loaded automatically

## Learning from Errors
If a query fails due to wrong column name:
1. Call sqlite_describe_table to get correct columns
2. Save correction using memory-set with key like "schema:<table_name>"
3. Retry with corrected query`

const CONSTRAINTS = [
  // Schema usage
  'USE column names from "Pre-loaded Context" section - do NOT guess',
  'Only call sqlite_describe_table if column not in pre-loaded schema',
  'Save any schema discoveries using memory-set with key like "schema:<table_name>"',

  // Database query safety
  'Only execute read-only queries on the email database',
  'ALWAYS use LIMIT (e.g., LIMIT 20) to avoid result overflow',
  'NEVER use SELECT * - always select specific columns',

  // Privacy and UX
  'Respect user privacy - never share email content externally',
  'Remember user preferences using memory-set with key like "pref:<preference_name>"'
]

// ============================================================================
// Types
// ============================================================================

export interface PersonalAssistantConfig {
  /** OpenAI API key */
  apiKey: string
  /** Model to use (default: gpt-4o-mini) */
  model?: string
  /** Path to SQLite email database */
  emailDbPath?: string
  /** Project path for facts storage */
  projectPath?: string
  /** Enable debug logging */
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

/**
 * Load schema from kv-memory store to inject into system prompt.
 * This ensures the LLM always has schema info without needing to call describe_table.
 */
async function loadSchemaFromMemory(projectPath: string, debug: boolean): Promise<string | undefined> {
  const memoryPath = path.join(projectPath, '.agent-foundry', 'memory', 'kv-store.json')

  try {
    const content = await import('node:fs').then(fs =>
      fs.promises.readFile(memoryPath, 'utf-8')
    )
    const data = JSON.parse(content)
    const entries = data.entries || {}

    // Filter for schema-related entries (keys starting with "schema:")
    const schemaEntries = Object.entries(entries).filter(([key]) =>
      key.startsWith('schema:')
    )

    if (schemaEntries.length === 0) {
      if (debug) {
        console.log('[Debug] No schema entries found, agent will discover schema')
      }
      return undefined
    }

    // Build context string from schema entries
    const lines = [
      '## Pre-loaded Database Schema (from memory)',
      '',
      'Use this schema information directly. Do NOT call sqlite_describe_table unless you need columns not listed here.',
      ''
    ]

    for (const [key, value] of schemaEntries) {
      const tableName = key.replace('schema:', '')
      lines.push(`### Table: ${tableName}`)
      lines.push(`${JSON.stringify(value)}`)
      lines.push('')
    }

    if (debug) {
      console.log(`[Debug] Loaded ${schemaEntries.length} schema entries into context`)
    }

    return lines.join('\n')
  } catch (error) {
    if (debug) {
      console.log('[Debug] No memory file found, agent will discover schema')
    }
    return undefined
  }
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
    model = 'gpt-5.2',
    emailDbPath = '~/Library/Application Support/ChatMail/local-email.db',
    projectPath = process.cwd(),
    debug = false
  } = config

  if (!apiKey) {
    throw new Error('API key is required')
  }

  const dbPath = expandPath(emailDbPath)

  if (debug) {
    console.log(`[Debug] Email DB path: ${dbPath}`)
    console.log(`[Debug] Project path: ${projectPath}`)
  }

  // Load schema from memory to inject into system prompt
  // This ensures the LLM has schema info without needing to call describe_table
  const schemaContext = await loadSchemaFromMemory(projectPath, debug)

  // Create MCP provider for SQLite
  // Uses mcp-server-sqlite-npx from the MCP catalog (src/recommendation/data/mcp-catalog.yaml)
  // Database path is passed as the last positional argument
  // NOTE: Read-only is enforced via prompt constraints (the MCP server doesn't support --readonly flag)
  // See: https://github.com/johnnyoshika/mcp-server-sqlite-npx
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
  // - kvMemory: key-value memory for persistent knowledge
  // - sessionHistory: conversation history viewing
  // - MCP packs: sqlite, markitdown
  const allPacks = mergePacks(
    packs.safe(),
    packs.kvMemory(),        // Provides memory-set, memory-delete tools
    packs.sessionHistory(),  // Provides session.messages, session.trace, session.search
    ...mcpPacks
  )

  // Create the agent
  const agent = createAgent({
    apiKey,
    model,
    projectPath,  // Used for facts storage at .agent-foundry/memory/
    packs: [allPacks],
    identity: IDENTITY,
    constraints: CONSTRAINTS,
    initialContext: schemaContext,  // Auto-inject schema facts into system prompt
    skipConfigFile: true,
    onStream: debug ? (chunk) => process.stdout.write(chunk) : undefined,
    onToolCall: debug ? (tool, input) => {
      console.log(`\n[Tool Call] ${tool}:`, JSON.stringify(input, null, 2))
    } : undefined,
    onToolResult: debug ? (tool, result) => {
      console.log(`[Tool Result] ${tool}:`, JSON.stringify(result, null, 2).slice(0, 500))
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

  console.log('='.repeat(60))
  console.log('Personal Email Assistant')
  console.log('='.repeat(60))
  console.log('')
  console.log('This assistant can:')
  console.log('  - Read and summarize your emails (read-only)')
  console.log('  - Analyze attachments (PDF, Word, Excel, images)')
  console.log('  - Learn and remember your preferences (via kv-memory)')
  console.log('  - Persist knowledge across sessions')
  console.log('')
  console.log('Type your questions. Type "exit" or "quit" to quit.')
  console.log('Type "help" for usage tips.')
  if (debug) {
    console.log('')
    console.log('[Debug mode enabled]')
  }
  console.log('')

  let assistant: { agent: Agent; cleanup: () => Promise<void> } | null = null

  try {
    console.log('Initializing assistant...')
    assistant = await createPersonalAssistant({
      apiKey,
      emailDbPath: process.env['EMAIL_DB_PATH'],
      projectPath: path.dirname(new URL(import.meta.url).pathname),
      debug
    })
    console.log('Ready!\n')

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
1. Start by asking: "What tables are in my email database?"
   (The agent will discover schema and save it to memory)

2. Then explore: "Show me emails from this week"

3. Search emails: "Any emails from john@example.com?"

4. Summarize: "Summarize my unread emails"

5. Analyze attachments: "Read the PDF at /path/to/file.pdf"

6. Set preferences: "Remember that I prefer brief responses"

7. Check memory: "What have you saved to memory?"

Supported attachment formats:
  PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx),
  Images (PNG, JPG with OCR), Audio (MP3, WAV), HTML

Knowledge Persistence:
  - Schema and preferences are stored in .agent-foundry/memory/kv-store.json
  - Knowledge persists across sessions
  - Use "memory-set" to save new knowledge
  - Use ctx.get("memory.list") to see all stored knowledge

Commands:
---------
exit/quit  - Exit the assistant
help       - Show this help message
`)
          prompt()
          return
        }

        try {
          process.stdout.write('\nAssistant: ')
          const result = await assistant!.agent.run(trimmed)

          if (result.success) {
            // In debug mode, text was already streamed via onStream callback
            // Only print output if not in debug mode (no streaming)
            if (!debug) {
              console.log(result.output.trim())
            }
          } else {
            console.log(`Error: ${result.error}`)
          }

          if (debug) {
            console.log(`\n[Debug] Steps: ${result.steps}, Duration: ${result.durationMs}ms`)
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
if (process.argv[1]?.includes('personal-assistant')) {
  main().catch(console.error)
}

export default createPersonalAssistant
