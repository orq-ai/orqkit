import { z } from "zod";

const ExperimentInputSchema = z.object({
  experimentId: z.string(),
  runId: z.string().nullable().optional(),
});
export interface ExperimentInputOptions {
  experimentId: string;
  runId?: string | null;
}
export class ExperimentInput {
  readonly experimentId: string;
  readonly runId: string | null;
  constructor(options: ExperimentInputOptions) {
    const parsed = ExperimentInputSchema.parse(options);
    this.experimentId = parsed.experimentId;
    this.runId = parsed.runId ?? null;
  }
}
