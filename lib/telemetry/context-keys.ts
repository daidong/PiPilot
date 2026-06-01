/**
 * OTel context keys (Phase T — turn-id propagation).
 *
 * Leaf module: holds only `symbol` constants used as OTel `context.setValue` /
 * `context.getValue` keys. No heavy imports, so the ledger writers can read a
 * turn id off the active context without dragging the tracer SDK into their
 * import graph.
 *
 * Why a shared constant rather than each module minting its own:
 * `Symbol.for(...)` returns the same registered symbol across modules even if
 * the bundler duplicates this file, so independent `getValue`/`setValue` calls
 * still resolve to the same key. Exporting the constant additionally guards
 * against description typos.
 */

/**
 * Active user-turn id (`pipilot.turn.id`). Published on the OTel context by the
 * coordinator for the lifetime of one user turn (and around auto-recap). Every
 * span created inside that context inherits the attribute via `startSpan`;
 * background work that detaches via `ROOT_CONTEXT` (memory extractor, wiki-bg)
 * is deliberately excluded because the value is read from the resolved parent
 * context, not the global active one.
 */
export const TURN_ID_KEY = Symbol.for('pipilot.telemetry.turnId')
