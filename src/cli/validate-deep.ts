/**
 * validate-deep CLI Command
 *
 * Deep validation of AgentFoundry configuration:
 * 1. Config validation (agent.yaml syntax)
 * 2. API key check (verify keys are set and work)
 * 3. Model availability (verify model is known/supported)
 * 4. Pack validation (verify packs exist and can load)
 * 5. MCP server check (verify connectivity with timeout)
 * 6. Tool listing (list all available tools)
 * 7. Policy listing (list all active policies)
 * 8. Skill listing (list all skills with loading strategy)
 */

import type { AgentYAMLConfig } from '../config/index.js'
import type { Pack } from '../types/pack.js'
import type { ProviderID } from '../llm/provider.types.js'

// ── ANSI color helpers ──────────────────────────────────────────────────────

const isColorEnabled = process.stdout.isTTY !== false

function green(text: string): string {
  return isColorEnabled ? `\x1b[32m${text}\x1b[0m` : text
}

function red(text: string): string {
  return isColorEnabled ? `\x1b[31m${text}\x1b[0m` : text
}

function yellow(text: string): string {
  return isColorEnabled ? `\x1b[33m${text}\x1b[0m` : text
}

function dim(text: string): string {
  return isColorEnabled ? `\x1b[2m${text}\x1b[0m` : text
}

function pass(message: string): void {
  console.log(`${green('\u2713')} ${message}`)
}

function fail(message: string): void {
  console.log(`${red('\u2717')} ${message}`)
}

function warn(message: string): void {
  console.log(`${yellow('!')} ${message}`)
}

function info(message: string): void {
  console.log(`  ${dim(message)}`)
}

// ── Provider env key mapping ────────────────────────────────────────────────

const PROVIDER_ENV_KEYS: Record<ProviderID, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY'
}

const PROVIDER_NAMES: Record<ProviderID, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google AI'
}

// ── Validation steps ────────────────────────────────────────────────────────

interface DeepValidationResult {
  passed: number
  failed: number
  warnings: number
}

/**
 * Step 1: Load and validate config
 */
async function validateConfig(dir?: string): Promise<{ config: AgentYAMLConfig; configPath: string } | null> {
  const { findConfigFile, loadConfig, validateConfig: checkConfig } = await import('../config/index.js')

  const configPath = findConfigFile(dir)
  if (!configPath) {
    fail('Config: agent.yaml not found')
    return null
  }

  try {
    const config = loadConfig(configPath)
    const errors = checkConfig(config)

    if (errors.length > 0) {
      fail(`Config: agent.yaml has ${errors.length} error(s)`)
      for (const error of errors) {
        info(`- ${error}`)
      }
      return null
    }

    pass(`Config: agent.yaml loaded successfully ${dim(`(${configPath})`)}`)
    return { config, configPath }
  } catch (error) {
    fail(`Config: failed to load agent.yaml - ${(error as Error).message}`)
    return null
  }
}

/**
 * Step 2: Check API keys for configured provider
 */
async function validateApiKeys(
  config: AgentYAMLConfig,
  result: DeepValidationResult
): Promise<{ provider: ProviderID; apiKey: string } | null> {
  const { getModel } = await import('../llm/index.js')

  // Determine which provider to use
  let targetProvider: ProviderID | null = null

  if (config.model?.provider) {
    targetProvider = config.model.provider as ProviderID
  } else if (config.model?.default) {
    const modelConfig = getModel(config.model.default)
    if (modelConfig) {
      targetProvider = modelConfig.providerID
    }
  }

  // If no provider determined from config, detect from environment
  if (!targetProvider) {
    for (const [provider, envKey] of Object.entries(PROVIDER_ENV_KEYS)) {
      if (process.env[envKey]?.trim()) {
        targetProvider = provider as ProviderID
        break
      }
    }
  }

  if (!targetProvider) {
    fail('Provider: no API key found in environment')
    info('Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GOOGLE_API_KEY')
    result.failed++
    return null
  }

  const envKey = PROVIDER_ENV_KEYS[targetProvider]
  const apiKey = process.env[envKey]?.trim()

  if (!apiKey) {
    fail(`Provider: ${PROVIDER_NAMES[targetProvider]} - ${envKey} not set`)
    result.failed++
    return null
  }

  // Try a lightweight API call to verify the key works
  try {
    const verified = await verifyApiKey(targetProvider, apiKey)
    if (verified) {
      pass(`Provider: ${PROVIDER_NAMES[targetProvider]} ${dim('(API key verified)')}`)
      result.passed++
    } else {
      warn(`Provider: ${PROVIDER_NAMES[targetProvider]} ${dim('(API key set but could not verify)')}`)
      result.warnings++
    }
  } catch (error) {
    fail(`Provider: ${PROVIDER_NAMES[targetProvider]} - API key verification failed: ${(error as Error).message}`)
    result.failed++
    return null
  }

  // Report other available providers
  const otherProviders: string[] = []
  for (const [provider, ek] of Object.entries(PROVIDER_ENV_KEYS)) {
    if (provider !== targetProvider && process.env[ek]?.trim()) {
      otherProviders.push(PROVIDER_NAMES[provider as ProviderID])
    }
  }
  if (otherProviders.length > 0) {
    info(`Also available: ${otherProviders.join(', ')}`)
  }

  return { provider: targetProvider, apiKey }
}

/**
 * Verify an API key by making a lightweight call
 */
async function verifyApiKey(provider: ProviderID, apiKey: string): Promise<boolean> {
  const timeoutMs = 10_000

  try {
    switch (provider) {
      case 'openai': {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal
          })
          return response.ok
        } finally {
          clearTimeout(timer)
        }
      }

      case 'anthropic': {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          // Use messages endpoint with minimal payload to verify key
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }]
            }),
            signal: controller.signal
          })
          // 200 = success, 400 = bad request (but key is valid)
          // 401 = unauthorized (key is invalid)
          return response.status !== 401
        } finally {
          clearTimeout(timer)
        }
      }

      case 'deepseek': {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch('https://api.deepseek.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal
          })
          return response.ok
        } finally {
          clearTimeout(timer)
        }
      }

      case 'google': {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
            { signal: controller.signal }
          )
          return response.ok
        } finally {
          clearTimeout(timer)
        }
      }

      default:
        return false
    }
  } catch {
    // Network error, timeout, etc.
    return false
  }
}

/**
 * Step 3: Validate model availability
 */
async function validateModel(
  config: AgentYAMLConfig,
  provider: ProviderID,
  result: DeepValidationResult
): Promise<void> {
  const { getModel } = await import('../llm/index.js')

  const modelId = config.model?.default
  if (!modelId) {
    warn('Model: no model specified in config, will use provider default')
    result.warnings++
    return
  }

  const modelConfig = getModel(modelId)
  if (!modelConfig) {
    fail(`Model: "${modelId}" is not in the model registry`)
    info('Known models can be found in src/llm/models.ts')
    result.failed++
    return
  }

  if (modelConfig.providerID !== provider) {
    fail(`Model: "${modelId}" belongs to ${PROVIDER_NAMES[modelConfig.providerID]}, but configured provider is ${PROVIDER_NAMES[provider]}`)
    result.failed++
    return
  }

  const contextStr = modelConfig.limit.maxContext >= 1000
    ? `${Math.round(modelConfig.limit.maxContext / 1000)}k context`
    : `${modelConfig.limit.maxContext} context`

  const features: string[] = []
  if (modelConfig.capabilities.reasoning) features.push('reasoning')
  if (modelConfig.capabilities.toolcall) features.push('tools')
  if (modelConfig.capabilities.input.includes('image')) features.push('vision')

  pass(`Model: ${modelConfig.name} ${dim(`(${contextStr}${features.length > 0 ? ', ' + features.join(', ') : ''})`)}`)
  result.passed++
}

/**
 * Step 4: Validate packs and list tools/policies/skills
 */
async function validatePacks(
  config: AgentYAMLConfig,
  result: DeepValidationResult
): Promise<void> {
  const { normalizePackConfigs, SUPPORTED_YAML_PACKS } = await import('../config/index.js')

  if (!config.packs || config.packs.length === 0) {
    warn('Packs: none configured, will use safe pack as default')
    result.warnings++
    return
  }

  const normalized = normalizePackConfigs(config.packs)
  const validPacks: string[] = []
  const invalidPacks: string[] = []

  for (const packConfig of normalized) {
    if (SUPPORTED_YAML_PACKS.includes(packConfig.name as typeof SUPPORTED_YAML_PACKS[number])) {
      validPacks.push(packConfig.name)
    } else {
      invalidPacks.push(packConfig.name)
    }
  }

  if (invalidPacks.length > 0) {
    fail(`Packs: unknown pack(s): ${invalidPacks.join(', ')}`)
    result.failed++
  }

  if (validPacks.length > 0) {
    // Try to actually load the packs to get tool/policy/skill details
    try {
      const loadedPacks = await loadPackInstances(validPacks)
      const allTools: string[] = []
      const allPolicies: string[] = []
      const allSkills: Array<{ id: string; strategy: string }> = []

      for (const pack of loadedPacks) {
        if (pack.tools) {
          for (const tool of pack.tools) {
            if (!allTools.includes(tool.name)) {
              allTools.push(tool.name)
            }
          }
        }
        if (pack.policies) {
          for (const policy of pack.policies) {
            if (!allPolicies.includes(policy.id)) {
              allPolicies.push(policy.id)
            }
          }
        }
        if (pack.skills) {
          for (const skill of pack.skills) {
            if (!allSkills.find(s => s.id === skill.id)) {
              allSkills.push({
                id: skill.id,
                strategy: skill.loadingStrategy ?? 'lazy'
              })
            }
          }
        }
      }

      pass(`Packs: ${validPacks.join(' + ')}`)
      result.passed++

      // Tools listing
      if (allTools.length > 0) {
        info(`Tools: ${allTools.join(', ')} (${allTools.length} tools)`)
      } else {
        info('Tools: (none)')
      }

      // Policies listing
      if (allPolicies.length > 0) {
        info(`Policies: ${allPolicies.join(', ')} (${allPolicies.length} policies)`)
      } else {
        info('Policies: (none)')
      }

      // Skills listing
      if (allSkills.length > 0) {
        const skillStrs = allSkills.map(s => `${s.id} (${s.strategy})`)
        info(`Skills: ${skillStrs.join(', ')} (${allSkills.length} skills)`)
      } else {
        info('Skills: (none)')
      }
    } catch (error) {
      fail(`Packs: failed to load - ${(error as Error).message}`)
      result.failed++
    }
  }
}

/**
 * Load pack instances from pack names (simplified, no project path needed for basic packs)
 */
async function loadPackInstances(packNames: string[]): Promise<Pack[]> {
  const packsModule = await import('../packs/index.js')
  const loaded: Pack[] = []

  const factoryMap: Record<string, (() => Pack) | undefined> = {
    safe: packsModule.safe,
    exec: packsModule.exec,
    network: packsModule.network as () => Pack,
    compute: packsModule.compute as () => Pack,
    git: packsModule.git,
    exploration: packsModule.exploration,
    'kv-memory': packsModule.kvMemory,
    kvMemory: packsModule.kvMemory,
    docs: packsModule.docs,
    discovery: packsModule.discovery,
    todo: packsModule.todo
  }

  for (const name of packNames) {
    const factory = factoryMap[name]
    if (factory) {
      try {
        loaded.push(factory())
      } catch {
        // Some packs may require options; skip gracefully
      }
    }
  }

  return loaded
}

/**
 * Step 5: Check MCP servers
 */
async function validateMCPServers(
  config: AgentYAMLConfig,
  result: DeepValidationResult
): Promise<void> {
  if (!config.mcp || config.mcp.length === 0) {
    info('MCP: no servers configured')
    return
  }

  const { normalizeMCPConfigs } = await import('../config/index.js')
  const { createMCPClient } = await import('../mcp/index.js')
  const servers = normalizeMCPConfigs(config.mcp)

  for (const server of servers) {
    const timeoutMs = 5000
    try {
      const client = createMCPClient(server)

      // Race connection against timeout
      const connected = await Promise.race([
        client.connect().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
      ])

      if (connected) {
        pass(`MCP: server "${server.name}" connected successfully`)
        result.passed++
        try {
          await client.disconnect()
        } catch {
          // Ignore disconnect errors
        }
      } else {
        fail(`MCP: server "${server.name}" connection timeout after ${timeoutMs / 1000}s`)
        result.failed++
      }
    } catch (error) {
      fail(`MCP: server "${server.name}" connection failed - ${(error as Error).message}`)
      result.failed++
    }
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

export interface ValidateDeepOptions {
  /** Directory to search for config file */
  configDir?: string
}

/**
 * Run deep validation
 */
export async function runValidateDeep(options: ValidateDeepOptions = {}): Promise<void> {
  console.log('')
  console.log('  AgentFoundry Deep Validation')
  console.log('  ----------------------------')
  console.log('')

  const result: DeepValidationResult = {
    passed: 0,
    failed: 0,
    warnings: 0
  }

  // Step 1: Config validation
  const configResult = await validateConfig(options.configDir)
  if (configResult) {
    result.passed++
  } else {
    result.failed++
    printSummary(result)
    return
  }

  const { config } = configResult

  // Step 2: API key check
  const providerResult = await validateApiKeys(config, result)

  // Step 3: Model availability (only if we have a provider)
  if (providerResult) {
    await validateModel(config, providerResult.provider, result)
  } else {
    warn('Model: skipped (no provider available)')
    result.warnings++
  }

  // Step 4: Pack validation + tool/policy/skill listing
  await validatePacks(config, result)

  // Step 5: MCP server check
  await validateMCPServers(config, result)

  // Summary
  printSummary(result)
}

function printSummary(result: DeepValidationResult): void {
  console.log('')
  console.log('  ----------------------------')

  const parts: string[] = []
  if (result.passed > 0) parts.push(green(`${result.passed} passed`))
  if (result.failed > 0) parts.push(red(`${result.failed} failed`))
  if (result.warnings > 0) parts.push(yellow(`${result.warnings} warnings`))

  console.log(`  ${parts.join(', ')}`)
  console.log('')

  if (result.failed > 0) {
    process.exit(1)
  }
}

/**
 * Print help for validate --deep command
 */
export function printValidateDeepHelp(): void {
  console.log(`
validate --deep - Deep validation of AgentFoundry configuration

Usage:
  agent-foundry validate --deep [options]

Checks:
  1. Config validation   - Loads and validates agent.yaml
  2. API key check       - Verifies API keys for the configured provider
  3. Model availability  - Verifies the configured model is known and supported
  4. Pack validation     - Verifies all packs exist and can be loaded
  5. MCP server check    - Tests MCP server connectivity (5s timeout)
  6. Tool listing        - Lists all tools from loaded packs
  7. Policy listing      - Lists all active policies
  8. Skill listing       - Lists all skills with loading strategy

Options:
  --help, -h             Show this help

Examples:
  $ agent-foundry validate --deep
`)
}
