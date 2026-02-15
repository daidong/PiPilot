import type {
  CoordinatorTurnResult,
  PlannerOutput,
  QueuedUserInput,
  ReviewerProcessReview,
  TurnSpec,
  YoloCoordinator,
  YoloStage
} from './types.js'

export class ScriptedCoordinator implements YoloCoordinator {
  private cursor = 0

  constructor(private readonly scriptedResults: CoordinatorTurnResult[]) {}

  async runTurn(_input: {
    turnSpec: TurnSpec
    stage: YoloStage
    goal: string
    mergedUserInputs: QueuedUserInput[]
    plannerOutput?: PlannerOutput
    reviewerOutput?: ReviewerProcessReview
  }): Promise<CoordinatorTurnResult> {
    if (this.cursor >= this.scriptedResults.length) {
      throw new Error('ScriptedCoordinator: no scripted result available for this turn')
    }

    const result = this.scriptedResults[this.cursor]
    this.cursor += 1
    return result
  }
}
