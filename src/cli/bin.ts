#!/usr/bin/env node
/**
 * Agent Foundry CLI
 *
 * 命令行入口
 */

import { runInitWizard } from './init-wizard.js'
import { runIndexDocs, parseIndexDocsArgs, printIndexDocsHelp } from './index-docs.js'

const VERSION = '0.1.0'

const HELP = `
Agent Foundry CLI v${VERSION}

Usage:
  agent-foundry <command> [options]

Commands:
  init          Create agent.yaml configuration file
  validate      Validate configuration file
  index-docs    Build document index for docs context sources
  help          Show help information

Options:
  --help, -h    Show help information
  --version, -v Show version number

Examples:
  $ agent-foundry init
  $ agent-foundry validate
  $ agent-foundry init --api-key sk-xxx
  $ agent-foundry index-docs --paths docs,wiki -v
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  // 解析选项
  const options: { apiKey?: string; help?: boolean; version?: boolean } = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--api-key' && args[i + 1]) {
      options.apiKey = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--version' || arg === '-v') {
      options.version = true
    }
  }

  // 处理全局选项
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
    case 'init':
      await runInitWizard(options.apiKey as string | undefined)
      break

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
 * 验证配置文件
 */
async function runValidate(): Promise<void> {
  const { findConfigFile, loadConfig, validateConfig } = await import('../config/index.js')

  const configPath = findConfigFile()
  if (!configPath) {
    console.error('❌ 未找到配置文件 (agent.yaml)')
    process.exit(1)
  }

  console.log(`📄 验证配置文件: ${configPath}`)

  try {
    const config = loadConfig(configPath)
    const errors = validateConfig(config)

    if (errors.length > 0) {
      console.error('❌ 配置文件验证失败:')
      for (const error of errors) {
        console.error(`   • ${error}`)
      }
      process.exit(1)
    }

    console.log('✅ 配置文件验证通过')
    console.log('')
    console.log(`   Agent ID: ${config.id}`)
    console.log(`   Name: ${config.name || '(未设置)'}`)
    console.log(`   Packs: ${config.packs?.length || 0}`)
    console.log(`   MCP Servers: ${config.mcp?.length || 0}`)
  } catch (error) {
    console.error(`❌ 加载配置文件失败: ${(error as Error).message}`)
    process.exit(1)
  }
}

// 运行
main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
