import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { pythonStrip } from "../common/sanitize.js";
import { atifToOtel } from "./atif-to-otel.js";
import { atifToResponses } from "./convert-responses-atif.js";
import { parsePythonJson, pythonJson } from "./json.js";
import { parseIso } from "./time.js";

export const SUPPORTED_VERSIONS = ["ATIF-v1.7", "ATIF-v1.8"] as const;
type Row = Record<string, unknown>;
const record = (v: unknown): v is Row =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
function saved<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  return z.preprocess((value) => {
    if (!record(value)) return value;
    const out = { ...value };
    for (const key of Object.keys(schema.shape)) {
      const legacy = snake(key);
      if (legacy === key || !Object.hasOwn(out, legacy)) continue;
      if (Object.hasOwn(out, key) && !isDeepStrictEqual(out[key], out[legacy]))
        throw new TypeError(`Conflicting ${key} and ${legacy} values`);
      if (!Object.hasOwn(out, key)) out[key] = out[legacy];
      delete out[legacy];
    }
    return out;
  }, schema.readonly());
}
const FLOAT =
  /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;
function numberInput(v: unknown): unknown {
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "string" && FLOAT.test(pythonStrip(v))) {
    const s = pythonStrip(v).replaceAll("_", "");
    if (/^[+-]?inf(?:inity)?$/i.test(s))
      return s.startsWith("-") ? -Infinity : Infinity;
    return Number(s);
  }
  return v;
}
const float = z.preprocess(
  numberInput,
  z.custom<number>((v) => typeof v === "number"),
);
const integer = z.preprocess((v) => {
  if (typeof v === "boolean") return Number(v);
  if (
    typeof v === "string" &&
    /^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(pythonStrip(v))
  )
    return Number(pythonStrip(v).replaceAll("_", ""));
  return v;
}, z.number().int());
const dictionary = z
  .custom<Record<string, unknown>>(
    (value) =>
      record(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
  )
  .transform((value) => Object.fromEntries(Object.entries(value)));
const nullable = z.string().nullable().default(null),
  metadata = dictionary.nullable().default(null);
const bool = z.preprocess((v) => {
  if (v === 0 || v === 1) return Boolean(v);
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (["true", "t", "yes", "y", "on", "1"].includes(s)) return true;
    if (["false", "f", "no", "n", "off", "0"].includes(s)) return false;
  }
  return v;
}, z.boolean());
const AUDIO_ALIASES: Readonly<Record<string, string>> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpga": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
};
export const AtifImageSourceSchema = saved(
  z.strictObject({
    mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    path: z.string(),
  }),
);
export type AtifImageSource = z.infer<typeof AtifImageSourceSchema>;
export const AtifAudioSourceSchema = saved(
  z.strictObject({
    mediaType: z.preprocess(
      (v) => {
        if (typeof v !== "string") return v;
        const s = pythonStrip(v).toLowerCase();
        return Object.hasOwn(AUDIO_ALIASES, s) ? AUDIO_ALIASES[s] : s;
      },
      z.enum([
        "audio/wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
        "audio/aiff",
      ]),
    ),
    path: z.string(),
    durationSec: float
      .refine((v) => v >= 0)
      .nullable()
      .default(null),
  }),
);
export type AtifAudioSource = z.infer<typeof AtifAudioSourceSchema>;
export const AtifContentPartSchema = saved(
  z.strictObject({
    type: z.enum(["text", "image", "audio"]),
    text: nullable,
    source: z
      .union([AtifImageSourceSchema, AtifAudioSourceSchema])
      .nullable()
      .default(null),
  }),
).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.type === "text") {
    if (value.text === null) fail("text is required for a text part");
    if (value.source !== null) fail("source is not allowed for a text part");
  } else {
    if (value.source === null) fail("source is required for a media part");
    if (value.text !== null) fail("text is not allowed for a media part");
    if (value.source && !value.source.mediaType.startsWith(`${value.type}/`))
      fail("media source does not match the content part type");
  }
});
export type AtifContentPart = z.infer<typeof AtifContentPartSchema>;
const content = z.union([z.string(), z.array(AtifContentPartSchema)]);
export const AtifToolCallSchema = saved(
  z.strictObject({
    toolCallId: z.string(),
    functionName: z.string(),
    arguments: dictionary,
    extra: metadata,
  }),
);
export type AtifToolCall = z.infer<typeof AtifToolCallSchema>;
export const AtifSubagentRefSchema = saved(
  z.strictObject({
    trajectoryId: nullable,
    sessionId: nullable,
    trajectoryPath: nullable,
    extra: metadata,
  }),
).superRefine((value, ctx) => {
  if (value.trajectoryId === null && value.trajectoryPath === null)
    ctx.addIssue({
      code: "custom",
      message: "Subagent reference requires trajectoryId or trajectoryPath",
    });
});
export type AtifSubagentRef = z.infer<typeof AtifSubagentRefSchema>;
export const AtifObservationResultSchema = saved(
  z.strictObject({
    sourceCallId: nullable,
    content: content.nullable().default(null),
    subagentTrajectoryRef: z
      .array(AtifSubagentRefSchema)
      .nullable()
      .default(null),
    extra: metadata,
  }),
);
export type AtifObservationResult = z.infer<typeof AtifObservationResultSchema>;
export const AtifObservationSchema = saved(
  z.strictObject({ results: z.array(AtifObservationResultSchema) }),
);
export type AtifObservation = z.infer<typeof AtifObservationSchema>;
export const AtifMetricsSchema = saved(
  z.strictObject({
    promptTokens: integer.nullable().default(null),
    completionTokens: integer.nullable().default(null),
    cachedTokens: integer.nullable().default(null),
    costUsd: float.nullable().default(null),
    promptTokenIds: z.array(integer).nullable().default(null),
    completionTokenIds: z.array(integer).nullable().default(null),
    logprobs: z.array(float).nullable().default(null),
    extra: metadata,
  }),
);
export type AtifMetrics = z.infer<typeof AtifMetricsSchema>;
export const AtifFinalMetricsSchema = saved(
  z.strictObject({
    totalPromptTokens: integer.nullable().default(null),
    totalCompletionTokens: integer.nullable().default(null),
    totalCachedTokens: integer.nullable().default(null),
    totalCostUsd: float.nullable().default(null),
    totalSteps: integer
      .refine((v) => v >= 0)
      .nullable()
      .default(null),
    extra: metadata,
  }),
);
export type AtifFinalMetrics = z.infer<typeof AtifFinalMetricsSchema>;
export const AtifAgentSchema = saved(
  z.strictObject({
    name: z.string(),
    version: z.string(),
    modelName: nullable,
    toolDefinitions: z.array(dictionary).nullable().default(null),
    extra: metadata,
  }),
);
export type AtifAgent = z.infer<typeof AtifAgentSchema>;
export const AtifStepSchema = saved(
  z.strictObject({
    stepId: integer.refine((v) => v >= 1),
    timestamp: z
      .string()
      .refine((v) => {
        try {
          parseIso(v);
          return true;
        } catch {
          return false;
        }
      }, "Invalid ISO 8601 timestamp")
      .nullable()
      .default(null),
    source: z.enum(["system", "user", "agent"]),
    modelName: nullable,
    reasoningEffort: z.union([z.string(), float]).nullable().default(null),
    message: content,
    reasoningContent: nullable,
    toolCalls: z.array(AtifToolCallSchema).nullable().default(null),
    observation: AtifObservationSchema.nullable().default(null),
    metrics: AtifMetricsSchema.nullable().default(null),
    isCopiedContext: bool.nullable().default(null),
    llmCallCount: integer
      .refine((v) => v >= 0)
      .nullable()
      .default(null),
    extra: metadata,
  }),
).superRefine((step, ctx) => {
  if (step.source !== "agent")
    for (const field of [
      "modelName",
      "reasoningEffort",
      "reasoningContent",
      "toolCalls",
      "metrics",
    ] as const)
      if (step[field] !== null)
        ctx.addIssue({
          code: "custom",
          message: `${field} is only applicable to agent steps`,
        });
  if (step.source === "agent" && step.llmCallCount === 0)
    for (const field of ["metrics", "reasoningContent"] as const)
      if (step[field] !== null)
        ctx.addIssue({
          code: "custom",
          message: `${field} must be absent when llmCallCount is zero`,
        });
});
export type AtifStep = z.infer<typeof AtifStepSchema>;
export interface AtifTrajectoryFields {
  readonly schemaVersion: (typeof SUPPORTED_VERSIONS)[number];
  readonly sessionId: string | null;
  readonly trajectoryId: string | null;
  readonly agent: AtifAgent;
  readonly steps: AtifStep[];
  readonly notes: string | null;
  readonly finalMetrics: AtifFinalMetrics | null;
  readonly continuedTrajectoryRef: string | null;
  readonly extra: Record<string, unknown> | null;
  readonly subagentTrajectories: AtifTrajectoryFields[] | null;
}
export const AtifTrajectorySchema: z.ZodType<AtifTrajectoryFields> = z.lazy(
  () =>
    saved(
      z.strictObject({
        schemaVersion: z.enum(SUPPORTED_VERSIONS).default("ATIF-v1.7"),
        sessionId: nullable,
        trajectoryId: nullable,
        agent: AtifAgentSchema,
        steps: z.array(AtifStepSchema).min(1),
        notes: nullable,
        finalMetrics: AtifFinalMetricsSchema.nullable().default(null),
        continuedTrajectoryRef: nullable,
        extra: metadata,
        subagentTrajectories: z
          .array(AtifTrajectorySchema)
          .nullable()
          .default(null),
      }),
    ).superRefine((trajectory, ctx) => {
      for (const [index, step] of trajectory.steps.entries()) {
        if (step.stepId !== index + 1)
          ctx.addIssue({
            code: "custom",
            message: `steps[${index}].stepId must be ${index + 1}`,
          });
        const known = new Set(
          (step.toolCalls ?? []).map((call) => call.toolCallId),
        );
        for (const result of step.observation?.results ?? [])
          if (result.sourceCallId !== null && !known.has(result.sourceCallId))
            ctx.addIssue({
              code: "custom",
              message:
                "Observation references a tool call absent from its step",
            });
      }
      const seen = new Set<string>();
      for (const sub of trajectory.subagentTrajectories ?? []) {
        if (sub.trajectoryId === null)
          ctx.addIssue({
            code: "custom",
            message: "Embedded subagents require trajectoryId",
          });
        else if (seen.has(sub.trajectoryId))
          ctx.addIssue({
            code: "custom",
            message: "Embedded subagent trajectoryId must be unique",
          });
        else seen.add(sub.trajectoryId);
      }
    }),
);
const modelChildren = new Set([
  "source",
  "agent",
  "steps",
  "message",
  "content",
  "toolCalls",
  "observation",
  "results",
  "subagentTrajectoryRef",
  "metrics",
  "finalMetrics",
  "subagentTrajectories",
]);
function freeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(freeJson);
  if (value instanceof Date) return value.toISOString();
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freeJson(item)]),
    );
  return value;
}
function wire(value: unknown, excludeNone: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => wire(item, excludeNone));
  if (!record(value)) return value;
  const out: Row = {};
  for (const [key, item] of Object.entries(value)) {
    if (excludeNone && item === null) continue;
    out[snake(key)] = modelChildren.has(key)
      ? wire(item, excludeNone)
      : freeJson(item);
  }
  return out;
}
const audioContent = (value: string | AtifContentPart[] | null): boolean =>
  Array.isArray(value) && value.some((part) => part.type === "audio");
function hasAudio(trajectory: AtifTrajectoryFields): boolean {
  return (
    trajectory.steps.some(
      (step) =>
        audioContent(step.message) ||
        (step.observation?.results ?? []).some((result) =>
          audioContent(result.content),
        ),
    ) || (trajectory.subagentTrajectories ?? []).some(hasAudio)
  );
}
function stamp(doc: Row, version: string): Row {
  doc.schema_version = version;
  for (const sub of (doc.subagent_trajectories ?? []) as Row[])
    stamp(sub, version);
  return doc;
}
export class AtifTrajectory implements AtifTrajectoryFields {
  declare readonly schemaVersion: AtifTrajectoryFields["schemaVersion"];
  declare readonly sessionId: string | null;
  declare readonly trajectoryId: string | null;
  declare readonly agent: AtifAgent;
  declare readonly steps: AtifStep[];
  declare readonly notes: string | null;
  declare readonly finalMetrics: AtifFinalMetrics | null;
  declare readonly continuedTrajectoryRef: string | null;
  declare readonly extra: Record<string, unknown> | null;
  declare readonly subagentTrajectories: AtifTrajectoryFields[] | null;
  constructor(input: unknown) {
    Object.assign(this, AtifTrajectorySchema.parse(input));
    Object.freeze(this);
  }
  static fromJson(
    input: string | Uint8Array | Record<string, unknown>,
  ): AtifTrajectory {
    const doc: unknown =
      typeof input === "string" || input instanceof Uint8Array
        ? parsePythonJson(
            typeof input === "string"
              ? input
              : new TextDecoder("utf-8", { fatal: true }).decode(input),
          )
        : input;
    if (!record(doc))
      throw new TypeError("An ATIF document must be a JSON object");
    if (!Object.hasOwn(doc, "schema_version"))
      throw new TypeError(
        "schema_version is required (supported: ATIF-v1.7, ATIF-v1.8)",
      );
    const trajectory = new AtifTrajectory(doc);
    if (trajectory.schemaVersion === "ATIF-v1.7" && trajectory.hasAudio())
      throw new TypeError(
        "ATIF-v1.7 documents cannot contain audio content parts",
      );
    return trajectory;
  }
  hasAudio(): boolean {
    return hasAudio(this);
  }
  toJsonDict(
    options: { version?: "1.7" | "1.8" } = {},
  ): Record<string, unknown> {
    const audio = this.hasAudio();
    if (options.version === "1.7" && audio)
      throw new TypeError(
        "Cannot write ATIF-v1.7: the trajectory contains audio content parts",
      );
    const version = options.version
      ? `ATIF-v${options.version}`
      : audio
        ? "ATIF-v1.8"
        : this.schemaVersion;
    return stamp(wire(this, true) as Row, version);
  }
  toJson(
    options: { version?: "1.7" | "1.8"; indent?: number | null } = {},
  ): string {
    return pythonJson(this.toJsonDict(options), { indent: options.indent });
  }
  toModelDict(): Record<string, unknown> {
    return wire(this, false) as Record<string, unknown>;
  }
  toOtel() {
    return atifToOtel(this);
  }
  toResponses() {
    return atifToResponses(this);
  }
  toChat() {
    return this.toResponses().toChat();
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}

export function atifWire(
  value: AtifTrajectoryFields | AtifObservationResult | AtifFinalMetrics,
  excludeNone = false,
): Record<string, unknown> {
  return wire(value, excludeNone) as Record<string, unknown>;
}
