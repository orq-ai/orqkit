import { getField } from "../common/fields.js";
import {
  type AtifContentPart,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  AtifTrajectory,
  atifWire,
} from "./atif.js";
import { contentSeed, stableHex } from "./ids.js";
import { pythonJson } from "./json.js";
import {
  isoFromEpoch,
  type OtelMessage,
  OtelMessageSchema,
  type OtelPart,
  OtelSpan,
  OtelTrace,
  parsePart,
  parseTime,
} from "./otel.js";
import {
  atifContentText,
  jsonArgumentsText,
  RAW_ARGUMENTS_EXTRA_KEY,
} from "./shared.js";
import { parseIso } from "./time.js";

type Row = Record<string, unknown>;
const STEP_EXTRA = "evaluatorq.atif.step.extra",
  TRAJECTORY_EXTRA = "evaluatorq.atif.trajectory.extra",
  FINAL_METRICS = "evaluatorq.atif.final_metrics",
  TOOL_CALL_EXTRA = "evaluatorq.atif.tool_call.extra",
  RESULT_EXTRA = "evaluatorq.atif.result.extra";
const mappedExtra = new Set([
    "ancestry",
    "invocation",
    "finish_reasons",
    "error_type",
    "requested_model",
  ]),
  statuses = new Set(["ok", "error", "unset"]);
function seed(traj: AtifTrajectory): string {
  return stableHex(
    [
      traj.sessionId || contentSeed(traj.toModelDict()),
      traj.trajectoryId || "",
    ],
    64,
  );
}
function putJson(attrs: Row, key: string, value: Row | null): void {
  if (value && Object.keys(value).length)
    attrs[key] = pythonJson(value, { compact: true, defaultString: true });
}
const extraString = (step: AtifStep, key: string): string | null =>
  typeof step.extra?.[key] === "string" ? step.extra[key] : null;
const finishReasons = (step: AtifStep): string[] | null =>
  Array.isArray(step.extra?.finish_reasons)
    ? step.extra.finish_reasons.filter(
        (reason): reason is string => typeof reason === "string",
      )
    : null;
function atifTime(value: unknown): string | null {
  if (typeof value === "number") {
    try {
      return isoFromEpoch(value);
    } catch {
      console.warn("ATIF timestamp is out of range; leaving it unset");
      return null;
    }
  }
  return parseTime(value);
}
function times(
  step: AtifStep,
): [string | null, string | null, "ok" | "error" | "unset"] {
  const invocation = step.extra?.invocation;
  if (invocation == null) return [parseTime(step.timestamp), null, "unset"];
  const status = getField(invocation, "status");
  return [
    atifTime(getField(invocation, "start_timestamp")) ||
      parseTime(step.timestamp),
    atifTime(getField(invocation, "end_timestamp")),
    typeof status === "string" && statuses.has(status)
      ? (status as "ok" | "error" | "unset")
      : "unset",
  ];
}
function otelParts(content: string | AtifContentPart[]): OtelPart[] {
  if (typeof content === "string")
    return content ? [parsePart({ type: "text", content })] : [];
  return content.flatMap((part) =>
    part.type === "text"
      ? [parsePart({ type: "text", content: part.text || "" })]
      : part.source
        ? [
            parsePart({
              type: "uri",
              modality: part.type,
              uri: part.source.path,
              mimeType: part.source.mediaType,
            }),
          ]
        : [],
  );
}
function inputParts(content: string | AtifContentPart[]): OtelPart[] {
  const parts = otelParts(content);
  return parts.length ? parts : [parsePart({ type: "text", content: "" })];
}
function assistantParts(step: AtifStep): OtelPart[] {
  return [
    ...(step.reasoningContent
      ? [parsePart({ type: "reasoning", content: step.reasoningContent })]
      : []),
    ...otelParts(step.message),
    ...(step.toolCalls ?? []).map((call) =>
      parsePart({
        type: "tool_call",
        id: call.toolCallId,
        name: call.functionName,
        arguments: call.arguments,
      }),
    ),
  ];
}
function chatAttributes(
  step: AtifStep,
  errorType: string | null,
  tools: Row[] | null,
): Row {
  const attrs: Row = { "gen_ai.operation.name": "chat" };
  if (tools?.length) attrs["gen_ai.tool.definitions"] = tools;
  if (step.modelName) {
    attrs["gen_ai.request.model"] =
      extraString(step, "requested_model") || step.modelName;
    attrs["gen_ai.response.model"] = step.modelName;
  }
  if (step.metrics) {
    const m = step.metrics,
      reasoning = m.extra?.reasoning_tokens,
      usage = {
        "gen_ai.usage.input_tokens": m.promptTokens,
        "gen_ai.usage.output_tokens": m.completionTokens,
        "gen_ai.usage.cache_read.input_tokens": m.cachedTokens,
        "gen_ai.usage.reasoning.output_tokens":
          typeof reasoning === "number" || typeof reasoning === "boolean"
            ? reasoning
            : null,
        "gen_ai.usage.total_cost": m.costUsd,
      };
    Object.assign(
      attrs,
      Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== null)),
    );
  }
  const reasons = finishReasons(step);
  if (reasons !== null) attrs["gen_ai.response.finish_reasons"] = reasons;
  if (errorType !== null) attrs["error.type"] = errorType;
  putJson(
    attrs,
    STEP_EXTRA,
    Object.fromEntries(
      Object.entries(step.extra ?? {}).filter(([k]) => !mappedExtra.has(k)),
    ),
  );
  return attrs;
}
function toolSpan(
  call: AtifToolCall,
  result: AtifObservationResult | null,
  text: string | null,
  traceId: string,
  spanId: string,
  parentSpanId: string,
): OtelSpan {
  const attrs: Row = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": call.functionName,
    "gen_ai.tool.call.id": call.toolCallId,
    "gen_ai.tool.call.arguments":
      typeof call.extra?.[RAW_ARGUMENTS_EXTRA_KEY] === "string"
        ? call.extra[RAW_ARGUMENTS_EXTRA_KEY]
        : jsonArgumentsText(call.arguments),
  };
  putJson(attrs, TOOL_CALL_EXTRA, call.extra);
  let errorType: string | null = null;
  if (result) {
    putJson(attrs, RESULT_EXTRA, result.extra);
    if (text !== null) attrs["gen_ai.tool.call.result"] = text;
    if (typeof result.extra?.error_type === "string") {
      errorType = result.extra.error_type;
      attrs["error.type"] = errorType;
    }
  }
  const extra = result?.extra ?? {},
    status =
      typeof extra.status === "string" && statuses.has(extra.status)
        ? extra.status
        : errorType !== null
          ? "error"
          : "unset";
  return new OtelSpan({
    traceId,
    spanId,
    parentSpanId,
    name: `execute_tool ${call.functionName}`,
    operation: "execute_tool",
    startTime: atifTime(extra.start_timestamp),
    endTime: atifTime(extra.end_timestamp),
    status,
    errorType,
    attributes: attrs,
  });
}
const callKey = (stepId: number, callId: string, occurrence: number): string =>
  JSON.stringify([stepId, callId, occurrence]);
function emitStep(
  step: AtifStep,
  idSeed: string,
  traceId: string,
  parentSpanId: string,
  history: OtelMessage[],
  system: OtelPart[],
  callSpans: Map<string, string>,
  tools: Row[] | null,
): OtelSpan[] {
  const reasons = finishReasons(step),
    output = OtelMessageSchema.parse({
      role: "assistant",
      parts: assistantParts(step),
      finishReason: reasons?.[0] ?? null,
    });
  let [start, end, status] = times(step),
    errorType = extraString(step, "error_type");
  if (errorType === null && extraString(step, "status") === "failed")
    errorType = "_OTHER";
  if (errorType !== null && status === "unset") status = "error";
  const spans = [
    new OtelSpan({
      traceId,
      spanId: stableHex([idSeed, "chat", String(step.stepId)], 16),
      parentSpanId,
      name: step.modelName ? `chat ${step.modelName}` : "chat",
      operation: "chat",
      startTime: start,
      endTime: end,
      status,
      errorType,
      inputMessages: history.length ? [...history] : null,
      outputMessages: [output],
      systemInstructions: system.length ? [...system] : null,
      attributes: chatAttributes(step, errorType, tools),
    }),
  ];
  const results = new Map<string, AtifObservationResult[]>();
  for (const result of step.observation?.results ?? [])
    if (result.sourceCallId !== null) {
      const group = results.get(result.sourceCallId) ?? [];
      group.push(result);
      results.set(result.sourceCallId, group);
    }
  const calls = step.toolCalls ?? [],
    occurrences = new Map<string, number>(),
    assigned = new Map<number, AtifObservationResult[]>(),
    responseTexts = new Map<number, string | null>(),
    callOccurrences = new Map<string, number>();
  for (const [index, call] of calls.entries()) {
    const group = results.get(call.toolCallId) ?? [],
      occurrence = occurrences.get(call.toolCallId) ?? 0;
    occurrences.set(call.toolCallId, occurrence + 1);
    const result = group[occurrence];
    if (result) assigned.set(index, [result]);
  }
  for (const [callId, group] of results) {
    const matching = calls.flatMap((call, i) =>
        call.toolCallId === callId ? [i] : [],
      ),
      last = matching.at(-1);
    if (last !== undefined && group.length > matching.length)
      assigned.get(last)?.push(...group.slice(matching.length));
  }
  for (const [index, call] of calls.entries()) {
    const spanId = stableHex(
        [idSeed, "execute_tool", `${step.stepId}.${index}`],
        16,
      ),
      group = assigned.get(index) ?? [],
      primary = group[0] ?? null,
      text =
        primary?.content != null
          ? atifContentText(primary.content, "OTel")
          : null;
    responseTexts.set(index, text);
    const span = toolSpan(call, primary, text, traceId, spanId, parentSpanId);
    if (group.length > 1)
      span.attributes["evaluatorq.atif.additional_results"] = pythonJson(
        group.slice(1).map((result) => atifWire(result, true)),
        { compact: true },
      );
    spans.push(span);
    const occurrence = callOccurrences.get(call.toolCallId) ?? 0;
    callOccurrences.set(call.toolCallId, occurrence + 1);
    const key = callKey(step.stepId, call.toolCallId, occurrence);
    if (!callSpans.has(key)) callSpans.set(key, spanId);
  }
  history.push(output);
  const primaryCalls = new Map<AtifObservationResult, number>();
  for (const [index, group] of assigned) {
    const primary = group[0];
    if (primary) primaryCalls.set(primary, index);
  }
  const unmatched = new Set(
    [...results].flatMap(([callId, group]) =>
      occurrences.has(callId) ? [] : group,
    ),
  );
  if (unmatched.size)
    console.warn(
      "ATIF results match no tool call; preserving them as tool messages",
    );
  for (const result of step.observation?.results ?? []) {
    const index = primaryCalls.get(result);
    let callId: string, response: string | null;
    if (index !== undefined) {
      callId = calls[index]?.toolCallId ?? "";
      response = responseTexts.get(index) ?? null;
    } else if (unmatched.has(result)) {
      callId = result.sourceCallId || "";
      response =
        result.content !== null
          ? atifContentText(result.content, "OTel")
          : null;
    } else continue;
    history.push(
      OtelMessageSchema.parse({
        role: "tool",
        parts: [
          parsePart({ type: "tool_call_response", id: callId, response }),
        ],
      }),
    );
  }
  return spans;
}
function refCalls(
  traj: AtifTrajectory,
): Map<string, [number, string, number, number]> {
  const refs = new Map<string, [number, string, number, number]>();
  for (const step of traj.steps) {
    const counts = new Map<string, number>();
    for (const call of step.toolCalls ?? [])
      counts.set(call.toolCallId, (counts.get(call.toolCallId) ?? 0) + 1);
    const occurrences = new Map<string, number>();
    for (const result of step.observation?.results ?? []) {
      const callId = result.sourceCallId;
      if (callId === null) continue;
      const occurrence = occurrences.get(callId) ?? 0;
      occurrences.set(callId, occurrence + 1);
      const count = counts.get(callId) ?? 0;
      if (!count) continue;
      const callOccurrence = Math.min(occurrence, count - 1),
        offset = occurrence - callOccurrence;
      for (const ref of result.subagentTrajectoryRef ?? [])
        if (ref.trajectoryId !== null && !refs.has(ref.trajectoryId))
          refs.set(ref.trajectoryId, [
            step.stepId,
            callId,
            callOccurrence,
            offset,
          ]);
    }
  }
  return refs;
}
function warnDropped(traj: AtifTrajectory): void {
  const embedded = new Set(
    (traj.subagentTrajectories ?? []).map((s) => s.trajectoryId),
  );
  let noCall = 0,
    onNonAgent = 0,
    external = 0;
  for (const step of traj.steps) {
    const results = step.observation?.results ?? [];
    if (step.source !== "agent") {
      onNonAgent += results.length;
      continue;
    }
    for (const result of results) {
      const refs = result.subagentTrajectoryRef ?? [];
      if (result.sourceCallId === null && !refs.length) noCall++;
      external += refs.filter((ref) => !embedded.has(ref.trajectoryId)).length;
    }
  }
  if (noCall)
    console.warn(
      `Dropping ${noCall} observation results with no source_call_id`,
    );
  if (onNonAgent)
    console.warn(
      `Dropping ${onNonAgent} observation results on non-agent steps`,
    );
  if (external)
    console.warn(
      `Dropping ${external} references to subagents that are not embedded`,
    );
}
function emitAgent(
  traj: AtifTrajectory,
  parentSpanId: string | null,
  traceId: string,
): OtelSpan[] {
  const idSeed = seed(traj),
    agentSpanId = stableHex([idSeed, "invoke_agent", "0"], 16);
  warnDropped(traj);
  const spans: OtelSpan[] = [],
    callSpans = new Map<string, string>(),
    history: OtelMessage[] = [],
    system: OtelPart[] = [];
  let uncarried = false;
  for (const [index, step] of traj.steps.entries()) {
    if (step.source === "agent") {
      spans.push(
        ...emitStep(
          step,
          idSeed,
          traceId,
          agentSpanId,
          history,
          system,
          callSpans,
          traj.agent.toolDefinitions,
        ),
      );
      uncarried = false;
      continue;
    }
    const role =
      step.source === "user"
        ? "user"
        : step.extra?.original_role === "developer"
          ? "developer"
          : "system";
    if (index === 0 && role === "system")
      system.push(...inputParts(step.message));
    else
      history.push(
        OtelMessageSchema.parse({ role, parts: inputParts(step.message) }),
      );
    uncarried = true;
  }
  if (uncarried)
    spans.push(
      new OtelSpan({
        traceId,
        spanId: stableHex([idSeed, "chat", "input_only"], 16),
        parentSpanId: agentSpanId,
        name: "chat",
        operation: "chat",
        inputMessages: history.length ? [...history] : null,
        systemInstructions: system.length ? [...system] : null,
        attributes: { "gen_ai.operation.name": "chat" },
      }),
    );
  const attrs: Row = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": traj.agent.name,
    "gen_ai.agent.version": traj.agent.version,
  };
  if (traj.sessionId !== null) attrs["gen_ai.conversation.id"] = traj.sessionId;
  putJson(attrs, TRAJECTORY_EXTRA, traj.extra);
  if (traj.finalMetrics !== null)
    putJson(attrs, FINAL_METRICS, atifWire(traj.finalMetrics, true));
  const starts = spans
      .flatMap((span) => (span.startTime === null ? [] : [span.startTime]))
      .sort((a, b) => parseIso(a).epochSeconds - parseIso(b).epochSeconds),
    root = new OtelSpan({
      traceId,
      spanId: agentSpanId,
      parentSpanId,
      name: `invoke_agent ${traj.agent.name}`,
      operation: "invoke_agent",
      startTime: starts[0] ?? null,
      attributes: attrs,
    });
  const refs = refCalls(traj);
  for (const sub of traj.subagentTrajectories ?? []) {
    const ref = refs.get(sub.trajectoryId || ""),
      parent = ref
        ? (callSpans.get(callKey(ref[0], ref[1], ref[2])) ?? agentSpanId)
        : agentSpanId,
      children = emitAgent(new AtifTrajectory(sub), parent, traceId);
    if (ref) {
      const first = children[0];
      if (first) {
        first.attributes["evaluatorq.atif.subagent_result_offset"] = ref[3];
        first.attributes["evaluatorq.atif.subagent_source_trajectory_id"] =
          sub.trajectoryId;
      }
    }
    spans.push(...children);
  }
  return [root, ...spans];
}
export function atifToOtel(traj: AtifTrajectory): OtelTrace {
  return new OtelTrace({
    spans: emitAgent(traj, null, stableHex([seed(traj), "trace"], 32)),
  });
}
