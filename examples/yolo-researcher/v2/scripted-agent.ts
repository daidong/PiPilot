import type { TurnContext, TurnRunOutcome, YoloSingleAgent } from './types.js'

export class ScriptedSingleAgent implements YoloSingleAgent {
  private cursor = 0

  constructor(private readonly scriptedOutcomes: TurnRunOutcome[]) {}

  async runTurn(_context: TurnContext): Promise<TurnRunOutcome> {
    if (this.cursor >= this.scriptedOutcomes.length) {
      return {
        intent: 'No more scripted outcomes; stop cleanly.',
        status: 'stopped',
        summary: 'Script exhausted.',
        stopReason: 'Script exhausted.',
        updateSummary: ['No more scripted outcomes available.']
      }
    }

    const outcome = this.scriptedOutcomes[this.cursor]
    this.cursor += 1
    return outcome
  }
}
