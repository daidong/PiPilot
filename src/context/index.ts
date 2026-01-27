/**
 * Context Module - Context Assembly Pipeline
 *
 * Exports pipeline creation and built-in phases for context assembly.
 */

// Pipeline core
export {
  createContextPipeline,
  createBudget,
  PHASE_PRIORITIES,
  DEFAULT_BUDGETS,
  type ContextPipelineConfig
} from './pipeline.js'

// Built-in phases
export {
  createSystemPhase,
  createPinnedPhase,
  createSelectedPhase,
  createSessionPhase,
  createIndexPhase,
  type SystemPhaseConfig,
  type PinnedPhaseConfig,
  type SelectedPhaseConfig,
  type SessionPhaseConfig,
  type IndexPhaseConfig
} from './phases/index.js'

// Compressors
export {
  SimpleHistoryCompressor,
  createSimpleCompressor,
  type SimpleHistoryCompressorConfig
} from './compressors/index.js'
