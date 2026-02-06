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

// Focus canonical surface
export {
  focusAdd,
  focusList,
  focusRemove,
  focusClear,
  focusPrune
} from './focus.js'

// Task anchor canonical surface
export {
  taskAnchorGet,
  taskAnchorSet,
  taskAnchorUpdate
} from './task-anchor.js'

// Explain canonical surface
export {
  memoryExplainTurn,
  memoryExplainFact,
  memoryExplainBudget
} from './memory-explain.js'

// Legacy compatibility wrappers
export { saveNote } from './save-note.js'
export { savePaper, parseSavePaperArgs } from './save-paper.js'
export { saveData, parseSaveDataArgs } from './save-data.js'
export { deleteEntity } from './delete.js'
export { listAllArtifacts, listNotes, listLiterature, listData } from './list.js'
export { searchEntities } from './search.js'
export { toggleSelect, getSelected, clearSelections } from './select.js'
export { togglePin, getPinned } from './pin.js'

// Types
export type { ArtifactCreateResult, ArtifactUpdateResult, ArtifactDeleteResult, ArtifactSearchResult } from './artifact.js'
export type { FocusAddResult, FocusListResult, FocusRemoveResult, FocusPruneResult } from './focus.js'
export type { TaskAnchorResult } from './task-anchor.js'
export type { MemoryExplainResult } from './memory-explain.js'

export type { SaveNoteResult } from './save-note.js'
export type { SavePaperResult } from './save-paper.js'
export type { SaveDataResult } from './save-data.js'
export type { DeleteResult } from './delete.js'
export type { ArtifactListItem, NoteListItem, LiteratureListItem, DataListItem } from './list.js'
export type { SearchResult } from './search.js'
export type { SelectResult, SelectedEntity } from './select.js'
export type { PinResult, PinnedEntity } from './pin.js'
