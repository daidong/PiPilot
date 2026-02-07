/**
 * Context Module - Shared Context Utilities
 *
 * Exports WorkingSet Builder and Shape Degrader (used by Kernel V2).
 * V1 context pipeline has been removed; Kernel V2 is now mandatory.
 */

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
