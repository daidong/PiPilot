export { createAgent } from './create-agent.js'
export type { CreateAgentOptions } from './create-agent.js'

export {
  InMemoryStateStore,
  createEvent
} from './state-store.js'
export { fileStore, FileStateStore } from './file-store.js'

export { HookBus } from './hook-bus.js'
export { ToolRunner } from './tool-runner.js'
export { PluginRegistry } from './plugin-registry.js'
export { PluginLoader, createPluginScaffold } from './plugin-loader.js'

export {
  fsPlugin,
  execPlugin,
  memoryPlugin,
  reviewPlugin,
  pluginManagerPlugin
} from './plugins/index.js'

export type {
  ThinAgent,
  ThinCreateAgentOptions,
  PluginDefinition,
  PluginManifest,
  PluginPermissions,
  PluginToolDefinition,
  PluginToolResult,
  PluginInstallResult,
  StateStore,
  SessionEvent,
  DynamicPluginHandle
} from './types.js'
