/**
 * Shared compute types — currently re-exported from lib/local-compute.
 *
 * In §7.2 of RFC-008, the definitions will physically move here and
 * local-compute will re-export from this module instead. The deletion
 * of lib/local-compute is §7.10. Keeping them re-exported for now
 * avoids churn in untouched call sites.
 */
export type { FailureCode, FailureSignal, StructuredProgress, OutputProgress } from '../local-compute/types.js'
