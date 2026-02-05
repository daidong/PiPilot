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
  createProjectCardsPhase,
  createSelectedPhase,
  createSessionPhase,
  createIndexPhase,
  createStateSummaryPhase,
  isSessionItemExpired,
  cleanExpiredSessionItems,
  type SystemPhaseConfig,
  type PinnedPhaseConfig,
  type ProjectCardsPhaseConfig,
  type SelectedPhaseConfig,
  type SessionPhaseConfig,
  type IndexPhaseConfig,
  type StateSummaryPhaseConfig
} from './phases/index.js'

// Compressors
export {
  SimpleHistoryCompressor,
  createSimpleCompressor,
  type SimpleHistoryCompressorConfig
} from './compressors/index.js'

// WorkingSet Builder (RFC-009)
export {
  ContinuityTracker,
  searchEntities,
  buildWorkingSet,
  createWorkingSetPhase,
  type WorkingSetBuilderConfig,
  type WorkingSetBuildInput,
  type WorkingSetPhaseConfig,
  type ContinuityEntry,
  type EntityIndex,
  type WorkingSetResolvedEntity
} from './workingset-builder.js'

// Shape Degrader (RFC-009)
export {
  ShapeDegrader,
  createShapeDegrader,
  getDegradationLevel,
  getTargetShape,
  isMoreDegraded,
  generateShapeContent,
  type DegradationLevel,
  type ShapeDegraderConfig,
  type DegradableItem,
  type DegradationResult
} from './shape-degrader.js'
