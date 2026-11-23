import { z } from "zod";

import type { Message } from "./contracts.js";
import type { DataPoint, Output } from "./types.js";

export const DEFAULT_TRACE_QUERY_LIMIT = 20;

const ISO_DATETIME =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?)?$/;

/**
 * Epoch seconds of an ISO-8601 string, or null when it is not one. `Date.parse`
 * stops at milliseconds, which ties spans that differ by microseconds.
 */
export function parseIsoTimestamp(
  value: string,
  options: { naive: "utc" | "local" },
): number | null {
  const match = ISO_DATETIME.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  const offset = match[8];
  let epochMs: number;
  if (offset || options.naive === "utc") {
    epochMs = Date.UTC(year, month - 1, day, hour, minute, second);
  } else {
    epochMs = new Date(year, month - 1, day, hour, minute, second).getTime();
  }
  let seconds = epochMs / 1000;
  if (offset && offset !== "Z") {
    const digits = offset.slice(1).replaceAll(":", "");
    const magnitude =
      Number(digits.slice(0, 2)) * 3600 +
      Number(digits.slice(2, 4) || 0) * 60 +
      Number(digits.slice(4, 6) || 0);
    seconds += offset.startsWith("-") ? magnitude : -magnitude;
  }
  const fraction = match[7];
  return fraction ? seconds + Number(`0.${fraction.slice(0, 6)}`) : seconds;
}

function toDate(value: Date | string, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${field} is not a valid date.`);
    }
    return value;
  }
  const seconds = parseIsoTimestamp(value, { naive: "utc" });
  if (seconds === null) {
    throw new Error(`${field} is not an ISO-8601 datetime: ${value}`);
  }
  return new Date(Math.trunc(seconds * 1000));
}

const TraceFilterSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    op: z.enum([
      "eq",
      "neq",
      "in",
      "not_in",
      "gt",
      "gte",
      "lt",
      "lte",
      "between",
      "contains",
      "exists",
      "not_exists",
    ]),
    values: z
      .array(z.string().max(4096))
      .max(100)
      .default(() => []),
  })
  .strict();
export type TraceFilter = z.input<typeof TraceFilterSchema>;

const TraceInputOptionsSchema = z
  .object({
    traceId: z.string().nullish(),
    spanId: z.string().nullish(),
    limit: z.number().int().min(1).nullish(),
    startTime: z.union([z.date(), z.string()]).nullish(),
    endTime: z.union([z.date(), z.string()]).nullish(),
    search: z.string().max(512).optional(),
    filters: z.array(TraceFilterSchema).max(20).optional(),
  })
  .strict();

export type TraceInputOptions = z.input<typeof TraceInputOptionsSchema>;

/**
 * One exact trace/span, one trace, or a bounded trace search. The modes are
 * exclusive, `limit` included: trace mode never reads it, so accepting it would
 * answer `limit: 50` with one trace and no warning. A string time without an
 * offset is read as UTC, so one query means one window on every host. V3
 * searches require both startTime and endTime; trace-ID fetches need neither.
 * Filters use the v3 field/op/values contract.
 */
export class TraceInput {
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly limit: number | null;
  readonly startTime: Date | null;
  readonly endTime: Date | null;
  readonly search: string;
  readonly filters: z.output<typeof TraceFilterSchema>[];

  constructor(options: TraceInputOptions = {}) {
    const parsed = TraceInputOptionsSchema.parse(options);
    this.traceId = parsed.traceId ?? null;
    this.spanId = parsed.spanId ?? null;
    this.limit = parsed.limit ?? null;
    this.startTime =
      parsed.startTime != null ? toDate(parsed.startTime, "startTime") : null;
    this.endTime =
      parsed.endTime != null ? toDate(parsed.endTime, "endTime") : null;
    this.search = parsed.search ?? "";
    this.filters = parsed.filters ?? [];
    if (this.spanId !== null && this.traceId === null) {
      throw new Error("spanId requires traceId.");
    }
    if (
      this.traceId !== null &&
      (this.search ||
        this.filters.length > 0 ||
        this.startTime ||
        this.endTime ||
        this.limit !== null)
    ) {
      throw new Error(
        "traceId cannot be combined with trace search criteria or limit.",
      );
    }
    if (this.startTime && this.endTime && this.startTime >= this.endTime) {
      throw new Error("startTime must be before endTime.");
    }
  }

  get queryLimit(): number {
    return this.limit ?? DEFAULT_TRACE_QUERY_LIMIT;
  }
}

export type TraceMessageFormat =
  | "chat_completions"
  | "responses"
  | "otel_genai"
  | "mixed";

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropNulls);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== null && inner !== undefined)
        .map(([key, inner]) => [key, dropNulls(inner)]),
    );
  }
  return value;
}

function dumpMessages(messages: readonly Message[]): unknown[] {
  return messages.map(dropNulls);
}

export interface TraceFields {
  traceId: string;
  requestedSpanId?: string | null;
  messageSpanId?: string | null;
  messageFormat?: TraceMessageFormat | null;
  inputMessages?: Message[];
  outputMessages?: Message[];
  query?: string | null;
  retrievals?: string[];
  toolsCalled?: string[];
  sessionId?: string | null;
  actorId?: string | null;
  threadId?: string | null;
  metadata?: Record<string, unknown>;
  expectedOutput?: Output;
  importError?: string | null;
}

/**
 * A normalized Orq trace exchange. `inputMessages` and `outputMessages` keep
 * their source-side boundaries; `messages` is the derived single transcript.
 */
export class Trace {
  readonly traceId: string;
  readonly requestedSpanId: string | null;
  readonly messageSpanId: string | null;
  readonly messageFormat: TraceMessageFormat | null;
  readonly inputMessages: Message[];
  readonly outputMessages: Message[];
  readonly query: string | null;
  readonly retrievals: string[];
  readonly toolsCalled: string[];
  readonly sessionId: string | null;
  readonly actorId: string | null;
  readonly threadId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly expectedOutput: Output;
  readonly importError: string | null;

  constructor(fields: TraceFields) {
    this.traceId = fields.traceId;
    this.requestedSpanId = fields.requestedSpanId ?? null;
    this.messageSpanId = fields.messageSpanId ?? null;
    this.messageFormat = fields.messageFormat ?? null;
    this.inputMessages = fields.inputMessages ?? [];
    this.outputMessages = fields.outputMessages ?? [];
    this.query = fields.query ?? null;
    this.retrievals = fields.retrievals ?? [];
    this.toolsCalled = fields.toolsCalled ?? [];
    this.sessionId = fields.sessionId ?? null;
    this.actorId = fields.actorId ?? null;
    this.threadId = fields.threadId ?? null;
    this.metadata = fields.metadata ?? {};
    this.expectedOutput = fields.expectedOutput ?? null;
    this.importError = fields.importError ?? null;
    if (
      this.importError !== null &&
      (this.inputMessages.length > 0 || this.outputMessages.length > 0)
    ) {
      throw new Error(
        "A Trace with importError set cannot carry input or output messages.",
      );
    }
  }

  /** Input followed by output, without one duplicated boundary. */
  get messages(): Message[] {
    const input = dumpMessages(this.inputMessages).map((m) =>
      JSON.stringify(m),
    );
    const output = dumpMessages(this.outputMessages).map((m) =>
      JSON.stringify(m),
    );
    let overlap = 0;
    for (let size = Math.min(input.length, output.length); size > 0; size--) {
      const tail = input.slice(input.length - size);
      if (tail.every((text, index) => text === output[index])) {
        overlap = size;
        break;
      }
    }
    return [...this.inputMessages, ...this.outputMessages.slice(overlap)];
  }

  toDatapoint(): DataPoint {
    const inputs: Record<string, unknown> = {
      messages: dumpMessages(this.messages),
      recordedOutput: dumpMessages(this.outputMessages),
      query: this.query,
      sourceTraceId: this.traceId,
      sourceRequestedSpanId: this.requestedSpanId,
      sourceSpanId: this.messageSpanId,
      messageFormat: this.messageFormat,
      retrievals: [...this.retrievals],
      toolsCalled: [...this.toolsCalled],
      sessionId: this.sessionId,
      actorId: this.actorId,
      threadId: this.threadId,
      traceMetadata: { ...this.metadata },
    };
    if (this.importError !== null) {
      inputs.traceImportError = this.importError;
    }
    return { inputs, expectedOutput: this.expectedOutput };
  }
}
