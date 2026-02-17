import type { TurnContext, TurnDecision, YoloSingleAgent } from './types.js'

export class ScriptedSingleAgent implements YoloSingleAgent {
  private cursor = 0

  constructor(private readonly scriptedDecisions: TurnDecision[]) {}

  async decide(_context: TurnContext): Promise<TurnDecision> {
    if (this.cursor >= this.scriptedDecisions.length) {
      return {
        intent: 'No more scripted decisions; stop cleanly.',
        action: {
          kind: 'Stop',
          reason: 'Script exhausted.'
        },
        updateSummary: ['No more scripted actions available.']
      }
    }

    const decision = this.scriptedDecisions[this.cursor]
    this.cursor += 1
    return decision
  }
}
