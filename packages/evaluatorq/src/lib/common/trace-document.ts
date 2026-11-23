import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import {
  AtifAudioSourceSchema,
  type AtifContentPart,
  AtifContentPartSchema,
  AtifMetricsSchema,
  type AtifObservationResult,
  AtifObservationResultSchema,
  type AtifStep,
  AtifStepSchema,
  type AtifToolCall,
  AtifToolCallSchema,
  AtifTrajectory,
} from "../formats/atif.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";
import { isoFromEpoch } from "../formats/otel.js";
import {
  atifToolArguments,
  RAW_ARGUMENTS_EXTRA_KEY,
} from "../formats/shared.js";
import { parseIso } from "../formats/time.js";
import {
  SignalReport,
  SignalReportSchema,
  signalBoolean,
  signalDictionary,
  signalFloat,
  signalInteger,
  signalModel,
} from "../signals/models.js";
import { TRUNCATED_EXTRA_KEY } from "../signals/preconditions.js";
import type { DataPoint } from "../types.js";
import { pythonCasefold, pythonString, pythonStrip } from "./sanitize.js";

type Row = Record<string, unknown>;
const PREFIX = "evaluatorq.insights.";
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const mapping = (value: unknown): Row => (record(value) ? value : {});
const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : record(value)
      ? Object.keys(value).length > 0
      : Boolean(value));
const first = (...values: unknown[]): unknown => values.find(truth);
const fields = (value: Row, excluded: readonly (string | null)[]): Row =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.includes(key)),
  );
const own = (
  value: Row,
  key: string,
  fallback: unknown = undefined,
): unknown => (Object.hasOwn(value, key) ? value[key] : fallback);
const order = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
export const DatasetRefSchema = signalModel(
  {
    name: z.string().min(1),
    revision: z.string().min(1),
    split: z.string().nullable().default(null),
    rowId: z.string().min(1),
  },
  true,
);
export type DatasetRef = z.infer<typeof DatasetRefSchema>;
export const OutcomeSchema = signalModel(
  {
    passed: signalBoolean.nullable(),
    score: signalFloat.nullable().default(null),
    source: z.enum(["programmatic", "human", "judge", "none"]),
    definition: z.string().min(1),
  },
  true,
).superRefine((value, ctx) => {
  if ((value.passed === null) !== (value.source === "none"))
    ctx.addIssue({
      code: "custom",
      message: "passed must be null exactly when source is 'none'",
    });
});
export type Outcome = z.infer<typeof OutcomeSchema>;
export type LabelSource = Outcome["source"];
export const TraceTimestampSchema = z
  .unknown()
  .transform((value, ctx) => {
    if (value == null) return null;
    try {
      if (value instanceof Date) return value.toISOString();
      if (
        typeof value === "number" ||
        (typeof value === "string" &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(pythonStrip(value)))
      ) {
        const n = Number(value),
          adjusted =
            typeof value === "number" && n < 0 && !Number.isInteger(n)
              ? Math.floor(n) + Math.abs(n - Math.trunc(n))
              : n;
        return isoFromEpoch(
          Math.abs(n) > 20000000000 ? adjusted / 1000 : adjusted,
        ).replace(/\+00:00$/, "Z");
      }
      if (
        typeof value === "string" &&
        pythonStrip(value) === value &&
        /^\d{4}-\d{2}-\d{2}/.test(value) &&
        !value.endsWith("z")
      ) {
        const parsed = parseIso(value);
        if (parsed.offsetSeconds !== null)
          return parsed.iso.replace(/\+00:00$/, "Z");
      }
    } catch {}
    ctx.addIssue({
      code: "custom",
      message: "timestamp must be a valid datetime with a timezone offset",
    });
    return z.NEVER;
  })
  .default(null);
const metadataShape = {
  schemaVersion: z
    .preprocess((value) => (value === true ? 1 : value), z.literal(1))
    .default(1),
  traceId: z.string().min(1),
  spanId: z.string().min(1).nullable().default(null),
  timestamp: TraceTimestampSchema,
  project: z.string().default(""),
  model: z.string().default(""),
  provider: z.string().default(""),
  status: z.string().default(""),
  product: z.string().default(""),
  traceType: z.string().default(""),
  agentName: z.string().default(""),
  toolNames: z
    .array(z.string())
    .readonly()
    .default(() => []),
  toolDefinitionCount: signalInteger.refine((value) => value >= 0).default(0),
  toolDefinitionTokens: signalInteger.refine((value) => value >= 0).default(0),
  totalTokens: signalInteger
    .refine((value) => value >= 0)
    .nullable()
    .default(null),
  durationMs: signalInteger
    .refine((value) => value >= 0)
    .nullable()
    .default(null),
  captureMetadata: signalDictionary.default(() => ({})),
  signals: SignalReportSchema.transform((value) => new SignalReport(value))
    .nullable()
    .default(null),
  dataset: DatasetRefSchema.nullable().default(null),
  outcome: OutcomeSchema.nullable().default(null),
};
export const TraceMetadataSchema = z
  .preprocess((value) => {
    if (!record(value)) return value;
    const input = { ...value };
    for (const key of Object.keys(metadataShape)) {
      const legacy = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      if (key !== legacy && Object.hasOwn(input, legacy)) {
        if (
          Object.hasOwn(input, key) &&
          !isDeepStrictEqual(input[key], input[legacy])
        )
          throw new TypeError(`Conflicting ${key} and ${legacy}`);
        input[key] = input[legacy];
        delete input[legacy];
      }
    }
    return input;
  }, z.looseObject(metadataShape).readonly())
  .superRefine((value, ctx) => {
    if (value.dataset === null && (!value.spanId || value.timestamp === null))
      ctx.addIssue({
        code: "custom",
        message: "a trace without a dataset needs spanId and timestamp",
      });
    if (value.dataset !== null && value.outcome === null)
      ctx.addIssue({
        code: "custom",
        message:
          "a dataset row needs an outcome; use source='none' when it is unlabelled",
      });
  });
export type TraceMetadata = z.infer<typeof TraceMetadataSchema>;
export const TrajectoryCountsSchema = signalModel(
  {
    toolCalls: signalInteger.refine((value) => value >= 0),
    toolResults: signalInteger.refine((value) => value >= 0),
    reasoningSteps: signalInteger.refine((value) => value >= 0),
  },
  true,
);
export type TrajectoryCounts = z.infer<typeof TrajectoryCountsSchema>;
export class TraceDocument {
  readonly metadata: TraceMetadata;
  readonly trajectory: AtifTrajectory;
  declare readonly schemaVersion: TraceMetadata["schemaVersion"];
  declare readonly traceId: TraceMetadata["traceId"];
  declare readonly spanId: TraceMetadata["spanId"];
  declare readonly timestamp: TraceMetadata["timestamp"];
  declare readonly project: TraceMetadata["project"];
  declare readonly model: TraceMetadata["model"];
  declare readonly provider: TraceMetadata["provider"];
  declare readonly status: TraceMetadata["status"];
  declare readonly product: TraceMetadata["product"];
  declare readonly traceType: TraceMetadata["traceType"];
  declare readonly agentName: TraceMetadata["agentName"];
  declare readonly toolNames: TraceMetadata["toolNames"];
  declare readonly toolDefinitionCount: TraceMetadata["toolDefinitionCount"];
  declare readonly toolDefinitionTokens: TraceMetadata["toolDefinitionTokens"];
  declare readonly totalTokens: TraceMetadata["totalTokens"];
  declare readonly durationMs: TraceMetadata["durationMs"];
  declare readonly captureMetadata: TraceMetadata["captureMetadata"];
  declare readonly signals: TraceMetadata["signals"];
  declare readonly dataset: TraceMetadata["dataset"];
  declare readonly outcome: TraceMetadata["outcome"];
  constructor(input: unknown) {
    if (!record(input)) throw new TypeError("Trace document must be an object");
    this.metadata = TraceMetadataSchema.parse(input.metadata);
    this.trajectory =
      input.trajectory instanceof AtifTrajectory
        ? input.trajectory
        : new AtifTrajectory(input.trajectory);
    for (const key of Object.keys(metadataShape))
      Object.defineProperty(this, key, {
        get: () => this.metadata[key],
        enumerable: false,
      });
    Object.freeze(this);
  }
  get messages(): Row[] {
    return toChatMessages(this);
  }
  get sourceCoverage(): Row {
    return sourceCoverageProjection(this.metadata.captureMetadata);
  }
  toDatapoint(): DataPoint {
    const inputs: Row = { trajectory: this.trajectory.toJsonDict() },
      dataset = this.metadata.dataset;
    if (dataset)
      inputs.dataset = {
        name: dataset.name,
        revision: dataset.revision,
        split: dataset.split,
        row_id: dataset.rowId,
      };
    return {
      inputs,
      expectedOutput: this.metadata.outcome
        ? { ...this.metadata.outcome }
        : null,
    };
  }
}
export function trajectoryCounts(trajectory: AtifTrajectory): TrajectoryCounts {
  let toolCalls = 0,
    toolResults = 0,
    reasoningSteps = 0;
  const visit = (value: typeof trajectory) => {
    for (const step of value.steps) {
      toolCalls += step.toolCalls?.length ?? 0;
      toolResults += step.observation?.results.length ?? 0;
      reasoningSteps += Number(Boolean(step.reasoningContent));
    }
    for (const sub of value.subagentTrajectories ?? [])
      visit(new AtifTrajectory(sub));
  };
  visit(trajectory);
  return TrajectoryCountsSchema.parse({
    toolCalls,
    toolResults,
    reasoningSteps,
  });
}
export function checkTraceDocument(
  document: TraceDocument,
  options: { expectedCounts: TrajectoryCounts; expectedOutcome: Outcome },
): void {
  const counts = trajectoryCounts(document.trajectory);
  if (!isDeepStrictEqual(counts, options.expectedCounts))
    throw new Error("trajectory counts differ");
  if (!isDeepStrictEqual(document.metadata.outcome, options.expectedOutcome))
    throw new Error("trace document outcome differs");
  const restored = new TraceDocument(JSON.parse(JSON.stringify(document)));
  if (!isDeepStrictEqual(restored, document))
    throw new Error("trace document changed during JSON round-trip");
}
export function ensureTraceDocument(value: TraceDocument | Row): TraceDocument {
  if (value instanceof TraceDocument) return value;
  const { messages, ...rest } = value,
    metadata = TraceMetadataSchema.parse(rest),
    trajectory = trajectoryFromMessages(metadata, messages),
    captureMetadata = fields(metadata.captureMetadata, [
      "signal_tool_spans",
      "signal_selected_span",
    ]);
  return new TraceDocument({
    metadata: { ...metadata, captureMetadata },
    trajectory,
  });
}
export function traceDocumentWithSignals(
  document: TraceDocument,
  report: SignalReport,
): TraceDocument {
  if (
    report.trajectoryId &&
    document.trajectory.trajectoryId &&
    report.trajectoryId !== document.trajectory.trajectoryId
  )
    throw new Error(
      "signal report trajectoryId does not match the trace document",
    );
  return new TraceDocument({
    metadata: { ...document.metadata, signals: report },
    trajectory: document.trajectory,
  });
}
function sourceCoverageProjection(capture: Row): Row {
  const projected: Row = {};
  for (const key of [
    "source",
    "start",
    "end",
    "project_id",
    "incomplete_reason",
  ])
    if (typeof capture[key] === "string") projected[key] = capture[key];
  const raw = capture.signal_span_coverage;
  if (!record(raw)) return projected;
  const coverage: Row = {};
  for (const key of ["selected_span_id", "enrichment_error"])
    if (typeof raw[key] === "string") coverage[key] = raw[key];
  for (const key of [
    "selected_span_found",
    "selected_data_correlated",
    "selected_detail_captured",
  ])
    if (typeof raw[key] === "boolean") coverage[key] = raw[key];
  for (const key of [
    "scoped_span_count",
    "matched_tool_span_count",
    "responses_items_captured",
  ])
    if (
      typeof raw[key] === "number" &&
      Number.isInteger(raw[key]) &&
      raw[key] >= 0
    )
      coverage[key] = raw[key];
  for (const key of [
    "matched_call_ids",
    "missing_call_ids",
    "enrichment_errors",
  ])
    if (
      Array.isArray(raw[key]) &&
      raw[key].every((value) => typeof value === "string")
    )
      coverage[key] = [...raw[key]];
  if (Object.keys(coverage).length) projected.signal_span_coverage = coverage;
  return projected;
}
export function toChatMessages(document: TraceDocument | Row): Row[] {
  const doc = ensureTraceDocument(document),
    ordered: [number, Row][] = [];
  for (const step of doc.trajectory.steps) {
    const extra = step.extra ?? {},
      sourceOrder = order(extra[`${PREFIX}source_order`], step.stepId - 1);
    if (!truth(extra[`${PREFIX}hidden`])) {
      const role = own(
          extra,
          `${PREFIX}source_role`,
          step.source === "agent" ? "assistant" : step.source,
        ),
        message: Row = { ...mapping(extra[`${PREFIX}message_fields`]), role };
      if (Object.hasOwn(extra, `${PREFIX}content_override`))
        message.content = extra[`${PREFIX}content_override`];
      else if (typeof step.message === "string") {
        if (truth(own(extra, `${PREFIX}content_present`, true)))
          message.content = step.message;
      } else
        message.content = renderPartList(
          step.message,
          extra[`${PREFIX}content_layout`],
        );
      const calls = (step.toolCalls ?? []).map(renderCall);
      if (calls.length) message.tool_calls = calls;
      if (step.reasoningContent && !Object.hasOwn(message, "reasoning_content"))
        message.reasoning_content = step.reasoningContent;
      ordered.push([sourceOrder, message]);
    }
    for (const result of step.observation?.results ?? []) {
      const extra = result.extra ?? {};
      if (truth(extra[`${PREFIX}hidden`])) continue;
      const resultOrder = order(extra[`${PREFIX}source_order`], sourceOrder),
        message: Row = {
          ...mapping(extra[`${PREFIX}message_fields`]),
          role: own(extra, `${PREFIX}source_role`, "tool"),
        };
      message.content = Object.hasOwn(extra, `${PREFIX}content_override`)
        ? extra[`${PREFIX}content_override`]
        : typeof result.content === "string" || result.content === null
          ? result.content
          : renderPartList(result.content, extra[`${PREFIX}content_layout`]);
      const callId = first(result.sourceCallId, extra[`${PREFIX}call_id`]);
      if (callId != null) message.tool_call_id = callId;
      ordered.push([resultOrder, message]);
    }
  }
  return ordered.sort((a, b) => a[0] - b[0]).map(([, message]) => message);
}
function atifMessage(content: unknown, extra: Row): string | AtifContentPart[] {
  if (typeof content === "string") return content;
  const converted = atifContent(content, extra);
  if (Array.isArray(converted)) return converted;
  if (content == null && !truth(own(extra, `${PREFIX}content_present`, true)))
    return "";
  extra[`${PREFIX}content_override`] = content ?? null;
  return "";
}
function atifContent(
  content: unknown,
  extra: Row,
): string | AtifContentPart[] | null {
  if (content == null || typeof content === "string") return content ?? null;
  if (!Array.isArray(content)) {
    extra[`${PREFIX}content_override`] = content;
    return null;
  }
  const parts: AtifContentPart[] = [],
    layout: Row[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(AtifContentPartSchema.parse({ type: "text", text: part }));
      layout.push({ string: true });
    } else if (
      record(part) &&
      ["text", "input_text", "output_text", "summary_text", "refusal"].includes(
        String(part.type),
      )
    ) {
      const key = ["text", "content", "refusal"].find((key) =>
          Object.hasOwn(part, key),
        ),
        text = key ? part[key] : null;
      if (typeof text === "string") {
        parts.push(AtifContentPartSchema.parse({ type: "text", text }));
        layout.push({
          string: false,
          type: part.type,
          text_key: key,
          fields: fields(part, ["type", key ?? null]),
        });
      } else {
        parts.push(AtifContentPartSchema.parse({ type: "text", text: "" }));
        layout.push({ raw: part });
      }
    } else if (
      record(part) &&
      ["image", "image_url", "input_image", "audio", "input_audio"].includes(
        String(part.type),
      )
    ) {
      const [media, shape] = ["audio", "input_audio"].includes(
        String(part.type),
      )
        ? atifAudio(part)
        : atifImage(part);
      parts.push(
        media ?? AtifContentPartSchema.parse({ type: "text", text: "" }),
      );
      layout.push(media ? shape : { raw: part });
    } else {
      parts.push(AtifContentPartSchema.parse({ type: "text", text: "" }));
      layout.push({ raw: part });
    }
  }
  extra[`${PREFIX}content_layout`] = layout;
  return parts;
}
function renderPartList(
  content: readonly AtifContentPart[],
  layout: unknown = null,
): unknown[] {
  return content.map((part, index) => {
    const shape = Array.isArray(layout) ? mapping(layout[index]) : {};
    if (Object.hasOwn(shape, "raw")) return shape.raw;
    if (truth(shape.string)) return part.text || "";
    if (part.type === "image" && part.source) {
      if (truth(shape.direct))
        return {
          ...mapping(shape.fields),
          ...(shape.type != null ? { type: shape.type } : {}),
          [pythonString(first(shape.url_key, "url"))]: part.source.path,
        };
      if (truth(shape.string_container))
        return {
          ...mapping(shape.fields),
          type: shape.type ?? null,
          [pythonString(shape.container_key)]: part.source.path,
        };
      return {
        ...mapping(shape.fields),
        type: own(shape, "type", "image_url"),
        [pythonString(first(shape.container_key, "image_url"))]: {
          ...mapping(shape.container_fields),
          [pythonString(first(shape.url_key, "url"))]: part.source.path,
        },
      };
    }
    if (part.type === "audio" && part.source) {
      const path = own(shape, "raw_data", part.source.path),
        typed = shape.type != null ? { type: shape.type } : {};
      if (truth(shape.direct))
        return {
          ...mapping(shape.fields),
          ...typed,
          [pythonString(first(shape.url_key, "url"))]: path,
        };
      if (truth(shape.string_container))
        return {
          ...mapping(shape.fields),
          ...typed,
          [pythonString(shape.container_key)]: path,
        };
      return {
        ...mapping(shape.fields),
        ...typed,
        [pythonString(first(shape.container_key, "input_audio"))]: {
          ...mapping(shape.container_fields),
          [pythonString(first(shape.url_key, "url"))]: path,
        },
      };
    }
    return {
      ...mapping(shape.fields),
      ...(shape.type != null ? { type: shape.type } : {}),
      [pythonString(first(shape.text_key, "text"))]: part.text || "",
    };
  });
}
function inferImageMediaType(path: string): string | null {
  let media: unknown;
  if (path.startsWith("data:"))
    media = path.slice(5).split(",", 1)[0]?.split(";", 1)[0]?.toLowerCase();
  else {
    let rest = path.replaceAll(/[\t\r\n]/g, "");
    let start = 0;
    while (rest.charCodeAt(start) <= 32) start++;
    rest = rest.slice(start).replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, "");
    if (rest.startsWith("//")) {
      const authority = rest.slice(2).split(/[/?#]/, 1)[0] ?? "";
      if (authority.includes("[") !== authority.includes("]")) return null;
      if (authority.includes("[")) {
        const host = authority.slice(
          authority.indexOf("[") + 1,
          authority.indexOf("]"),
        );
        if (isIP(host) !== 6 && !/^v[\da-f]+\.[^\s]+$/i.test(host)) return null;
      }
      const normalized = authority.normalize("NFKC");
      for (const c of "/?#@:")
        if (!authority.includes(c) && normalized.includes(c)) return null;
      rest = rest.slice(2 + authority.length);
    }
    const pathOnly = rest.split(/[?#]/, 1)[0] ?? "",
      suffix = pathOnly.includes(".")
        ? pathOnly.slice(pathOnly.lastIndexOf(".") + 1).toLowerCase()
        : "";
    media = (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
      } as Row
    )[suffix];
  }
  return typeof media === "string" &&
    ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(media)
    ? media
    : null;
}
function atifImage(part: Row): readonly [AtifContentPart | null, Row] {
  const container = Object.hasOwn(part, "image_url")
      ? "image_url"
      : Object.hasOwn(part, "source")
        ? "source"
        : null,
    source = container ? part[container] : null,
    stringContainer = typeof source === "string";
  let urlKey: string | null,
    path: unknown,
    media: unknown,
    containerFields: Row;
  if (record(source)) {
    urlKey =
      typeof source.url === "string"
        ? "url"
        : typeof source.path === "string"
          ? "path"
          : null;
    path = urlKey ? source[urlKey] : null;
    media = first(source.media_type, source.mime_type);
    containerFields = fields(source, [urlKey]);
  } else if (typeof source === "string") {
    urlKey = null;
    path = source;
    media = first(part.media_type, part.mime_type);
    containerFields = {};
  } else {
    urlKey =
      typeof part.url === "string"
        ? "url"
        : typeof part.path === "string"
          ? "path"
          : null;
    path = urlKey ? part[urlKey] : null;
    media = first(part.media_type, part.mime_type);
    containerFields = {};
  }
  if (typeof media !== "string")
    media = typeof path === "string" ? inferImageMediaType(path) : null;
  if (
    typeof path !== "string" ||
    typeof media !== "string" ||
    !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(media)
  )
    return [null, {}];
  const direct = container === null,
    shape = {
      type: part.type,
      container_key: container,
      url_key: urlKey,
      container_fields: containerFields,
      fields: fields(part, ["type", container, ...(direct ? [urlKey] : [])]),
      direct,
      string_container: stringContainer,
    };
  return [
    AtifContentPartSchema.parse({
      type: "image",
      source: { mediaType: media, path },
    }),
    shape,
  ];
}
function atifAudio(part: Row): readonly [AtifContentPart | null, Row] {
  const container =
      ["input_audio", "audio", "source"].find((key) =>
        Object.hasOwn(part, key),
      ) ?? null,
    source = container ? part[container] : null,
    stringContainer = typeof source === "string";
  let pathKey: string | null,
    path: unknown,
    rawType: unknown,
    extra: Row,
    rawData: string | null = null;
  if (record(source)) {
    pathKey =
      ["url", "path", "data"].find((key) => typeof source[key] === "string") ??
      null;
    path = pathKey ? source[pathKey] : null;
    rawType = first(
      source.media_type,
      source.mime_type,
      typeof source.format === "string" ? `audio/${source.format}` : null,
    );
    extra = fields(source, [pathKey]);
    if (pathKey === "data" && typeof path === "string") {
      rawData = path;
      const parsed = AtifAudioSourceSchema.safeParse({
        mediaType: rawType,
        path: "placeholder",
      });
      if (!parsed.success) return [null, {}];
      path = path.startsWith("data:")
        ? path
        : `data:${parsed.data.mediaType};base64,${path}`;
    }
  } else if (typeof source === "string") {
    pathKey = "url";
    path = source;
    rawType = first(part.media_type, part.mime_type);
    extra = {};
  } else {
    pathKey =
      typeof part.url === "string"
        ? "url"
        : typeof part.path === "string"
          ? "path"
          : null;
    path = pathKey ? part[pathKey] : null;
    rawType = first(part.media_type, part.mime_type);
    extra = {};
  }
  if (typeof path !== "string" || typeof rawType !== "string")
    return [null, {}];
  const audio = AtifAudioSourceSchema.safeParse({ mediaType: rawType, path });
  if (!audio.success) return [null, {}];
  const direct = container === null,
    shape: Row = {
      type: part.type,
      container_key: container || "input_audio",
      url_key: pathKey || "url",
      container_fields: extra,
      fields: fields(part, ["type", container, ...(direct ? [pathKey] : [])]),
      direct,
      string_container: stringContainer,
    };
  if (rawData !== null) shape.raw_data = rawData;
  return [
    AtifContentPartSchema.parse({ type: "audio", source: audio.data }),
    shape,
  ];
}
function atifCall(raw: unknown, fallbackId: string): AtifToolCall | null {
  if (!record(raw)) return null;
  const nested = record(raw.function),
    fn = nested ? (raw.function as Row) : raw,
    nameKeys = ["name", "tool_name"].filter((key) => Object.hasOwn(fn, key)),
    argumentKeys = ["arguments", "input"].filter((key) =>
      Object.hasOwn(fn, key),
    ),
    name = first(fn.name, fn.tool_name, "(unnamed)"),
    rawArguments = own(fn, "arguments", own(fn, "input", {})),
    [args, provenance] = atifToolArguments(rawArguments, name),
    rawId = first(raw.id, raw.call_id, raw.item_id),
    idPresent = typeof rawId === "string" && rawId.length > 0,
    id = idPresent ? rawId : fallbackId;
  const extra: Row = {
    [`${PREFIX}nested_function`]: nested,
    [`${PREFIX}name_keys`]: nameKeys,
    [`${PREFIX}argument_keys`]: argumentKeys,
    [`${PREFIX}id_key`]: Object.hasOwn(raw, "id")
      ? "id"
      : Object.hasOwn(raw, "call_id")
        ? "call_id"
        : "item_id",
    [`${PREFIX}id_present`]: idPresent,
    [`${PREFIX}generated_id`]: id,
    [`${PREFIX}call_outer_fields`]: fields(raw, [
      "id",
      "call_id",
      "item_id",
      ...(nested ? ["function"] : ["name", "arguments", "input", "tool_name"]),
    ]),
  };
  if (typeof rawArguments === "string")
    extra[`${PREFIX}arguments_text`] = rawArguments;
  else if (!record(rawArguments))
    extra[`${PREFIX}arguments_value`] = rawArguments;
  if (provenance !== null) extra[RAW_ARGUMENTS_EXTRA_KEY] = provenance;
  if (nested) {
    const values = fields(fn, ["name", "tool_name", "arguments", "input"]);
    if (Object.keys(values).length) extra[`${PREFIX}function_fields`] = values;
  }
  return AtifToolCallSchema.parse({
    toolCallId: id,
    functionName: pythonString(name),
    arguments: args,
    extra,
  });
}
function pythonEqual(a: unknown, b: unknown): boolean {
  if (
    (typeof a === "number" || typeof a === "boolean") &&
    (typeof b === "number" || typeof b === "boolean")
  )
    return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((value, index) => pythonEqual(value, b[index]))
    );
  if (record(a) && record(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && pythonEqual(a[key], b[key]))
    );
  }
  return a === b;
}
function renderCall(call: AtifToolCall): Row {
  const extra = call.extra ?? {},
    raw = extra[`${PREFIX}arguments_text`];
  let args: unknown = call.arguments;
  if (
    Object.hasOwn(extra, `${PREFIX}arguments_value`) &&
    !Object.keys(call.arguments).length
  )
    args = extra[`${PREFIX}arguments_value`];
  if (typeof raw === "string") {
    try {
      const decoded = parsePythonJson(raw);
      if (
        pythonEqual(decoded, call.arguments) ||
        (!record(decoded) && !Object.keys(call.arguments).length)
      )
        args = raw;
    } catch {
      if (!Object.keys(call.arguments).length) args = raw;
    }
  }
  const outer: Row = { ...mapping(extra[`${PREFIX}call_outer_fields`]) },
    idKey = pythonString(own(extra, `${PREFIX}id_key`, "id")),
    includeId =
      truth(extra[`${PREFIX}id_present`]) ||
      call.toolCallId !== extra[`${PREFIX}generated_id`];
  if (!truth(extra[`${PREFIX}nested_function`])) {
    if (includeId)
      Object.defineProperty(outer, idKey, {
        value: call.toolCallId,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    for (const key of own(extra, `${PREFIX}name_keys`, ["name"]) as string[])
      Object.defineProperty(outer, key, {
        value: call.functionName,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    for (const key of own(extra, `${PREFIX}argument_keys`, [
      "arguments",
    ]) as string[])
      Object.defineProperty(outer, key, {
        value: args,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return outer;
  }
  const fn: Row = { ...mapping(extra[`${PREFIX}function_fields`]) };
  for (const key of own(extra, `${PREFIX}name_keys`, ["name"]) as string[])
    Object.defineProperty(fn, key, {
      value: call.functionName,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  for (const key of own(extra, `${PREFIX}argument_keys`, [
    "arguments",
  ]) as string[])
    Object.defineProperty(fn, key, {
      value: args,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  if (includeId && !Object.hasOwn(outer, idKey))
    Object.defineProperty(outer, idKey, {
      value: call.toolCallId,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  outer.function = fn;
  return outer;
}
function trajectoryFromMessages(
  metadata: TraceMetadata,
  messages: unknown,
): AtifTrajectory {
  const sourceMessages = Array.isArray(messages) ? messages : [],
    steps: AtifStep[] = [],
    selected = mapping(metadata.captureMetadata.signal_selected_span),
    rawOrders = selected.step_orders,
    selectedOrders = new Set<number>(
      (Array.isArray(rawOrders) ? rawOrders : []).filter(
        (value): value is number =>
          typeof value === "number" && Number.isInteger(value) && value >= 0,
      ),
    );
  if (
    !selectedOrders.size &&
    typeof selected.step_order === "number" &&
    Number.isInteger(selected.step_order) &&
    selected.step_order >= 0
  )
    selectedOrders.add(selected.step_order);
  const representative = selectedOrders.size
      ? Math.min(...selectedOrders)
      : null,
    itemsByOrder = mapping(selected.output_items_by_order),
    callSteps = new Map<string, AtifStep[]>(),
    unattached: [number, Row][] = [];
  const replace = (owner: AtifStep, results: AtifObservationResult[]) => {
    const replacement = AtifStepSchema.parse({
      ...owner,
      observation: { results },
    });
    steps[owner.stepId - 1] = replacement;
    for (const [key, values] of callSteps)
      callSteps.set(
        key,
        values.map((candidate) =>
          candidate === owner ? replacement : candidate,
        ),
      );
  };
  for (const [index, raw] of sourceMessages.entries()) {
    const item: Row = record(raw) ? { ...raw } : { role: "user", content: raw },
      role = own(item, "role", "user");
    if (role === "tool") {
      unattached.push([index, item]);
      continue;
    }
    const source =
        role === "system" || role === "developer"
          ? "system"
          : role === "user"
            ? "user"
            : "agent",
      extra: Row = {
        [`${PREFIX}source_order`]: index,
        [`${PREFIX}source_role`]: role,
        [`${PREFIX}content_present`]: Object.hasOwn(item, "content"),
      },
      messageFields = fields(item, ["role", "content", "tool_calls"]);
    if (Object.keys(messageFields).length)
      extra[`${PREFIX}message_fields`] = messageFields;
    const message = atifMessage(item.content, extra),
      calls: AtifToolCall[] = [];
    for (const [i, call] of (
      (truth(item.tool_calls) ? item.tool_calls : []) as unknown[]
    ).entries()) {
      const converted = atifCall(call, `unknown-${index}-${i}`);
      if (converted) calls.push(converted);
    }
    if (selectedOrders.has(index)) {
      const items = itemsByOrder[String(index)];
      if (Array.isArray(items) && items.length)
        extra["evaluatorq.responses_output_items"] = items;
      if (
        truth(selected.tool_definitions_present) &&
        Array.isArray(selected.tool_definitions)
      )
        extra["evaluatorq.responses_tools"] = selected.tool_definitions;
    }
    const isRepresentative = index === representative,
      metrics = isRepresentative ? selected.metrics : null;
    if (
      isRepresentative &&
      (selected.start_timestamp != null || selected.end_timestamp != null)
    )
      extra.invocation = Object.fromEntries(
        ["start_timestamp", "end_timestamp"]
          .filter((key) => selected[key] != null)
          .map((key) => [key, selected[key]]),
      );
    const step = AtifStepSchema.parse({
      stepId: steps.length + 1,
      source,
      message,
      toolCalls: calls.length ? calls : null,
      timestamp: isRepresentative ? (selected.started_at ?? null) : null,
      metrics:
        record(metrics) && Object.keys(metrics).length
          ? AtifMetricsSchema.parse(metrics)
          : null,
      llmCallCount: selectedOrders.has(index)
        ? isRepresentative
          ? 1
          : 0
        : null,
      extra,
    });
    steps.push(step);
    for (const call of calls)
      callSteps.set(call.toolCallId, [
        ...(callSteps.get(call.toolCallId) ?? []),
        step,
      ]);
  }
  for (const [index, item] of unattached) {
    const callId = first(item.tool_call_id, item.call_id),
      candidates =
        typeof callId === "string" ? (callSteps.get(callId) ?? []) : [],
      prior = candidates.filter(
        (candidate) =>
          order(
            candidate.extra?.[`${PREFIX}source_order`],
            candidate.stepId - 1,
          ) < index &&
          !(candidate.observation?.results ?? []).some(
            (result) => result.sourceCallId === callId,
          ),
      );
    let owner = prior.at(-1);
    if (!owner) {
      owner = AtifStepSchema.parse({
        stepId: steps.length + 1,
        source: "system",
        message: "",
        extra: { [`${PREFIX}hidden`]: true, [`${PREFIX}source_order`]: index },
      });
      steps.push(owner);
    }
    const extra: Row = {
      [`${PREFIX}source_order`]: index,
      [`${PREFIX}source_role`]: "tool",
    };
    if (callId != null) extra[`${PREFIX}call_id`] = callId;
    const resultFields = fields(item, [
      "role",
      "content",
      "tool_call_id",
      "call_id",
    ]);
    if (Object.keys(resultFields).length)
      extra[`${PREFIX}message_fields`] = resultFields;
    const content = atifContent(item.content, extra),
      sourceResult = mapping(mapping(item.trace_finder_metadata).tool_result);
    for (const key of ["status", "error_type"]) {
      let value = own(sourceResult, key, item[key]);
      if (value != null) {
        if (
          key === "status" &&
          typeof value === "string" &&
          ["error", "fail"].some((word) =>
            pythonCasefold(value as string).includes(word),
          )
        )
          value = "error";
        extra[key] = value;
      }
    }
    if (
      truth(item[TRUNCATED_EXTRA_KEY]) ||
      truth(sourceResult[TRUNCATED_EXTRA_KEY])
    )
      extra[TRUNCATED_EXTRA_KEY] = true;
    const known = new Set(
        (owner.toolCalls ?? []).map((call) => call.toolCallId),
      ),
      sourceCallId =
        typeof callId === "string" && known.has(callId) ? callId : null;
    if (sourceCallId !== null) delete extra[`${PREFIX}call_id`];
    const result = AtifObservationResultSchema.parse({
      sourceCallId,
      content,
      extra,
    });
    replace(owner, [...(owner.observation?.results ?? []), result]);
  }
  if (
    Array.isArray(selected.unmapped_output_items) &&
    selected.unmapped_output_items.length
  )
    steps.push(
      AtifStepSchema.parse({
        stepId: steps.length + 1,
        source: "system",
        message: "",
        extra: {
          [`${PREFIX}hidden`]: true,
          "evaluatorq.responses_output_items": selected.unmapped_output_items,
        },
      }),
    );
  const signalSpans = mapping(metadata.captureMetadata.signal_tool_spans);
  for (const [callId, values] of Object.entries(signalSpans)) {
    const owner = callSteps.get(callId)?.at(-1);
    if (!owner || !record(values)) continue;
    const results = [...(owner.observation?.results ?? [])],
      paired = results.findIndex((result) => result.sourceCallId === callId),
      signalFields = Object.fromEntries(
        Object.entries(values).filter(([key]) =>
          ["status", "error_type", "start_timestamp", "end_timestamp"].includes(
            key,
          ),
        ),
      );
    if (!Object.keys(signalFields).length) continue;
    if (paired < 0)
      results.push(
        AtifObservationResultSchema.parse({
          sourceCallId: callId,
          content: null,
          extra: { ...signalFields, [`${PREFIX}hidden`]: true },
        }),
      );
    else {
      const result = results[paired] as AtifObservationResult,
        extra = { ...result.extra };
      for (const [key, value] of Object.entries(signalFields))
        if (!Object.hasOwn(extra, key))
          Object.defineProperty(extra, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
      results[paired] = AtifObservationResultSchema.parse({ ...result, extra });
    }
    replace(owner, results);
  }
  steps.sort(
    (a, b) =>
      Number(a.extra?.[`${PREFIX}source_order`] ?? 2 ** 63) -
      Number(b.extra?.[`${PREFIX}source_order`] ?? 2 ** 63),
  );
  const identity = pythonJson([metadata.traceId, metadata.spanId], {
      ensureAscii: false,
      compact: true,
    }),
    hash = createHash("sha1")
      .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
      .update(`https://evaluatorq.orq.ai/trace-document/v1/${identity}`, "utf8")
      .digest()
      .subarray(0, 16);
  hash[6] = ((hash[6] ?? 0) & 15) | 80;
  hash[8] = ((hash[8] ?? 0) & 63) | 128;
  const hex = hash.toString("hex"),
    trajectoryId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    trajectory = new AtifTrajectory({
      trajectoryId,
      agent: {
        name: metadata.agentName || "unknown",
        version: "unknown",
        modelName: metadata.model,
      },
      steps: steps.length
        ? steps.map((step, index) => ({ ...step, stepId: index + 1 }))
        : [
            {
              stepId: 1,
              source: "system",
              message: "",
              extra: { [`${PREFIX}hidden`]: true },
            },
          ],
    });
  return trajectory.hasAudio() && trajectory.schemaVersion !== "ATIF-v1.8"
    ? new AtifTrajectory({ ...trajectory, schemaVersion: "ATIF-v1.8" })
    : trajectory;
}

const snake = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const snakeModel = (value: unknown): unknown =>
  record(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, item]) => [snake(key), item]),
      )
    : value;
const withoutNone = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutNone)
    : record(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== null)
            .map(([key, item]) => [key, withoutNone(item)]),
        )
      : value;

function signalsDict(report: SignalReport | null): unknown {
  if (report === null) return null;
  return {
    trajectory_id: report.trajectoryId,
    results: Object.fromEntries(
      Object.entries(report.results).map(([name, result]) => {
        const row = snakeModel(result) as Row;
        row.evidence = result.evidence.map(snakeModel);
        row.preconditions = result.preconditions.map(snakeModel);
        return [name, row];
      }),
    ),
    config_version: report.configVersion,
  };
}

/** The document as Python's `model_dump_json` writes it: snake_case metadata, compact or indented. */
export function traceDocumentJson(
  document: TraceDocument,
  options: { indent?: number; excludeNone?: boolean } = {},
): string {
  const metadata = snakeModel(document.metadata) as Row;
  metadata.signals = signalsDict(document.metadata.signals);
  metadata.dataset = snakeModel(document.metadata.dataset);
  metadata.outcome = snakeModel(document.metadata.outcome);
  let value: unknown = {
    metadata,
    trajectory: document.trajectory.toModelDict(),
  };
  if (options.excludeNone) value = withoutNone(value);
  return pythonJson(
    value,
    options.indent === undefined
      ? { compact: true, ensureAscii: false }
      : { indent: options.indent, ensureAscii: false },
  );
}
