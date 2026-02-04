/**
 * Built-in Context Phases - Export all phase creators
 */

export {
  createSystemPhase,
  type SystemPhaseConfig
} from './system-phase.js'

// Legacy pinned phase (deprecated, use project-cards-phase)
export {
  createPinnedPhase,
  type PinnedPhaseConfig
} from './pinned-phase.js'

// Project Cards phase (RFC-009)
export {
  createProjectCardsPhase,
  type ProjectCardsPhaseConfig
} from './project-cards-phase.js'

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

// State Summary phase (RFC-009)
export {
  createStateSummaryPhase,
  isSessionItemExpired,
  cleanExpiredSessionItems,
  type StateSummaryPhaseConfig
} from './state-summary-phase.js'
