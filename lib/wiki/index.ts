/**
 * Wiki module — public API re-exports.
 */

export { createWikiAgent } from './agent.js'
export { createWikiLookupTool } from './tool.js'
export { getWikiRoot, type WikiAgent, type WikiAgentConfig, type WikiStatus, type WikiPacingConfig } from './types.js'
export { countPaperPages, countConceptPages, countByFulltextStatus, readRecentLog, listWikiPages, readWikiPage, wikiSlugForPaperArtifact, buildPaperSlugMap } from './io.js'
export type { WikiPageEntry } from './io.js'

// RFC-005 memory sidecar + retrieval layer
export {
  WIKI_MEMORY_SCHEMA_VERSION,
  WikiPaperMemoryMetaV3,
  WikiConceptMemoryMetaV3,
  type WikiPaperMemoryMeta,
  type WikiConceptMemoryMeta,
  type DatasetEntry,
  type FindingEntry,
  type ConceptEdge,
  type ProjectLens,
} from './memory-schema.js'
export {
  parsePaperPage,
  writeMetaBlockInto,
  serializeMetaBlock,
  tryRepairJson,
  validateAndCoerce,
  type MetaParseOutcome,
  type ParseStatus,
} from './meta-parser.js'
export { rebuildMemoryIndex, loadFacets, loadBy } from './indexer.js'
export { createWikiTools } from './wiki-tools.js'
