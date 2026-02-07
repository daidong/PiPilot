import type { KernelV2Config, KernelV2ResolvedConfig } from './types.js'
import { FRAMEWORK_DIR } from '../constants.js'

export function resolveKernelV2Config(config: KernelV2Config | undefined, contextWindow: number, modelId: string): KernelV2ResolvedConfig {
  return {
    enabled: config?.enabled ?? true,
    contextWindow,
    modelId,
    context: {
      protectedRecentTurns: config?.context?.protectedRecentTurns ?? 3,
      includeToolMessagesInProtectedZone: config?.context?.includeToolMessagesInProtectedZone ?? true,
      tailTaskAnchor: config?.context?.tailTaskAnchor ?? true,
      protectedMinTokens: config?.context?.protectedMinTokens ?? 1200
    },
    budget: {
      reserveOutput: {
        intermediate: config?.budget?.reserveOutput?.intermediate ?? 4096,
        final: config?.budget?.reserveOutput?.final ?? 8192,
        extended: config?.budget?.reserveOutput?.extended ?? 12288
      },
      softThreshold: config?.budget?.softThreshold ?? 0.82
    },
    continuity: {
      injectPreviousSessionSummary: config?.continuity?.injectPreviousSessionSummary ?? true,
      maxPreviousSessions: config?.continuity?.maxPreviousSessions ?? 2,
      injectActiveTasks: config?.continuity?.injectActiveTasks ?? true
    },
    memory: {
      writeGate: {
        enforced: true,
        maxWritesPerTurn: config?.memory?.writeGate?.maxWritesPerTurn ?? 20,
        maxWritesPerSession: config?.memory?.writeGate?.maxWritesPerSession ?? 500
      }
    },
    compaction: {
      enabled: config?.compaction?.enabled ?? true,
      preFlush: {
        enabled: config?.compaction?.preFlush?.enabled ?? true,
        timeoutMs: config?.compaction?.preFlush?.timeoutMs ?? 10000,
        writeReserve: config?.compaction?.preFlush?.writeReserve ?? 5,
        promptTemplate: config?.compaction?.preFlush?.promptTemplate
          ?? 'Context nearing compaction. Save only durable, high-signal facts and task updates now. Ignore transient details.',
        allowNoOp: config?.compaction?.preFlush?.allowNoOp ?? true,
        fallbackOnTimeout: 'skip'
      },
      requireReplayRefs: config?.compaction?.requireReplayRefs ?? true
    },
    retrieval: {
      hybrid: config?.retrieval?.hybrid ?? true,
      vectorWeight: config?.retrieval?.vectorWeight ?? 0.7,
      lexicalWeight: config?.retrieval?.lexicalWeight ?? 0.3,
      fallbackChain: config?.retrieval?.fallbackChain ?? ['hybrid', 'lexical', 'vector-only', 'raw-file-scan'],
      rawScanLimitTokens: config?.retrieval?.rawScanLimitTokens ?? 10000
    },
    telemetry: {
      baselineAlwaysOn: config?.telemetry?.baselineAlwaysOn ?? true,
      mode: config?.telemetry?.mode ?? 'stderr+file',
      filePath: config?.telemetry?.filePath ?? `${FRAMEWORK_DIR}/logs/kernel-v2.log`
    },
    lifecycle: {
      autoWeekly: config?.lifecycle?.autoWeekly ?? true,
      decayThresholdDays: config?.lifecycle?.decayThresholdDays ?? 90
    },
    storage: {
      integrity: {
        verifyOnStartup: config?.storage?.integrity?.verifyOnStartup ?? true
      },
      recovery: {
        autoTruncateToLastValidRecord: config?.storage?.recovery?.autoTruncateToLastValidRecord ?? true,
        createRecoverySnapshot: config?.storage?.recovery?.createRecoverySnapshot ?? true
      }
    }
  }
}
