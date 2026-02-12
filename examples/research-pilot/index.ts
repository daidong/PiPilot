/**
 * Research Pilot - Library Entry Point
 *
 * Headless library exposing agents, commands, mentions, and types
 * for consumption by UI frontends (e.g. research-pilot-desktop).
 */

// Agents
export { createCoordinator, createCoordinatorRunner } from './agents/coordinator.js'
export type { CoordinatorConfig } from './agents/coordinator.js'
export { createLiteratureTeam } from './agents/literature-team.js'
export { createDataAnalyzer } from './agents/data-team.js'
export type { AnalyzeResult } from './agents/data-team.js'

// Skills
export { academicWritingSkill, literatureSkill, dataAnalysisSkill, researchPilotSkills } from './skills/index.js'

// Commands
export {
  artifactCreate,
  artifactUpdate,
  artifactGet,
  artifactList,
  artifactSearch,
  artifactDelete,
  memoryExplainTurn,
  sessionSummaryGet,
  enrichPaperArtifacts,

  // Compatibility exports
  savePaper, parseSavePaperArgs,
  saveData, parseSaveDataArgs,
  deleteEntity,
  listAllArtifacts, listNotes, listLiterature, listData,
  searchEntities,
} from './commands/index.js'

export type {
  ArtifactCreateResult,
  ArtifactUpdateResult,
  ArtifactDeleteResult,
  ArtifactSearchResult,
  MemoryExplainResult,
  SessionSummaryResult,
  EnrichPapersResult,
  EnrichPapersProgress,
  ArtifactListItem,
  NoteListItem,
  LiteratureListItem,
  DataListItem,
  SearchResult,
  SavePaperResult,
  SaveDataResult,
  DeleteResult
} from './commands/index.js'

// Mentions
export { parseMentions, resolveMentions, getCandidates } from './mentions/index.js'
export type { MentionType, MentionRef, ParseResult, ResolvedMention, MentionCandidate } from './mentions/index.js'

// Mention utilities
export { setCachedMarkdown, fileUriToPath } from './mentions/document-cache.js'

// Types
export {
  PATHS
} from './types.js'

export type {
  ArtifactType,
  Provenance,
  Artifact,
  NoteArtifact,
  PaperArtifact,
  DataArtifact,
  WebContentArtifact,
  ToolOutputArtifact,
  SessionSummary,
  DataSchema,

  // Compatibility aliases
  ResearchEntity,
  Note,
  Literature,
  DataAttachment,
  Entity,

  UserCorrection,
  ProjectConfig,
  Session,
  CLIContext,
  ColumnSchemaDetailed,
  ResultsManifest
} from './types.js'
