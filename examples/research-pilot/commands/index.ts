/**
 * Research Pilot Commands (RFC-012)
 */

// Artifact canonical surface
export {
  artifactCreate,
  artifactUpdate,
  artifactGet,
  artifactList,
  artifactSearch,
  artifactDelete
} from './artifact.js'

// Explain (read-only, retained for ContextDebugView)
export {
  memoryExplainTurn
} from './memory-explain.js'

// Session summary
export {
  sessionSummaryGet
} from './session-summary.js'

// Paper enrichment
export {
  enrichPaperArtifacts
} from './paper-enrichment.js'

// Compatibility wrappers
export { savePaper, parseSavePaperArgs } from './save-paper.js'
export { saveData, parseSaveDataArgs } from './save-data.js'
export { deleteEntity } from './delete.js'
export { listAllArtifacts, listNotes, listLiterature, listData } from './list.js'
export { searchEntities } from './search.js'

// Types
export type { ArtifactCreateResult, ArtifactUpdateResult, ArtifactDeleteResult, ArtifactSearchResult } from './artifact.js'
export type { MemoryExplainResult } from './memory-explain.js'
export type { SessionSummaryResult } from './session-summary.js'
export type { EnrichPapersResult, EnrichPapersProgress } from './paper-enrichment.js'
export type { SavePaperResult } from './save-paper.js'
export type { SaveDataResult } from './save-data.js'
export type { DeleteResult } from './delete.js'
export type { ArtifactListItem, NoteListItem, LiteratureListItem, DataListItem } from './list.js'
export type { SearchResult } from './search.js'
