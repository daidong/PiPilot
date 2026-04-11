/**
 * Wiki module — public API re-exports.
 */

export { createWikiAgent } from './agent.js'
export { createWikiLookupTool } from './tool.js'
export { getWikiRoot, type WikiAgent, type WikiAgentConfig, type WikiStatus, type WikiPacingConfig } from './types.js'
export { countPaperPages, countConceptPages, countByFulltextStatus, readRecentLog } from './io.js'
