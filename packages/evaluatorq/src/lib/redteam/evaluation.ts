import { z } from "zod/v4";

import type { JuryResult, Usage } from "../contracts.js";
import { savedJury, savedUsage } from "./saved-model.js";

export const AttackEvaluationResultSchema = z.preprocess(
  (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const raw = { ...value } as Record<string, unknown>;
    for (const key of ["evaluatorId", "tokenUsage", "rawOutput"]) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (!(key in raw) && snake in raw) raw[key] = raw[snake];
    }
    return raw;
  },
  z.object({
    passed: z.boolean().nullable(),
    explanation: z.string(),
    evaluatorId: z.string(),
    tokenUsage: savedUsage.nullable().default(null),
    rawOutput: z.record(z.string(), z.unknown()).nullable().default(null),
    jury: savedJury.nullable().default(null),
  }),
);
export class AttackEvaluationResult {
  passed!: boolean | null;
  explanation!: string;
  evaluatorId!: string;
  tokenUsage!: Usage | null;
  rawOutput!: Record<string, unknown> | null;
  jury!: JuryResult | null;
  constructor(value: unknown) {
    Object.assign(this, AttackEvaluationResultSchema.parse(value));
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}
