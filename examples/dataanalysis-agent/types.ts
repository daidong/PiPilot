/**
 * Data Analysis Multi-Agent System Types
 *
 * This file contains all TypeScript interfaces and constants used by
 * the data analysis team of agents.
 */

import type { AgentConfig } from '../../src/index.js'

// ============================================================================
// Database Configuration
// ============================================================================

/**
 * Supported database types for analysis
 */
export type DatabaseType = 'postgresql' | 'mysql' | 'sqlite'

/**
 * Configuration for connecting to a database
 */
export interface DatabaseConfig {
  type: DatabaseType
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  path?: string // For SQLite file path
}

// ============================================================================
// Team Configuration
// ============================================================================

/**
 * Configuration for creating a Data Analysis Team
 */
export interface DataAnalysisTeamConfig extends Pick<AgentConfig, 'apiKey' | 'projectPath'> {
  /** Named database connections available to the executor */
  databases?: Record<string, DatabaseConfig>
  /** Maximum review-refine loop iterations (default: 3) */
  maxReviewIterations?: number
  /** Progress callback for monitoring execution */
  onProgress?: (info: ProgressInfo) => void
}

/**
 * Progress information emitted during team execution
 */
export interface ProgressInfo {
  agent: string
  status: string
  step?: number
}

// ============================================================================
// Analysis Plan
// ============================================================================

/**
 * Step types that the executor can perform
 */
export type AnalysisStepType = 'sql' | 'python' | 'file' | 'fetch' | 'transform'

/**
 * A single step in an analysis plan
 */
export interface AnalysisStep {
  id: string
  type: AnalysisStepType
  description: string
  command: string
  /** Optional dependency on previous step IDs */
  dependsOn?: string[]
}

/**
 * Complete analysis plan created by the planner agent
 */
export interface AnalysisPlan {
  id: string
  originalRequest: string
  steps: AnalysisStep[]
  /** Identified data sources */
  dataSources?: string[]
  /** Expected output format */
  expectedOutput?: string
}

// ============================================================================
// Analysis Results
// ============================================================================

/**
 * Results from executing an analysis plan
 */
export interface AnalysisResults {
  success: boolean
  data: unknown
  summary: string
  executionTimeMs: number
  /** Step-by-step execution details */
  stepResults?: StepResult[]
  /** Error message if success is false */
  error?: string
}

/**
 * Result from executing a single analysis step
 */
export interface StepResult {
  stepId: string
  success: boolean
  output: unknown
  durationMs: number
  error?: string
}

// ============================================================================
// Review Feedback
// ============================================================================

/**
 * Severity levels for review issues
 */
export type IssueSeverity = 'critical' | 'major' | 'minor'

/**
 * An issue identified during review
 */
export interface ReviewIssue {
  severity: IssueSeverity
  message: string
  /** Related step ID if applicable */
  stepId?: string
}

/**
 * Feedback from the reviewer agent
 */
export interface ReviewFeedback {
  approved: boolean
  confidence: number // 0.0 to 1.0
  issues: ReviewIssue[]
  suggestions: string[]
  /** Summary of review findings */
  reviewSummary?: string
}

// ============================================================================
// Shared State (Blackboard)
// ============================================================================

/**
 * The complete analysis state stored in the team's blackboard
 */
export interface AnalysisState {
  plan?: AnalysisPlan
  results?: AnalysisResults
  feedback?: ReviewFeedback
  /** Number of review iterations completed */
  reviewIterations?: number
  /** Original user request */
  userRequest?: string
}

// ============================================================================
// Constants
// ============================================================================

/**
 * State path keys for blackboard storage
 */
export const STATE_PATHS = {
  PLAN: 'plan',
  RESULTS: 'results',
  FEEDBACK: 'feedback',
  REVIEW_ITERATIONS: 'reviewIterations',
  USER_REQUEST: 'userRequest'
} as const

/**
 * Default configuration values
 */
export const DEFAULTS = {
  MAX_REVIEW_ITERATIONS: 3,
  MAX_QUERY_ROWS: 1000,
  EXECUTION_TIMEOUT_MS: 120000,
  PLANNER_MAX_STEPS: 10,
  EXECUTOR_MAX_STEPS: 30,
  REVIEWER_MAX_STEPS: 5
} as const

/**
 * Session state keys for agent-specific state
 */
export const SESSION_KEYS = {
  DATABASE_PREFIX: 'db:',
  EXECUTION_HISTORY: 'execution:history',
  QUERY_COUNT: 'execution:queryCount'
} as const
