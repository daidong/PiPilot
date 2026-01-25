/**
 * Protocols Module Exports
 */

export {
  // Protocol templates
  pipeline,
  fanOutFanIn,
  supervisorProtocol,
  criticRefineLoop,
  debate,
  voting,
  raceProtocol,
  gatedPipeline,
  builtinProtocols,

  // Registry
  ProtocolRegistry,
  createProtocolRegistry
} from './templates.js'

export type {
  ProtocolTemplate,
  ProtocolConfig
} from './templates.js'
