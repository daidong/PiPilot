/**
 * Built-in Context Phases - Export all phase creators
 */

export {
  createSystemPhase,
  type SystemPhaseConfig
} from './system-phase.js'

export {
  createPinnedPhase,
  type PinnedPhaseConfig
} from './pinned-phase.js'

export {
  createSelectedPhase,
  type SelectedPhaseConfig
} from './selected-phase.js'

export {
  createSessionPhase,
  type SessionPhaseConfig
} from './session-phase.js'

export {
  createIndexPhase,
  type IndexPhaseConfig
} from './index-phase.js'
