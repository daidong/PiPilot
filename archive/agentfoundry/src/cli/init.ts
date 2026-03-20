/**
 * init CLI Command
 *
 * Scaffolds a new AgentFoundry project with sensible defaults.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

export interface InitOptions {
  name?: string
  directory?: string
}

/**
 * Prompt user for input via readline.
 */
function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const suffix = defaultValue ? ` (${defaultValue})` : ''

  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

/**
 * Generate agent.yaml content.
 */
function generateAgentYaml(projectName: string): string {
  return `# AgentFoundry Configuration
# See docs/API.md for full reference

id: ${projectName}
name: ${projectName}
description: An AgentFoundry agent

# LLM model (provider auto-detected from API key)
model: gpt-4o

# Capability packs to load
packs:
  - safe      # read, write, edit, glob, grep
  - exec      # bash execution
  # - network # fetch (uncomment if needed)
  # - compute # llm-call, llm-expand, llm-filter (uncomment if needed)
  # - git     # git operations (uncomment if needed)

# Runner configuration (for 'agent-foundry run')
runner:
  mode: single
  maxTurns: 50

# MCP servers (uncomment and configure as needed)
# mcp:
#   - name: example-server
#     transport: stdio
#     command: npx
#     args: ["-y", "@example/mcp-server"]
`
}

/**
 * Generate src/index.ts entry point.
 */
function generateEntryPoint(_projectName: string): string {
  return `import { createAgent } from 'agent-foundry'

async function main() {
  const agent = createAgent({
    projectPath: import.meta.dirname ?? process.cwd()
  })

  try {
    const prompt = process.argv[2]
    if (!prompt) {
      console.error('Usage: npx tsx src/index.ts "<your prompt>"')
      process.exit(1)
    }

    const result = await agent.run(prompt)
    console.log(result.output)
  } finally {
    await agent.destroy()
  }
}

main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
`
}

/**
 * Generate package.json for the new project.
 */
function generatePackageJson(projectName: string): string {
  const pkg = {
    name: projectName,
    version: '0.1.0',
    type: 'module',
    private: true,
    scripts: {
      start: 'tsx src/index.ts',
      build: 'tsc',
      dev: 'tsc --watch'
    },
    dependencies: {
      'agent-foundry': '^0.1.0'
    },
    devDependencies: {
      tsx: '^4.21.0',
      typescript: '^5.3.0',
      '@types/node': '^20.0.0'
    }
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

/**
 * Generate tsconfig.json for the new project.
 */
function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true
    },
    include: ['src'],
    exclude: ['node_modules', 'dist']
  }
  return JSON.stringify(config, null, 2) + '\n'
}

/**
 * Write a file, creating parent directories as needed.
 */
function writeFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, content, 'utf-8')
}

/**
 * Parse command line arguments for init command.
 */
export function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    switch (arg) {
      case '--name':
      case '-n':
        if (args[i + 1]) {
          options.name = args[++i]
        }
        break

      default:
        // First positional argument is the directory
        if (!arg.startsWith('-') && !options.directory) {
          options.directory = arg
        }
        break
    }
  }

  return options
}

/**
 * Run the init command.
 */
export async function runInit(options: InitOptions): Promise<void> {
  const targetDir = options.directory
    ? path.resolve(options.directory)
    : process.cwd()

  const dirName = path.basename(targetDir)
  const defaultName = options.name ?? dirName

  // Interactive prompts
  console.log('')
  console.log('  AgentFoundry Project Setup')
  console.log('  -------------------------')
  console.log('')

  const projectName = await prompt('  Project name', defaultName)

  // Check for existing files
  const filesToCreate = [
    'agent.yaml',
    'src/index.ts',
    'package.json',
    'tsconfig.json'
  ]

  const existingFiles = filesToCreate.filter(f =>
    fs.existsSync(path.join(targetDir, f))
  )

  if (existingFiles.length > 0) {
    console.log('')
    console.log(`  Warning: The following files already exist and will be overwritten:`)
    for (const f of existingFiles) {
      console.log(`    - ${f}`)
    }
    const confirm = await prompt('  Continue? (y/N)', 'N')
    if (confirm.toLowerCase() !== 'y') {
      console.log('  Aborted.')
      return
    }
  }

  // Create project directory if needed
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  // Write files
  console.log('')

  writeFileSync(
    path.join(targetDir, 'agent.yaml'),
    generateAgentYaml(projectName)
  )
  console.log('  Created agent.yaml')

  writeFileSync(
    path.join(targetDir, 'src/index.ts'),
    generateEntryPoint(projectName)
  )
  console.log('  Created src/index.ts')

  writeFileSync(
    path.join(targetDir, 'package.json'),
    generatePackageJson(projectName)
  )
  console.log('  Created package.json')

  writeFileSync(
    path.join(targetDir, 'tsconfig.json'),
    generateTsConfig()
  )
  console.log('  Created tsconfig.json')

  // Print getting started message
  console.log('')
  console.log('  -------------------------')
  console.log('  Project scaffolded successfully!')
  console.log('')
  console.log('  Getting started:')
  console.log('')
  if (options.directory) {
    console.log(`    cd ${options.directory}`)
  }
  console.log('    npm install')
  console.log('    export OPENAI_API_KEY=sk-...')
  console.log('')
  console.log('  Run your agent:')
  console.log('')
  console.log('    npx agent-foundry run "Hello, what can you do?"')
  console.log('    # or')
  console.log('    npx tsx src/index.ts "Hello, what can you do?"')
  console.log('')
  console.log('  Configuration:')
  console.log('    Edit agent.yaml to customize packs, model, and MCP servers.')
  console.log('    See https://github.com/anthropics/agent-foundry for docs.')
  console.log('')
}

/**
 * Print help for init command.
 */
export function printInitHelp(): void {
  console.log(`
init - Scaffold a new AgentFoundry project

Usage:
  agent-foundry init [directory] [options]

Arguments:
  directory               Target directory (default: current directory)

Options:
  --name, -n <name>       Project name (default: directory name)
  --help, -h              Show this help

Examples:
  # Initialize in current directory
  $ agent-foundry init

  # Initialize in a new directory
  $ agent-foundry init my-agent

  # Initialize with a custom name
  $ agent-foundry init my-agent --name "My Cool Agent"
`)
}
