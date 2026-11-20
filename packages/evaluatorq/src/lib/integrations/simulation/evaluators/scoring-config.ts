import { z } from "zod/v4";

const unit = z.number().min(0).max(1);
const ConfigSchema = z
  .object({
    turnEfficiencyCliffs: z
      .array(z.tuple([z.number().int().positive(), unit]))
      .nonempty()
      .default([
        [2, 1],
        [4, 0.9],
        [6, 0.7],
      ]),
    turnEfficiencyDecayPerTurn: unit.default(0.1),
    turnEfficiencyFloor: unit.default(0.3),
    goalAchievedWeight: unit.default(0.4),
    criteriaMetWeight: unit.default(0.3),
    turnEfficiencyWeight: unit.default(0.3),
  })
  .strict()
  .superRefine((value, context) => {
    let previousTurns = 0;
    let previousScore = 1;
    for (const [turns, score] of value.turnEfficiencyCliffs) {
      if (turns <= previousTurns || score > previousScore)
        context.addIssue({
          code: "custom",
          message:
            "turnEfficiencyCliffs must increase in turns and must not increase in score",
        });
      previousTurns = turns;
      previousScore = score;
    }
    if (value.turnEfficiencyFloor > previousScore)
      context.addIssue({
        code: "custom",
        message: "turnEfficiencyFloor exceeds the last cliff score",
      });
    if (
      Math.abs(
        value.goalAchievedWeight +
          value.criteriaMetWeight +
          value.turnEfficiencyWeight -
          1,
      ) > 1e-9
    )
      context.addIssue({
        code: "custom",
        message: "conversation quality weights must sum to 1",
      });
  });

export type SimulationScoringConfigInput = z.input<typeof ConfigSchema>;
export class SimulationScoringConfig {
  readonly turnEfficiencyCliffs: readonly (readonly [number, number])[];
  readonly turnEfficiencyDecayPerTurn: number;
  readonly turnEfficiencyFloor: number;
  readonly goalAchievedWeight: number;
  readonly criteriaMetWeight: number;
  readonly turnEfficiencyWeight: number;
  constructor(input: SimulationScoringConfigInput = {}) {
    const config = ConfigSchema.parse(input);
    this.turnEfficiencyCliffs = Object.freeze(
      config.turnEfficiencyCliffs.map((step) => Object.freeze(step)),
    );
    this.turnEfficiencyDecayPerTurn = config.turnEfficiencyDecayPerTurn;
    this.turnEfficiencyFloor = config.turnEfficiencyFloor;
    this.goalAchievedWeight = config.goalAchievedWeight;
    this.criteriaMetWeight = config.criteriaMetWeight;
    this.turnEfficiencyWeight = config.turnEfficiencyWeight;
    Object.freeze(this);
  }
}
export const DEFAULT_SCORING_CONFIG = new SimulationScoringConfig();
