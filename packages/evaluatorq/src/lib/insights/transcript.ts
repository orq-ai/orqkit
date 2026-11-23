import {
  coerceContentText,
  containsMediaContent,
  toolResultToText,
} from "../common/messages.js";
import {
  cleanModelText,
  type MessageSpan,
  type ModelText,
  messageLines,
  pairToolCallResults,
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
import { toolCallStatus } from "../trace-finder/projection.js";

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
