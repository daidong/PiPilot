#!/usr/bin/env node
/**
 * Agent Foundry CLI
 *
 * CLI entry point
 */

import { runIndexDocs, parseIndexDocsArgs, printIndexDocsHelp } from './index-docs.js'

const VERSION = '0.1.0'

const HELP = `
Agent Foundry CLI v${VERSION}

Usage:
  agent-foundry <command> [options]

Commands:
  validate      Validate configuration file
  index-docs    Build document index for docs context sources
  help          Show help information

Options:
  --help, -h    Show help information
  --version, -v Show version number

Examples:
  $ agent-foundry validate
  $ agent-foundry index-docs --paths docs,wiki -v
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  // Parse options
  const options: { help?: boolean; version?: boolean } = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--version' || arg === '-v') {
      options.version = true
    }
  }

  // Handle global options
  if (options.version || command === 'version' || command === '-v' || command === '--version') {
    console.log(`agent-foundry v${VERSION}`)
    return
  }

  if (options.help || command === 'help' || command === '-h' || command === '--help' || !command) {
    console.log(HELP)
    return
  }

  // Execute command
  switch (command) {
    case 'validate':
      await runValidate()
      break

    case 'index-docs': {
      // Check for help flag
      const cmdArgs = args.slice(1)
      if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
        printIndexDocsHelp()
        break
      }
      const indexDocsOptions = parseIndexDocsArgs(cmdArgs)
      await runIndexDocs(indexDocsOptions)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.log(HELP)
      process.exit(1)
  }
}

/**
 * Validate configuration file
 */
async function runValidate(): Promise<void> {
  const { findConfigFile, loadConfig, validateConfig } = await import('../config/index.js')

  const configPath = findConfigFile()
  if (!configPath) {
    console.error('Configuration file not found (agent.yaml)')
    process.exit(1)
  }

  console.log(`Validating configuration file: ${configPath}`)

  try {
    const config = loadConfig(configPath)
    const errors = validateConfig(config)

    if (errors.length > 0) {
      console.error('Configuration file validation failed:')
      for (const error of errors) {
        console.error(`   • ${error}`)
      }
      process.exit(1)
    }

    console.log('Configuration file validation passed')
    console.log('')
    console.log(`   Agent ID: ${config.id}`)
    console.log(`   Name: ${config.name || '(not set)'}`)
    console.log(`   Packs: ${config.packs?.length || 0}`)
    console.log(`   MCP Servers: ${config.mcp?.length || 0}`)
  } catch (error) {
    console.error(`Failed to load configuration file: ${(error as Error).message}`)
    process.exit(1)
  }
}

// Run
main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
