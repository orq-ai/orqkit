import {
  iterContentParts,
  MediaContent,
  matchToolResults,
} from "./messages.js";
import { scrubKnownSecrets } from "./redact.js";

export const CHARS_PER_ESTIMATED_TOKEN = 4;
export const JEV_STATE_CHARS = 28_000 * CHARS_PER_ESTIMATED_TOKEN;
export const JEV_STATE_QUESTION_CHARS = 32_000 * CHARS_PER_ESTIMATED_TOKEN;
export const JEV_STATE_ALL_QUESTIONS_CHARS = 64_000 * CHARS_PER_ESTIMATED_TOKEN;

const REMINDER = /<system-reminder>.*?<\/system-reminder>/gs;
const ZERO_MARKER_LENGTH = "[... 0 chars left out ...]".length;

export class ModelInputCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelInputCapError";
  }
}

// A String object still serializes as JSON text, which a wrapper type would not.
export class CappedText extends String {
  readonly sourceText: string;
  readonly sourcePrefixChars: number;
  readonly sourceSuffixChars: number;

  constructor(
    value: string,
    sourceText: string,
    prefixChars = 0,
    suffixChars = 0,
  ) {
    super(value);
    this.sourceText = sourceText;
    this.sourcePrefixChars = prefixChars;
    this.sourceSuffixChars = suffixChars;
  }
}

export type ModelText = string | CappedText;
export type MessageSpan = readonly [start: number, end: number, index: number];

class MessageLines extends CappedText {
  readonly spans: readonly MessageSpan[];
  readonly partsCut: boolean;

  constructor(
    value: string,
    sourceText: string,
    prefixChars: number,
    suffixChars: number,
    spans: readonly MessageSpan[],
    partsCut: boolean,
  ) {
    super(value, sourceText, prefixChars, suffixChars);
    this.spans = spans;
    this.partsCut = partsCut;
  }
}

// Caps count characters, not UTF-16 units, so a cut never splits an emoji.
function charLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length--;
        i++;
      }
    }
  }
  return length;
}

function charSlice(text: string, start: number, end?: number): string {
  return charLength(text) === text.length
    ? text.slice(start, end)
    : Array.from(text).slice(start, end).join("");
}

const isText = (value: unknown): value is ModelText =>
  typeof value === "string" || value instanceof String;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !(value instanceof String);

function sortKeys(value: unknown): unknown {
  if (value instanceof String) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

const sortedJson = (value: unknown): string =>
  JSON.stringify(sortKeys(value)) ?? "null";

export function messageLines(
  text: string,
  spans: readonly MessageSpan[],
  options: { partsCut: boolean },
): ModelText {
  return new MessageLines(
    text,
    text,
    charLength(text),
    0,
    spans,
    options.partsCut,
  );
}

export function capText(text: ModelText, limit: number): [ModelText, number] {
  if (limit < 1) {
    throw new ModelInputCapError("model input character cap must be positive");
  }
  if (charLength(String(text)) <= limit) {
    return [text, 0];
  }
  if (text instanceof MessageLines) {
    const byMessage = capMessageLines(text, limit);
    if (byMessage !== null) {
      return byMessage;
    }
  }
  if (limit < ZERO_MARKER_LENGTH) {
    throw new ModelInputCapError(
      "model input character cap is too small for an omission marker",
    );
  }
  const source = text instanceof CappedText ? text.sourceText : text;
  const sourceLength = charLength(source);
  let retained = Math.max(0, limit - ZERO_MARKER_LENGTH);
  let first = Math.floor(retained / 2);
  let last = retained - first;
  let omitted = sourceLength - retained;
  let marker = `[... ${omitted} chars left out ...]`;
  while (first + last + marker.length > limit && retained) {
    retained -= 1;
    first = Math.floor(retained / 2);
    last = retained - first;
    omitted = sourceLength - retained;
    marker = `[... ${omitted} chars left out ...]`;
  }
  if (first + last + marker.length > limit) {
    throw new ModelInputCapError(
      "model input character cap is too small for an exact omission marker",
    );
  }
  const tail = last ? charSlice(source, sourceLength - last) : "";
  return [
    new CappedText(
      `${charSlice(source, 0, first)}${marker}${tail}`,
      source,
      first,
      last,
    ),
    omitted,
  ];
}

function capMessageLines(
  text: MessageLines,
  limit: number,
): [ModelText, number] | null {
  const { sourceText: source, spans } = text;
  if (spans.length === 0) {
    return null;
  }
  const sourceLength = charLength(source);
  const last = Math.max(...spans.map(([, , index]) => index));
  const charMarker = `[... ${sourceLength} chars of message ${last} left out ...]`;
  const budget =
    limit -
    2 * charMarker.length -
    `[... ${spans.length} messages (${last}-${last}) left out ...]`.length -
    3;
  if (budget < 2) {
    return null;
  }
  const halfBudget = Math.floor(budget / 2);
  let tail = spans.length;
  while (
    tail > 0 &&
    sourceLength - (spans[tail - 1] as MessageSpan)[0] <= halfBudget
  ) {
    tail -= 1;
  }
  const cutEnd =
    tail < spans.length
      ? (spans[tail] as MessageSpan)[0]
      : sourceLength - halfBudget;
  let head = 0;
  while (
    head < spans.length &&
    (spans[head] as MessageSpan)[1] <= budget - (sourceLength - cutEnd)
  ) {
    head += 1;
  }
  const cutStart = head
    ? (spans[head - 1] as MessageSpan)[1]
    : budget - (sourceLength - cutEnd);

  const owner = (offset: number): MessageSpan | undefined =>
    spans.find(([start, end]) => start < offset && offset < end);

  const headEntry = owner(cutStart);
  const tailEntry = owner(cutEnd);
  const middle: string[] = [];
  if (headEntry !== undefined && headEntry === tailEntry) {
    middle.push(`[... ${cutEnd - cutStart} chars left out ...]`);
  } else {
    if (headEntry !== undefined) {
      middle.push(
        `[... ${headEntry[1] - cutStart} chars of message ${headEntry[2]} left out ...]\n`,
      );
    }
    const dropped = [
      ...new Set(
        spans
          .filter(([start, end]) => start >= cutStart && end <= cutEnd)
          .map(([, , index]) => index),
      ),
    ].sort((a, b) => a - b);
    if (dropped.length > 0) {
      const which =
        dropped.length === 1
          ? `message ${dropped[0]}`
          : `${dropped.length} messages (${dropped[0]}-${dropped[dropped.length - 1]})`;
      middle.push(`[... ${which} left out ...]\n`);
    }
    if (tailEntry !== undefined) {
      middle.push(
        `[... ${cutEnd - tailEntry[0]} chars of message ${tailEntry[2]} left out ...]`,
      );
    }
  }
  const value = `${charSlice(source, 0, cutStart)}${headEntry ? "" : "\n"}${middle.join("")}${charSlice(source, cutEnd)}`;
  return [
    new MessageLines(
      value,
      source,
      cutStart,
      sourceLength - cutEnd,
      spans,
      text.partsCut,
    ),
    cutEnd - cutStart,
  ];
}

export function sourceTextChars(text: ModelText): number {
  return charLength(text instanceof CappedText ? text.sourceText : text);
}

export function sourceTextRanges(
  text: ModelText,
): readonly (readonly [number, number])[] {
  if (!(text instanceof CappedText)) {
    return [[0, charLength(text)]];
  }
  const sourceLength = charLength(text.sourceText);
  const ranges: [number, number][] = [];
  if (text.sourcePrefixChars) {
    ranges.push([0, text.sourcePrefixChars]);
  }
  if (text.sourceSuffixChars) {
    ranges.push([sourceLength - text.sourceSuffixChars, sourceLength]);
  }
  return ranges;
}

export function hasTruncatedSourceText(value: unknown): boolean {
  if (value instanceof MessageLines && value.partsCut) {
    return true;
  }
  if (value instanceof CappedText) {
    return charLength(value.sourceText) > charLength(String(value));
  }
  if (isRecord(value)) {
    return Object.values(value).some(hasTruncatedSourceText);
  }
  return Array.isArray(value) && value.some(hasTruncatedSourceText);
}

export function serializedChars(value: unknown): number {
  return charLength(sortedJson(value));
}

export type Questions = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface ClassifierQuestionPayload {
  type: unknown;
  instructions: unknown;
  criteria?: unknown;
}

export function classifierQuestionWirePayloads(
  questions: Readonly<Record<string, unknown>>,
): Record<string, ClassifierQuestionPayload> {
  const wire: Record<string, ClassifierQuestionPayload> = {};
  for (const [name, raw] of Object.entries(questions)) {
    const question = isRecord(raw) ? raw : {};
    const payload: ClassifierQuestionPayload = {
      type: ("kind" in question ? question.kind : question.type) ?? null,
      instructions: question.instructions ?? null,
    };
    if (question.criteria !== null && question.criteria !== undefined) {
      payload.criteria = question.criteria;
    }
    wire[name] = payload;
  }
  return wire;
}

function questionWithoutState(question: unknown): unknown {
  if (!isRecord(question)) {
    return question;
  }
  const { state: _state, ...rest } = question;
  return rest;
}

function questionPayloads(
  questions: Questions,
): unknown[] | Record<string, ClassifierQuestionPayload> {
  return Array.isArray(questions)
    ? questions.map(questionWithoutState)
    : classifierQuestionWirePayloads(
        questions as Readonly<Record<string, unknown>>,
      );
}

const payloadValues = (
  payloads: unknown[] | Record<string, unknown>,
): unknown[] => (Array.isArray(payloads) ? payloads : Object.values(payloads));

export function serializedQuestionChars(questions: Questions): number {
  const payloads = questionPayloads(questions);
  return payloadValues(payloads).length > 0 ? serializedChars(payloads) : 0;
}

export function isJevModel(model: string): boolean {
  return model.toLowerCase().startsWith("typesafe/jev");
}

type RawMessage = Record<string, unknown>;

export interface ToolCallRecord {
  index: number;
  callIndex: number;
  call: Record<string, unknown>;
  results: [number, RawMessage][];
}

export function pairToolCallResults(
  messages: readonly RawMessage[],
): [ToolCallRecord[], [number, RawMessage][]] {
  const calls: ToolCallRecord[] = [];
  const rows: [unknown, (string | null)[], string | null][] = [];
  const recordOf = new Map<string, ToolCallRecord>();
  messages.forEach((message, index) => {
    const callIds: (string | null)[] = [];
    if (message.role === "assistant") {
      const toolCalls = message.tool_calls;
      (Array.isArray(toolCalls) ? toolCalls : []).forEach((call, callIndex) => {
        if (!isRecord(call)) {
          return;
        }
        const record: ToolCallRecord = { index, callIndex, call, results: [] };
        calls.push(record);
        recordOf.set(`${index}:${callIds.length}`, record);
        callIds.push(typeof call.id === "string" ? call.id : null);
      });
    }
    const toolCallId = message.tool_call_id;
    rows.push([
      message.role,
      callIds,
      typeof toolCallId === "string" ? toolCallId : null,
    ]);
  });
  const { pairs, orphans } = matchToolResults(rows as never, {
    tolerant: true,
  });
  for (const [row, positions] of pairs) {
    for (const [position, results] of positions) {
      recordOf
        .get(`${row}:${position}`)
        ?.results.push(
          ...results.map((result): [number, RawMessage] => [
            result,
            messages[result] as RawMessage,
          ]),
        );
    }
  }
  return [
    calls,
    orphans.map((index): [number, RawMessage] => [
      index,
      messages[index] as RawMessage,
    ]),
  ];
}

export interface EdgeLimit {
  total: number;
  edge: number;
}

export interface JevOptions {
  stateChars: number;
  assistant: EdgeLimit;
  user: EdgeLimit;
  system: EdgeLimit;
  toolInput: EdgeLimit;
  toolResult: EdgeLimit;
  includeSystem: boolean;
  includeDeveloper: boolean;
  includeUser: boolean;
  includeAssistant: boolean;
  includeToolCalls: boolean;
  includeToolResults: boolean;
  coverage: boolean;
  locatedOmission: boolean;
  fieldOrder: boolean;
  dropEmpty: boolean;
}

export const DEFAULT_JEV_OPTIONS: Readonly<JevOptions> = Object.freeze({
  stateChars: JEV_STATE_CHARS,
  assistant: { total: 1000, edge: 500 },
  user: { total: 2000, edge: 1000 },
  system: { total: 8000, edge: 4000 },
  toolInput: { total: 200, edge: 100 },
  toolResult: { total: 200, edge: 100 },
  includeSystem: true,
  includeDeveloper: true,
  includeUser: true,
  includeAssistant: true,
  includeToolCalls: true,
  includeToolResults: true,
  coverage: false,
  locatedOmission: false,
  fieldOrder: false,
  dropEmpty: false,
});

const edgePhrase = (limit: EdgeLimit): string =>
  `whole up to ${limit.total} chars, longer keeps ${limit.edge} at each end`;

export function jevCoverage(
  options: Readonly<JevOptions> = DEFAULT_JEV_OPTIONS,
): Record<string, unknown> {
  const switches: readonly [string, boolean, EdgeLimit][] = [
    ["system", options.includeSystem, options.system],
    ["developer", options.includeDeveloper, options.system],
    ["user", options.includeUser, options.user],
    ["assistant", options.includeAssistant, options.assistant],
    ["tool_calls", options.includeToolCalls, options.toolInput],
    ["tool_results", options.includeToolResults, options.toolResult],
  ];
  const includes = switches
    .filter(([, included]) => included)
    .map(([name]) => name);
  // Results ride on their calls; with calls off only orphan results remain.
  if (options.includeToolResults && !options.includeToolCalls) {
    includes[includes.indexOf("tool_results")] =
      "tool_results (only those without a call)";
  }
  const context: Record<string, unknown> = {
    includes,
    left_out: switches
      .filter(([, included]) => !included)
      .map(([name]) => name),
    reasoning: "not included",
    trimmed: Object.fromEntries(
      switches
        .filter(([, included]) => included)
        .map(([name, , limit]) => [name, edgePhrase(limit)]),
    ),
  };
  const layout = (
    [
      [
        "omissions marked in place as omission entries",
        options.locatedOmission,
      ],
      ["keys ordered with identifiers first and text last", options.fieldOrder],
      ["empty fields left out", options.dropEmpty],
    ] as const
  )
    .filter(([, enabled]) => enabled)
    .map(([text]) => text);
  if (layout.length > 0) {
    context.format = layout;
  }
  return context;
}

export interface JevEntry {
  type: string;
  index?: number;
  role?: unknown;
  text?: ModelText;
  input?: ModelText;
  results?: Record<string, unknown>[];
  call_index?: number;
  [key: string]: unknown;
}

export interface JevState {
  messages: JevEntry[];
  omission?: string;
  [key: string]: unknown;
}

const edge = (text: ModelText, limit: EdgeLimit): ModelText =>
  edgeText(text, limit.total, limit.edge);

const firstPresent = (
  primary: Record<string, unknown>,
  fallback: Record<string, unknown>,
  key: string,
): unknown => (key in primary ? primary[key] : fallback[key]) ?? null;

export function jevState(
  messages: readonly RawMessage[],
  config: { globalCharCap: number; options?: Partial<JevOptions> },
): JevState {
  const { globalCharCap } = config;
  const options: Readonly<JevOptions> = {
    ...DEFAULT_JEV_OPTIONS,
    ...config.options,
  };
  const [callRecords, orphanRecords] = pairToolCallResults(messages);
  let entries: JevEntry[] = [];
  const calls: JevEntry[] = [];
  const includedRoles = new Set(
    (
      [
        ["system", options.includeSystem],
        ["developer", options.includeDeveloper],
        ["user", options.includeUser],
        ["assistant", options.includeAssistant],
      ] as const
    )
      .filter(([, included]) => included)
      .map(([role]) => role as string),
  );
  const orphanResults: JevEntry[] = options.includeToolResults
    ? orphanRecords.map(([index, message]) => ({
        index,
        role: "tool",
        type: "orphan_result",
        ...resultEntry(message, null, globalCharCap),
      }))
    : [];

  messages.forEach((message, index) => {
    const role = "role" in message ? message.role : "unknown";
    if (typeof role === "string" && includedRoles.has(role)) {
      const [rawBody, media] = content(message.content);
      const body = capText(rawBody, globalCharCap)[0];
      if (body.length > 0 || media.length > 0) {
        entries.push({
          index,
          role,
          type: "message",
          text: body,
          ...(media.length > 0 ? { media } : {}),
        });
      }
    }
  });

  for (const record of options.includeToolCalls ? callRecords : []) {
    const { call } = record;
    const fn = isRecord(call.function) ? call.function : {};
    calls.push({
      index: record.index,
      call_index: record.callIndex,
      role: "assistant",
      type: "tool_call",
      id: call.id ?? null,
      name: firstPresent(fn, call, "name"),
      input: capText(
        cleanModelText(firstPresent(fn, call, "arguments")),
        globalCharCap,
      )[0],
      results: options.includeToolResults
        ? record.results.map(([index, message]) =>
            resultEntry(message, index, globalCharCap),
          )
        : [],
    });
  }

  entries.push(...calls, ...orphanResults);
  entries.sort(
    (a, b) =>
      (a.index as number) - (b.index as number) ||
      (a.call_index ?? -1) - (b.call_index ?? -1) ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
  );
  if (options.dropEmpty) {
    const callsPerMessage = new Map<number, number>();
    for (const call of calls) {
      const index = call.index as number;
      callsPerMessage.set(index, (callsPerMessage.get(index) ?? 0) + 1);
    }
    entries = entries.map((entry) =>
      compact(entry, callsPerMessage.get(entry.index as number) === 1),
    );
  }
  const bounded = capMessages(entries, globalCharCap);
  for (const entry of bounded.messages) {
    if (entry.type === "message") {
      const limit =
        entry.role === "assistant"
          ? options.assistant
          : entry.role === "user"
            ? options.user
            : options.system;
      entry.text = edge(entry.text as ModelText, limit);
    } else if (entry.type === "tool_call") {
      if (entry.input !== undefined) {
        entry.input = edge(entry.input, options.toolInput);
      }
      if (entry.results !== undefined) {
        entry.results = entry.results.map((result) =>
          "text" in result
            ? {
                ...result,
                text: edge(result.text as ModelText, options.toolResult),
              }
            : result,
        );
      }
    } else if (entry.type === "orphan_result" && entry.text !== undefined) {
      entry.text = edge(entry.text, options.toolResult);
    }
  }
  const omittedBefore =
    messages.length - representedIndexes(bounded.messages).size;
  const cap = Math.min(globalCharCap, options.stateChars);
  const metadata = options.coverage
    ? { context: jevCoverage(options) }
    : undefined;
  const state = options.locatedOmission
    ? locatedState(bounded.messages, {
        total: messages.length,
        cap,
        omittedBefore,
        metadata,
      })
    : capMessages(bounded.messages, cap, omittedBefore, metadata);
  if (options.dropEmpty) {
    // The size cap can empty a text further; that only shrinks the state.
    state.messages = state.messages.map((entry) =>
      entry.type === "omission" ? entry : compact(entry, false),
    );
  }
  if (options.fieldOrder) {
    state.messages = state.messages.map((entry) =>
      entry.type === "omission" ? entry : (inFieldOrder(entry) as JevEntry),
    );
  }
  return state;
}

const isEmptyText = (value: unknown): boolean =>
  isText(value) && value.length === 0;

function compact(entry: JevEntry, dropCallIndex: boolean): JevEntry {
  const kept = Object.fromEntries(
    Object.entries(entry).filter(
      ([key, value]) =>
        !(
          ((key === "text" || key === "input") &&
            isEmptyText(value) &&
            entry.type !== "message") ||
          (key === "results" && Array.isArray(value) && value.length === 0) ||
          (key === "call_index" && value === 0 && dropCallIndex)
        ),
    ),
  ) as JevEntry;
  if (kept.results !== undefined) {
    kept.results = kept.results.map((result) =>
      Object.fromEntries(
        Object.entries(result).filter(
          ([key, value]) => !(key === "text" && isEmptyText(value)),
        ),
      ),
    );
  }
  return kept;
}

const IDENTIFIER_KEYS = [
  "index",
  "call_index",
  "role",
  "type",
  "id",
  "name",
  "status",
  "exit_code",
  "error_code",
  "media",
];
const BODY_KEYS = ["text", "input", "results"];

function inFieldOrder(entry: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of IDENTIFIER_KEYS) {
    if (key in entry) {
      ordered[key] = entry[key];
    }
  }
  for (const [key, value] of Object.entries(entry)) {
    if (!(key in ordered) && !BODY_KEYS.includes(key)) {
      ordered[key] = value;
    }
  }
  for (const key of BODY_KEYS) {
    if (key in entry) {
      ordered[key] = entry[key];
    }
  }
  if (Array.isArray(ordered.results)) {
    ordered.results = ordered.results.map((result) =>
      inFieldOrder(result as Record<string, unknown>),
    );
  }
  return ordered;
}

function locatedState(
  entries: JevEntry[],
  config: {
    total: number;
    cap: number;
    omittedBefore: number;
    metadata: Record<string, unknown> | undefined;
  },
): JevState {
  const { total, cap, omittedBefore, metadata } = config;
  let best: JevState = {
    ...metadata,
    messages: withOmissionMarkers([], total),
  };
  if (serializedChars(best) > cap) {
    throw new ModelInputCapError(
      "model input character cap cannot fit Jev state metadata and its omission marker",
    );
  }
  let low = 1;
  let high = cap;
  while (low <= high) {
    const entryCap = Math.floor((low + high) / 2);
    let state: JevState;
    try {
      state = capMessages(entries, entryCap, omittedBefore, metadata);
    } catch (error) {
      // Below the fixed metadata reserve: a larger entry budget is required.
      if (!(error instanceof ModelInputCapError)) {
        throw error;
      }
      low = entryCap + 1;
      continue;
    }
    const { messages, omission: _omission, ...rest } = state;
    const located: JevState = {
      ...rest,
      messages: withOmissionMarkers(messages, total),
    };
    if (serializedChars(located) <= cap) {
      best = located;
      low = entryCap + 1;
    } else {
      high = entryCap - 1;
    }
  }
  return best;
}

function withOmissionMarkers(kept: JevEntry[], total: number): JevEntry[] {
  const represented = [...representedIndexes(kept)].sort((a, b) => a - b);
  const neighbours: (number | null)[] = [null, ...represented, null];
  const markers: [number, JevEntry][] = [];
  for (let i = 0; i < neighbours.length - 1; i++) {
    const after = neighbours[i] as number | null;
    const before = neighbours[i + 1] as number | null;
    const first = after === null ? 0 : after + 1;
    const end = before === null ? total : before;
    if (first < end) {
      markers.push([
        first,
        {
          type: "omission",
          after_index: after,
          before_index: before,
          messages_left_out: end - first,
        },
      ]);
    }
  }
  const located: JevEntry[] = [];
  let position = 0;
  for (const entry of kept) {
    while (
      position < markers.length &&
      (markers[position] as [number, JevEntry])[0] < (entry.index as number)
    ) {
      located.push((markers[position] as [number, JevEntry])[1]);
      position += 1;
    }
    located.push(entry);
  }
  located.push(...markers.slice(position).map(([, marker]) => marker));
  return located;
}

export function jevTextState(
  text: unknown,
  config: { globalCharCap: number },
): JevState {
  const entry: JevEntry = {
    index: 0,
    role: "user",
    type: "message",
    text: cleanModelText(text),
  };
  return capMessages([entry], config.globalCharCap);
}

export function jevStateCharLimit(
  questions: Questions,
  config: { globalCharCap?: number } = {},
): number {
  const globalCharCap = config.globalCharCap ?? JEV_STATE_CHARS;
  const payloads = questionPayloads(questions);
  const values = payloadValues(payloads);
  const longest = values.reduce<number>(
    (max, question) => Math.max(max, serializedChars(question)),
    0,
  );
  const allQuestionChars = values.length > 0 ? serializedChars(payloads) : 0;
  if (allQuestionChars > JEV_STATE_ALL_QUESTIONS_CHARS) {
    throw new ModelInputCapError(
      "classification questions alone exceed the 256000-character limit",
    );
  }
  const limit = Math.min(
    JEV_STATE_CHARS,
    globalCharCap - allQuestionChars,
    JEV_STATE_QUESTION_CHARS - longest,
    JEV_STATE_ALL_QUESTIONS_CHARS - allQuestionChars,
  );
  if (limit <= 0) {
    throw new ModelInputCapError(
      "classification questions leave no Jev state budget under the configured input cap",
    );
  }
  return limit;
}

export function fitJevState(
  state: JevState,
  questions: Questions,
  config: { globalCharCap?: number } = {},
): JevState {
  const limit = jevStateCharLimit(questions, config);
  const { messages: original = [], omission, ...metadata } = state;
  const omittedBefore = omissionCount(omission);
  if (original.some((entry) => entry.type === "omission")) {
    const entries = original.filter((entry) => entry.type !== "omission");
    const omitted = stateOmittedMessages(state);
    return locatedState(entries, {
      total: representedIndexes(entries).size + omitted,
      cap: limit,
      omittedBefore: omitted,
      metadata,
    });
  }
  return capMessages(original, limit, omittedBefore, metadata);
}

export function fitClassifierInput(
  state: ModelText | Record<string, unknown>,
  config: { model: string; questions: Questions; globalCharCap: number },
): ModelText | Record<string, unknown> {
  const { model, questions, globalCharCap } = config;
  if (isJevModel(model)) {
    if (!isRecord(state)) {
      throw new TypeError("Jev classifier state must be an object");
    }
    return fitJevState(state as JevState, questions, { globalCharCap });
  }
  const payloads = questionPayloads(questions);
  const questionChars =
    payloadValues(payloads).length > 0 ? serializedChars(payloads) : 0;
  const stateBudget = globalCharCap - questionChars;
  if (stateBudget <= 0) {
    throw new ModelInputCapError(
      "classifier questions leave no state budget under the configured model input cap",
    );
  }
  if (isRecord(state) && isText(state.conversation)) {
    return fitConversationPayload(state, stateBudget);
  }
  const rendered = isText(state) ? state : sortedJson(state);
  return capText(rendered, stateBudget)[0];
}

function fitConversationPayload(
  state: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  const conversation = state.conversation as ModelText;
  if (serializedChars(state) <= limit) {
    return state;
  }
  if (serializedChars({ ...state, conversation: "" }) > limit) {
    throw new ModelInputCapError(
      "classifier state metadata cannot fit under the configured model input cap",
    );
  }
  let low = ZERO_MARKER_LENGTH;
  let high = charLength(String(conversation));
  let best: Record<string, unknown> | null = null;
  while (low <= high) {
    const textLimit = Math.floor((low + high) / 2);
    const candidate = {
      ...state,
      conversation: capText(conversation, textLimit)[0],
    };
    if (serializedChars(candidate) <= limit) {
      best = candidate;
      low = textLimit + 1;
    } else {
      high = textLimit - 1;
    }
  }
  if (best === null) {
    throw new ModelInputCapError(
      "classifier state and omission marker cannot fit under the configured model input cap",
    );
  }
  return best;
}

function statePayload(
  messages: JevEntry[],
  omitted: number,
  metadata: Record<string, unknown>,
): JevState {
  const payload: JevState = { ...metadata, messages };
  if (omitted) {
    payload.omission = `[... ${omitted} messages left out ...]`;
  }
  return payload;
}

function capMessages(
  entries: JevEntry[],
  cap: number,
  omittedBefore = 0,
  metadata?: Record<string, unknown>,
): JevState {
  const { messages: _messages, omission: _omission, ...fixed } = metadata ?? {};
  const emptyWithoutMarker = serializedChars(statePayload([], 0, fixed)) - 2;
  const emptyWithMarker = serializedChars(statePayload([], 1, fixed)) - 2;
  const entrySizes = entries.map(serializedChars);
  const sourceIndexes = representedIndexes(entries);

  const payloadSize = (
    messageChars: number,
    messageCount: number,
    omitted: number,
  ): number =>
    (omitted === 0
      ? emptyWithoutMarker
      : emptyWithMarker + String(omitted).length - 1) +
    2 +
    messageChars +
    Math.max(0, messageCount - 1);

  const messageChars = entrySizes.reduce((sum, size) => sum + size, 0);
  if (payloadSize(messageChars, entries.length, omittedBefore) <= cap) {
    return statePayload(entries, omittedBefore, fixed);
  }

  const markerReserve = payloadSize(0, 0, 999999);
  if (cap < markerReserve) {
    throw new ModelInputCapError(
      "model input character cap is too small for the message omission marker",
    );
  }
  const half = Math.floor(Math.max(0, cap - markerReserve) / 2);
  const indexesByEntry = entries.map((entry) => representedIndexes([entry]));

  const left: JevEntry[] = [];
  const right: JevEntry[] = [];
  const selected = new Set<number>();
  let lo = 0;
  let hi = entries.length - 1;
  let leftUsed = 0;
  let rightUsed = 0;
  let selectedChars = 0;

  const keep = (
    fromLeft: boolean,
    entry: JevEntry,
    size: number,
    at: number,
  ) => {
    if (fromLeft) {
      left.push(entry);
      leftUsed += size + 1;
    } else {
      right.unshift(entry);
      rightUsed += size + 1;
    }
    selectedChars += size;
    for (const index of indexesByEntry[at] as Set<number>) {
      selected.add(index);
    }
  };

  const takeEdge = (fromLeft: boolean) => {
    const at = fromLeft ? lo : hi;
    const used = fromLeft ? leftUsed : rightUsed;
    const size = entrySizes[at] as number;
    if (used + size + 1 > half) {
      const candidate = fitEntry(entries[at] as JevEntry, half - used - 1);
      if (candidate !== null) {
        keep(fromLeft, candidate, serializedChars(candidate), at);
      }
    } else {
      keep(fromLeft, entries[at] as JevEntry, size, at);
    }
    if (fromLeft) {
      lo += 1;
    } else {
      hi -= 1;
    }
  };

  while (lo <= hi) {
    takeEdge(true);
    if (lo > hi) {
      break;
    }
    takeEdge(false);
  }

  while (lo <= hi) {
    let added = false;
    for (const fromLeft of leftUsed <= rightUsed
      ? [true, false]
      : [false, true]) {
      const at = fromLeft ? lo : hi;
      const fresh = [...(indexesByEntry[at] as Set<number>)].filter(
        (index) => !selected.has(index),
      ).length;
      const omittedCount =
        omittedBefore + sourceIndexes.size - (selected.size + fresh);
      const size = entrySizes[at] as number;
      if (
        payloadSize(
          selectedChars + size,
          left.length + right.length + 1,
          omittedCount,
        ) > cap
      ) {
        continue;
      }
      keep(fromLeft, entries[at] as JevEntry, size, at);
      if (fromLeft) {
        lo += 1;
      } else {
        hi -= 1;
      }
      added = true;
      break;
    }
    if (!added) {
      break;
    }
  }

  let omitted = omittedBefore + sourceIndexes.size - selected.size;
  let bounded = statePayload([...left, ...right], omitted, fixed);
  if (serializedChars(bounded) > cap) {
    omitted += selected.size;
    bounded = statePayload([], omitted, fixed);
    if (serializedChars(bounded) > cap) {
      throw new ModelInputCapError(
        "model input character cap cannot fit Jev state metadata and its omission marker",
      );
    }
  }
  return bounded;
}

function fitEntry(entry: JevEntry, charBudget: number): JevEntry | null {
  if (charBudget < 1) {
    return null;
  }
  let low = 0;
  let high = charBudget;
  let best: JevEntry | null = null;
  while (low <= high) {
    const textCap = Math.floor((low + high) / 2);
    const candidate = entryWithTextCap(entry, textCap);
    if (serializedChars(candidate) <= charBudget) {
      best = candidate;
      low = textCap + 1;
    } else {
      high = textCap - 1;
    }
  }
  return best;
}

function entryWithTextCap(entry: JevEntry, limit: number): JevEntry {
  const cap = (value: ModelText): ModelText =>
    limit >= ZERO_MARKER_LENGTH ? capText(value, limit)[0] : "";
  const bounded: JevEntry = { ...entry };
  if (isText(bounded.text)) {
    bounded.text = cap(bounded.text);
  }
  if (isText(bounded.input)) {
    bounded.input = cap(bounded.input);
  }
  if (Array.isArray(bounded.results)) {
    bounded.results = bounded.results.map((result) =>
      isRecord(result)
        ? { ...result, text: isText(result.text) ? cap(result.text) : "" }
        : result,
    );
  }
  return bounded;
}

function representedIndexes(entries: readonly JevEntry[]): Set<number> {
  const indexes = new Set<number>();
  for (const entry of entries) {
    if (Number.isInteger(entry.index)) {
      indexes.add(entry.index as number);
    }
    for (const result of entry.results ?? []) {
      const index = isRecord(result) ? result.index : undefined;
      if (Number.isInteger(index)) {
        indexes.add(index as number);
      }
    }
  }
  return indexes;
}

export function stateOmittedMessages(state: Partial<JevState>): number {
  const placed = (state.messages ?? []).reduce(
    (sum, entry) =>
      entry.type === "omission"
        ? sum + ((entry.messages_left_out as number | undefined) ?? 0)
        : sum,
    0,
  );
  return omissionCount(state.omission) + placed;
}

export function omissionCount(marker: unknown): number {
  if (typeof marker !== "string") {
    return 0;
  }
  const match = /^\[\.\.\. (\d+) messages left out \.\.\.\]$/.exec(marker);
  return match ? Number(match[1]) : 0;
}

function content(value: unknown): [string, string[]] {
  const textParts: string[] = [];
  const media: string[] = [];
  for (const part of iterContentParts(value)) {
    if (part instanceof MediaContent) {
      const marker =
        part.kind === "image" ? imageMarker(part.value) : `[${part.kind}]`;
      media.push(marker);
      textParts.push(marker);
    } else {
      textParts.push(cleanModelText(part));
    }
  }
  return [textParts.join("\n"), media];
}

function imageMarker(block: unknown): string {
  const part = isRecord(block) ? block : {};
  const imageUrl = part.image_url;
  let raw = part.image || part.data;
  if (isRecord(imageUrl)) {
    raw = imageUrl.url || imageUrl.data || raw;
  } else if (typeof imageUrl === "string") {
    raw = imageUrl;
  }
  const size = inlineImageSize(raw);
  return size === null
    ? "[image, size unknown]"
    : `[image, ${Math.floor(size / 1024)} KB]`;
}

function inlineImageSize(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const encoded =
    raw.startsWith("data:") && raw.includes(";base64,")
      ? raw.slice(raw.indexOf(",") + 1)
      : raw;
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return null;
  }
  const padding = encoded.length - encoded.replace(/=+$/, "").length;
  return Math.floor((encoded.length * 3) / 4) - Math.min(padding, 2);
}

function resultEntry(
  message: RawMessage,
  index: number | null,
  charCap: number,
): Record<string, unknown> {
  const [body] = content(message.content);
  const result: Record<string, unknown> = { text: capText(body, charCap)[0] };
  if (index !== null) {
    result.index = index;
  }
  const [status, exitCode, errorCode] = toolResultMetadata(message);
  if (status !== null) {
    result.status = status;
  }
  if (exitCode !== null) {
    result.exit_code = exitCode;
  }
  if (errorCode !== null) {
    result.error_code = errorCode;
  }
  return result;
}

export function cleanModelText(value: unknown): string {
  let text: string;
  if (isText(value)) {
    text = String(value);
  } else if (value !== null && typeof value === "object") {
    text = sortedJson(value);
  } else {
    text = value === null || value === undefined ? "" : String(value);
  }
  return scrubKnownSecrets(text).replace(
    REMINDER,
    "[harness reminder omitted]",
  );
}

export function edgeText(
  text: ModelText,
  total: number,
  side: number,
): ModelText {
  if (charLength(String(text)) <= total) {
    return text;
  }
  const source = text instanceof CappedText ? text.sourceText : text;
  const sourceLength = charLength(source);
  const omitted = sourceLength - side * 2;
  return new CappedText(
    `${charSlice(source, 0, side)}[... ${omitted} chars left out ...]${charSlice(source, sourceLength - side)}`,
    source,
    side,
    side,
  );
}

export function toolResultMetadata(
  message: RawMessage,
): [unknown, unknown, unknown] {
  const metadata = message.trace_finder_metadata;
  const nested = isRecord(metadata) ? metadata.tool_result : undefined;
  let status: unknown = null;
  let exitCode: unknown = null;
  let errorCode: unknown = null;
  for (const source of [nested, message]) {
    if (!isRecord(source)) {
      continue;
    }
    if (status === null) {
      status = source.status ?? null;
      if (
        status === null &&
        source.is_error !== null &&
        source.is_error !== undefined
      ) {
        status = source.is_error ? "error" : "completed";
      }
    }
    exitCode ??= source.exit_code ?? null;
    errorCode ??= source.error_code ?? null;
  }
  return [status, exitCode, errorCode];
}

export async function effectiveTraceInputChars(): Promise<number> {
  const { effectiveDashboardSettings } = await import(
    "../trace-finder/settings.js"
  );
  return (await effectiveDashboardSettings()).traceInputChars;
}
