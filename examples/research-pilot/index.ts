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
export { createDataAgent, dataAnalyzer } from './agents/data-agent.js'
export { createWritingAgent, writingOutliner, writingDrafter } from './agents/writing-agent.js'
export { createDataAnalyzer } from './agents/data-team.js'
export type { AnalyzeResult } from './agents/data-team.js'

// Commands
export {
  saveNote,
  savePaper, parseSavePaperArgs,
  saveData, parseSaveDataArgs,
  deleteEntity,
  listNotes, listLiterature, listData,
  searchEntities,
  toggleSelect, getSelected, clearSelections,
  togglePin, getPinned
} from './commands/index.js'

export type {
  SaveNoteResult,
  SelectResult, SelectedEntity,
  PinResult, PinnedEntity,
  NoteListItem, LiteratureListItem, DataListItem,
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
  Provenance,
  ResearchEntity,
  Note,
  Literature,
  DataAttachment,
  DataSchema,
  Entity,
  UserCorrection,
  ProjectConfig,
  Session,
  CLIContext,
  ColumnSchemaDetailed,
  ResultsManifest
} from './types.js'
