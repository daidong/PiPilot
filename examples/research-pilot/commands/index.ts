/**
 * Research Pilot CLI Commands
 */

// Legacy readline-based handlers
export { handleSaveNote, saveNote, getSaveNoteContent } from './save-note.js'
export { handleSelect, toggleSelect, getSelected, clearSelections } from './select.js'
export { handlePin, togglePin, getPinned } from './pin.js'

// Data-returning commands (for Ink UI)
export { listNotes, listLiterature, listData } from './list.js'
export { searchEntities } from './search.js'
export { savePaper, parseSavePaperArgs } from './save-paper.js'
export { saveData, parseSaveDataArgs } from './save-data.js'
export { deleteEntity } from './delete.js'

// Types
export type { SaveNoteResult } from './save-note.js'
export type { SelectResult, SelectedEntity } from './select.js'
export type { PinResult, PinnedEntity } from './pin.js'
export type { NoteListItem, LiteratureListItem, DataListItem } from './list.js'
export type { SearchResult } from './search.js'
export type { SavePaperResult } from './save-paper.js'
export type { SaveDataResult } from './save-data.js'
export type { DeleteResult } from './delete.js'
