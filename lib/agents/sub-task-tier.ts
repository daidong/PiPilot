/**
 * Sub-task model-tier resolution (B-class sub-task sinking).
 *
 * Background: every internal `ctx.callLlm` sub-call used to run on the main
 * (flagship) model. The B-class sub-tasks — literature relevance review,
 * compute task-profiling, command risk assessment, SVG-fallback diagram
 * review — are stateless single-shot classification/extraction calls. They
 * never share the main conversation's prompt prefix, so running them on the
 * flagship model buys no prompt-cache benefit; sinking them to the cheap
 * router-tier model is cache-neutral and just trades raw per-token price.
 *
 * THE RULE: a call may sink only when it (a) opts in with `tier: 'light'` AND
 * (b) never carries conversation `messages`. Stateful, cache-bearing calls
 * always stay on the main model — switching their model would evict the warm
 * prompt cache and cost MORE. `ctx.callLlm`'s signature structurally enforces
 * (b): it only accepts `systemPrompt + userContent`, never a message array.
 *
 * NEVER-SINK members (each replays the main system prompt + conversation
 * `messages` on piModel for cache affinity, so each is its own path OUTSIDE
 * `ctx.callLlm` — by design, not debt):
 *   - recap            — coordinator.ts, `runSubLlmText({ model: piModel, messages })`
 *   - memory-extract   — lib/memory/extractor.ts, same shape
 * If you add a sub-call that needs conversation history, it joins this list:
 * keep it on piModel and do NOT give it a `tier: 'light'` opt-in.
 *
 * `subTaskModelTier` (Settings → Research, default `'light'`) is the global
 * control. Setting it to `'flagship'` overrides every opt-in back to the main
 * model — the A/B control group for measuring the cost/quality delta via the
 * existing per-purpose sub-LLM telemetry.
 */
import type { SubTaskModelTier } from '../../shared-ui/settings-types.js'

export interface SubTaskModelInputs<M> {
  /** The main, user-selected model. Always the safe fallback. */
  mainModel: M
  /** The cheap router-tier model, or null if the provider has no light tier. */
  lightModel: M | null
  /** Global control from Settings. */
  setting: SubTaskModelTier
}

/**
 * Pick the model for a sub-task call. Returns `lightModel` only when the call
 * opted in (`requestedTier === 'light'`), the global setting permits it, and a
 * light model actually exists; otherwise returns `mainModel`.
 */
export function resolveSubTaskModel<M>(
  requestedTier: SubTaskModelTier | undefined,
  inputs: SubTaskModelInputs<M>,
): M {
  const sinkable = requestedTier === 'light' && inputs.setting === 'light'
  if (sinkable && inputs.lightModel) return inputs.lightModel
  return inputs.mainModel
}
