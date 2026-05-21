/**
 * Bounded backend availability probing.
 *
 * A backend's probeAvailability() shells out (Modal CLI, docker daemon, AWS
 * STS) and can hang on a blocked network or stuck daemon. Every caller —
 * Registry register/hydrate/refresh and the list_compute_backends tool — must
 * race it against a hard timeout so one hung backend can't stall the whole
 * compute surface. This helper was copy-pasted in registry.ts and tools.ts
 * (the tool copy silently lacked the `force` option); it now lives once.
 */

import type { ComputeBackend } from './backend.js'
import type { BackendAvailability } from './types.js'

/** Bound on every availability probe. */
export const PROBE_TIMEOUT_MS = 3000

/**
 * Race a backend's probeAvailability against PROBE_TIMEOUT_MS. On throw or
 * timeout, resolve to `available: false` with a diagnostic requirement string
 * rather than rejecting — callers always get a usable answer.
 */
export function probeWithTimeout(
  backend: ComputeBackend,
  opts?: { force?: boolean },
): Promise<BackendAvailability> {
  return Promise.race([
    backend.probeAvailability(opts).catch((err): BackendAvailability => ({
      available: false,
      missingRequirements: [`Availability probe threw: ${err instanceof Error ? err.message : String(err)}`],
    })),
    new Promise<BackendAvailability>((resolve) =>
      setTimeout(
        () =>
          resolve({
            available: false,
            missingRequirements: [`Availability probe timed out after ${PROBE_TIMEOUT_MS}ms`],
          }),
        PROBE_TIMEOUT_MS,
      ),
    ),
  ])
}
