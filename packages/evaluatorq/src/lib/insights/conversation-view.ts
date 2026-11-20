import {
  coerceContentText,
  containsMediaContent,
  reasoningText,
  toolResultToText,
} from "../common/messages.js";
import {
  capText,
  cleanModelText,
  type MessageSpan,
  type ModelText,
  messageLines,
  pairToolCallResults,
  type ToolCallRecord,
  toolResultMetadata,
} from "../common/model-input.js";
import { scrubKnownSecrets } from "../common/redact.js";
import { pythonString, pythonStrip } from "../common/sanitize.js";
import {
  type TraceDocument,
  toChatMessages,
} from "../common/trace-document.js";
import { parsePythonJson } from "../formats/json.js";
import { SHELL_TOOL_NAMES } from "../signals/config.js";
import type { TraceRecord } from "../trace-finder/models.js";
import { toolCallEntries } from "../trace-finder/orq-source-data.js";
import { toolCallStatus } from "../trace-finder/projection.js";
import {
  detectWorkingDirectory,
  MIN_REFERENCED_RESULT_CHARS,
  plainArguments,
  ReadableStyle,
  TextReducer,
} from "./readable-style.js";
import {
  callArguments,
  callName,
  firstCommand,
  isRiskyCommand,
  rawCallArguments,
  shellCommand,
  skillNames,
} from "./transcript.js";

type Row = Record<string, unknown>;

export const TOOL_INPUT_CHARS = 300;
export const USER_TURN_CHARS = 8_000;
export const ASSISTANT_CHARS = 1_000;
export const REASONING_CHARS = 2_000;
export const TOOL_RESULT_CHARS = 300;
export const TARGET_CHARS = 80;
export const CUT_SLACK = 40;

export const MESSAGE_KINDS = [
  "system",
  "user",
  "assistant",
  "reasoning",
  "tool_input",
  "tool_result",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type ToolsMode = "collapsed" | "per_call";
type Caps = Record<MessageKind, number>;

const ROLE_KINDS: Readonly<Record<string, MessageKind>> = {
  system: "system",
  developer: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool_result",
  function: "tool_result",
};
const KIND_LABELS: Readonly<Record<MessageKind, string>> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  reasoning: "reasoning",
  tool_input: "tool input",
  tool_result: "tool result",
};
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const chars = (text: string) => Array.from(text);
const len = (text: string) => chars(text).length;
const head = (text: string, n: number) => chars(text).slice(0, n).join("");
const tail = (text: string, n: number) =>
  n > 0 ? chars(text).slice(-n).join("") : "";
const pyList = (values: readonly string[]) =>
  `[${values.map((value) => `'${value}'`).join(", ")}]`;
const floorHalf = (n: number) => Math.floor(n / 2);

function messageKinds(
  kinds: Iterable<MessageKind> | string,
  name: string,
): ReadonlySet<MessageKind> {
  if (typeof kinds === "string")
    throw new TypeError(
      `${name} takes a collection of message kinds, not a string`,
    );
  const selected = new Set(kinds);
  const unknown = [...selected]
    .filter((kind) => !(MESSAGE_KINDS as readonly string[]).includes(kind))
    .sort();
  if (unknown.length)
    throw new Error(
      `unknown message kinds ${pyList(unknown)}, expected some of ${pyList([...MESSAGE_KINDS].sort())}`,
    );
  return selected;
}

export interface ConversationViewOptions {
  readonly include: ReadonlySet<MessageKind>;
  readonly tools: ToolsMode;
  readonly system_chars: number;
  readonly user_chars: number;
  readonly assistant_chars: number;
  readonly reasoning_chars: number;
  readonly tool_input_chars: number;
  readonly tool_result_chars: number;
}

function optionCaps(options: ConversationViewOptions): Caps {
  return {
    system: options.system_chars,
    user: options.user_chars,
    assistant: options.assistant_chars,
    reasoning: options.reasoning_chars,
    tool_input: options.tool_input_chars,
    tool_result: options.tool_result_chars,
  };
}

/** What `fullConversationView` renders and how much of each message type it keeps; `-1` keeps a type whole. */
export function conversationViewOptions(
  fields: Partial<
    Omit<ConversationViewOptions, "include"> & {
      include: Iterable<MessageKind>;
    }
  > = {},
): ConversationViewOptions {
  const options: ConversationViewOptions = {
    include: messageKinds(
      fields.include ??
        MESSAGE_KINDS.filter((k) => k !== "reasoning" && k !== "tool_result"),
      "include",
    ),
    tools: fields.tools ?? "collapsed",
    system_chars: fields.system_chars ?? -1,
    user_chars: fields.user_chars ?? USER_TURN_CHARS,
    assistant_chars: fields.assistant_chars ?? ASSISTANT_CHARS,
    reasoning_chars: fields.reasoning_chars ?? REASONING_CHARS,
    tool_input_chars: fields.tool_input_chars ?? TOOL_INPUT_CHARS,
    tool_result_chars: fields.tool_result_chars ?? TOOL_RESULT_CHARS,
  };
  if (options.tools !== "collapsed" && options.tools !== "per_call")
    throw new Error(
      `tools must be 'collapsed' or 'per_call', got '${options.tools}'`,
    );
  if (options.tools === "collapsed" && options.include.has("tool_result"))
    throw new Error(
      "tools='collapsed' shows no tool results; use tools='per_call' or leave out 'tool_result'",
    );
  for (const [kind, cap] of Object.entries(optionCaps(options)))
    if (cap !== -1 && cap < 2)
      throw new Error(
        `the ${kind} cap must be -1 (whole) or at least 2, got ${cap}`,
      );
  return Object.freeze(options);
}

/** One line of tool names per message, no results. */
export const COMPACT = conversationViewOptions();
/** Every call and its result, results cut to 300 characters. */
export const DETAILED = conversationViewOptions({
  include: MESSAGE_KINDS.filter((k) => k !== "reasoning"),
  tools: "per_call",
});
/** Everything whole, one line per call. */
export const WHOLE = conversationViewOptions({
  include: MESSAGE_KINDS.filter((k) => k !== "reasoning"),
  tools: "per_call",
  system_chars: -1,
  user_chars: -1,
  assistant_chars: -1,
  reasoning_chars: -1,
  tool_input_chars: -1,
  tool_result_chars: -1,
});

export interface ConversationViewOverrides {
  include?: Iterable<MessageKind> | null;
  exclude?: Iterable<MessageKind>;
  system_chars?: number | null;
  user_chars?: number | null;
  assistant_chars?: number | null;
  assistant_edge?: number | null;
  reasoning_chars?: number | null;
  tools?: ToolsMode | null;
  tool_input_chars?: number | null;
  tool_result_chars?: number | null;
  tool_max_chars?: number | null;
  coverage_header?: boolean;
  style?: ReadableStyle | null;
}

function viewKinds(
  include: Iterable<MessageKind> | null | undefined,
  exclude: Iterable<MessageKind>,
  defaults: ReadonlySet<MessageKind>,
): ReadonlySet<MessageKind> {
  const selected = messageKinds(include ?? defaults, "include");
  const dropped = messageKinds(exclude, "exclude");
  if (include != null) {
    const both = [...selected].filter((kind) => dropped.has(kind)).sort();
    if (both.length)
      throw new Error(
        `include and exclude both name ${both.join(", ")}; name each message type in only one`,
      );
  }
  return new Set([...selected].filter((kind) => !dropped.has(kind)));
}

function viewCaps(
  options: ConversationViewOptions,
  overrides: ConversationViewOverrides,
): Caps {
  const caps = optionCaps(options);
  if (caps.assistant !== -1)
    caps.assistant = Math.max(1, floorHalf(caps.assistant));
  for (const kind of [
    "system",
    "user",
    "reasoning",
    "tool_input",
    "tool_result",
  ] as const) {
    const value = overrides[`${kind}_chars`];
    if (value != null) caps[kind] = value;
  }
  const assistant = overrides.assistant_chars;
  if (assistant != null)
    caps.assistant = assistant === -1 ? -1 : Math.max(1, floorHalf(assistant));
  if (overrides.assistant_edge != null)
    caps.assistant = overrides.assistant_edge;
  if (overrides.tool_max_chars != null)
    caps.tool_result = overrides.tool_max_chars;
  for (const [kind, cap] of Object.entries(caps)) {
    const floor = kind === "tool_result" ? 0 : 1;
    if (cap !== -1 && cap < floor)
      throw new Error(
        `the ${kind} cap must be -1 (whole) or >= ${floor}, got ${cap}`,
      );
  }
  return caps;
}

function viewTools(
  tools: ToolsMode | null | undefined,
  defaults: ToolsMode,
  kinds: ReadonlySet<MessageKind>,
): ToolsMode {
  const selected = tools ?? defaults;
  if (selected !== "collapsed" && selected !== "per_call")
    throw new Error(
      `tools must be 'collapsed' or 'per_call', got '${selected}'`,
    );
  if (selected === "collapsed" && kinds.has("tool_result"))
    throw new Error(
      "tools='collapsed' shows no tool results; use tools='per_call' or leave out 'tool_result'",
    );
  return selected;
}

const showsResults = (
  kinds: ReadonlySet<MessageKind>,
  caps: Caps,
  tools: ToolsMode,
) => kinds.has("tool_result") && tools === "per_call" && caps.tool_result !== 0;

/** Render one preset with source-indexed entries, optional overrides and opt-in readable styling. */
export function fullConversationView(
  trace: TraceRecord | TraceDocument,
  budget: number,
  options: ConversationViewOptions = COMPACT,
  overrides: ConversationViewOverrides = {},
): ModelText {
  const kinds = viewKinds(
    overrides.include,
    overrides.exclude ?? [],
    options.include,
  );
  const caps = viewCaps(options, overrides);
  const tools = viewTools(overrides.tools, options.tools, kinds);
  const style = overrides.style ?? null;
  const [text, spans, messageCount, present, partsCut] =
    new ConversationRenderer(trace, kinds, caps, tools, style).render();
  const rendered = messageLines(text, spans, { partsCut });
  if (!overrides.coverage_header) return capText(rendered, budget)[0];
  const settings = {
    kinds,
    caps,
    tools,
    present,
    messageCount,
    style: style ?? new ReadableStyle(),
  };
  let header = coverageHeader({ ...settings, cut: false });
  let [body, omitted] = capUnderHeader(rendered, header, budget);
  if (omitted) {
    header = coverageHeader({ ...settings, cut: true });
    [body] = capUnderHeader(rendered, header, budget);
  }
  const bodyText = String(body);
  return messageLines(bodyText ? `${header}\n${bodyText}` : header, [], {
    partsCut: partsCut || Boolean(omitted),
  });
}

function capUnderHeader(
  rendered: ModelText,
  header: string,
  cap: number,
): [ModelText, number] {
  const room = cap - len(header) - 1;
  if (room < 1)
    throw new Error("the view budget is too small for the coverage header");
  return capText(rendered, room);
}

function capPhrase(kind: MessageKind, cap: number): string {
  const label = KIND_LABELS[kind];
  if (cap === -1) return `${label} whole`;
  if (kind === "assistant") return `${label} ${cap} chars at each end`;
  if (kind === "tool_input") return `${label} ${cap} chars`;
  return `${label} ${cap} chars (start and end kept)`;
}

function coverageHeader(settings: {
  kinds: ReadonlySet<MessageKind>;
  caps: Caps;
  tools: ToolsMode;
  present: ReadonlySet<MessageKind>;
  messageCount: number;
  cut: boolean;
  style: ReadableStyle;
}): string {
  const { kinds, caps, tools, present, style } = settings;
  const results = showsResults(kinds, caps, tools);
  const shown = MESSAGE_KINDS.filter(
    (kind) => kinds.has(kind) && !(kind === "tool_result" && !results),
  );
  const included = shown
    .filter((kind) => present.has(kind))
    .map((k) => KIND_LABELS[k]);
  const absent = shown
    .filter((kind) => !present.has(kind))
    .map((k) => KIND_LABELS[k]);
  const leftOut = MESSAGE_KINDS.filter((kind) => !shown.includes(kind)).map(
    (k) => KIND_LABELS[k],
  );
  const cuts = shown
    .filter(
      (kind) =>
        present.has(kind) && !(kind === "tool_input" && tools === "collapsed"),
    )
    .map((kind) => capPhrase(kind, caps[kind]));
  const parts = [`includes ${included.join(", ") || "nothing"}`];
  if (leftOut.length) parts.push(`left out: ${leftOut.join(", ")}`);
  if (absent.length) parts.push(`none in this trace: ${absent.join(", ")}`);
  if (cuts.length) parts.push(`cuts: ${cuts.join(", ")}`);
  if (shown.includes("tool_input"))
    parts.push(
      tools === "per_call"
        ? style.blocks
          ? "tools: one block per call"
          : "tools: one line per call"
        : "tools: calls collapsed to one `tools:` line per run, results left out",
    );
  const pairing =
    style.blocks && tools === "per_call" && kinds.has("tool_input") && results;
  const layout = style
    .formatNotes()
    .filter((note) => note !== "results paired with calls" || pairing);
  if (layout.length) parts.push(`format: ${layout.join(", ")}`);
  if (style.pair_results && !pairing)
    parts.push(
      style.blocks
        ? "pairing disabled: requires shown tool inputs and results in per-call mode"
        : "pairing disabled: requires block layout",
    );
  const reductions = style.reductionNotes();
  if (reductions.length) parts.push(`reduced: ${reductions.join(", ")}`);
  parts.push(`${settings.messageCount} source messages`);
  if (settings.cut) parts.push("view cut to budget");
  return `[context: ${parts.join("; ")}]`;
}

function block(header: string, body: string): string {
  return body
    ? [header, ...body.split("\n").map((row) => `  ${row}`)].join("\n")
    : header;
}

function headerText(value: unknown): string {
  return cleanModelText(value).replaceAll("\r", " ⏎ ").replaceAll("\n", " ⏎ ");
}

function resultOutcome(message: Row): string {
  let status = toolCallStatus("result", [
    { ...message, tool_call_id: "result" },
  ]);
  const [, recordedExit, errorCode] = toolResultMetadata(message);
  let exitCode: unknown = recordedExit;
  if (exitCode === null) {
    const content = toolResultToText(message.content ?? null);
    let decoded: unknown = null;
    try {
      decoded = parsePythonJson(content);
    } catch {
      decoded = null;
    }
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const fields = decoded as Row;
      exitCode = fields.exit_code ?? null;
      const outcome = fields.outcome;
      if (
        exitCode === null &&
        outcome &&
        typeof outcome === "object" &&
        !Array.isArray(outcome)
      )
        exitCode = (outcome as Row).exit_code ?? null;
    } else {
      const match = content.match(/^Exit (?:code|status)[: ]+(-?\d+)\b/i);
      if (match) exitCode = match[1];
    }
  }
  if (
    exitCode !== null &&
    typeof exitCode !== "boolean" &&
    /^-?\d+$/.test(pythonString(exitCode)) &&
    pythonString(exitCode)
      .replace(/^-+/, "")
      .replace(/^0+|0+$/g, "")
  )
    status = "error";
  if (errorCode !== null && errorCode !== false && errorCode !== "")
    status = "error";
  const parts = [status];
  if (exitCode !== null) parts.push(`exit ${headerText(exitCode)}`);
  if (errorCode !== null) parts.push(`error ${headerText(errorCode)}`);
  return parts.join(", ");
}

const errorsFirst = (outcomes: Iterable<string>) =>
  [...new Set(outcomes)].sort(
    (a, b) => Number(!a.startsWith("error")) - Number(!b.startsWith("error")),
  );

function callOutcome(results: readonly [number, Row][]): string {
  return (
    errorsFirst(results.map(([, result]) => resultOutcome(result))).join(
      "; ",
    ) || "pending"
  );
}

const keyOf = (index: number, callIndex: number) => `${index}:${callIndex}`;

function callRuns(messages: readonly Row[]): Map<string, string[]> {
  const runs = new Map<string, string[]>();
  let first: string | null = null;
  let signature: string | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") continue;
    if (
      reasoningText(message) ||
      pythonStrip(coerceContentText(message.content))
    )
      first = null;
    const calls = toolCallEntries(message.tool_calls);
    if (message.role !== "assistant" || !calls.length) {
      first = null;
      continue;
    }
    for (const [callIndex, call] of calls.entries()) {
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        first = null;
        continue;
      }
      const key = keyOf(index, callIndex);
      const callSignature = JSON.stringify([
        prepare(callName(call as Row)),
        prepare(rawCallArguments(call as Row)),
      ]);
      if (first !== null && callSignature === signature)
        runs.get(first)?.push(key);
      else {
        first = key;
        signature = callSignature;
        runs.set(key, [key]);
      }
    }
  }
  return new Map([...runs].filter(([, members]) => members.length > 1));
}

const runStatus = (statuses: readonly string[]) =>
  statuses.includes("error")
    ? "error"
    : statuses.includes("pending")
      ? "pending"
      : "completed";

function viewWorkingDirectory(
  trace: TraceRecord | TraceDocument,
  records: Iterable<ToolCallRecord>,
): string | null {
  const capture = trace.captureMetadata as Row;
  const recorded = ["cwd", "workdir", "working_directory"]
    .map((key) => capture[key])
    .filter((value): value is string => typeof value === "string");
  if (
    pythonString(capture.source ?? "").startsWith("local:") &&
    trace.project.startsWith("/")
  )
    recorded.push(trace.project);
  return detectWorkingDirectory(
    [...records].map((record) => rawCallArguments(record.call)),
    { recorded },
  );
}

function prepare(
  text: string,
  reducer: TextReducer | null = null,
  transform: ((text: string) => string) | null = null,
): string {
  let out = text;
  if (reducer !== null || transform !== null) out = scrubKnownSecrets(out);
  if (transform !== null) out = transform(out);
  if (reducer !== null) out = reducer.beforeScrub(out);
  out = scrubKnownSecrets(out).replace(REMINDER, "[harness reminder omitted]");
  return reducer !== null ? reducer.afterScrub(out) : out;
}

export function joinCut(head_: string, tail_: string, omitted: number): string {
  return `${head_} [... ${omitted} chars left out ...] ${tail_}`;
}

function labelledCut(
  text: string,
  limit: number,
  label: string,
  firstOnly = false,
): string {
  const size = len(text);
  if (size <= limit) return text;
  let marker = `[... ${size} chars of ${label} left out ...]`;
  if (len(marker) > limit)
    throw new Error(
      "the message cap is too small for a labelled omission marker",
    );
  let retained = limit - len(marker);
  for (;;) {
    marker = `[... ${size - retained} chars of ${label} left out ...]`;
    const room = limit - len(marker);
    if (retained <= room) break;
    retained = room;
  }
  const first = firstOnly ? retained : floorHalf(retained);
  const last = firstOnly ? 0 : retained - first;
  return `${head(text, first)}${marker}${tail(text, last)}`;
}

function headTail(
  text: string,
  headChars: number,
  tailChars: number,
  label: string | null = null,
): string {
  if (label !== null) return labelledCut(text, headChars + tailChars, label);
  const size = len(text);
  if (size <= headChars + tailChars + CUT_SLACK) return text;
  return joinCut(
    head(text, headChars),
    tail(text, tailChars),
    size - headChars - tailChars,
  );
}

function cut(prepared: string, cap: number, label: string | null = null) {
  if (cap === -1) return prepared;
  return headTail(
    label !== null ? prepared : pythonStrip(prepared),
    floorHalf(cap),
    cap - floorHalf(cap),
    label,
  );
}

function clean(text: string, cap: number, label: string | null = null) {
  return cut(prepare(text), cap, label);
}

function fit(text: string, cap: number): [string, boolean] {
  const cleaned = pythonStrip(cleanModelText(text));
  const size = len(cleaned);
  if (cap === -1 || size <= cap + CUT_SLACK) return [cleaned, false];
  return [
    joinCut(
      head(cleaned, floorHalf(cap)),
      tail(cleaned, cap - floorHalf(cap)),
      size - cap,
    ),
    true,
  ];
}

const inputText = (call: Row) =>
  SHELL_TOOL_NAMES.has(callName(call))
    ? shellCommand(callArguments(call))
    : rawCallArguments(call);

function callLine(call: Row, limit: number): string {
  const name = callName(call);
  const args = callArguments(call);
  if (SHELL_TOOL_NAMES.has(name)) {
    const command = shellCommand(args);
    if (isRiskyCommand(command))
      return `${name}: \`${fit(command, limit)[0].replaceAll("\n", " ⏎ ")}\``;
    return `${name}: ${firstCommand(command)}`;
  }
  if (name === "Skill") {
    const skills = skillNames(call, args);
    return `${name}: ${skills[0] ?? "?"}`;
  }
  for (const key of [
    "file_path",
    "path",
    "url",
    "query",
    "description",
    "pattern",
  ]) {
    const value = args[key];
    if (typeof value === "string")
      return `${name}: ${fit(value, TARGET_CHARS)[0]}`;
  }
  return name;
}

type RenderResult = [
  string,
  readonly MessageSpan[],
  number,
  ReadonlySet<MessageKind>,
  boolean,
];

class ConversationRenderer {
  private readonly explicitStyle: boolean;
  private readonly style: ReadableStyle;
  private readonly messages: Row[];
  private readonly records = new Map<string, ToolCallRecord>();
  private readonly statuses = new Map<string, string>();
  private readonly callLabels = new Map<string, string>();
  private readonly resultLabels = new Map<number, string>();
  private readonly resultDetails = new Map<number, [string, string]>();
  private readonly showResults: boolean;
  private readonly pair: boolean;
  private readonly pairedResults: ReadonlySet<number>;
  private readonly cwd: string | null;
  private readonly reducer: TextReducer | null;
  private readonly runs: Map<string, string[]>;
  private readonly folded: ReadonlySet<string>;
  private readonly seenResults = new Map<string, string>();
  private lines: [string, number][] = [];
  private readonly present = new Set<MessageKind>();
  private readonly pending: string[] = [];
  private pendingIndex = 0;
  private partsCut = false;

  constructor(
    trace: TraceRecord | TraceDocument,
    private readonly include: ReadonlySet<MessageKind>,
    private readonly caps: Caps,
    private readonly tools: ToolsMode,
    style: ReadableStyle | null,
  ) {
    this.explicitStyle =
      style !== null &&
      (style.blocks ||
        style.plain_tool_input ||
        style.labelled_cuts ||
        style.strip_terminal_noise ||
        style.shorten_cwd ||
        style.collapse_repeats ||
        style.collapse_blobs);
    this.style = style ?? new ReadableStyle();
    this.messages = toChatMessages(trace) as Row[];
    const [calls] = pairToolCallResults(this.messages);
    for (const call of calls) {
      const id = call.call.id;
      const record: ToolCallRecord =
        this.style.blocks && (typeof id !== "string" || !id)
          ? { ...call, results: [] }
          : call;
      this.records.set(keyOf(record.index, record.callIndex), record);
    }
    let number = 0;
    for (const [key, record] of this.records) {
      const status = toolCallStatus(
        record.call.id,
        record.results.map(([, result]) => result as Row),
      );
      this.statuses.set(key, status);
      this.callLabels.set(key, `c${++number}`);
      for (const [resultIndex] of record.results) {
        this.resultLabels.set(resultIndex, `c${number}`);
        this.resultDetails.set(resultIndex, [
          `${callName(record.call)} (call ${record.index}.${record.callIndex + 1})`,
          status,
        ]);
      }
    }
    this.showResults = showsResults(include, caps, tools);
    this.pair =
      this.style.pair_results &&
      this.style.blocks &&
      tools === "per_call" &&
      include.has("tool_input");
    this.pairedResults = new Set(this.pair ? this.resultLabels.keys() : []);
    this.cwd = this.style.shorten_cwd
      ? viewWorkingDirectory(trace, this.records.values())
      : null;
    this.reducer = TextReducer.forStyle(this.style, this.cwd);
    this.runs =
      this.style.collapse_repeats && tools === "per_call"
        ? callRuns(this.messages)
        : new Map();
    this.folded = new Set(
      [...this.runs.values()].flatMap((members) => members.slice(1)),
    );
  }

  private cutLabel(kind: MessageKind): string | null {
    return this.style.labelled_cuts ? KIND_LABELS[kind] : null;
  }

  private fit(text: string, cap: number): string {
    const [fitted, wasCut] = fit(text, cap);
    this.partsCut ||= wasCut;
    return fitted;
  }

  private add(index: number, label: string, text: string): void {
    this.lines.push([
      this.style.blocks
        ? block(`[${index}] ${headerText(label)}`, text)
        : `#${index} ${label}: ${text}`,
      index,
    ]);
  }

  private flush(): void {
    if (!this.pending.length) return;
    const runs: [string, number][] = [];
    for (const entry of this.pending) {
      const last = runs.at(-1);
      if (last && last[0] === entry) last[1]++;
      else runs.push([entry, 1]);
    }
    this.add(
      this.pendingIndex,
      "tools",
      runs
        .map(([entry, count]) => (count > 1 ? `${entry} x${count}` : entry))
        .join(", "),
    );
    this.pending.length = 0;
  }

  private capResult(text: string): string {
    return this.explicitStyle
      ? cut(text, this.caps.tool_result, this.cutLabel("tool_result"))
      : this.fit(text, this.caps.tool_result);
  }

  private resultText(index: number, message: Row): string {
    const content = message.content ?? null;
    const text = containsMediaContent(content)
      ? coerceContentText(content)
      : toolResultToText(content);
    const prepared = this.explicitStyle
      ? prepare(text, this.reducer)
      : pythonStrip(cleanModelText(text));
    if (this.style.collapse_repeats) {
      const scrubbed = prepare(text);
      if (len(scrubbed) >= MIN_REFERENCED_RESULT_CHARS) {
        const earlier = this.seenResults.get(scrubbed);
        if (earlier === undefined) {
          const label = this.resultLabels.get(index);
          this.seenResults.set(
            scrubbed,
            this.style.blocks && label ? `[${index}] (${label})` : `[${index}]`,
          );
        } else {
          const reference = `same as result ${earlier}`;
          if (len(reference) < len(prepared)) return this.capResult(reference);
        }
      }
    }
    return this.capResult(prepared);
  }

  private addResult(index: number, message: Row): void {
    const body = this.resultText(index, message);
    let rendered: string;
    if (this.style.blocks) {
      const label = this.resultLabels.get(index);
      const subject = label
        ? `result of ${label}`
        : "orphan (no matching call)";
      rendered = block(
        `[${index}] tool result [${resultOutcome(message)}] ${subject}`,
        body,
      );
    } else {
      const [label, status] = this.resultDetails.get(index) ?? [
        "(no matching call)",
        "completed",
      ];
      const flag = status === "completed" ? "" : ` [${status}]`;
      rendered = `#${index} tool result ${label}${flag}: ${body}`;
    }
    this.lines.push([rendered, index]);
    this.present.add("tool_result");
  }

  private toolInputText(call: Row): string {
    const cap = this.caps.tool_input;
    if (
      !(this.style.plain_tool_input || this.style.labelled_cuts || this.reducer)
    )
      return this.fit(inputText(call), cap);
    const shell =
      !this.style.plain_tool_input && SHELL_TOOL_NAMES.has(callName(call));
    let text = this.style.plain_tool_input
      ? prepare(rawCallArguments(call), this.reducer, plainArguments)
      : prepare(
          shell ? shellCommand(callArguments(call)) : rawCallArguments(call),
          this.reducer,
        );
    if (shell && !this.style.blocks) text = text.replaceAll("\n", " ⏎ ");
    if (cap !== -1 && len(text) > cap)
      text = this.style.labelled_cuts
        ? labelledCut(text, cap, "tool input", true)
        : head(text, cap);
    return text;
  }

  private addMessageText(index: number, message: Row): void {
    const reasoning = this.include.has("reasoning")
      ? reasoningText(message)
      : "";
    if (reasoning) {
      this.flush();
      const text = this.explicitStyle
        ? clean(reasoning, this.caps.reasoning, this.cutLabel("reasoning"))
        : this.fit(reasoning, this.caps.reasoning);
      this.add(index, "reasoning", text);
      this.present.add("reasoning");
    }
    const role = pythonString(message.role || "unknown");
    const kind = ROLE_KINDS[role] ?? "system";
    const content = coerceContentText(message.content);
    if (!this.include.has(kind) || !pythonStrip(content)) return;
    this.flush();
    const cap = this.caps[kind];
    let text: string;
    if (!this.explicitStyle)
      text = this.fit(
        content,
        kind === "assistant" && cap !== -1 ? cap * 2 : cap,
      );
    else {
      text = clean(
        content,
        kind === "assistant" ? -1 : cap,
        this.cutLabel(kind),
      );
      if (kind === "assistant" && cap !== -1)
        text = headTail(text, cap, cap, this.cutLabel(kind));
    }
    this.add(index, role, text);
    this.present.add(kind);
  }

  private addCall(index: number, call: Row, key: string): void {
    const members = this.runs.get(key) ?? [key];
    const status = runStatus(
      members.map((member) => this.statuses.get(member) as string),
    );
    const times = members.length > 1 ? ` x${members.length}` : "";
    const args = this.toolInputText(call);
    let rendered: string;
    if (this.style.blocks) {
      const span =
        members.length === 1
          ? this.callLabels.get(key)
          : `${this.callLabels.get(key)}-${this.callLabels.get(members.at(-1) as string)}`;
      const outcomes = errorsFirst(
        members.map((member) =>
          callOutcome(
            (this.records.get(member) as ToolCallRecord).results as [
              number,
              Row,
            ][],
          ),
        ),
      );
      rendered = block(
        `[${index}] tool call [${outcomes.join("; ")}] ${headerText(callName(call))} (${span})${times}`,
        args,
      );
    } else {
      const callIndex = Number(key.split(":")[1]);
      const flag = status === "completed" ? "" : ` [${status}]`;
      rendered = `#${index} tool input ${callName(call)} (call ${index}.${callIndex + 1})${times}${flag}: ${args}`;
    }
    this.lines.push([rendered, index]);
    this.present.add("tool_input");
    if (this.pair && this.showResults)
      for (const member of members)
        for (const [resultIndex, result] of (
          this.records.get(member) as ToolCallRecord
        ).results)
          this.addResult(resultIndex, result as Row);
  }

  private addCalls(index: number, message: Row): void {
    if (!this.include.has("tool_input")) return;
    for (const [callIndex, call] of toolCallEntries(
      message.tool_calls,
    ).entries()) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      const key = keyOf(index, callIndex);
      if (this.tools === "collapsed") {
        if (!this.pending.length) this.pendingIndex = index;
        const status = this.statuses.get(key) ?? "completed";
        const flag = status === "completed" ? "" : ` [${status}]`;
        this.pending.push(
          `${callLine(call as Row, this.caps.tool_input)}${flag}`,
        );
        this.present.add("tool_input");
        continue;
      }
      if (!this.folded.has(key)) this.addCall(index, call as Row, key);
    }
  }

  render(): RenderResult {
    for (const [index, message] of this.messages.entries()) {
      const role = pythonString(message.role || "unknown");
      if (ROLE_KINDS[role] === "tool_result") {
        if (this.showResults && !this.pairedResults.has(index))
          this.addResult(index, message);
        continue;
      }
      this.addMessageText(index, message);
      this.addCalls(index, message);
    }
    this.flush();
    if (!this.style.blocks)
      this.lines = this.lines.map(([line, index]) => [
        line.replaceAll("\n", "\n  "),
        index,
      ]);
    if (this.lines.length && this.cwd)
      this.lines.unshift([`paths under ${this.cwd} are shown as ./`, 0]);
    const spans: MessageSpan[] = [];
    let offset = 0;
    for (const [line, index] of this.lines) {
      const size = len(line);
      spans.push([offset, offset + size, index]);
      offset += size + 1;
    }
    return [
      this.lines.map(([line]) => line).join("\n"),
      Object.freeze(spans),
      this.messages.length,
      this.present,
      this.partsCut,
    ];
  }
}
