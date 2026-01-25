/**
 * Init Wizard - Initialization Wizard
 *
 * Interactive creation of agent.yaml configuration file
 */

import * as fs from 'node:fs'
import * as readline from 'node:readline'

import {
  ToolRecommender,
  type RecommendationResult
} from '../recommendation/index.js'

import {
  getMCPServerByName,
  hasParameterizedConfig
} from '../recommendation/mcp-catalog.js'

import {
  resolveTemplate,
  getAllParameters,
  getParameterPrompt,
  parseParameterInput,
  type ParameterValues
} from '../recommendation/template-resolver.js'

import {
  saveConfig,
  generateEnvExample,
  type AgentYAMLConfig,
  type MCPConfigEntry
} from '../config/index.js'

import { createLLMClient, detectProviderFromApiKey } from '../llm/index.js'

/**
 * Wizard state
 */
interface WizardState {
  description: string
  agentName: string
  agentId: string
  recommendations: RecommendationResult | null
  finalConfig: AgentYAMLConfig | null
  mcpParameters: Map<string, ParameterValues>
}

/**
 * Console colors
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
}

/**
 * Print colored text
 */
function print(text: string, color?: keyof typeof colors): void {
  if (color) {
    console.log(`${colors[color]}${text}${colors.reset}`)
  } else {
    console.log(text)
  }
}

/**
 * Print header
 */
function printHeader(): void {
  console.log('')
  print('╔═══════════════════════════════════════════════════════════╗', 'cyan')
  print('║          🤖 Agent Foundry - Configuration Wizard          ║', 'cyan')
  print('╚═══════════════════════════════════════════════════════════╝', 'cyan')
  console.log('')
}

/**
 * Create readline interface
 */
function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
}

/**
 * Ask a question
 */
async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${colors.green}> ${colors.reset}${question} `, (answer) => {
      resolve(answer.trim())
    })
  })
}

/**
 * Initialization Wizard
 */
export class InitWizard {
  private rl: readline.Interface
  private state: WizardState
  private recommender: ToolRecommender

  constructor(apiKey?: string) {
    this.rl = createReadline()
    this.state = {
      description: '',
      agentName: '',
      agentId: '',
      recommendations: null,
      finalConfig: null,
      mcpParameters: new Map()
    }

    // Create recommender
    // Prefer passed key, otherwise read from environment
    const key = apiKey
      || process.env.OPENAI_API_KEY
      || process.env.ANTHROPIC_API_KEY

    let llmClient
    if (key) {
      try {
        const provider = detectProviderFromApiKey(key) || 'openai'
        const model = provider === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022'
        llmClient = createLLMClient({
          provider,
          model,
          config: { apiKey: key }
        })
      } catch (_e) {
        // Cannot create LLM client, use keyword matching
      }
    }
    this.recommender = new ToolRecommender(llmClient)
  }

  /**
   * Run the wizard
   */
  async run(): Promise<void> {
    try {
      printHeader()

      // Step 1: Collect description
      await this.collectDescription()

      // Step 2: Collect name
      await this.collectName()

      // Step 3: Analyze and recommend
      await this.analyzeAndRecommend()

      // Step 4: Confirm and refine
      await this.confirmAndRefine()

      // Step 5: Collect MCP parameters (for parameterized templates)
      await this.collectMCPParameters()

      // Step 6: Generate configuration
      await this.generateConfig()

      print('\n✅ Configuration created!', 'green')
      this.printNextSteps()

    } catch (error) {
      if ((error as Error).message === 'USER_CANCELLED') {
        print('\n❌ Cancelled', 'yellow')
      } else {
        print(`\n❌ Error: ${(error as Error).message}`, 'red')
      }
    } finally {
      this.rl.close()
    }
  }

  /**
   * Collect agent description
   */
  private async collectDescription(): Promise<void> {
    print('Please describe the agent you want to build:', 'bold')
    print('(Describe its functionality, purpose, required resources, etc.)', 'dim')
    console.log('')

    const description = await ask(this.rl, '')

    if (!description) {
      throw new Error('Please provide an agent description')
    }

    this.state.description = description
  }

  /**
   * Collect agent name
   */
  private async collectName(): Promise<void> {
    console.log('')
    const name = await ask(this.rl, 'Agent name:')

    if (!name) {
      throw new Error('Please provide an agent name')
    }

    this.state.agentName = name
    // Generate ID: lowercase, spaces to dashes
    this.state.agentId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  }

  /**
   * Analyze and recommend
   */
  private async analyzeAndRecommend(): Promise<void> {
    console.log('')
    print('Analyzing...', 'dim')

    this.state.recommendations = await this.recommender.recommend(this.state.description)

    console.log('')
    this.printUnderstanding()
    console.log('')
    this.printRecommendations()
  }

  /**
   * Print understood requirements
   */
  private printUnderstanding(): void {
    const { recommendations } = this.state
    if (!recommendations || recommendations.understoodRequirements.length === 0) return

    print('📋 Understood requirements:', 'bold')
    for (const req of recommendations.understoodRequirements) {
      print(`   • ${req}`, 'dim')
    }
  }

  /**
   * Print recommendations
   */
  private printRecommendations(): void {
    const { recommendations } = this.state
    if (!recommendations) return

    print('📦 Recommended Packs:', 'bold')
    console.log('')

    for (const pack of recommendations.packs) {
      const riskBadge = pack.riskLevel === 'high' ? '⚠️ ' :
                        pack.riskLevel === 'elevated' ? '⚡ ' : '✅ '
      const confidence = Math.round(pack.confidence * 100)

      print(`   ${riskBadge}${pack.name} (${confidence}%)`, 'cyan')
      print(`      ${pack.reason}`, 'dim')
      if (pack.matchReasons && pack.matchReasons.length > 0) {
        for (const reason of pack.matchReasons.slice(0, 2)) {
          print(`      • ${reason}`, 'dim')
        }
      }
      print(`      Tools: ${pack.tools.join(', ')}`, 'dim')
      console.log('')
    }

    if (recommendations.mcpServers.length > 0) {
      print('🔌 Recommended MCP Servers:', 'bold')
      console.log('')

      for (const server of recommendations.mcpServers) {
        const riskBadge = server.riskLevel === 'high' ? '⚠️ ' :
                          server.riskLevel === 'elevated' ? '⚡ ' : '✅ '
        const confidence = Math.round(server.confidence * 100)
        const configNote = server.requiresParameters ? ' ⚙️ requires config' : ''

        print(`   ${riskBadge}${server.name} (${confidence}%)${configNote}`, 'cyan')
        print(`      ${server.reason}`, 'dim')
        if (server.matchReasons && server.matchReasons.length > 0) {
          for (const reason of server.matchReasons.slice(0, 2)) {
            print(`      • ${reason}`, 'dim')
          }
        }
        if (server.envVars?.length) {
          print(`      Requires: ${server.envVars.join(', ')}`, 'yellow')
        }
        console.log('')
      }
    }

    if (recommendations.warnings.length > 0) {
      print('⚠️  Warnings:', 'yellow')
      for (const warning of recommendations.warnings) {
        print(`   • ${warning}`, 'yellow')
      }
      console.log('')
    }
  }

  /**
   * Confirm and refine
   */
  private async confirmAndRefine(): Promise<void> {
    while (true) {
      console.log('')
      const feedback = await ask(this.rl, 'Any adjustments needed? (Press Enter to confirm, type q to cancel)')

      if (feedback.toLowerCase() === 'q') {
        throw new Error('USER_CANCELLED')
      }

      if (feedback === '') {
        break
      }

      // Adjust recommendations based on feedback
      print('\nAdjusting...', 'dim')
      this.state.recommendations = await this.recommender.refineWithFeedback(
        this.state.recommendations!,
        feedback
      )

      console.log('')
      this.printRecommendations()
    }
  }

  /**
   * Collect MCP parameters for parameterized templates
   */
  private async collectMCPParameters(): Promise<void> {
    const { recommendations } = this.state
    if (!recommendations) return

    // Find MCP servers that need parameters
    const serversNeedingParams = recommendations.mcpServers.filter(s => s.requiresParameters)

    if (serversNeedingParams.length === 0) return

    console.log('')
    print('⚙️  Some MCP servers require configuration:', 'bold')
    console.log('')

    for (const server of serversNeedingParams) {
      const entry = getMCPServerByName(server.name)
      if (!entry || !hasParameterizedConfig(entry)) continue

      print(`   ${server.name}:`, 'cyan')

      const parameters = getAllParameters(entry.configTemplate)
      const values: ParameterValues = {}

      for (const param of parameters) {
        const prompt = getParameterPrompt(param)
        print(`      ${prompt}`, 'dim')

        const input = await ask(this.rl, `      ${param.name}:`)
        const parsed = parseParameterInput(param, input)

        if (parsed !== undefined && parsed !== '' && (!Array.isArray(parsed) || parsed.length > 0)) {
          values[param.name] = parsed
        }
      }

      this.state.mcpParameters.set(server.name, values)
      console.log('')
    }
  }

  /**
   * Generate configuration
   */
  private async generateConfig(): Promise<void> {
    const { recommendations, agentId, agentName, description, mcpParameters } = this.state

    // Build configuration
    const config: AgentYAMLConfig = {
      id: agentId,
      name: agentName,
      identity: `You are ${agentName}.\n\n${description}`,
      packs: recommendations!.packs.map(p => {
        // For packs with options, return object format
        if (p.name === 'network') {
          return { name: 'network', options: { allowHttp: true } }
        }
        return p.name
      }),
      model: {
        default: 'gpt-4o',
        maxTokens: 16384
      },
      maxSteps: 25
    }

    // Add MCP configuration
    if (recommendations!.mcpServers.length > 0) {
      config.mcp = []

      for (const server of recommendations!.mcpServers) {
        const entry = getMCPServerByName(server.name)

        if (entry && hasParameterizedConfig(entry)) {
          // Resolve parameterized template
          const params = mcpParameters.get(server.name) || {}

          try {
            const resolved = resolveTemplate(entry.configTemplate, params)

            const mcpConfig: MCPConfigEntry = {
              name: server.name,
              package: server.package,
              transport: resolved.config.transport
            }

            if (server.envVars?.length) {
              mcpConfig.env = server.envVars
            }

            config.mcp.push(mcpConfig)
          } catch (error) {
            print(`   ⚠️  Warning: Could not configure ${server.name}: ${(error as Error).message}`, 'yellow')
            // Add basic config without parameters
            const mcpConfig: MCPConfigEntry = {
              name: server.name,
              package: server.package,
              transport: {
                type: 'stdio',
                command: 'npx',
                args: ['-y', server.package]
              }
            }
            if (server.envVars?.length) {
              mcpConfig.env = server.envVars
            }
            config.mcp.push(mcpConfig)
          }
        } else {
          // Simple template
          const mcpConfig: MCPConfigEntry = {
            name: server.name,
            package: server.package,
            transport: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', server.package]
            }
          }

          if (server.envVars?.length) {
            mcpConfig.env = server.envVars
          }

          config.mcp.push(mcpConfig)
        }
      }
    }

    this.state.finalConfig = config

    // Save configuration file
    console.log('')
    print('📝 Generating configuration files...', 'dim')

    saveConfig(config, 'agent.yaml')
    print('   ✓ agent.yaml', 'green')

    // Generate .env.example
    if (Object.keys(recommendations!.requiredEnvVars).length > 0) {
      const envContent = generateEnvExample(recommendations!.requiredEnvVars)
      fs.writeFileSync('.env.example', envContent, 'utf-8')
      print('   ✓ .env.example', 'green')
    }
  }

  /**
   * Print next steps
   */
  private printNextSteps(): void {
    console.log('')
    print('📝 Next steps:', 'bold')
    console.log('')
    print('   1. Edit agent.yaml to adjust configuration', 'dim')

    const { recommendations } = this.state
    if (recommendations && Object.keys(recommendations.requiredEnvVars).length > 0) {
      print('   2. Copy .env.example to .env and fill in environment variables', 'dim')
      print('   3. Use in your code:', 'dim')
    } else {
      print('   2. Use in your code:', 'dim')
    }

    console.log('')
    print("   import { createAgent } from 'agent-foundry'", 'cyan')
    print("   const agent = await createAgent({ apiKey: '...' })", 'cyan')
    console.log('')
  }
}

/**
 * Run the initialization wizard
 */
export async function runInitWizard(apiKey?: string): Promise<void> {
  const wizard = new InitWizard(apiKey)
  await wizard.run()
}
