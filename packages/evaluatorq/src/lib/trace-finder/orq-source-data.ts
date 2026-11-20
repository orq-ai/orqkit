import { getField } from "../common/fields.js";
import { contentPartText } from "../common/messages.js";
import {
  codepointCompare,
  pythonCasefold,
  pythonString,
  pythonStrip,
} from "../common/sanitize.js";
import { detectMessageFormat, parseMessages } from "../common/trace-input.js";
import { toChatCompletion } from "../contracts.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";
import { joinText } from "../formats/shared.js";
import { parseIso } from "../formats/time.js";
import { isResponsesItem } from "../integrations/openresponses/otel-messages.js";
import { projectLabels } from "./facets.js";
import {
  type FacetSelection,
  type NumericFilters,
  type Snapshot,
  TraceRecord,
  timeMicros,
} from "./models.js";
import { fromMicroseconds, parseSummaryTime, responseModels } from "./rows.js";
import { isErrorSpan, spanStatusText } from "./span-status.js";
export type Row = Record<string, unknown>;
export const BASE_FILTER = 'operation not_in ("generate_content")';
export const FACET_OQL_FIELDS: Readonly<Record<string, string>> = Object.freeze(
  {
    model: "model",
    provider: "provider",
    status: "status",
    product: "product",
    trace_type: "attributes.orq.leading_span.span_type",
    agent_name: "agent_name",
    tool_name: "tool_name",
  },
);
export const MAX_LIVE_TRACES = 5000,
  PAGE_SIZE = 200,
  MAX_SPAN_PAGES = 10,
  MAX_SPANS_PER_TRACE = PAGE_SIZE * MAX_SPAN_PAGES,
  SDK_TIMEOUT_MS = 30000,
  TARGET_RELOAD_PAGE_BUDGET_SECONDS = 30,
  DEFAULT_LOOKBACK_MS = 7 * 86400000;
export const CONVERSATION_SPAN_TYPES: ReadonlySet<string> = new Set([
    "span.chat_completion",
    "span.completion",
    "span.deployment",
    "span.responses",
  ]),
  EVALUATOR_SPAN_TYPES: ReadonlySet<string> = new Set([
    "span.evaluation_engine",
    "span.evaluator",
  ]);
export class OrqSourceError extends Error {
  override name = "OrqSourceError";
}
export class OrqSpanMismatchError extends OrqSourceError {
  override name = "OrqSpanMismatchError";
}
export const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : record(value)
      ? Object.keys(value).length > 0
      : Boolean(value));
const first = (...values: unknown[]): unknown =>
  values.find(truth) ?? values.at(-1);
export const field = (value: unknown, name: string): unknown =>
  getField(value, name) ??
  getField(
    value,
    name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
  );
const own = (value: Row, key: string, fallback: unknown = null): unknown =>
  Object.hasOwn(value, key) ? value[key] : fallback;
export function toolCallEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!truth(value) || typeof value === "string" || record(value)) return [];
  throw new TypeError("tool_calls must be iterable");
}
export function plain(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            item !== undefined &&
            (Object.getPrototypeOf(value) === Object.prototype ||
              Object.getPrototypeOf(value) === null ||
              !key.startsWith("_")),
        )
        .map(([key, item]) => [key, plain(item)]),
    );
  return value;
}
export const mapping = (value: unknown): Row => {
  const converted = plain(value);
  return record(converted) ? converted : {};
};
export function requireCompleteTargetedLoad(
  snapshot: Snapshot,
  options: { errorType: new (message: string) => Error; operation: string },
): void {
  const reason = snapshot.captureMetadata.incomplete_reason;
  if (truth(reason))
    throw new options.errorType(
      `${options.operation} was incomplete: ${pythonString(reason)}`,
    );
}
export function buildOql(
  facets: FacetSelection,
  numeric: NumericFilters,
  projectNames: Readonly<Record<string, string>>,
  options: { traceIds?: ReadonlySet<string> | null } = {},
): string {
  const clauses: string[] =
      facets.model.size || facets.provider.size ? [] : [BASE_FILTER],
    quoted = (values: readonly string[]) =>
      values
        .map((value) => pythonJson(value, { ensureAscii: false }))
        .join(", ");
  if (facets.projectId) {
    if (!Object.hasOwn(projectNames, facets.projectId))
      throw new OrqSourceError(
        `cannot resolve selected project id: ${facets.projectId}`,
      );
    clauses.push(`project_id in (${quoted([facets.projectId])})`);
  } else if (facets.project.size) {
    const labels = projectLabels(projectNames),
      ids = Object.keys(labels)
        .filter((id) => facets.project.has(labels[id] as string))
        .sort(codepointCompare),
      available = new Set(Object.values(labels)),
      missing = [...facets.project]
        .filter((name) => !available.has(name))
        .sort(codepointCompare);
    if (missing.length)
      throw new OrqSourceError(
        `cannot resolve selected project names to ids: ${pythonString(missing)}`,
      );
    clauses.push(`project_id in (${quoted(ids)})`);
  }
  for (const [name, fieldName] of Object.entries(FACET_OQL_FIELDS)) {
    const key = name.replace(/_([a-z])/g, (_, c: string) =>
        c.toUpperCase(),
      ) as keyof FacetSelection,
      values = [...(facets[key] as ReadonlySet<string>)].sort(codepointCompare);
    if (values.length) clauses.push(`${fieldName} in (${quoted(values)})`);
  }
  const stages = clauses.map((clause) => `filter ${clause}`);
  if (options.traceIds != null) {
    if (!options.traceIds.size)
      throw new OrqSourceError(
        "targeted OQL reload requires at least one trace ID",
      );
    stages.push(
      `filter trace_id in (${quoted([...options.traceIds].sort(codepointCompare))})`,
    );
  }
  for (const [name, min, max] of [
    ["total_tokens", numeric.tokensMin, numeric.tokensMax],
    ["duration_ms", numeric.durationMsMin, numeric.durationMsMax],
  ] as const) {
    if (min !== null) stages.push(`filter ${name} >= ${min}`);
    if (max !== null) stages.push(`filter ${name} <= ${max}`);
  }
  return `fetch traces | ${stages.join(" | ")} | sort end_time desc`;
}
export type SelectedSummary = readonly [unknown, unknown, boolean];
export function selectSummaries(
  summaries: readonly unknown[],
  rawById: ReadonlyMap<string, unknown>,
  seen: Set<string>,
  projectId: string | null,
): { selected: SelectedSummary[]; rejected: number } {
  const selected: SelectedSummary[] = [];
  let rejected = 0;
  for (const summary of summaries) {
    const id = first(field(summary, "trace_id"), field(summary, "id"));
    if (!truth(id) || seen.has(pythonString(id))) continue;
    const key = pythonString(id);
    seen.add(key);
    const rawSummary = rawById.get(key),
      raw = rawSummary ?? plain(summary);
    if (
      projectId &&
      pythonString(first(metadataValue(summary, raw, "project_id"), "")) !==
        projectId
    ) {
      rejected++;
      continue;
    }
    selected.push([summary, raw, rawSummary == null]);
  }
  return { selected, rejected };
}
export function loadTargetReached(
  records: readonly TraceRecord[],
  limit: number,
  targets: ReadonlySet<string> | null,
): boolean {
  return targets === null
    ? records.length >= limit
    : [...targets].every((id) =>
        records.some((record) => record.traceId === id),
      );
}
export function matchingTargets(
  summaries: readonly SelectedSummary[],
  targets: ReadonlySet<string> | null,
): readonly SelectedSummary[] {
  return targets === null
    ? summaries
    : summaries.filter(([summary]) =>
        targets.has(
          pythonString(first(field(summary, "trace_id"), field(summary, "id"))),
        ),
      );
}
export function firstTime(typed: unknown, raw: unknown): string | null {
  for (let source of [typed, raw]) {
    source = first(field(source, "summary"), source);
    for (const name of ["ended_at", "end_time", "started_at", "start_time"]) {
      const time = parseSummaryTime(field(source, name));
      if (time !== null) return time;
    }
  }
  return null;
}
export const recordedTime = (value: unknown): string =>
  firstTime(value, value) ?? "0001-01-01T00:00:00Z";
export function eligibleSpans(spans: readonly unknown[]): unknown[] {
  const excluded = new Set<string>(),
    children = new Map<string, string[]>(),
    byId = new Map<string, unknown>();
  for (const span of spans) {
    const id = pythonString(
      first(field(span, "span_id"), field(span, "id"), ""),
    );
    if (!id) continue;
    byId.set(id, span);
    const parent = first(
      field(span, "parent_span_id"),
      field(span, "parent_id"),
    );
    if (truth(parent)) {
      const key = pythonString(parent);
      children.set(key, [...(children.get(key) ?? []), id]);
    }
    if (EVALUATOR_SPAN_TYPES.has(pythonString(first(field(span, "type"), ""))))
      excluded.add(id);
  }
  const queue = [...excluded];
  for (let i = 0; i < queue.length; i++)
    for (const child of children.get(queue[i] as string) ?? [])
      if (!excluded.has(child)) {
        excluded.add(child);
        queue.push(child);
      }
  return [...byId]
    .filter(
      ([id, span]) =>
        !excluded.has(id) &&
        CONVERSATION_SPAN_TYPES.has(
          pythonString(first(field(span, "type"), "")),
        ),
    )
    .map(([, span]) => span)
    .sort((a, b) => {
      const x = timeMicros(recordedTime(a)),
        y = timeMicros(recordedTime(b));
      return x > y
        ? -1
        : x < y
          ? 1
          : -codepointCompare(
              pythonString(first(field(a, "span_id"), "")),
              pythonString(first(field(b, "span_id"), "")),
            );
    });
}
export function metadataValue(
  typed: unknown,
  raw: unknown,
  ...names: string[]
): unknown {
  for (let source of [typed, raw]) {
    source = first(field(source, "summary"), source);
    for (const name of names) {
      const value = field(source, name);
      if (value != null && value !== "") return value;
    }
    const attributes = mapping(field(source, "attributes")),
      genAi = mapping(attributes.gen_ai),
      request = mapping(genAi.request);
    for (const name of names) {
      const value = first(request[name], genAi[name], attributes[name]);
      if (value != null && value !== "") return value;
    }
  }
  return null;
}
function decimalString(value: string): number | null {
  if (
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x1c && code <= 0x1f;
    })
  )
    return null;
  const text = pythonStrip(value);
  if (!/^[+-]?\p{Decimal_Number}(?:_?\p{Decimal_Number})*$/u.test(text))
    return null;
  const normalized = [...text]
    .map((char) => {
      if (!/\p{Decimal_Number}/u.test(char)) return char;
      const code = char.codePointAt(0) as number;
      let first = code;
      while (
        first > 0 &&
        /\p{Decimal_Number}/u.test(String.fromCodePoint(first - 1))
      )
        first--;
      return String((code - first) % 10);
    })
    .join("")
    .replaceAll("_", "");
  return Number(normalized);
}
export function numericMetadata(
  sources: readonly unknown[],
  name: string,
): number | null {
  if (sources.length % 2)
    throw new RangeError("metadata sources must be typed/raw pairs");
  let value: unknown = null;
  outer: for (let i = 0; i < sources.length; i += 2) {
    value = metadataValue(sources[i], sources[i + 1], name);
    if (value != null && value !== "") break;
    for (const source of [sources[i], sources[i + 1]])
      for (const candidate of [source, field(source, "summary")]) {
        value = field(field(candidate, "usage"), name);
        if (value != null && value !== "") break outer;
      }
  }
  const result =
    typeof value === "number"
      ? Math.trunc(value)
      : typeof value === "string"
        ? decimalString(value)
        : null;
  return result !== null && Number.isFinite(result) && result >= 0
    ? result || 0
    : null;
}
export function toolNames(...sources: unknown[]): string[] {
  if (sources.length % 2)
    throw new RangeError("tool sources must be typed/raw pairs");
  const values: string[] = [];
  for (let i = 0; i < sources.length; i += 2)
    for (const source of [sources[i], sources[i + 1]])
      for (const candidate of [source, field(source, "summary")])
        for (const key of ["tool_names", "tool_name"]) {
          const value = field(candidate, key),
            candidates =
              Array.isArray(value) || value instanceof Set
                ? [...value]
                : [value];
          for (let item of candidates) {
            if (record(item)) item = first(item.name, item.id);
            if (typeof item === "string" && item && !values.includes(item))
              values.push(item);
          }
        }
  return values;
}
export function toolDefinitionSize(
  ...sources: unknown[]
): readonly [number, number] {
  for (const source of sources) {
    const attributes = mapping(field(source, "attributes")),
      genAi = mapping(attributes.gen_ai),
      definitions = first(
        mapping(genAi.tool).definitions,
        attributes["gen_ai.tool.definitions"],
      );
    if (Array.isArray(definitions) && definitions.length) {
      const text = pythonJson(definitions, {
        ensureAscii: false,
        compact: true,
        defaultString: true,
      });
      return [definitions.length, Math.ceil([...text].length / 4)];
    }
  }
  return [0, 0];
}
export function leadingSpanType(typed: unknown, raw: unknown): unknown {
  for (const source of [typed, raw]) {
    const attributes = mapping(field(source, "attributes")),
      orq = mapping(attributes.orq);
    for (const leading of [
      mapping(orq.leading_span),
      mapping(attributes.leading_span),
    ])
      if (truth(leading.span_type)) return leading.span_type;
  }
  return metadataValue(typed, raw, "type", "operation");
}
export const metadataLabel = (value: unknown): unknown =>
  record(value) ? (first(value.name, value.id) ?? null) : value;
const firstListValue = (value: unknown, name: string): unknown => {
  const values = field(value, name);
  return Array.isArray(values) && values.length ? values[0] : null;
};
export function withSpanModels(
  value: TraceRecord | null,
  models: readonly string[],
): TraceRecord | null {
  return value === null ||
    !models.length ||
    !["", "unknown"].includes(value.model)
    ? value
    : new TraceRecord({ ...value, model: models.join(", ") });
}
export function traceRecord(
  traceSummary: unknown,
  rawTrace: unknown,
  selected: unknown,
  rawSelected: unknown,
  messages: Row[],
  projectNames: Readonly<Record<string, string>>,
): TraceRecord | null {
  const selectedSummary = first(field(selected, "summary"), selected),
    traceId = pythonString(
      first(field(traceSummary, "trace_id"), field(traceSummary, "id")),
    ),
    spanId = pythonString(
      first(
        field(selectedSummary, "span_id"),
        field(selectedSummary, "id"),
        field(traceSummary, "leading_span_id"),
        field(traceSummary, "root_span_id"),
        traceId,
      ),
    ),
    projectId = metadataValue(traceSummary, rawTrace, "project_id"),
    project = Object.hasOwn(projectNames, pythonString(projectId))
      ? projectNames[pythonString(projectId)]
      : pythonString(first(projectId, "unknown")),
    timestamp =
      firstTime(traceSummary, rawTrace) ??
      firstTime(selectedSummary, rawSelected);
  if (timestamp === null) return null;
  const served = responseModels(selectedSummary, rawSelected).length
      ? responseModels(selectedSummary, rawSelected)
      : responseModels(traceSummary, rawTrace),
    model = served.length
      ? served[0]
      : metadataLabel(
          first(
            metadataValue(selectedSummary, rawSelected, "model"),
            firstListValue(traceSummary, "models"),
          ),
        ),
    provider = metadataLabel(
      first(
        metadataValue(selectedSummary, rawSelected, "provider"),
        firstListValue(traceSummary, "providers"),
      ),
    ),
    agent = metadataLabel(
      first(
        metadataValue(traceSummary, rawTrace, "agent_name"),
        metadataValue(selectedSummary, rawSelected, "agent_name"),
      ),
    ),
    [toolDefinitionCount, toolDefinitionTokens] = toolDefinitionSize(
      rawSelected,
      selected,
      rawTrace,
      traceSummary,
    );
  return new TraceRecord({
    schemaVersion: 1,
    traceId,
    spanId,
    timestamp,
    messages,
    project,
    model: pythonString(first(model, "unknown")),
    provider: pythonString(first(provider, "unknown")),
    status: pythonString(
      first(metadataValue(traceSummary, rawTrace, "status"), "unknown"),
    ),
    product: pythonString(
      first(metadataValue(traceSummary, rawTrace, "product"), "unknown"),
    ),
    traceType: pythonString(
      first(leadingSpanType(traceSummary, rawTrace), "unknown"),
    ),
    agentName: pythonString(first(agent, "")),
    toolNames: toolNames(traceSummary, rawTrace, selectedSummary, rawSelected),
    toolDefinitionCount,
    toolDefinitionTokens,
    totalTokens: numericMetadata(
      [traceSummary, rawTrace, selectedSummary, rawSelected],
      "total_tokens",
    ),
    durationMs: numericMetadata(
      [traceSummary, rawTrace, selectedSummary, rawSelected],
      "duration_ms",
    ),
    captureMetadata: {
      source: "orq-oql",
      project_id: pythonString(first(projectId, "")),
    },
  });
}
export function responseItemText(item: Row): string | null {
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    const parts = item.content
      .map(contentPartText)
      .filter((value): value is string => value !== null);
    return parts.length ? joinText(parts) : null;
  }
  return null;
}
export function firstNumber(value: Row, ...names: string[]): number | null {
  for (const name of names) {
    const item = field(value, name);
    if (typeof item === "number") return item;
  }
  return null;
}
export function spanToolCallId(span: unknown): string | null {
  const attributes = mapping(field(plain(span), "attributes")),
    genAi = mapping(attributes.gen_ai),
    call = mapping(mapping(genAi.tool).call);
  return (
    [
      attributes["gen_ai.tool.call.id"],
      attributes.tool_call_id,
      attributes.call_id,
      genAi["tool.call.id"],
      call.id,
    ].find(
      (value): value is string => typeof value === "string" && Boolean(value),
    ) ?? null
  );
}
export function signalStatus(span: unknown): Row {
  const raw = plain(span),
    attributes = mapping(field(raw, "attributes")),
    status = [
      attributes["gen_ai.tool.call.status"],
      attributes["tool.status"],
      attributes.status,
    ].find(
      (value): value is string =>
        typeof value === "string" && Boolean(pythonStrip(value)),
    ),
    result: Row = {},
    start = parseSummaryTime(
      first(field(raw, "started_at"), field(raw, "start_time")),
    ),
    end = parseSummaryTime(
      first(field(raw, "ended_at"), field(raw, "end_time")),
    );
  if (start !== null) result.start_timestamp = parseIso(start).epochSeconds;
  if (end !== null) result.end_timestamp = parseIso(end).epochSeconds;
  if (
    isErrorSpan(raw) ||
    (status !== undefined &&
      ["error", "fail"].some((word) => pythonCasefold(status).includes(word)))
  ) {
    result.status = "error";
    const errorType = first(attributes["error.type"], attributes.error_type);
    if (typeof errorType === "string" && errorType)
      result.error_type = errorType;
    return result;
  }
  const good = new Set([
      "ok",
      "success",
      "succeeded",
      "completed",
      "passed",
      "status_code_ok",
      "1",
    ]),
    observed = [status, spanStatusText(raw)].find(
      (value): value is string =>
        typeof value === "string" && good.has(pythonCasefold(value)),
    );
  if (observed !== undefined)
    result.status = ["status_code_ok", "1"].includes(pythonCasefold(observed))
      ? "ok"
      : observed;
  return result;
}
export function checkWindow(
  start: Date | string | null,
  end: Date | string | null,
  limit: number,
  now: Date = new Date(),
): readonly [string, string] {
  if (limit < 1) throw new OrqSourceError("limit must be at least 1");
  const aware = (value: Date | string, name: string): string => {
    if (typeof value === "string") {
      const parsed = parseIso(value);
      if (parsed.offsetSeconds === null)
        throw new OrqSourceError(`${name} must include a timezone offset`);
    }
    const time = parseSummaryTime(value);
    if (time === null) throw new OrqSourceError(`invalid ${name}`);
    return time;
  };
  const resolvedEnd = aware(end ?? now, "end"),
    resolvedStart =
      start !== null
        ? aware(start, "start")
        : fromMicroseconds(
            timeMicros(resolvedEnd) - BigInt(DEFAULT_LOOKBACK_MS) * 1000n,
          );
  if (resolvedStart === null)
    throw new OrqSourceError(
      "default trace window is outside the supported date range",
    );
  if (timeMicros(resolvedStart) > timeMicros(resolvedEnd))
    throw new OrqSourceError("start must not be after end");
  return [resolvedStart, resolvedEnd];
}
export function rawTraceSummaries(payload: unknown): Row[] {
  if (!truth(payload)) return [];
  if (!record(payload))
    throw new TypeError("trace summary payload is not a mapping");
  const body = mapping(payload),
    search = record(body.search) ? body.search : body,
    data = search.data;
  if (!truth(data)) return [];
  if (Array.isArray(data)) return data.filter(record);
  if (typeof data === "string" || record(data)) return [];
  throw new TypeError("trace summaries data is not iterable");
}
function decoded(value: unknown): unknown {
  const converted = plain(value);
  if (typeof converted !== "string") return converted;
  try {
    return parsePythonJson(converted);
  } catch {
    return converted;
  }
}
export function contentHasValue(value: unknown): boolean {
  if (typeof value === "string") return Boolean(pythonStrip(value));
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(contentBlockHasValue);
  if (record(value)) return contentBlockHasValue(value);
  return true;
}
export function contentBlockHasValue(value: unknown): boolean {
  if (!record(value)) return contentHasValue(value);
  if (value.type === "reasoning") return false;
  const keys = [
    "content",
    "image_url",
    "input_text",
    "output_text",
    "text",
  ].filter((key) => Object.hasOwn(value, key));
  return keys.length
    ? keys.some((key) => contentHasValue(value[key]))
    : Object.entries(value).some(
        ([key, item]) => key !== "type" && contentHasValue(item),
      );
}
export function messageHasContent(message: Row): boolean {
  return (
    contentHasValue(message.content) ||
    truth(message.tool_calls) ||
    (Array.isArray(message.parts) && message.parts.some(contentBlockHasValue))
  );
}
export const usable = (messages: readonly Row[]): boolean =>
  messages.some(messageHasContent);
export function hasReply(messages: readonly Row[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Row;
    if (messageHasContent(message))
      return ["assistant", "tool"].includes(String(message.role));
  }
  return false;
}
function structuredMappingMessage(
  value: Row,
  defaultRole: string | null,
): Row[] | null {
  for (const key of ["messages", "input"])
    if (Object.hasOwn(value, key)) return messageList(value[key], defaultRole);
  if (Object.hasOwn(value, "prompt"))
    return messageList(value.prompt, defaultRole);
  if (Array.isArray(value.choices)) {
    const messages: Row[] = [];
    for (const choice of value.choices) {
      if (!record(choice)) continue;
      if (record(choice.message)) {
        const parsed = structuredMessageList(choice.message, defaultRole);
        if (parsed !== null) messages.push(...parsed);
      } else if (Object.hasOwn(choice, "text"))
        messages.push(
          ...(structuredMessageList({ content: choice.text }, defaultRole) ??
            []),
        );
    }
    return messages;
  }
  if (
    ["content", "parts", "role", "tool_calls"].some((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    const message = { ...value };
    if (!truth(message.role) && defaultRole) message.role = defaultRole;
    return truth(message.role) ? [message] : [];
  }
  return null;
}
function structuredMessageList(
  value: unknown,
  defaultRole: string | null,
): Row[] | null {
  if (record(value)) return structuredMappingMessage(value, defaultRole);
  if (!Array.isArray(value)) return null;
  const messages: Row[] = [];
  let recognized = !value.length;
  for (const item of value) {
    if (!record(item)) continue;
    const parsed = structuredMessageList(item, defaultRole);
    if (parsed !== null) {
      recognized = true;
      messages.push(...parsed);
    }
  }
  return recognized ? messages : null;
}
export function messageList(
  value: unknown,
  defaultRole: string | null = null,
): Row[] {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = parsePythonJson(value);
    } catch {
      return defaultRole && pythonStrip(value)
        ? [{ role: defaultRole, content: value }]
        : [];
    }
    if (record(parsed) || Array.isArray(parsed)) {
      const messages = structuredMessageList(parsed, defaultRole);
      if (messages !== null) return messages;
    }
    return defaultRole && pythonStrip(value)
      ? [{ role: defaultRole, content: value }]
      : [];
  }
  return structuredMessageList(value, defaultRole) ?? [];
}
export function hasChatTextParts(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      value = parsePythonJson(value);
    } catch {
      return false;
    }
  }
  if (record(value)) value = own(value, "messages", [value]);
  if (!Array.isArray(value)) return false;
  const messages = value.filter(
    (item) => record(item) && Object.hasOwn(item, "parts"),
  ) as Row[];
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        Array.isArray(message.parts) &&
        message.parts.every(
          (part) =>
            record(part) &&
            typeof part.text === "string" &&
            !Object.hasOwn(part, "content"),
        ),
    )
  );
}
function mixedChatPartsAndResponses(
  value: unknown,
  defaultRole: "user" | "assistant" | null,
): Row[] | null {
  let data = decoded(value);
  if (record(data)) {
    const keys =
      defaultRole === "assistant"
        ? ["messages", "output", "input"]
        : ["messages", "input", "output"];
    data = keys.map((key) => (data as Row)[key]).find(Array.isArray) ?? null;
  }
  if (
    !Array.isArray(data) ||
    !hasChatTextParts(data) ||
    !data.some((item) => record(item) && isResponsesItem(item))
  )
    return null;
  return data.filter(record).map((item) => {
    const message = { ...item };
    if (message.content == null && Array.isArray(message.parts)) {
      const texts = message.parts
        .filter(record)
        .map((part) => part.text)
        .filter((text): text is string => typeof text === "string");
      if (texts.length) message.content = texts.join("");
    }
    return message;
  });
}
function attachOtelToolResultMetadata(messages: Row[], value: unknown): void {
  const body = decoded(value);
  if (!record(body) && !Array.isArray(body)) return;
  const outcomes = new Map<string, Row>(),
    pending: unknown[] = [body];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      pending.push(...item);
      continue;
    }
    if (!record(item)) continue;
    if (Array.isArray(item.parts))
      for (const part of item.parts) {
        if (!record(part) || part.type !== "tool_call_response") continue;
        const id = first(part.id, part.call_id);
        if (typeof id !== "string" || !id) continue;
        const explicit = Object.fromEntries(
          ["status", "is_error", "error"]
            .filter((key) => Object.hasOwn(part, key))
            .map((key) => [key, part[key]]),
        );
        if (Object.keys(explicit).length) outcomes.set(id, explicit);
      }
    pending.push(
      ...Object.entries(item)
        .filter(([key]) => key !== "parts")
        .map(([, value]) => value),
    );
  }
  for (const message of messages) {
    const outcome =
      typeof message.tool_call_id === "string"
        ? outcomes.get(message.tool_call_id)
        : null;
    if (outcome) message.trace_finder_metadata = { tool_result: outcome };
  }
}
export function normalisedMessages(
  value: unknown,
  defaultRole: "user" | "assistant" | null = null,
): Row[] {
  const format = detectMessageFormat(value),
    mixed = mixedChatPartsAndResponses(value, defaultRole);
  if (mixed !== null)
    return parseMessages(mixed, {
      hinted: "responses",
      defaultRole: defaultRole ?? "user",
    }).messages.map(toChatCompletion);
  if (format === "chat_completions" || hasChatTextParts(value)) {
    const messages = messageList(value, defaultRole);
    for (const message of messages)
      if (message.content == null && Array.isArray(message.parts)) {
        const texts = message.parts
          .filter(record)
          .map((part) => part.text)
          .filter((text): text is string => typeof text === "string");
        if (texts.length) message.content = texts.join("");
      }
    return messages;
  }
  const messages = parseMessages(value, {
    hinted: format,
    defaultRole: defaultRole ?? "user",
  }).messages.map(toChatCompletion);
  if (format === "otel_genai") attachOtelToolResultMetadata(messages, value);
  return messages;
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
export function conversationMessages(payload: unknown): Row[] {
  const body = plain(payload);
  if (!record(body)) return [];
  const attributes = mapping(body.attributes),
    genAi = mapping(attributes.gen_ai),
    direct = normalisedMessages(body.messages),
    inputs = [genAi.input, attributes["gen_ai.input"], body.input],
    outputs = [genAi.output, attributes["gen_ai.output"], body.output];
  const firstMessages = (
    values: unknown[],
    role: "user" | "assistant",
  ): Row[] => {
    for (const value of values) {
      const parsed = normalisedMessages(value, role);
      if (parsed.length) return parsed;
    }
    return [];
  };
  const messages = usable(direct) ? direct : firstMessages(inputs, "user"),
    output = firstMessages(outputs, "assistant");
  for (const message of output) {
    if (!messageHasContent(message)) continue;
    if (!messages.length || !pythonEqual(message, messages.at(-1)))
      messages.push(message);
  }
  for (const value of [...inputs, ...outputs]) {
    const data = decoded(value),
      sources = record(data) ? data.messages : null;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (!record(source) || !Array.isArray(source.parts)) continue;
      const parts = source.parts,
        text = parts
          .filter((part) => record(part) && part.type !== "reasoning")
          .map((part) => pythonString(first(part.content, part.text, "")))
          .join("");
      for (const message of messages)
        if (
          pythonEqual(message.role, source.role) &&
          pythonEqual(message.content, text)
        ) {
          message.parts = [...parts];
          if (
            parts.length &&
            parts.every(
              (part) => record(part) && Object.hasOwn(part, "content"),
            )
          )
            delete message.content;
          break;
        }
    }
  }
  return messages;
}
export function summaryOutputTokens(summary: unknown): unknown {
  return (
    field(field(summary, "usage"), "completion_tokens") ??
    field(summary, "tokens_out")
  );
}
export function selectedSpanSignalData(
  span: unknown,
  messages: readonly Row[],
): Row {
  const raw = plain(span),
    attributes = mapping(field(raw, "attributes")),
    genAi = mapping(attributes.gen_ai),
    tool = mapping(genAi.tool);
  let definitions = first(
    tool.definitions,
    attributes["gen_ai.tool.definitions"],
  );
  const requestCandidates = [
    attributes["openresponses.request"],
    attributes["orq.openresponses.request"],
    mapping(attributes.openresponses).request,
    mapping(mapping(attributes.orq).openresponses).request,
  ];
  for (const candidate of requestCandidates) {
    const value = decoded(candidate);
    if (record(value) && Array.isArray(value.tools)) {
      definitions = value.tools;
      break;
    }
  }
  let usage = mapping(first(field(raw, "usage"), genAi.usage));
  const start = parseSummaryTime(
      first(field(raw, "started_at"), field(raw, "start_time")),
    ),
    end = parseSummaryTime(
      first(field(raw, "ended_at"), field(raw, "end_time")),
    ),
    responseCandidates = [
      attributes["openresponses.response"],
      attributes["orq.openresponses.response"],
      mapping(attributes.openresponses).response,
      mapping(mapping(attributes.orq).openresponses).response,
    ];
  let items: Row[] = [];
  for (const candidate of responseCandidates) {
    let value = decoded(candidate);
    if (record(value)) {
      const responseUsage = mapping(value.usage);
      if (Object.keys(responseUsage).length && !Object.keys(usage).length)
        usage = responseUsage;
      value = value.output;
    }
    if (Array.isArray(value)) {
      items = value.filter(record).map((item) => ({ ...item }));
      if (items.length) break;
    }
  }
  const orders = new Set<number>(),
    sidecars = new Map<string, Row[]>(),
    unmapped: Row[] = [];
  for (const item of items) {
    const type = item.type,
      id = item.call_id,
      candidates = new Set<number>();
    if (typeof id === "string" && id) {
      for (const [index, message] of messages.entries())
        if (
          message.role === "assistant" &&
          toolCallEntries(message.tool_calls).some(
            (call) => record(call) && first(call.id, call.call_id) === id,
          )
        )
          candidates.add(index);
    } else if (type === "message") {
      const text = responseItemText(item);
      for (const [index, message] of messages.entries())
        if (
          message.role === "assistant" &&
          typeof message.content === "string" &&
          text === message.content
        )
          candidates.add(index);
    }
    if (candidates.size !== 1) {
      unmapped.push(item);
      continue;
    }
    const index = [...candidates][0] as number,
      key = String(index);
    orders.add(index);
    let captured = item;
    if (
      ["function_call", "function_call_output", "message"].includes(
        String(type),
      )
    )
      captured = Object.fromEntries(
        [
          "id",
          "call_id",
          "type",
          "name",
          "status",
          "error_type",
          "finish_reason",
        ]
          .filter((key) => Object.hasOwn(item, key))
          .map((key) => [key, item[key]]),
      );
    sidecars.set(key, [...(sidecars.get(key) ?? []), captured]);
  }
  const sorted = [...orders].sort((a, b) => a - b),
    details = mapping(
      first(usage.input_tokens_details, usage.prompt_tokens_details),
    ),
    metrics = Object.fromEntries(
      Object.entries({
        prompt_tokens: firstNumber(usage, "input_tokens", "prompt_tokens"),
        completion_tokens: firstNumber(
          usage,
          "output_tokens",
          "completion_tokens",
        ),
        cached_tokens: firstNumber(
          details,
          "cached_tokens",
          "cache_read_input_tokens",
        ),
        cost_usd: firstNumber(usage, "cost_usd", "cost"),
      }).filter(([, value]) => value !== null),
    ),
    result: Row = {
      step_order: sorted.length === 1 ? sorted[0] : null,
      step_orders: sorted,
      output_items_by_order: Object.fromEntries(sidecars),
      unmapped_output_items: unmapped,
      output_item_count: items.length,
      tool_definitions: Array.isArray(definitions) ? definitions : [],
      tool_definitions_present: Array.isArray(definitions),
    };
  if (Object.keys(metrics).length) result.metrics = metrics;
  if (start !== null) {
    result.started_at = parseIso(start).iso;
    result.start_timestamp = parseIso(start).epochSeconds;
  }
  if (end !== null) {
    result.ended_at = parseIso(end).iso;
    result.end_timestamp = parseIso(end).epochSeconds;
  }
  return result;
}
