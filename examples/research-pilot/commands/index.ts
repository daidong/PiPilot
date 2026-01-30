/**
 * Research Pilot Commands
 */

// Entity CRUD
export { saveNote } from './save-note.js'
export { savePaper, parseSavePaperArgs } from './save-paper.js'
export { saveData, parseSaveDataArgs } from './save-data.js'
export { deleteEntity } from './delete.js'

// Entity queries
export { listNotes, listLiterature, listData } from './list.js'
export { searchEntities } from './search.js'

// Selection & pinning
export { toggleSelect, getSelected, clearSelections } from './select.js'
export { togglePin, getPinned } from './pin.js'

// Types
export type { SaveNoteResult } from './save-note.js'
export type { SavePaperResult } from './save-paper.js'
export type { SaveDataResult } from './save-data.js'
export type { DeleteResult } from './delete.js'
export type { NoteListItem, LiteratureListItem, DataListItem } from './list.js'
export type { SearchResult } from './search.js'
export type { SelectResult, SelectedEntity } from './select.js'
export type { PinResult, PinnedEntity } from './pin.js'
