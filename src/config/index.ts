/**
 * Config Module - Configuration module
 */

export {
  loadConfig,
  saveConfig,
  tryLoadConfig,
  findConfigFile,
  mergeConfigs,
  normalizePackConfigs,
  normalizeMCPConfigs,
  generateEnvExample,
  validateConfig,
  DEFAULT_CONFIG_FILENAMES,
  type AgentYAMLConfig,
  type PackConfigEntry,
  type MCPConfigEntry
} from './loader.js'
