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
  resolveProviderIdFromConfig,
  DEFAULT_CONFIG_FILENAMES,
  SUPPORTED_YAML_PACKS,
  type AgentYAMLConfig,
  type PackConfigEntry,
  type ProviderConfigEntry,
  type SkillDependencyEntry,
  type MCPConfigEntry,
  type RunnerConfigEntry
} from './loader.js'
