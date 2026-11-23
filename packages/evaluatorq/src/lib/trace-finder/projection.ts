import { toolResultToText } from "../common/messages.js";
import {
  effectiveTraceInputChars,
  fitClassifierInput,
  isJevModel,
  JEV_STATE_CHARS,
  jevState,
  type ModelText,
  sourceTextRanges,
} from "../common/model-input.js";
import { pythonCasefold, pythonStrip } from "../common/sanitize.js";
import {
  type TraceDocument,
  toChatMessages,
} from "../common/trace-document.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";
import { fullConversationViewWithMessageSpans } from "../insights/transcript.js";
import {
  type TraceProjection,
  TraceProjectionSchema,
  type TraceRecord,
} from "./models.js";
import { MAX_TRACE_INPUT_CHARS, MIN_TRACE_INPUT_CHARS } from "./settings.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const ERROR_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "failed",
  "failure",
  "cancelled",
  "canceled",
]);
export const SUCCESS_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "success",
  "succeeded",
  "ok",
]);
const TOOL_RESULT_CATEGORIES: readonly (readonly [
  string,
  readonly string[],
])[] = [
  ["not_found", ["not found", "not_found", "does not exist", "no such record"]],
  [
    "permission_denied",
    ["permission denied", "forbidden", "unauthorized", "access denied"],
  ],
  ["rate_limited", ["rate limit", "rate_limit", "too many requests"]],
  ["timeout", ["timed out", "timeout", "deadline exceeded"]],
  ["unavailable", ["unavailable", "connection refused", "connection reset"]],
  ["invalid_request", ["invalid request", "invalid argument", "bad request"]],
];
export function serializeProjection(payload: Row): string {
  return pythonJson(payload, {
    ensureAscii: false,
    sortKeys: true,
    compact: true,
    defaultString: true,
  });
}
export function estimateTokens(serialized: string): number {
  return Math.floor((Array.from(serialized).length + 3) / 4);
}
export interface ProjectionOptions {
  model?: string;
  traceInputChars?: number;
  questionPayloads?: Readonly<Record<string, unknown>> | null;
}
export async function projectTrace(
  trace: TraceRecord | TraceDocument,
  options: ProjectionOptions = {},
): Promise<TraceProjection> {
  const characterCap =
    options.traceInputChars ?? (await effectiveTraceInputChars());
  return projectTraceWithCap(trace, {
    ...options,
    traceInputChars: characterCap,
  });
}
export function projectTraceWithCap(
  trace: TraceRecord | TraceDocument,
  options: ProjectionOptions & { traceInputChars: number },
): TraceProjection {
  const characterCap = options.traceInputChars,
    model = options.model ?? "typesafe/jev-latest",
    questions = options.questionPayloads;
  if (
    !(
      MIN_TRACE_INPUT_CHARS <= characterCap &&
      characterCap <= MAX_TRACE_INPUT_CHARS
    )
  )
    throw new RangeError(
      `trace_input_chars must be between ${MIN_TRACE_INPUT_CHARS} and ${MAX_TRACE_INPUT_CHARS} characters`,
    );
  const source = toChatMessages(trace),
    sourceBytes = source.reduce(
      (total, message) =>
        total + Buffer.byteLength(serializeProjection(message), "utf8"),
      0,
    );
  if (isJevModel(model)) {
    const empty = { messages: [] },
      overhead =
        Array.from(
          serializeProjection({ trace_status: trace.status, ...empty }),
        ).length - Array.from(serializeProjection(empty)).length;
    let payload: Row = {
      trace_status: trace.status,
      ...jevState(source, {
        globalCharCap: Math.min(JEV_STATE_CHARS, characterCap - overhead),
      }),
    };
    if (questions !== null && questions !== undefined) {
      const fitted = fitClassifierInput(payload, {
        model,
        questions,
        globalCharCap: characterCap,
      });
      if (!record(fitted))
        throw new TypeError("Jev classifier state must be an object");
      payload = fitted;
    }
    const serialized = serializeProjection(payload),
      messages = Array.isArray(payload.messages) ? payload.messages : [],
      represented = new Set(
        messages.filter(record).map((entry) => entry.index),
      );
    for (const entry of messages)
      if (record(entry))
        for (const result of Array.isArray(entry.results) ? entry.results : [])
          if (
            record(result) &&
            typeof result.index === "number" &&
            Number.isInteger(result.index)
          )
            represented.add(result.index);
    return TraceProjectionSchema.parse({
      payload,
      serialized,
      estimatedTokens: estimateTokens(serialized),
      omittedMessages: Math.max(0, source.length - represented.size),
      omittedBytes: Math.max(
        0,
        sourceBytes - Buffer.byteLength(serialized, "utf8"),
      ),
    });
  }
  const [original, spans, count] = fullConversationViewWithMessageSpans(trace),
    initial = { trace_status: trace.status, conversation: original },
    payload = fitClassifierInput(initial, {
      model,
      questions: questions ?? {},
      globalCharCap: characterCap,
    });
  if (!record(payload))
    throw new TypeError("non-Jev classifier state must be an object");
  const conversation = payload.conversation as ModelText,
    serialized = serializeProjection(payload),
    ranges = sourceTextRanges(conversation),
    represented = new Set(
      spans
        .filter(([start, end]) =>
          ranges.some(
            ([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart,
          ),
        )
        .map(([, , index]) => index),
    );
  if (String(conversation) !== String(original))
    console.warn(
      `trace ${trace.traceId} conversation was truncated to fit the ${characterCap} character model input limit`,
    );
  return TraceProjectionSchema.parse({
    payload,
    serialized,
    estimatedTokens: estimateTokens(serialized),
    omittedMessages: Math.max(0, count - represented.size),
    omittedBytes: Math.max(
      0,
      sourceBytes - Buffer.byteLength(serialized, "utf8"),
    ),
  });
}
function matchingToolResult(
  callId: unknown,
  results: readonly Row[],
): Row | null {
  return typeof callId === "string" && callId
    ? (results.find((item) => item.tool_call_id === callId) ?? null)
    : null;
}
const errorValue = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== "" &&
  value !== 0;
export function toolResultCategory(
  callId: unknown,
  results: readonly Row[],
): string | null {
  const result = matchingToolResult(callId, results);
  if (result === null || toolCallStatus(callId, results) !== "error")
    return null;
  const text = pythonCasefold(toolResultToText(result.content ?? null));
  return (
    TOOL_RESULT_CATEGORIES.find(([, markers]) =>
      markers.some((marker) => text.includes(marker)),
    )?.[0] ?? "provider_error"
  );
}
export function toolCallStatus(
  callId: unknown,
  results: readonly Row[],
): string {
  const result = matchingToolResult(callId, results);
  if (result === null) return "pending";
  const metadata = record(result.trace_finder_metadata)
      ? result.trace_finder_metadata
      : {},
    nested = metadata.tool_result,
    sources = [nested, result].filter(record);
  for (const source of sources)
    if (
      (typeof source.status === "string" &&
        ERROR_STATUSES.has(pythonCasefold(source.status))) ||
      source.is_error === true ||
      errorValue(source.error)
    )
      return "error";
  for (const source of sources)
    if (
      (typeof source.status === "string" &&
        SUCCESS_STATUSES.has(pythonCasefold(source.status))) ||
      source.is_error === false
    )
      return "completed";
  return (
    contentToolCallStatus(
      pythonStrip(toolResultToText(result.content ?? null)),
    ) ?? "completed"
  );
}
export function contentToolCallStatus(content: string): string | null {
  let decoded: unknown;
  try {
    decoded = parsePythonJson(content);
  } catch {
    decoded = null;
  }
  if (record(decoded)) {
    if (
      typeof decoded.status === "string" &&
      ERROR_STATUSES.has(pythonCasefold(decoded.status))
    )
      return "error";
    if (errorValue(decoded.error)) return "error";
    if (
      typeof decoded.status === "string" &&
      SUCCESS_STATUSES.has(pythonCasefold(decoded.status))
    )
      return "completed";
    if (decoded.is_error === false) return "completed";
  }
  return pythonCasefold(content).startsWith("error:") ? "error" : null;
}
