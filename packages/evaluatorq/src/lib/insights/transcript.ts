import {
  coerceContentText,
  containsMediaContent,
  toolResultToText,
} from "../common/messages.js";
import {
  capText,
  cleanModelText,
  type JevState,
  jevState,
  jevStateCharLimit,
  type MessageSpan,
  type ModelText,
  messageLines,
  pairToolCallResults,
  type Questions,
  serializedChars,
  serializedQuestionChars,
  type ToolCallRecord,
} from "../common/model-input.js";
import { scrubKnownSecrets } from "../common/redact.js";
import { pythonString, pythonStrip } from "../common/sanitize.js";
import {
  type TraceDocument,
  toChatMessages,
} from "../common/trace-document.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";
import { SHELL_TOOL_NAMES } from "../signals/config.js";
import { pythonRegexEngine } from "../signals/python-regex.js";
import type { TraceRecord } from "../trace-finder/models.js";
import { toolCallEntries } from "../trace-finder/orq-source-data.js";
import {
  toolCallStatus,
  toolResultCategory,
} from "../trace-finder/projection.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function callName(call: Row): string {
  const name = record(call.function) ? call.function.name : call.name;
  return typeof name === "string" && name ? name : "(unnamed)";
}
export function rawCallArguments(call: Row): string {
  const raw =
    (record(call.function) ? call.function.arguments : call.arguments) ?? null;
  if (typeof raw === "string") return raw;
  try {
    return pythonJson(raw);
  } catch {
    return "";
  }
}
const stringField = pythonRegexEngine(
  String.raw`"?(\w+)"?\s*:\s*"((?:[^"\\]|\\.)*)`,
);
export function callArguments(call: Row): Row {
  const raw = rawCallArguments(call);
  try {
    const value = raw ? parsePythonJson(raw) : {};
    return record(value) ? value : {};
  } catch {
    return Object.fromEntries(
      [
        ...raw.matchAll(
          new RegExp(stringField.source, `${stringField.flags}g`),
        ),
      ].map((match) => [
        match[1] as string,
        (match[2] as string).replace(/\\(.)/gu, (_, char: string) =>
          char === "n" ? "\n" : char === "t" ? "\t" : char,
        ),
      ]),
    );
  }
}
export function shellCommand(arguments_: Row): string {
  for (const key of ["command", "cmd", "script"]) {
    const value = arguments_[key];
    if (typeof value === "string") return scrubKnownSecrets(value);
    if (Array.isArray(value))
      return scrubKnownSecrets(value.map(pythonString).join(" "));
  }
  return "";
}
export function fullConversationViewWithMessageSpans(
  trace: TraceRecord | TraceDocument,
): readonly [ModelText, readonly MessageSpan[], number] {
  const messages = toChatMessages(trace),
    [calls] = pairToolCallResults(messages),
    byPosition = new Map(
      calls.map((call) => [`${call.index}:${call.callIndex}`, call]),
    ),
    statuses = new Map(
      calls.map((call) => [
        `${call.index}:${call.callIndex}`,
        toolCallStatus(
          call.call.id,
          call.results.map(([, result]) => result),
        ),
      ]),
    ),
    details = new Map<number, readonly [string, string]>();
  for (const call of calls)
    for (const [index] of call.results)
      details.set(index, [
        `${callName(call.call)} (call ${call.index}.${call.callIndex + 1})`,
        statuses.get(`${call.index}:${call.callIndex}`) as string,
      ]);
  const lines: [string, number][] = [];
  const entries: [string, number][] = [];
  for (const [index, message] of messages.entries()) {
    const role = pythonString(message.role || "unknown");
    if (role === "tool" || role === "function") {
      const content = message.content ?? null,
        text = pythonStrip(
          cleanModelText(
            containsMediaContent(content)
              ? coerceContentText(content)
              : toolResultToText(content),
          ),
        ),
        [label, status] = details.get(index) ?? [
          "(no matching call)",
          "completed",
        ],
        flag = status === "completed" ? "" : ` [${status}]`;
      entries.push([`#${index} tool result ${label}${flag}: ${text}`, index]);
      continue;
    }
    const content = coerceContentText(message.content);
    if (pythonStrip(content))
      entries.push([
        `#${index} ${role}: ${pythonStrip(cleanModelText(content))}`,
        index,
      ]);
    for (const [callIndex, call] of toolCallEntries(
      message.tool_calls,
    ).entries()) {
      if (!record(call)) continue;
      const key = `${index}:${callIndex}`;
      if (!byPosition.has(key))
        throw new Error("tool call has no paired source record");
      const status = statuses.get(key),
        flag = status === "completed" ? "" : ` [${status}]`,
        text = pythonStrip(
          cleanModelText(
            SHELL_TOOL_NAMES.has(callName(call))
              ? shellCommand(callArguments(call))
              : rawCallArguments(call),
          ),
        );
      entries.push([
        `#${index} tool input ${callName(call)} (call ${index}.${callIndex + 1})${flag}: ${text}`,
        index,
      ]);
    }
  }
  let offset = 0;
  const spans: MessageSpan[] = entries.map(([line, index]) => {
    const rendered = line.replaceAll("\n", "\n  "),
      length = Array.from(rendered).length,
      span = [offset, offset + length, index] as const;
    lines.push([rendered, index]);
    offset += length + 1;
    return span;
  });
  const conversation = lines.map(([line]) => line).join("\n");
  return [
    messageLines(conversation, spans, { partsCut: false }),
    Object.freeze(spans),
    messages.length,
  ];
}

const wrappers: Readonly<Record<string, string | null>> = {
  uv: "run",
  poetry: "run",
  uvx: null,
  npx: null,
  bunx: null,
  rtk: null,
  sudo: null,
  time: null,
  env: null,
  nohup: null,
  timeout: null,
};
const withSubcommand = new Set([
  "git",
  "gh",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "docker",
  "kubectl",
  "orq",
  "go",
  "cargo",
  "make",
  "brew",
  "uv",
  "terraform",
]);
const stateBuiltins = new Set([
  "cd",
  "source",
  ".",
  "export",
  "set",
  "unset",
  "pushd",
  "popd",
]);
const blockOpeners = new Set(["for", "while", "until", "if", "case", "select"]);
const blockWords = new Set(["do", "then", "else", "elif", "{", "(", "!"]);
const blockClosers = new Set(["done", "fi", "esac", "}", ")"]);
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = "",
    quote: string | null = null,
    started = false;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string;
    if (quote === null) {
      if (char === "#") break;
      if (/\s/u.test(char)) {
        if (started) {
          words.push(word);
          word = "";
          started = false;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        started = true;
        continue;
      }
      if (char === "\\") {
        if (i + 1 >= segment.length) {
          quote = "invalid";
          break;
        }
        word += segment[++i];
        started = true;
        continue;
      }
      word += char;
      started = true;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === '"' && char === "\\") {
      const next = segment[i + 1];
      if (next === '"' || next === "\\") {
        word += next;
        i++;
        continue;
      }
      word += char;
      continue;
    }
    word += char;
  }
  if (quote !== null)
    return pythonStrip(segment)
      .split(/\s+/u)
      .filter((word) => word && word !== "(" && word !== ")");
  if (started) words.push(word);
  return words.filter((word) => word !== "(" && word !== ")");
}
function stripWrappers(input: string[]): string[] {
  let words = input;
  while (words.length && Object.hasOwn(wrappers, words[0] as string)) {
    const sub = wrappers[words[0] as string];
    words = words.slice(sub && words[1] === sub ? 2 : 1);
    while (
      words.length &&
      (words[0]?.startsWith("-") ||
        /^\d+[smh]?$/.test(words[0] as string) ||
        /^[\p{L}\p{N}_]+=/u.test(words[0] as string))
    )
      words = words.slice(words[0] === "-u" ? 2 : 1);
  }
  return words;
}
export function firstCommand(command: string): string {
  for (const segment of command
    .replaceAll("\\\n", " ")
    .split(/&&|\|\||;|\||\n/)) {
    let words = shellWords(segment);
    if (
      !words.length ||
      blockOpeners.has(words[0] as string) ||
      /^[\p{L}\p{N}_]+=\S*\$\(/u.test(words[0] as string)
    )
      continue;
    while (words.length && blockWords.has(words[0] as string))
      words = words.slice(1);
    while (words.length && /^[\p{L}\p{N}_]+=/u.test(words[0] as string))
      words = words.slice(1);
    if (
      !words.length ||
      stateBuiltins.has(words[0] as string) ||
      blockClosers.has(words[0] as string)
    )
      continue;
    words = stripWrappers(words);
    if (!words.length) continue;
    const program =
      (words[0] as string).split("/").filter(Boolean).at(-1) ?? "";
    if (!/^[\p{L}\p{N}_.+-]+$/u.test(program) || program.startsWith("-"))
      continue;
    const rest = words.slice(1).filter((word) => !word.startsWith("-"));
    return withSubcommand.has(program) && rest.length
      ? `${program} ${rest[0]}`
      : program;
  }
  return "(none)";
}
const risky =
  /\bgit\s+(push|reset|clean|rebase|branch\s+-D|checkout\s+--|restore|stash|tag\s+-d|filter-branch)\b|\brm\s|\bgh\s+(pr\s+(merge|close|edit|comment|create|review)|release|repo\s+(delete|edit)|issue\s+(close|delete)|api\b)|\bkubectl\s+(delete|apply|scale|rollout)|\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)|\bterraform\s+(apply|destroy)|\bdrop\s+(table|database)\b|\btruncate\s+table\b|--force\b|\s-f\b.*\bpush\b|\bchmod\b|\bchown\b|\bkill(all)?\b|\bpkill\b|\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)|\bnpm\s+publish\b|\buv\s+publish\b|\btwine\s+upload\b|\bpsql\b|\bmysql\b|\bssh\b|\bscp\b/i;
export function isRiskyCommand(command: string): boolean {
  return risky.test(command);
}
export function toolStats(trace: TraceRecord | TraceDocument): {
  tools: Record<string, number>;
  skills: Record<string, number>;
  commands: Record<string, number>;
} {
  const tools = new Map<string, number>(),
    skills = new Map<string, number>(),
    commands = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);
  for (const message of toChatMessages(trace)) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls))
      continue;
    for (const call of message.tool_calls) {
      if (!record(call)) continue;
      const name = callName(call),
        args = callArguments(call);
      if (name === "Skill") {
        const matched = [
            ...rawCallArguments(call).matchAll(/"skill"\s*:\s*"([^"]+)"/g),
          ].map((match) => match[1] as string),
          names = matched.length
            ? matched
            : Object.hasOwn(args, "skill")
              ? [args.skill]
              : [];
        for (const name of names)
          add(skills, scrubKnownSecrets(pythonString(name)));
        continue;
      }
      add(tools, name);
      if (SHELL_TOOL_NAMES.has(name))
        add(commands, firstCommand(shellCommand(args)));
    }
  }
  const sorted = (counts: Map<string, number>) =>
    Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  return {
    tools: sorted(tools),
    skills: sorted(skills),
    commands: sorted(commands),
  };
}
export function toolInventory(trace: TraceRecord | TraceDocument): string {
  const stats = toolStats(trace),
    tools = Object.entries(stats.tools),
    skills = Object.entries(stats.skills),
    commands = Object.entries(stats.commands);
  if (!tools.length && !skills.length) return "No tool calls.";
  const lines = [
    `Tool calls: ${tools.reduce((sum, [, count]) => sum + count, 0)}`,
    ...tools.map(([name, count]) => `- ${name} x${count}`),
  ];
  if (commands.length)
    lines.push(
      "Shell commands:",
      ...commands.slice(0, 40).map(([name, count]) => `- ${name} x${count}`),
    );
  if (skills.length)
    lines.push(
      "Skills loaded:",
      ...skills.map(([name, count]) => `- ${name} x${count}`),
    );
  return lines.join("\n");
}

export function detailedConversationView(
  trace: TraceRecord | TraceDocument,
  budget: number,
): ModelText {
  const [whole, spans] = fullConversationViewWithMessageSpans(trace),
    source = Array.from(String(whole)),
    lines: string[] = [],
    nextSpans: MessageSpan[] = [];
  let offset = 0,
    partsCut = false;
  for (const [start, end, index] of spans) {
    const entry = source.slice(start, end).join("").replaceAll("\n  ", "\n");
    const match = entry.match(
      /^(#\d+ tool (?:input|result) .*? \(call \d+\.\d+\)(?: \[[^\]]+\])?: |#\d+ tool result \(no matching call\)(?: \[[^\]]+\])?: |#\d+ [^:]+: )([\s\S]*)$/u,
    );
    if (!match) throw new Error("Unable to identify conversation entry");
    const prefix = match[1] as string,
      body = match[2] as string,
      kind = prefix.includes(" tool input ")
        ? "tool_input"
        : prefix.includes(" tool result ")
          ? "tool_result"
          : prefix.match(/^#\d+ ([^:]+): /)?.[1];
    const cap =
        kind === "user"
          ? 8000
          : kind === "assistant"
            ? 1000
            : kind === "tool_input" || kind === "tool_result"
              ? 300
              : -1,
      chars = Array.from(body);
    let fitted = body;
    if (cap !== -1 && chars.length > cap + 40) {
      const head = Math.floor(cap / 2),
        tail = cap - head;
      fitted = `${chars.slice(0, head).join("")} [... ${chars.length - cap} chars left out ...] ${chars.slice(-tail).join("")}`;
      partsCut = true;
    }
    const line = (prefix + fitted).replaceAll("\n", "\n  "),
      length = Array.from(line).length;
    lines.push(line);
    nextSpans.push([offset, offset + length, index]);
    offset += length + 1;
  }
  return capText(
    messageLines(lines.join("\n"), nextSpans, { partsCut }),
    budget,
  )[0];
}

const outputMarkers: readonly [string, RegExp][] = [
  [
    "nonzero_exit",
    /exit(?:ed with)? (?:code|status)[: ]+[1-9]|"exit_code":\s*[1-9]|^Script failed/im,
  ],
  [
    "tests_failed",
    /\b[1-9]\d* (?:failed|failing|errors?)\b|^FAILED |tests? failed/im,
  ],
  [
    "exception",
    /Traceback \(most recent call last\)|^panic:|Unhandled exception/m,
  ],
  [
    "build_failed",
    /\bSyntaxError\b|error\[E\d+\]|error TS\d+|build failed|compilation failed/i,
  ],
];
const textLength = (text: string) => Array.from(text).length;
function headTail(text: string, head: number, tail: number): string {
  const chars = Array.from(text);
  return chars.length <= head + tail + 40
    ? text
    : `${chars.slice(0, head).join("")} [... ${chars.length - head - tail} chars left out ...] ${chars.slice(-tail).join("")}`;
}
function activityLine(call: Row, paired: readonly Row[]): string {
  const name = callName(call),
    command = SHELL_TOOL_NAMES.has(name)
      ? shellCommand(callArguments(call))
      : rawCallArguments(call),
    input = Array.from(
      scrubKnownSecrets(
        SHELL_TOOL_NAMES.has(name) ? command.replaceAll("\n", " ⏎ ") : command,
      ),
    )
      .slice(0, 300)
      .join("");
  const status = toolCallStatus(call.id, paired),
    category = toolResultCategory(call.id, paired),
    evidence: string[] = [];
  if (category !== null) evidence.push(`diagnostic: ${category}`);
  const result = paired[0];
  if (result && SHELL_TOOL_NAMES.has(name)) {
    const text = toolResultToText(result.content ?? null),
      markers = outputMarkers
        .filter(([, pattern]) => pattern.test(text))
        .map(([label]) => label);
    if (markers.length) evidence.push(`output shows: ${markers.join(", ")}`);
    const excerpt = headTail(scrubKnownSecrets(pythonStrip(text)), 150, 150);
    if (excerpt) evidence.push(`output: ${excerpt}`.replaceAll("\n", " ⏎ "));
  }
  return `CALL ${name} [${status}]: ${input}\n  → ${evidence.join("; ") || "result body omitted"}`;
}
function chunkActivity(lines: readonly string[], budget: number): string[] {
  let index = 0;
  while (index < lines.length && (lines[index] as string).startsWith("USER:"))
    index++;
  const body = lines.slice(index);
  if (!body.length)
    throw new Error("non-Jev tool activity has no call records to chunk");
  let opening = lines.slice(0, index).join("\n");
  const largest = Math.max(...body.map((line) => textLength(line) + 1)),
    contextBudget = budget - largest - 80;
  if (contextBudget < textLength("[... 0 chars left out ...]"))
    throw new Error(
      "one non-Jev tool-activity record cannot fit with its chunk header",
    );
  if (textLength(opening) > contextBudget)
    opening = String(capText(opening, contextBudget)[0]);
  const capacity = budget - textLength(opening) - 80;
  if (capacity < largest)
    throw new Error(
      "one non-Jev tool-activity record cannot fit with its chunk context and header",
    );
  const groups: string[][] = [[]];
  let used = 0;
  for (const line of body) {
    let last = groups[groups.length - 1] as string[];
    if (last.length && used + textLength(line) + 1 > capacity) {
      last = [];
      groups.push(last);
      used = 0;
    }
    last.push(line);
    used += textLength(line) + 1;
  }
  const chunks = groups.map((group, i) =>
    [
      opening,
      `[part ${i + 1} of ${groups.length} of the tool calls, in order]`,
      ...group,
    ]
      .join("\n")
      .replace(/^\n+/, ""),
  );
  if (chunks.some((chunk) => textLength(chunk) > budget))
    throw new Error(
      "non-Jev tool-activity chunk exceeded its question-reserved state budget",
    );
  return chunks;
}
export function textToolActivityChunks(
  trace: TraceRecord | TraceDocument,
  options: {
    traceInputChars: number;
    budget?: number;
    questionPayloads?: Questions;
  },
): string[] {
  const requestBudget = Math.min(
    options.traceInputChars,
    options.budget ?? options.traceInputChars,
  );
  if (requestBudget < 1)
    throw new Error("trace input character cap must be positive");
  const chunkBudget =
    requestBudget - serializedQuestionChars(options.questionPayloads ?? []);
  if (chunkBudget <= 0)
    throw new Error(
      "classifier questions leave no tool-activity state budget under the configured input cap",
    );
  const messages = toChatMessages(trace),
    [calls] = pairToolCallResults(messages),
    paired = new Map(
      calls.map((record) => [
        `${record.index}:${record.callIndex}`,
        record.results.map(([, result]) => result),
      ]),
    ),
    lines: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      const text = pythonStrip(
        coerceContentText(message.content).replace(
          /<system-reminder>[\s\S]*?<\/system-reminder>/g,
          "",
        ),
      );
      if (text) lines.push(`USER: ${headTail(text, 400, 200)}`);
    } else if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls)
    ) {
      for (const [callIndex, call] of message.tool_calls.entries())
        if (record(call))
          lines.push(
            activityLine(call, paired.get(`${index}:${callIndex}`) ?? []),
          );
    }
  }
  const callLines = lines.filter((line) => line.startsWith("CALL"));
  if (callLines.some((line) => textLength(line) + 1 > chunkBudget))
    throw new Error(
      "one non-Jev tool-activity record exceeds the question-reserved state budget",
    );
  if (!callLines.length) {
    if (textLength("No tool calls.") > chunkBudget)
      throw new Error(
        "classifier questions leave no non-Jev state budget for tool activity",
      );
    return ["No tool calls."];
  }
  return lines.reduce((sum, line) => sum + textLength(line), 0) +
    lines.length -
    1 <=
    chunkBudget
    ? [lines.join("\n")]
    : chunkActivity(lines, chunkBudget);
}

type ActivityUnit =
  | { kind: "call"; index: number; order: number; record: ToolCallRecord }
  | { kind: "orphan"; index: number; order: number; message: Row };
function activityUnits(messages: Row[]): ActivityUnit[] {
  const [calls, orphans] = pairToolCallResults(messages);
  const units: ActivityUnit[] = calls.map((item) => {
    const call = item.call;
    if (!SHELL_TOOL_NAMES.has(callName(call)))
      return {
        kind: "call",
        index: item.index,
        order: item.callIndex,
        record: item,
      };
    const command = shellCommand(callArguments(call)),
      changed = record(call.function)
        ? { ...call, function: { ...call.function, arguments: command } }
        : { ...call, arguments: command };
    return {
      kind: "call",
      index: item.index,
      order: item.callIndex,
      record: { ...item, call: changed },
    };
  });
  for (const [index, message] of orphans)
    units.push({ kind: "orphan", index, order: 0, message });
  return units.sort((a, b) => a.index - b.index || a.order - b.order);
}
function jevActivityState(
  context: Row[],
  units: readonly ActivityUnit[],
  budget: number,
  part: number,
  total: number,
): JevState | null {
  const source = [...context],
    groups = new Map<number, ToolCallRecord[]>(),
    events: {
      index: number;
      order: number;
      kind: "calls" | "result" | "orphan";
      value: unknown;
      call?: ToolCallRecord;
    }[] = [];
  for (const unit of units) {
    if (unit.kind === "call") {
      const group = groups.get(unit.index) ?? [];
      group.push(unit.record);
      groups.set(unit.index, group);
      for (const [index, message] of unit.record.results)
        events.push({
          index,
          order: 1,
          kind: "result",
          value: message,
          call: unit.record,
        });
    } else
      events.push({
        index: unit.index,
        order: 1,
        kind: "orphan",
        value: unit.message,
      });
  }
  for (const [index, value] of groups)
    events.push({ index, order: 0, kind: "calls", value });
  events.sort((a, b) => a.index - b.index || a.order - b.order);
  const callMetadata = new Map<string, Row>(),
    resultMetadata = new Map<number, Row>(),
    expectedCalls = new Set<string>(),
    expectedResults = new Set<number>();
  for (const event of events) {
    if (event.kind === "calls") {
      const calls = [...(event.value as ToolCallRecord[])].sort(
          (a, b) => a.callIndex - b.callIndex,
        ),
        index = source.length;
      source.push({
        role: "assistant",
        tool_calls: calls.map((call) => call.call),
      });
      calls.forEach((call, callIndex) => {
        const key = `${index}:${callIndex}`,
          paired = call.results.map(([, result]) => result),
          metadata: Row = { status: toolCallStatus(call.call.id, paired) },
          category = toolResultCategory(call.call.id, paired);
        if (category !== null) metadata.diagnostic = category;
        expectedCalls.add(key);
        callMetadata.set(key, metadata);
      });
      continue;
    }
    const index = source.length,
      message = event.value as Row;
    source.push(message);
    expectedResults.add(index);
    if (
      event.kind === "result" &&
      event.call &&
      SHELL_TOOL_NAMES.has(callName(event.call.call))
    ) {
      const content = message.content ?? null,
        text = pythonStrip(
          containsMediaContent(content)
            ? coerceContentText(content)
            : toolResultToText(content),
        ),
        markers = outputMarkers
          .filter(([, pattern]) => pattern.test(text))
          .map(([label]) => label);
      if (markers.length)
        resultMetadata.set(index, { output_markers: markers });
    }
  }
  const state = jevState(source, { globalCharCap: budget });
  state.activity_chunk = { part, total };
  const visibleCalls = new Set<string>(),
    visibleResults = new Set<number>();
  const annotateResult = (item: Row, index: number) => {
    for (const key of ["status", "exit_code", "error_code"])
      if (Object.hasOwn(item, key))
        item[key] = cleanModelText(pythonString(item[key]));
    Object.assign(item, resultMetadata.get(index) ?? {});
  };
  for (const entry of state.messages) {
    if (entry.type === "tool_call") {
      if (
        typeof entry.index === "number" &&
        typeof entry.call_index === "number"
      ) {
        const key = `${entry.index}:${entry.call_index}`;
        visibleCalls.add(key);
        Object.assign(entry, callMetadata.get(key) ?? {});
      }
      for (const result of entry.results ?? [])
        if (record(result) && typeof result.index === "number") {
          visibleResults.add(result.index);
          annotateResult(result, result.index);
        }
    } else if (
      entry.type === "orphan_result" &&
      typeof entry.index === "number"
    ) {
      visibleResults.add(entry.index);
      annotateResult(entry, entry.index);
    }
  }
  if (
    expectedCalls.size !== visibleCalls.size ||
    [...expectedCalls].some((key) => !visibleCalls.has(key)) ||
    expectedResults.size !== visibleResults.size ||
    [...expectedResults].some((key) => !visibleResults.has(key))
  )
    return null;
  return serializedChars(state) <= budget ? state : null;
}
export function jevToolActivityChunks(
  trace: TraceRecord | TraceDocument,
  options: {
    traceInputChars: number;
    budget?: number;
    questionPayloads?: Questions;
  },
): readonly (string | JevState)[] {
  const requestBudget = Math.min(
    options.traceInputChars,
    options.budget ?? options.traceInputChars,
  );
  if (requestBudget < 1)
    throw new Error("trace input character cap must be positive");
  const messages = toChatMessages(trace),
    units = activityUnits(messages),
    stateBudget = jevStateCharLimit(options.questionPayloads ?? [], {
      globalCharCap: requestBudget,
    });
  if (!units.length) {
    if (textLength("No tool calls.") > stateBudget)
      throw new Error(
        "classifier questions leave no Jev state budget for tool activity",
      );
    return ["No tool calls."];
  }
  const context = messages.filter((message) => message.role === "user"),
    groups: ActivityUnit[][] = [];
  let current: ActivityUnit[] = [];
  for (const unit of units) {
    const candidate = [...current, unit];
    if (
      jevActivityState(
        context,
        candidate,
        stateBudget,
        999999999,
        999999999,
      ) !== null
    ) {
      current = candidate;
      continue;
    }
    if (!current.length)
      throw new Error(
        "one Jev tool-activity record exceeds the reserved classifier state budget",
      );
    groups.push(current);
    current = [unit];
    if (
      jevActivityState(context, current, stateBudget, 999999999, 999999999) ===
      null
    )
      throw new Error(
        "one Jev tool-activity record exceeds the reserved classifier state budget",
      );
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const state = jevActivityState(
      context,
      group,
      stateBudget,
      index + 1,
      groups.length,
    );
    if (state === null)
      throw new Error(
        "Jev tool-activity chunk exceeded its reserved classifier state budget",
      );
    return state;
  });
}
