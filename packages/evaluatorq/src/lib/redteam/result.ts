import { z } from "zod";

import { xmlEscape } from "../common/sanitize.js";
import {
  type Message,
  MessageSchema,
  parseUsage,
  type Usage,
} from "../contracts.js";
import {
  ADVERSARIAL_ANALYSIS_PROMPT,
  ADVERSARIAL_INITIAL_USER_PROMPT,
} from "./adaptive/prompts.js";
import { type RunError, RunErrorSchema } from "./strategy.js";
import { Turn, turnsToMessages } from "./turn.js";

const savedUsage = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return parseUsage(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  })
  .nullable()
  .default(null);
const nullableString = z.string().nullable().default(null);
const ResultSchema = z.object({
  turns: z.array(z.unknown()).default(() => []),
  objectiveAchieved: z.boolean().default(false),
  objectiveRationale: nullableString,
  durationSeconds: z.number().default(0),
  tokenUsage: savedUsage,
  tokenUsageAdversarial: savedUsage,
  tokenUsageTarget: savedUsage,
  tokenUsageBootstrap: savedUsage,
  seedContext: z.array(MessageSchema).default(() => []),
  systemPrompt: nullableString,
  maxTurns: z.number().int().default(0),
  error: nullableString,
  errorType: nullableString,
  errorStage: nullableString,
  errorCode: nullableString,
  errorDetails: z.record(z.unknown()).nullable().default(null),
  errorTurn: z.number().int().nullable().default(null),
  truncatedTurns: z.array(z.number().int()).default(() => []),
  backtrackedTurns: z.array(z.unknown()).default(() => []),
  refusalJudgeFailures: z.number().int().default(0),
});
export type OrchestratorResultInput = z.input<typeof ResultSchema>;
export class OrchestratorResult {
  turns!: Turn[];
  objectiveAchieved!: boolean;
  objectiveRationale!: string | null;
  durationSeconds!: number;
  tokenUsage!: Usage | null;
  tokenUsageAdversarial!: Usage | null;
  tokenUsageTarget!: Usage | null;
  tokenUsageBootstrap!: Usage | null;
  seedContext!: Message[];
  systemPrompt!: string | null;
  maxTurns!: number;
  error!: string | null;
  errorType!: string | null;
  errorStage!: string | null;
  errorCode!: string | null;
  errorDetails!: Record<string, unknown> | null;
  errorTurn!: number | null;
  truncatedTurns!: number[];
  backtrackedTurns!: Turn[];
  refusalJudgeFailures!: number;
  constructor(input: OrchestratorResultInput | Record<string, unknown> = {}) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new TypeError("OrchestratorResult must be an object");
    const raw = { ...input } as Record<string, unknown>;
    for (const key of Object.keys(ResultSchema.shape)) {
      const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      if (!Object.hasOwn(raw, key) && Object.hasOwn(raw, snake))
        raw[key] = raw[snake];
    }
    const parsed = ResultSchema.parse(raw);
    Object.assign(this, parsed);
    this.turns = parsed.turns.map((value) =>
      value instanceof Turn
        ? value
        : new Turn(value as Record<string, unknown>),
    );
    this.backtrackedTurns = parsed.backtrackedTurns.map((value) =>
      value instanceof Turn
        ? value
        : new Turn(value as Record<string, unknown>),
    );
    if (this.maxTurns > 0 && this.maxTurns < this.turns.length)
      throw new RangeError(
        `maxTurns (${this.maxTurns}) must be >= turns.length (${this.turns.length})`,
      );
  }
  get nTurns(): number {
    return this.turns.length;
  }
  get finalResponse(): string {
    return this.turns.at(-1)?.target.text ?? "";
  }
  get chatCompletions(): Message[] {
    return turnsToMessages(this.turns);
  }
  attackerInputAt(index: number): Message[] {
    if (!Number.isInteger(index) || index < 0 || index > this.turns.length)
      throw new RangeError(
        `turn index ${index} out of range for ${this.turns.length} turns`,
      );
    const messages = [
      MessageSchema.parse({ role: "system", content: this.systemPrompt || "" }),
      MessageSchema.parse({
        role: "user",
        content: ADVERSARIAL_INITIAL_USER_PROMPT.replaceAll(
          "{max_turns}",
          String(this.maxTurns),
        ),
      }),
    ];
    for (const prior of this.turns.slice(0, index)) {
      messages.push(
        MessageSchema.parse({
          role: "assistant",
          content: prior.attacker.text,
        }),
        MessageSchema.parse({
          role: "user",
          content: ADVERSARIAL_ANALYSIS_PROMPT.replaceAll(
            "{response}",
            `<target_response>\n${xmlEscape(prior.target.text)}\n</target_response>`,
          ),
        }),
      );
    }
    return messages;
  }
  get errorInfo(): RunError | null {
    return this.error === null
      ? null
      : RunErrorSchema.parse({
          message: this.error,
          errorType: this.errorType || "unknown",
          stage: this.errorStage,
          code: this.errorCode,
          details: this.errorDetails,
          turn: this.errorTurn,
        });
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(
      Object.keys(ResultSchema.shape).map((key) => [
        key,
        key === "turns"
          ? this.turns.map((turn) => turn.toJSON())
          : key === "backtrackedTurns"
            ? this.backtrackedTurns.map((turn) => turn.toJSON())
            : this[key as keyof OrchestratorResult],
      ]),
    );
  }
}
export class AttackOutput extends OrchestratorResult {
  category: string;
  vulnerability: string;
  constructor(
    input: OrchestratorResultInput & {
      category?: string;
      vulnerability?: string;
    } = {},
  ) {
    super(input);
    const parsed = z
      .object({
        category: z.string().default(""),
        vulnerability: z.string().default(""),
      })
      .parse(input);
    this.category = parsed.category;
    this.vulnerability = parsed.vulnerability;
  }
  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      category: this.category,
      vulnerability: this.vulnerability,
    };
  }
}
