import { isDeepStrictEqual } from "node:util";

import { pythonStrip, SPACE } from "../common/sanitize.js";
import {
  type AtifAgent,
  AtifAgentSchema,
  AtifFinalMetricsSchema,
  AtifMetricsSchema,
  type AtifObservationResult,
  AtifObservationResultSchema,
  type AtifStep,
  AtifStepSchema,
  type AtifSubagentRef,
  AtifSubagentRefSchema,
  type AtifToolCall,
  AtifToolCallSchema,
  AtifTrajectory,
  atifWire,
} from "./atif.js";
import { contentSeed, stableHex } from "./ids.js";
import { parsePythonJson, pythonJson } from "./json.js";
import {
  type OtelMessage,
  OtelMessageSchema,
  type OtelPart,
  type OtelSpan,
  type OtelTrace,
  orderSpans,
  otelPartDict,
  spanUsage,
} from "./otel.js";
import {
  atifToolArguments,
  compactionExtra,
  finalMetrics,
  joinText,
  RAW_ARGUMENTS_EXTRA_KEY,
} from "./shared.js";
import { parseIso } from "./time.js";

type Row = Record<string, unknown>;
const record = (v: unknown): v is Row =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const STEP_EXTRA = "evaluatorq.atif.step.extra",
  TRAJECTORY_EXTRA = "evaluatorq.atif.trajectory.extra",
  FINAL_METRICS = "evaluatorq.atif.final_metrics",
  TOOL_CALL_EXTRA = "evaluatorq.atif.tool_call.extra",
  RESULT_EXTRA = "evaluatorq.atif.result.extra",
  RESULT_OFFSET = "evaluatorq.atif.subagent_result_offset",
  SOURCE_ID = "evaluatorq.atif.subagent_source_trajectory_id";
interface Scope {
  members: OtelSpan[];
  subagents: OtelSpan[];
}
interface Draft {
  fields: Row;
  span: OtelSpan | null;
  results: AtifObservationResult[];
  toolSpanIds: Set<string>;
  resultIndices: Map<string, number>;
  resultGroups: Map<string, number[]>;
}
const draft = (fields: Row, span: OtelSpan | null = null): Draft => ({
  fields,
  span,
  results: [],
  toolSpanIds: new Set(),
  resultIndices: new Map(),
  resultGroups: new Map(),
});
const calls = (d: Draft): AtifToolCall[] =>
  (d.fields.toolCalls as AtifToolCall[]) ?? [];
const epoch = (value: string): number => parseIso(value).epochSeconds;
const attr = (span: OtelSpan | null, key: string): string | null =>
  typeof span?.attributes[key] === "string" && span.attributes[key]
    ? span.attributes[key]
    : null;
function isPart(part: OtelPart, kind: string): boolean {
  if (part.type !== kind) return false;
  const row = part as Row;
  if (kind === "text" || kind === "reasoning")
    return typeof row.content === "string";
  if (kind === "tool_call") return typeof row.name === "string";
  if (kind === "tool_call_response") return Object.hasOwn(row, "response");
  return true;
}
const partRow = (part: OtelPart): Row => part as Row;
const dumpPart = (part: OtelPart, excludeNone = false): Row =>
  Object.fromEntries(
    Object.entries(otelPartDict(part)).filter(
      ([, v]) => !excludeNone || v !== null,
    ),
  );
function carried(span: OtelSpan | null, key: string): Row | null {
  let raw = span?.attributes[key];
  if (raw == null) return null;
  if (typeof raw === "string")
    try {
      raw = parsePythonJson(raw);
    } catch {
      raw = null;
    }
  if (record(raw) && Object.keys(raw).length === 0) return null;
  if (!record(raw)) {
    console.warn(`Span attribute ${key} is not a JSON object; ignoring it`);
    return null;
  }
  return raw;
}
function merge(
  derived: Row | null,
  saved: Row | null,
  where: string,
): Row | null {
  if (!saved || !Object.keys(saved).length) return derived;
  const current = derived ?? {};
  if (
    Object.entries(current).some(
      ([key, v]) =>
        Object.hasOwn(saved, key) && !isDeepStrictEqual(saved[key], v),
    )
  )
    console.warn(`${where}: keeping values from the trace over carried values`);
  return { ...saved, ...current };
}
function rootScope(trace: OtelTrace): OtelSpan[] {
  const roots = trace.roots();
  if (roots.length > 1) {
    console.warn("OTel trace has multiple roots; converting them as one run");
    return roots;
  }
  const first = roots[0];
  if (!first || first.operation === "invoke_agent") return roots;
  const agents = trace
    .children(first.spanId)
    .filter((s) => s.operation === "invoke_agent");
  return agents.length === 1 ? agents : roots;
}
function collect(trace: OtelTrace, tops: OtelSpan[]): Scope {
  const members: OtelSpan[] = [],
    subagents: OtelSpan[] = [],
    seen = new Set<string>(),
    stack: [OtelSpan, boolean][] = [...tops]
      .reverse()
      .map((s) => [s, s.operation === "invoke_agent"]);
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    const [span, inAgent] = entry;
    if (seen.has(span.spanId)) continue;
    seen.add(span.spanId);
    members.push(span);
    for (const child of [...trace.children(span.spanId)].reverse())
      if (child.operation === "invoke_agent" && inAgent) subagents.push(child);
      else stack.push([child, inAgent || child.operation === "invoke_agent"]);
  }
  return { members, subagents: orderSpans(subagents) };
}
function sessionId(trace: OtelTrace, tops: OtelSpan[]): string {
  for (const span of [...tops, ...trace.roots()]) {
    const id = attr(span, "gen_ai.conversation.id");
    if (id) return id;
  }
  return (
    tops.find((s) => s.traceId)?.traceId ||
    stableHex([contentSeed(trace.spans.map((s) => s.spanId))], 16)
  );
}
function toolDefinitions(chats: OtelSpan[]): Row[] | null {
  const definitions: Row[] = [],
    seen = new Set<string>();
  for (const chat of chats) {
    let raw = chat.attributes["gen_ai.tool.definitions"];
    if (typeof raw === "string")
      try {
        raw = parsePythonJson(raw);
      } catch {
        console.warn("Unreadable tool definitions; ignoring them");
        continue;
      }
    if (!Array.isArray(raw)) continue;
    for (const definition of raw) {
      if (!record(definition)) continue;
      const name = record(definition.function)
        ? definition.function.name
        : definition.name;
      if (typeof name === "string" && name && !seen.has(name)) {
        seen.add(name);
        definitions.push(definition);
      }
    }
  }
  return definitions.length ? definitions : null;
}
const fieldsByPart: Record<string, string[]> = {
  text: ["type", "content"],
  reasoning: ["type", "content"],
  tool_call: ["type", "id", "name", "arguments"],
  tool_call_response: ["type", "id", "response"],
  server_tool_call: ["type", "id", "name", "server_tool_call"],
  server_tool_call_response: ["type", "id", "server_tool_call_response"],
  blob: ["type", "mime_type", "modality", "content"],
  file: ["type", "mime_type", "modality", "file_id"],
  uri: ["type", "mime_type", "modality", "uri"],
  compaction: ["type", "id", "content"],
};
function semanticPart(part: OtelPart): Row {
  const payload = dumpPart(part, true),
    fields = fieldsByPart[part.type];
  return fields && isPart(part, part.type)
    ? Object.fromEntries(
        Object.entries(payload).filter(([key]) => fields.includes(key)),
      )
    : payload;
}
const normalizedRole = (role: string) =>
  role === "developer" ? "system" : role;
function sameParts(a: OtelPart[] | null, b: OtelPart[] | null): boolean {
  return a === null || b === null
    ? a === b
    : a.length === b.length &&
        a.every(
          (p, i) =>
            b[i] !== undefined &&
            isDeepStrictEqual(semanticPart(p), semanticPart(b[i] as OtelPart)),
        );
}
function sameTranscript(
  a: OtelMessage[] | null,
  b: OtelMessage[] | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.length === b.length &&
        a.every(
          (m, i) =>
            b[i] !== undefined &&
            normalizedRole(m.role) ===
              normalizedRole((b[i] as OtelMessage).role) &&
            sameParts(m.parts, (b[i] as OtelMessage).parts),
        );
}
function mirrorChild(trace: OtelTrace, span: OtelSpan): OtelSpan | null {
  if (span.spanType !== "trace" || span.outputMessages === null) return null;
  return (
    trace
      .children(span.spanId)
      .find(
        (child) =>
          child.operation === "chat" &&
          sameTranscript(child.inputMessages, span.inputMessages) &&
          sameTranscript(child.outputMessages, span.outputMessages) &&
          sameParts(child.systemInstructions, span.systemInstructions),
      ) ?? null
  );
}
function signature(message: OtelMessage): unknown[] {
  const text = pythonStrip(
    joinText(
      message.parts
        .filter((p) => isPart(p, "text"))
        .map((p) => String(partRow(p).content)),
    ).replace(new RegExp(`${SPACE}+`, "g"), " "),
  );
  return [
    normalizedRole(message.role),
    text,
    message.parts
      .filter((p) => !isPart(p, "text") && !isPart(p, "reasoning"))
      .map((p) =>
        pythonJson(dumpPart(p, true), { sortKeys: true, defaultString: true }),
      ),
  ];
}
const compactionPart = (part: OtelPart): boolean =>
  part.type === "compaction" ||
  (part.type === "data" &&
    record(partRow(part).content) &&
    (partRow(part).content as Row).type === "compaction");
const isCompaction = (message: OtelMessage): boolean =>
  message.parts.some(compactionPart);
function newInput(prev: OtelSpan, chat: OtelSpan): OtelMessage[] {
  const seen = [...(prev.inputMessages ?? []), ...(prev.outputMessages ?? [])],
    messages = chat.inputMessages ?? [],
    signatures = seen.map(signature),
    current = messages.map(signature);
  if (
    signatures.length &&
    isDeepStrictEqual(current.slice(0, signatures.length), signatures)
  )
    return messages.slice(signatures.length);
  const prior = (prev.inputMessages ?? []).map(signature);
  if (
    prior.length &&
    current.length > prior.length &&
    isDeepStrictEqual(current.slice(0, prior.length), prior)
  )
    return messages.slice(prior.length);
  let compacted: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      isCompaction(message) &&
      !seen.some((m) => isDeepStrictEqual(m, message))
    ) {
      compacted = i;
      break;
    }
  }
  if (compacted === null)
    console.warn(
      "Chat span does not replay its predecessor's history; aligning repeated messages in order",
    );
  const head =
      compacted === null ? [] : messages.slice(compacted, compacted + 1),
    tail = compacted === null ? messages : messages.slice(compacted + 1),
    tailSignatures = tail.map(signature);
  for (
    let length = Math.min(signatures.length, tailSignatures.length);
    length > 0;
    length--
  ) {
    const suffix = signatures.slice(-length);
    for (let i = 0; i <= tailSignatures.length - length; i++)
      if (isDeepStrictEqual(tailSignatures.slice(i, i + length), suffix))
        return [...head, ...tail.slice(0, i), ...tail.slice(i + length)];
  }
  return [...head, ...tail];
}
function splitText(parts: OtelPart[]): [string[], Row | null] {
  const texts = parts
      .filter((p) => isPart(p, "text"))
      .map((p) => String(partRow(p).content)),
    rest = parts.filter((p) => !isPart(p, "text")).map((p) => dumpPart(p));
  if (!rest.length) return [texts, null];
  console.warn("Keeping non-text OTel parts in ATIF extra.non_text_parts");
  return [texts, { non_text_parts: rest }];
}
function compactionStep(message: OtelMessage): Draft {
  const compactions = message.parts.filter(compactionPart),
    [texts, extra] = splitText(message.parts.filter((p) => !compactionPart(p)));
  texts.push(
    ...compactions.flatMap((p) =>
      p.type === "compaction" && typeof partRow(p).content === "string"
        ? [String(partRow(p).content)]
        : [],
    ),
  );
  return draft({
    source: "system",
    message: joinText(texts),
    extra: {
      ...extra,
      ...compactionExtra(compactions.map((p) => dumpPart(p))),
    },
  });
}
function messageStep(message: OtelMessage): Draft {
  const [texts, extra] = splitText(message.parts);
  return draft({
    source: message.role === "user" ? "user" : "system",
    message: joinText(texts),
    extra:
      message.role === "developer"
        ? { ...extra, original_role: "developer" }
        : extra,
  });
}
function toolCall(part: OtelPart, spanId: string, index: number): AtifToolCall {
  const p = partRow(part),
    name = String(p.name),
    id =
      typeof p.id === "string" && p.id
        ? p.id
        : `call_${stableHex([spanId, name, String(index)], 16)}`,
    [args, raw] =
      p.arguments == null
        ? ([{}, null] as const)
        : atifToolArguments(p.arguments, name);
  return AtifToolCallSchema.parse({
    toolCallId: id,
    functionName: name,
    arguments: args,
    extra: raw !== null ? { [RAW_ARGUMENTS_EXTRA_KEY]: raw } : null,
  });
}
function assistantFields(message: OtelMessage, spanId: string): Row {
  const texts: string[] = [],
    reasoning: string[] = [],
    calls: AtifToolCall[] = [],
    other: OtelPart[] = [];
  for (const p of message.parts)
    if (isPart(p, "text")) texts.push(String(partRow(p).content));
    else if (isPart(p, "reasoning")) reasoning.push(String(partRow(p).content));
    else if (isPart(p, "tool_call"))
      calls.push(toolCall(p, spanId, calls.length));
    else other.push(p);
  return {
    source: "agent",
    message: joinText(texts),
    reasoningContent: reasoning.join("\n\n") || null,
    toolCalls: calls.length ? calls : null,
    extra: splitText(other)[1],
  };
}
function result(
  callId: string | null,
  span: OtelSpan | null,
  part: OtelPart | null,
  orphan = false,
): AtifObservationResult | null {
  if (span === null && part === null) return null;
  let content: string | null = null;
  const extra: Row = {};
  if (span) {
    const value = span.attributes["gen_ai.tool.call.result"];
    if (value != null)
      content =
        typeof value === "string"
          ? value
          : pythonJson(value, { defaultString: true });
    if (span.status === "error") extra.error_type = span.errorType || "_OTHER";
    if (span.startTime !== null) extra.start_timestamp = epoch(span.startTime);
    if (span.endTime !== null) extra.end_timestamp = epoch(span.endTime);
    if (span.status !== "unset") extra.status = span.status;
  }
  if (content === null && part !== null && partRow(part).response != null) {
    const value = partRow(part).response;
    content =
      typeof value === "string"
        ? value
        : pythonJson(value, { defaultString: true });
  }
  if (orphan && callId !== null) extra.orphan_call_id = callId;
  const merged = merge(extra, carried(span, RESULT_EXTRA), RESULT_EXTRA);
  return AtifObservationResultSchema.parse({
    sourceCallId: orphan ? null : callId,
    content,
    extra: merged && Object.keys(merged).length ? merged : null,
  });
}
function history(
  messages: OtelMessage[],
  afterChat: boolean,
): {
  drafts: Draft[];
  unplaced: AtifObservationResult[];
  unpaired: OtelMessage[];
} {
  const output: {
      drafts: Draft[];
      unplaced: AtifObservationResult[];
      unpaired: OtelMessage[];
    } = { drafts: [], unplaced: [], unpaired: [] },
    issuers = new Map<string, Draft[]>();
  let unmatched = 0;
  for (const message of messages) {
    if (isCompaction(message)) output.drafts.push(compactionStep(message));
    else if (["system", "developer", "user"].includes(message.role))
      output.drafts.push(messageStep(message));
    else if (message.role === "assistant") {
      const fields = assistantFields(message, "input");
      if (message.finishReason !== null)
        fields.extra = {
          ...(fields.extra as Row | null),
          finish_reasons: [message.finishReason],
        };
      const d = draft(fields);
      d.results.push(...output.unplaced);
      output.unplaced = [];
      output.drafts.push(d);
      for (const call of calls(d)) {
        const ds = issuers.get(call.toolCallId) ?? [];
        ds.push(d);
        issuers.set(call.toolCallId, ds);
      }
    } else if (message.role === "tool")
      for (const part of message.parts) {
        if (!isPart(part, "tool_call_response")) continue;
        const id = partRow(part).id,
          callId = typeof id === "string" ? id : null,
          owners = callId ? issuers.get(callId) : undefined;
        if (!owners?.length && afterChat) {
          output.unpaired.push(
            OtelMessageSchema.parse({ ...message, parts: [part] }),
          );
          continue;
        }
        const r = result(callId, null, part, !owners?.length);
        if (!r) continue;
        const owner = owners?.shift();
        if (owner) {
          owner.results.push(r);
          continue;
        }
        unmatched++;
        const earlier = [...output.drafts]
          .reverse()
          .find((d) => d.fields.source === "agent");
        if (earlier) earlier.results.push(r);
        else output.unplaced.push(r);
      }
    else console.warn("Skipping chat input with unsupported role");
  }
  if (unmatched)
    console.warn(
      "Keeping unmatched input tool results on the nearest agent step",
    );
  return output;
}
function stepExtra(chat: OtelSpan, byId: Map<string, OtelSpan>): Row {
  const parent = chat.parentSpanId ? byId.get(chat.parentSpanId) : null,
    ancestry: Row = { function_id: chat.spanId, function_name: chat.name },
    invocation: Row = { status: chat.status };
  if (chat.parentSpanId !== null) ancestry.parent_id = chat.parentSpanId;
  if (parent) ancestry.parent_name = parent.name;
  if (chat.startTime !== null)
    invocation.start_timestamp = epoch(chat.startTime);
  if (chat.endTime !== null) invocation.end_timestamp = epoch(chat.endTime);
  const extra: Row = { ancestry, invocation };
  if (chat.errorType !== null) extra.error_type = chat.errorType;
  if (chat.attributes["gen_ai.response.finish_reasons"] != null)
    extra.finish_reasons = chat.attributes["gen_ai.response.finish_reasons"];
  const requested = attr(chat, "gen_ai.request.model"),
    responded = attr(chat, "gen_ai.response.model");
  if (requested && responded && requested !== responded)
    extra.requested_model = requested;
  return extra;
}
function metrics(chat: OtelSpan): unknown {
  const usage = spanUsage(chat);
  if (Object.values(usage).every((v) => v === null)) return null;
  const tokens = (value: number | null): number | null => {
    if (value === null || Number.isInteger(value)) return value;
    console.warn("Dropping fractional token count");
    return null;
  };
  return AtifMetricsSchema.parse({
    promptTokens: tokens(usage.inputTokens),
    completionTokens: tokens(usage.outputTokens),
    cachedTokens: tokens(usage.cachedTokens),
    costUsd: usage.costUsd,
    extra:
      usage.reasoningTokens !== null
        ? { reasoning_tokens: usage.reasoningTokens }
        : null,
  });
}
function agentStep(chat: OtelSpan, byId: Map<string, OtelSpan>): Draft | null {
  const outputs = chat.outputMessages ?? [],
    message = outputs.find((m) => m.role === "assistant");
  if (!message) {
    if (outputs.length)
      console.warn("Chat span has no assistant output message");
    return null;
  }
  if (outputs.length > 1)
    console.warn("Reading only the first assistant output message");
  const fields = assistantFields(message, chat.spanId),
    extra = stepExtra(chat, byId);
  if (
    chat.attributes["gen_ai.response.finish_reasons"] == null &&
    message.finishReason !== null
  )
    extra.finish_reasons = [message.finishReason];
  Object.assign(extra, fields.extra ?? {});
  return draft(
    {
      ...fields,
      modelName:
        attr(chat, "gen_ai.response.model") ||
        attr(chat, "gen_ai.request.model"),
      metrics: metrics(chat),
      llmCallCount: 1,
      timestamp: chat.startTime,
      extra: merge(extra, carried(chat, STEP_EXTRA), STEP_EXTRA),
    },
    chat,
  );
}
function chatSteps(
  chats: OtelSpan[],
  byId: Map<string, OtelSpan>,
): [Draft[], OtelMessage[][]] {
  const drafts: Draft[] = [],
    left: OtelMessage[][] = [];
  let lastSystem: OtelPart[] | null = null;
  for (const [index, chat] of chats.entries()) {
    if (
      chat.systemInstructions?.length &&
      !isDeepStrictEqual(chat.systemInstructions, lastSystem)
    ) {
      const [texts, extra] = splitText(chat.systemInstructions);
      drafts.push(draft({ source: "system", message: joinText(texts), extra }));
      lastSystem = chat.systemInstructions;
    }
    const prev = chats[index - 1],
      newMessages = prev ? newInput(prev, chat) : (chat.inputMessages ?? []),
      h = history(newMessages, index > 0);
    drafts.push(...h.drafts);
    left.push(h.unpaired);
    const agent = agentStep(chat, byId);
    if (agent) {
      agent.results.push(...h.unplaced);
      drafts.push(agent);
    } else if (h.unplaced.length)
      console.warn("Chat span has no agent step to hold unmatched results");
  }
  return [drafts, left];
}
function additionalResults(span: OtelSpan | null): AtifObservationResult[] {
  let raw = span?.attributes["evaluatorq.atif.additional_results"];
  if (raw == null) return [];
  try {
    if (typeof raw === "string") raw = parsePythonJson(raw);
    if (!Array.isArray(raw)) throw new TypeError("Expected a list");
    return raw.map((item) => AtifObservationResultSchema.parse(item));
  } catch {
    console.warn("Unreadable additional ATIF results; ignoring them");
    return [];
  }
}
function agentStartedBefore(
  agents: Draft[],
  started: string | null,
): Draft | undefined {
  const before = agents.filter(
    (d) =>
      started !== null &&
      d.span?.startTime != null &&
      epoch(d.span.startTime) <= epoch(started),
  );
  return before.at(-1) ?? agents[0];
}
function attachResults(
  drafts: Draft[],
  members: OtelSpan[],
  chats: OtelSpan[],
  newInputs: OtelMessage[][],
): void {
  const toolSpans = orderSpans(
      members.filter((s) => s.operation === "execute_tool"),
      { fallbackEnd: true },
    ),
    byCall = new Map<string, OtelSpan[]>();
  for (const span of toolSpans) {
    const id = span.attributes["gen_ai.tool.call.id"];
    if (typeof id === "string") {
      const spans = byCall.get(id) ?? [];
      spans.push(span);
      byCall.set(id, spans);
    }
  }
  const responses = newInputs.flatMap((messages, index) =>
      messages.flatMap((m) =>
        m.parts
          .filter((p) => isPart(p, "tool_call_response"))
          .map((p) => [index, p] as const),
      ),
    ),
    position = new Map(chats.map((chat, i) => [chat.spanId, i]));
  const issueTimes = new Map<string, [number, string | null][]>();
  for (const d of drafts)
    if (d.span)
      for (const call of calls(d)) {
        const entries = issueTimes.get(call.toolCallId) ?? [];
        entries.push([position.get(d.span.spanId) ?? 0, d.span.startTime]);
        issueTimes.set(call.toolCallId, entries);
      }
  const nextIssues = new Map<string, ([number, string | null] | null)[]>();
  for (const [id, occurrences] of issueTimes) {
    const nextByPosition = new Map<number, [number, string | null]>();
    let next: [number, string | null] | null = null;
    for (const [issued, started] of [...occurrences].reverse()) {
      if (next && next[0] > issued) nextByPosition.set(issued, next);
      if (!next || issued < next[0]) next = [issued, started];
    }
    nextIssues.set(
      id,
      occurrences.map(([issued]) => nextByPosition.get(issued) ?? null),
    );
  }
  const usedSpans = new Set<string>(),
    usedParts = new Set<number>(),
    nextSpan = new Map<string, number>(),
    callOccurrence = new Map<string, number>();
  for (const d of drafts) {
    if (!d.span) continue;
    const issuedAt = position.get(d.span.spanId) ?? 0,
      cs = calls(d),
      pending: {
        order: number;
        sequence: number;
        result: AtifObservationResult;
        spanId: string | null;
      }[] = [];
    let sequence = 0;
    for (const [n, call] of cs.entries()) {
      const found = responses.findIndex(
          ([at, p], index) =>
            !usedParts.has(index) &&
            at > issuedAt &&
            partRow(p).id === call.toolCallId,
        ),
        entry = found >= 0 ? responses[found] : undefined,
        part = entry?.[1] ?? null,
        id = call.toolCallId,
        spanIndex = nextSpan.get(id) ?? 0,
        occurrence = callOccurrence.get(id) ?? 0;
      callOccurrence.set(id, occurrence + 1);
      let span = byCall.get(id)?.[spanIndex] ?? null;
      const later = nextIssues.get(id)?.[occurrence] ?? null,
        spanTime = span?.startTime || span?.endTime;
      if (
        span &&
        spanTime &&
        later &&
        later[1] !== null &&
        epoch(spanTime) > epoch(later[1]) &&
        entry &&
        entry[0] <= later[0]
      )
        span = null;
      if (span) {
        nextSpan.set(id, spanIndex + 1);
        d.toolSpanIds.add(span.spanId);
      }
      const callExtra = carried(span, TOOL_CALL_EXTRA);
      if (callExtra)
        cs[n] = AtifToolCallSchema.parse({
          ...call,
          extra: { ...call.extra, ...callExtra },
        });
      if (found >= 0) usedParts.add(found);
      const r = result(id, span, part);
      if (r) {
        const order = found >= 0 ? found : responses.length + n;
        pending.push({
          order,
          sequence: sequence++,
          result: r,
          spanId: span?.spanId ?? null,
        });
        for (const additional of additionalResults(span))
          pending.push({
            order,
            sequence: sequence++,
            result: additional,
            spanId: span?.spanId ?? null,
          });
      }
      if (span) usedSpans.add(span.spanId);
    }
    for (const item of pending.sort(
      (a, b) => a.order - b.order || a.sequence - b.sequence,
    )) {
      const index = d.results.length;
      d.results.push(item.result);
      if (item.spanId !== null) {
        const indices = d.resultGroups.get(item.spanId) ?? [];
        indices.push(index);
        d.resultGroups.set(item.spanId, indices);
        if (!d.resultIndices.has(item.spanId))
          d.resultIndices.set(item.spanId, index);
      }
    }
  }
  const orphanSpans = toolSpans.filter((s) => !usedSpans.has(s.spanId)),
    orphanParts = responses.filter((_, i) => !usedParts.has(i));
  if (!orphanSpans.length && !orphanParts.length) return;
  console.warn(
    "Keeping tool results with no matching call on nearest agent step",
  );
  const agents = drafts.filter((d) => d.span !== null);
  if (!agents.length) {
    console.warn("No agent step for unmatched tool results; dropping them");
    return;
  }
  for (const span of orphanSpans) {
    const id = span.attributes["gen_ai.tool.call.id"],
      r = result(typeof id === "string" ? id : null, span, null, true);
    if (r) agentStartedBefore(agents, span.startTime)?.results.push(r);
  }
  for (const [at, part] of orphanParts) {
    const before = agents.filter(
        (d) => d.span !== null && (position.get(d.span.spanId) ?? 0) < at,
      ),
      id = partRow(part).id,
      r = result(typeof id === "string" ? id : null, null, part, true);
    if (r) (before.at(-1) ?? agents[0])?.results.push(r);
  }
}
function reference(
  ref: AtifSubagentRef,
  span: OtelSpan,
  drafts: Draft[],
  byId: Map<string, OtelSpan>,
): void {
  const parent = span.parentSpanId ? byId.get(span.parentSpanId) : null,
    callId =
      parent?.operation === "execute_tool"
        ? parent.attributes["gen_ai.tool.call.id"]
        : null,
    owner = drafts.find(
      (d) => parent && (d.span === parent || d.toolSpanIds.has(parent.spanId)),
    ),
    candidates = owner ? [owner] : drafts;
  if (owner && parent) {
    const rawOffset = span.attributes[RESULT_OFFSET],
      offset = typeof rawOffset === "boolean" ? Number(rawOffset) : rawOffset,
      group = owner.resultGroups.get(parent.spanId) ?? [],
      index =
        typeof offset === "number" &&
        Number.isInteger(offset) &&
        offset >= 0 &&
        offset < group.length
          ? group[offset]
          : owner.resultIndices.get(parent.spanId),
      r = index !== undefined ? owner.results[index] : undefined;
    if (r && r.sourceCallId === callId && index !== undefined) {
      const sourceId = span.attributes[SOURCE_ID],
        refs = (r.subagentTrajectoryRef ?? []).filter(
          (existing) => sourceId == null || existing.trajectoryId !== sourceId,
        );
      owner.results[index] = AtifObservationResultSchema.parse({
        ...r,
        subagentTrajectoryRef: [...refs, ref],
      });
      return;
    }
  }
  const matching = candidates.flatMap((d) =>
    d.results.flatMap((r, i) =>
      callId != null && r.sourceCallId === callId ? [[d, i, r] as const] : [],
    ),
  );
  const match = matching[0];
  if (matching.length === 1 && match) {
    const [d, i, r] = match;
    d.results[i] = AtifObservationResultSchema.parse({
      ...r,
      subagentTrajectoryRef: [...(r.subagentTrajectoryRef ?? []), ref],
    });
    return;
  }
  const agents = drafts.filter((d) => d.span !== null),
    agent = agentStartedBefore(agents, span.startTime);
  if (!agent) {
    console.warn("Subagent has no agent step to reference it");
    return;
  }
  agent.results.push(
    AtifObservationResultSchema.parse({
      sourceCallId: null,
      subagentTrajectoryRef: [ref],
    }),
  );
}
function summedMetrics(steps: AtifStep[], agent: OtelSpan | null): unknown {
  const derived = finalMetrics(steps),
    saved = carried(agent, FINAL_METRICS);
  if (!saved) return derived;
  const merged = merge(
      derived ? atifWire(derived, true) : null,
      saved,
      FINAL_METRICS,
    ),
    parsed = AtifFinalMetricsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  console.warn("Invalid carried final metrics; using step totals");
  return derived;
}
function build(
  trace: OtelTrace,
  tops: OtelSpan[],
  session: string,
  trajectoryId: string | null,
  agent: AtifAgent,
): AtifTrajectory | null {
  const scope = collect(trace, tops),
    byId = new Map(trace.spans.map((s) => [s.spanId, s])),
    chats = orderSpans(
      scope.members.filter(
        (s) => s.operation === "chat" && mirrorChild(trace, s) === null,
      ),
    ),
    [drafts, newInputs] = chatSteps(chats, byId);
  attachResults(drafts, scope.members, chats, newInputs);
  const subagents: AtifTrajectory[] = [];
  for (const span of scope.subagents) {
    const childId = stableHex([session, trajectoryId || "", span.spanId], 32),
      child = build(
        trace,
        [span],
        session,
        childId,
        AtifAgentSchema.parse({
          name: attr(span, "gen_ai.agent.name") || span.name || "unknown",
          version: attr(span, "gen_ai.agent.version") || "unknown",
        }),
      );
    if (!child) {
      console.warn("Subagent has no chat spans; dropping it");
      continue;
    }
    subagents.push(child);
    reference(
      AtifSubagentRefSchema.parse({
        trajectoryId: childId,
        sessionId: session,
      }),
      span,
      drafts,
      byId,
    );
  }
  if (!drafts.length) return null;
  const first = tops[0],
    agentSpan =
      tops.length === 1 && first?.operation === "invoke_agent" ? first : null,
    steps = drafts.map((d, i) =>
      AtifStepSchema.parse({
        stepId: i + 1,
        observation: d.results.length ? { results: d.results } : null,
        ...d.fields,
      }),
    ),
    definitions = toolDefinitions(chats);
  return new AtifTrajectory({
    sessionId: session,
    trajectoryId,
    agent: definitions ? { ...agent, toolDefinitions: definitions } : agent,
    steps,
    finalMetrics: summedMetrics(steps, agentSpan),
    extra: carried(agentSpan, TRAJECTORY_EXTRA),
    subagentTrajectories: subagents.length ? subagents : null,
  });
}
export interface OtelConversionOptions {
  agentName?: string;
  agentVersion?: string;
}
export function otelToAtif(
  trace: OtelTrace,
  options: OtelConversionOptions = {},
): AtifTrajectory {
  const tops = rootScope(trace),
    first = tops[0],
    root =
      tops.length === 1 && first?.operation === "invoke_agent" ? first : null,
    name = options.agentName ?? "unknown",
    version = options.agentVersion ?? "unknown",
    agent = AtifAgentSchema.parse({
      name:
        name !== "unknown"
          ? name
          : attr(root, "gen_ai.agent.name") || "unknown",
      version:
        version !== "unknown"
          ? version
          : attr(root, "gen_ai.agent.version") || "unknown",
    }),
    traj = build(trace, tops, sessionId(trace, tops), null, agent);
  if (!traj)
    throw new TypeError(
      "OtelTrace has no chat spans; ATIF needs at least one step",
    );
  return traj;
}
