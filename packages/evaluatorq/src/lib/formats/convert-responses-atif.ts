import { isDeepStrictEqual } from "node:util";

import type { Response } from "openai/resources/responses/responses";

import { type ContentPart, type Message, MessageSchema } from "../contracts.js";
import { messagesToResponsesInput } from "../integrations/openresponses/input-items.js";
import {
  AtifAgentSchema,
  type AtifContentPart,
  AtifContentPartSchema,
  type AtifMetrics,
  AtifMetricsSchema,
  type AtifStep,
  AtifStepSchema,
  AtifTrajectory,
} from "./atif.js";
import { contentSeed, stableHex } from "./ids.js";
import { parsePythonJson, pythonJson } from "./json.js";
import {
  isOutputItem,
  isRawToolCall,
  isSdkOutputItem,
  outputItem,
  ResponsesConversation,
  responseStarts,
  walkItems,
} from "./responses.js";
import {
  sdkErrorSchema,
  sdkIncompleteSchema,
  sdkResponseSchema,
} from "./sdk-models.js";
import {
  atifContentText,
  atifToolArguments,
  COMPACTION_EXTRA_KEY,
  compactionExtra,
  finalMetrics,
  joinText,
  jsonArgumentsText,
  mediaMarker,
  parseIso,
  partText,
  RAW_ARGUMENTS_EXTRA_KEY,
} from "./shared.js";

type Row = Record<string, unknown>;
const record = (v: unknown): v is Row =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const truth = (v: unknown): boolean =>
  v != null &&
  (Array.isArray(v)
    ? v.length > 0
    : record(v)
      ? Object.keys(v).length > 0
      : Boolean(v));
const pyString = (v: unknown): string =>
  v == null
    ? "None"
    : typeof v === "boolean"
      ? v
        ? "True"
        : "False"
      : String(v);
const OUTPUTS = "evaluatorq.responses_output_items",
  RESULTS = "evaluatorq.responses_result_items",
  ORDER = "evaluatorq.responses_result_order",
  TOOLS = "evaluatorq.responses_tools";
export const UNSET_USAGE_KEY = "atif_unset_usage",
  ERROR_TYPE_KEY = "atif_error_type",
  FINISH_REASONS_KEY = "atif_finish_reasons";
const textTypes = new Set(["input_text", "output_text", "text"]),
  statuses = new Set([
    "completed",
    "failed",
    "in_progress",
    "cancelled",
    "queued",
    "incomplete",
  ]);
interface Draft {
  source: "system" | "user" | "agent";
  texts: string[];
  reasoning: Row[];
  calls: Row[];
  results: Row[];
  unmappedOutputs: Row[];
  unmappedResults: Row[];
  resultOrder: { type: string; index: number }[];
  seenResult: boolean;
  item: Row | null;
  response: Response | null;
}
const draft = (
  source: Draft["source"],
  item: Row | null = null,
  response: Response | null = null,
): Draft => ({
  source,
  texts: [],
  reasoning: [],
  calls: [],
  results: [],
  unmappedOutputs: [],
  unmappedResults: [],
  resultOrder: [],
  seenResult: false,
  item,
  response,
});
const builtinResult = (item: unknown): item is Row =>
  record(item) &&
  typeof item.type === "string" &&
  item.type.endsWith("_call_output") &&
  !["function_call_output", "custom_tool_call_output"].includes(item.type);
function segment(items: Row[], starts: Map<number, Response>): Draft[] {
  const drafts: Draft[] = [];
  const currentAgent = (index: number): Draft => {
    let last = drafts.at(-1);
    if (
      !last ||
      last.source !== "agent" ||
      last.seenResult ||
      starts.has(index)
    ) {
      last = draft("agent", null, starts.get(index) ?? null);
      drafts.push(last);
    }
    return last;
  };
  const lastAgent = (): Draft => {
    let last = drafts.at(-1);
    if (last?.source !== "agent") {
      last = draft("agent");
      drafts.push(last);
    }
    return last;
  };
  const attach = (item: Row, type: "function" | "custom" | "builtin") => {
    if (type === "builtin") {
      const last = lastAgent();
      last.unmappedResults.push(item);
      last.resultOrder.push({
        type,
        index: last.unmappedResults.slice(0, -1).filter(builtinResult).length,
      });
      last.seenResult = true;
      return;
    }
    const callId = item.call_id;
    for (const d of [...drafts].reverse()) {
      if (d.source !== "agent") break;
      if (
        (type === "function" ? d.calls : d.unmappedOutputs).some(
          (c) => c.call_id === callId,
        )
      ) {
        if (type === "function") {
          d.results.push({
            sourceCallId: callId,
            content: toolOutputContent(item.output ?? null),
          });
          d.resultOrder.push({ type, index: d.results.length - 1 });
        } else {
          d.unmappedResults.push(item);
          d.resultOrder.push({
            type,
            index:
              d.unmappedResults.filter(
                (r) => r.type === "custom_tool_call_output",
              ).length - 1,
          });
        }
        d.seenResult = true;
        return;
      }
    }
    console.warn(
      `${type} tool result matches no call; preserving it on an agent step.`,
    );
    const last = lastAgent();
    if (type === "function") {
      last.results.push({
        sourceCallId: null,
        content: toolOutputContent(item.output ?? null),
        extra: { orphan_call_id: callId ?? null },
      });
      last.resultOrder.push({ type, index: last.results.length - 1 });
    } else {
      last.unmappedResults.push(item);
      last.resultOrder.push({
        type,
        index:
          last.unmappedResults.filter(
            (r) => r.type === "custom_tool_call_output",
          ).length - 1,
      });
    }
    last.seenResult = true;
  };
  const handlers = new Map<string, (index: number, item: Row) => void>([
    [
      "message",
      (index, item) => {
        const role = item.role;
        if (role === "user" || role === "system" || role === "developer")
          drafts.push(draft(role === "user" ? "user" : "system", item));
        else if (role === "assistant")
          currentAgent(index).texts.push(assistantText(item.content));
        else
          console.warn(
            `Skipping Responses message with role ${String(role)}: ATIF has no such step source.`,
          );
      },
    ],
    [
      "reasoning",
      (i, item) => {
        currentAgent(i).reasoning.push(item);
      },
    ],
    [
      "function_call",
      (i, item) => {
        if (typeof item.call_id === "string" && item.call_id)
          currentAgent(i).calls.push(item);
        else {
          console.warn(
            "Responses function_call has no valid call_id; preserving it as unmapped activity.",
          );
          currentAgent(i).unmappedOutputs.push(item);
        }
      },
    ],
    [
      "custom_tool_call",
      (i, item) => {
        if (typeof item.call_id === "string" && item.call_id)
          currentAgent(i).unmappedOutputs.push(item);
        else
          console.warn(
            "Responses custom_tool_call has no call_id; skipping it.",
          );
      },
    ],
    [
      "mcp_call",
      (i, item) => {
        currentAgent(i).unmappedOutputs.push(item);
      },
    ],
    ["function_call_output", (_, item) => attach(item, "function")],
    ["custom_tool_call_output", (_, item) => attach(item, "custom")],
    [
      "compaction",
      (_, item) => {
        drafts.push(draft("system", item));
      },
    ],
  ]);
  for (const item of items) {
    const kind = item.type;
    if (typeof kind !== "string" || handlers.has(kind)) continue;
    if (kind.endsWith("_call_output"))
      handlers.set(kind, (_, raw) => attach(raw, "builtin"));
    else if (isSdkOutputItem(item) || kind.endsWith("_call"))
      handlers.set(kind, (i, raw) => {
        currentAgent(i).unmappedOutputs.push(raw);
      });
  }
  walkItems(items, handlers, "ATIF");
  return drafts;
}
function assistantText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    console.warn("Assistant message content is not an array; dropping it.");
    return "";
  }
  return joinText(
    content.map((part) => {
      if (
        record(part) &&
        typeof part.type === "string" &&
        (textTypes.has(part.type) || part.type === "refusal")
      )
        return partText(part, "Assistant message");
      console.warn("Dropping non-text assistant content part.");
      return "";
    }),
  );
}
function imageMediaType(
  url: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = url.split("?", 1)[0]?.split(".").at(-1)?.toLowerCase(),
    guessed = url.startsWith("data:")
      ? url.slice(5).split(";", 1)[0]?.split(",", 1)[0]
      : (
          {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            jpe: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
          } as Record<string, string>
        )[ext ?? ""];
  if (
    guessed &&
    ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(guessed)
  )
    return guessed as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  console.warn("Cannot tell image media type; assuming image/png.");
  return "image/png";
}
function userPart(part: unknown): AtifContentPart {
  const kind = record(part)
    ? part.type
    : part === null
      ? "NoneType"
      : Array.isArray(part)
        ? "list"
        : typeof part === "string"
          ? "str"
          : typeof part === "number"
            ? Number.isInteger(part)
              ? "int"
              : "float"
            : typeof part === "boolean"
              ? "bool"
              : "dict";
  if (record(part) && typeof kind === "string" && textTypes.has(kind))
    return AtifContentPartSchema.parse({
      type: "text",
      text: partText(part, "Message"),
    });
  if (
    record(part) &&
    kind === "input_image" &&
    typeof part.image_url === "string"
  )
    return AtifContentPartSchema.parse({
      type: "image",
      source: {
        mediaType: imageMediaType(part.image_url),
        path: part.image_url,
      },
    });
  const name = record(part)
    ? part.filename || part.file_id || part.file_url
    : null;
  console.warn(
    `Content part ${String(kind)} has no ATIF equivalent; rendering a file marker.`,
  );
  return AtifContentPartSchema.parse({
    type: "text",
    text: `[file: ${pyString(name || kind)}]`,
  });
}
function userContent(content: unknown): string | AtifContentPart[] {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    console.warn("Message content is not an array; dropping it.");
    return "";
  }
  const parts = content.map(userPart);
  return parts.every((p) => p.type === "text")
    ? joinText(parts.map((p) => p.text || ""))
    : parts;
}
function toolOutputContent(output: unknown): string | AtifContentPart[] | null {
  if (output === null || typeof output === "string") return output;
  if (!Array.isArray(output))
    return pythonJson(output, { defaultString: true });
  return userContent(output);
}
function utcIso(epoch: number): string {
  const seconds = Math.floor(epoch),
    microsecond = Math.round((epoch - seconds) * 1e6),
    adjusted = seconds + Math.floor(microsecond / 1e6),
    micros = microsecond % 1e6;
  const date = new Date(adjusted * 1000),
    year = date.getUTCFullYear();
  if (year < 1 || year > 9999)
    throw new RangeError(
      "Response timestamp is outside the supported year range",
    );
  return (
    date.toISOString().slice(0, 19) +
    (micros ? `.${String(micros).padStart(6, "0")}` : "") +
    "+00:00"
  );
}
function readOutcome(
  errorCode: string | null,
  incompleteReason: string | null,
  metadata: Record<string, string> | null,
): [string | null, string[] | null] {
  let errorType = errorCode,
    finishReasons =
      incompleteReason === "max_output_tokens"
        ? ["length"]
        : incompleteReason === "content_filter"
          ? ["content_filter"]
          : null;
  if (metadata && Object.hasOwn(metadata, ERROR_TYPE_KEY))
    errorType = metadata[ERROR_TYPE_KEY] || null;
  if (metadata && Object.hasOwn(metadata, FINISH_REASONS_KEY)) {
    let stored: unknown = null;
    try {
      stored = parsePythonJson(metadata[FINISH_REASONS_KEY] ?? "");
    } catch {}
    if (
      stored === null ||
      (Array.isArray(stored) && stored.every((f) => typeof f === "string"))
    )
      finishReasons = stored;
    else
      console.warn(
        "Response finish reasons metadata is not a list of strings; ignoring it.",
      );
  }
  return [errorType, finishReasons];
}
function outcomeFields(
  errorType: string | null,
  finishReasons: string[] | null,
  failed: boolean,
): { status: string; error: Row | null; incomplete_details: Row | null } {
  if (failed) {
    const code =
      errorType !== null &&
      sdkErrorSchema.safeParse({ code: errorType, message: "" }).success
        ? errorType
        : "server_error";
    return {
      status: "failed",
      error: { code, message: errorType || "error" },
      incomplete_details: null,
    };
  }
  const finish = finishReasons?.find(
    (f) => f === "length" || f === "content_filter",
  );
  return finish
    ? {
        status: "incomplete",
        error: null,
        incomplete_details: {
          reason: finish === "length" ? "max_output_tokens" : "content_filter",
        },
      }
    : { status: "completed", error: null, incomplete_details: null };
}
function metricsFromUsage(response: Response): AtifMetrics | null {
  const usage = response.usage;
  if (!usage) return null;
  const unset = new Set(
      (response.metadata?.[UNSET_USAGE_KEY] || "").split(",").filter(Boolean),
    ),
    count = (name: string, n: number) => (unset.has(name) ? null : n);
  const extra = Object.fromEntries(
    Object.entries({
      reasoning_tokens: count(
        "reasoning_tokens",
        usage.output_tokens_details.reasoning_tokens,
      ),
      total_tokens: count("total_tokens", usage.total_tokens),
    }).filter(([, v]) => v !== null),
  );
  const metrics = AtifMetricsSchema.parse({
    promptTokens: count("prompt_tokens", usage.input_tokens),
    completionTokens: count("completion_tokens", usage.output_tokens),
    cachedTokens: count(
      "cached_tokens",
      usage.input_tokens_details.cached_tokens,
    ),
    extra: Object.keys(extra).length ? extra : null,
  });
  return isDeepStrictEqual(metrics, AtifMetricsSchema.parse({}))
    ? null
    : metrics;
}
function agentStep(d: Draft, stepId: number): AtifStep {
  const extra: Row = {},
    reasoning: string[] = [];
  for (const item of d.reasoning) {
    const texts = ["summary", "content"].flatMap((key) => {
      const parts = item[key] || [];
      if (!Array.isArray(parts))
        throw new TypeError("Reasoning parts must be iterable");
      return parts
        .filter((p) => record(p) && truth(p.text))
        .map((p) => pyString(p.text));
    });
    if (!texts.length && truth(item.encrypted_content))
      extra.encrypted_reasoning = true;
    reasoning.push(...texts);
  }
  const calls = d.calls.map((call) => {
    const [args, raw] = atifToolArguments(call.arguments ?? null, call.name);
    return {
      toolCallId: call.call_id,
      functionName: pyString(call.name || ""),
      arguments: args,
      extra: raw !== null ? { [RAW_ARGUMENTS_EXTRA_KEY]: raw } : null,
    };
  });
  const fcIds = Object.fromEntries(
    d.calls
      .filter((c) => typeof c.id === "string")
      .map((c) => [String(c.call_id), c.id]),
  );
  if (Object.keys(fcIds).length) extra.fc_item_ids = fcIds;
  if (d.unmappedOutputs.length) extra[OUTPUTS] = d.unmappedOutputs;
  if (d.unmappedResults.length) extra[RESULTS] = d.unmappedResults;
  if (new Set(d.resultOrder.map((e) => e.type)).size > 1)
    extra[ORDER] = d.resultOrder;
  let fields: Row = {};
  const response = d.response;
  if (response) {
    const placeholder =
      response.model === "" && response.usage == null && !response.created_at;
    if (!placeholder) extra.response_id = response.id;
    const [errorType, finishReasons] = readOutcome(
      response.error?.code ?? null,
      response.incomplete_details?.reason ?? null,
      response.metadata,
    );
    if (errorType !== null) extra.error_type = errorType;
    if (finishReasons !== null) extra.finish_reasons = finishReasons;
    const derived = outcomeFields(errorType, finishReasons, errorType !== null);
    if (response.status != null && response.status !== derived.status)
      extra.status = response.status;
    if (
      response.error != null &&
      !isDeepStrictEqual(response.error, derived.error)
    )
      extra.error = response.error;
    if (
      response.incomplete_details != null &&
      !isDeepStrictEqual(
        response.incomplete_details,
        derived.incomplete_details,
      )
    )
      extra.incomplete_details = response.incomplete_details;
    const tools = response.tools.map((tool) => omitNone(tool));
    if (tools.length || !placeholder) extra[TOOLS] = tools;
    if (!placeholder)
      fields = {
        modelName: response.model || null,
        timestamp: response.created_at ? utcIso(response.created_at) : null,
        metrics: metricsFromUsage(response),
        llmCallCount: 1,
      };
  }
  return AtifStepSchema.parse({
    stepId,
    source: "agent",
    message: joinText(d.texts),
    reasoningContent: reasoning.join("\n") || null,
    toolCalls: calls.length ? calls : null,
    observation: d.results.length ? { results: d.results } : null,
    extra: Object.keys(extra).length ? extra : null,
    ...fields,
  });
}
function omitNone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNone);
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, omitNone(v)]),
    );
  return value;
}
export interface AtifConversionOptions {
  agentName?: string;
  agentVersion?: string;
  sessionId?: string | null;
}
export function responsesToAtif(
  conv: ResponsesConversation,
  options: AtifConversionOptions = {},
): AtifTrajectory {
  const drafts = segment(
    conv.items,
    responseStarts(conv.items, conv.responses ?? []),
  );
  if (!drafts.length)
    throw new TypeError(
      "ResponsesConversation has no items; ATIF needs at least one step",
    );
  const steps = drafts.map((d, i) => {
    if (d.source === "agent") return agentStep(d, i + 1);
    const item = d.item ?? {};
    return AtifStepSchema.parse(
      item.type === "compaction"
        ? {
            stepId: i + 1,
            source: "system",
            message: "",
            extra: compactionExtra([item]),
          }
        : {
            stepId: i + 1,
            source: d.source,
            message: userContent(item.content),
            extra:
              item.role === "developer" ? { original_role: "developer" } : null,
          },
    );
  });
  return new AtifTrajectory({
    sessionId: options.sessionId || stableHex([contentSeed(conv.items)], 16),
    agent: AtifAgentSchema.parse({
      name: options.agentName ?? "unknown",
      version: options.agentVersion ?? "unknown",
    }),
    steps,
    finalMetrics: finalMetrics(steps),
  });
}
function atifParts(parts: AtifContentPart[]): ContentPart[] {
  return parts.map((part) => {
    if (part.type === "text")
      return { type: "input_text", text: part.text || "" };
    const path = part.source?.path ?? "";
    return part.type === "image" && /^(?:http:\/\/|https:\/\/|data:)/.test(path)
      ? { type: "input_image", image_url: path, detail: "auto" }
      : { type: "input_text", text: mediaMarker(part, "Responses input") };
  });
}
function orderResultItems(
  items: Row[],
  custom: Row[],
  builtin: Row[],
  order: unknown,
): void {
  const ordinary = items.filter((i) => i.type === "function_call_output");
  if (!Array.isArray(order)) {
    items.push(...custom, ...builtin);
    return;
  }
  const expected = new Set([
    ...[...ordinary.keys()].map((i) => `function:${i}`),
    ...[...custom.keys()].map((i) => `custom:${i}`),
    ...[...builtin.keys()].map((i) => `builtin:${i}`),
  ]);
  let observed: string[] = [];
  for (const entry of order) {
    if (
      !record(entry) ||
      !["function", "custom", "builtin"].includes(String(entry.type)) ||
      typeof entry.index !== "number" ||
      !Number.isInteger(entry.index)
    ) {
      observed = [];
      break;
    }
    observed.push(`${entry.type}:${entry.index}`);
  }
  if (
    observed.length !== expected.size ||
    new Set(observed).size !== expected.size ||
    observed.some((key) => !expected.has(key))
  ) {
    console.warn(
      "Malformed Responses result order metadata; restoring function, custom and built-in results.",
    );
    const kept = items.filter((i) => i.type !== "function_call_output"),
      insertion = kept.findIndex((i) => i.type === "custom_tool_call_output");
    kept.splice(
      insertion < 0 ? kept.length : insertion,
      0,
      ...ordinary,
      ...custom,
      ...builtin,
    );
    items.splice(0, items.length, ...kept);
    return;
  }
  const groups: Record<string, Row[]> = { function: ordinary, custom, builtin },
    combined = (order as { type: string; index: number }[]).flatMap((e) => {
      const item = groups[e.type]?.[e.index];
      return item ? [item] : [];
    });
  items.splice(
    0,
    items.length,
    ...items.filter((i) => i.type !== "function_call_output"),
    ...(combined.length === ordinary.length + custom.length + builtin.length
      ? combined
      : [...ordinary, ...custom, ...builtin]),
  );
}
function agentItems(step: AtifStep, seed: string): Row[] {
  const items: Row[] = [],
    extra = step.extra ?? {};
  if (step.reasoningContent)
    items.push({
      type: "reasoning",
      id: `rs_${stableHex([seed, String(step.stepId)], 24)}`,
      summary: [{ type: "summary_text", text: step.reasoningContent }],
    });
  let fcIds = extra.fc_item_ids || {};
  if (!record(fcIds)) {
    console.warn("Invalid fc_item_ids metadata; ignoring it.");
    fcIds = {};
  }
  const ids = fcIds as Row,
    calls = (step.toolCalls ?? []).map((call) => ({
      id: call.toolCallId,
      function: {
        name: call.functionName,
        arguments:
          typeof call.extra?.[RAW_ARGUMENTS_EXTRA_KEY] === "string"
            ? call.extra[RAW_ARGUMENTS_EXTRA_KEY]
            : jsonArgumentsText(call.arguments),
      },
      item_id:
        typeof ids[call.toolCallId] === "string" ? ids[call.toolCallId] : null,
    }));
  const names = new Map(
      (step.toolCalls ?? []).map((c) => [c.toolCallId, c.functionName]),
    ),
    content =
      typeof step.message === "string" ? step.message : atifParts(step.message);
  const hasOther = truth(step.reasoningContent) || truth(extra[OUTPUTS]),
    hasResults =
      truth(extra[RESULTS]) || Boolean(step.observation?.results.length);
  const messages: Message[] =
    truth(content) || calls.length || !(hasOther || hasResults)
      ? [
          MessageSchema.parse({
            role: "assistant",
            content: truth(content) ? content : null,
            tool_calls: calls.length ? calls : null,
          }),
        ]
      : [];
  for (const result of step.observation?.results ?? []) {
    for (const _ref of result.subagentTrajectoryRef ?? [])
      console.warn("Subagent references are not representable in Responses.");
    if (result.sourceCallId === null) {
      console.warn(
        `Dropping observation result in step ${step.stepId} with no source_call_id.`,
      );
      continue;
    }
    const rc = Array.isArray(result.content)
      ? result.content.every((p) => p.type === "text")
        ? atifContentText(result.content, "Responses")
        : atifParts(result.content)
      : result.content;
    messages.push(
      MessageSchema.parse({
        role: "tool",
        tool_call_id: result.sourceCallId,
        name: names.get(result.sourceCallId) ?? null,
        content: truth(rc) ? rc : "",
      }),
    );
  }
  items.push(...messagesToResponsesInput(messages, { wire: false }));
  const unmapped = extra[OUTPUTS];
  if (Array.isArray(unmapped)) {
    const outputs = unmapped.filter(
      (item): item is Row =>
        record(item) &&
        !builtinResult(item) &&
        (isOutputItem(item) || isRawToolCall(item) || isSdkOutputItem(item)),
    );
    if (
      outputs.length + unmapped.filter(builtinResult).length !==
      unmapped.length
    )
      console.warn("Malformed Responses output items; dropping them.");
    const insertion = items.findIndex((i) => i.type === "function_call_output");
    items.splice(insertion < 0 ? items.length : insertion, 0, ...outputs);
  }
  const builtin: Row[] = Array.isArray(unmapped)
    ? unmapped.filter(builtinResult)
    : [];
  let custom: Row[] = [];
  const rawResults = extra[RESULTS];
  if (Array.isArray(rawResults)) {
    const results = rawResults.filter(
      (item): item is Row =>
        record(item) &&
        (item.type === "custom_tool_call_output" || builtinResult(item)),
    );
    if (results.length !== rawResults.length)
      console.warn("Malformed Responses unmapped results; dropping them.");
    builtin.push(...results.filter(builtinResult));
    custom = results.filter((i) => !builtinResult(i));
  }
  orderResultItems(items, custom, builtin, extra[ORDER]);
  return items;
}
function responseForStep(
  step: AtifStep,
  seed: string,
  output: unknown[],
): Response {
  const extra = step.extra ?? {};
  let usage: Row | null = null,
    metadata: Record<string, string> | null = null;
  if (step.metrics) {
    const m = step.metrics,
      extraInt = (key: string): number | null => {
        const value = m.extra?.[key] ?? null;
        if (
          value === null ||
          (typeof value === "number" && Number.isInteger(value))
        )
          return value;
        console.warn(`Ignoring non-integer ${key} metric.`);
        return null;
      };
    const counts = {
        prompt_tokens: m.promptTokens,
        completion_tokens: m.completionTokens,
        cached_tokens: m.cachedTokens,
        reasoning_tokens: extraInt("reasoning_tokens"),
        total_tokens: extraInt("total_tokens"),
      },
      prompt = counts.prompt_tokens || 0,
      completion = counts.completion_tokens || 0;
    usage = {
      input_tokens: prompt,
      output_tokens: completion,
      total_tokens: counts.total_tokens ?? prompt + completion,
      input_tokens_details: { cached_tokens: counts.cached_tokens || 0 },
      output_tokens_details: { reasoning_tokens: counts.reasoning_tokens || 0 },
    };
    const unset = Object.entries(counts)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    metadata = unset.length ? { [UNSET_USAGE_KEY]: unset.join(",") } : null;
  }
  const responseId =
      typeof extra.response_id === "string" ? extra.response_id : null,
    status =
      typeof extra.status === "string" && statuses.has(extra.status)
        ? extra.status
        : null;
  if (
    (extra.response_id != null && responseId === null) ||
    (extra.status != null && status === null)
  )
    console.warn("Ignoring invalid Responses status or id metadata.");
  const tools: unknown[] = [];
  if (Array.isArray(extra[TOOLS]))
    for (const tool of extra[TOOLS]) {
      const parsed = sdkResponseSchema.safeParse({
        id: "probe",
        created_at: 0,
        model: "",
        object: "response",
        output: [],
        parallel_tool_calls: false,
        tool_choice: "auto",
        tools: [tool],
      });
      if (parsed.success) tools.push((parsed.data as Response).tools[0]);
      else console.warn("Dropping invalid Responses tool definition.");
    }
  else if (extra[TOOLS] !== undefined)
    console.warn("Ignoring invalid Responses tool definitions.");
  const errorType =
      typeof extra.error_type === "string" ? extra.error_type : null,
    finishReasons =
      Array.isArray(extra.finish_reasons) &&
      extra.finish_reasons.every((f) => typeof f === "string")
        ? extra.finish_reasons
        : null;
  if (
    (extra.error_type != null && errorType === null) ||
    (extra.finish_reasons != null && finishReasons === null)
  )
    console.warn("Ignoring invalid outcome metadata.");
  const failed =
      errorType !== null ||
      Boolean(finishReasons?.includes("error")) ||
      (record(extra.invocation) && extra.invocation.status === "error"),
    derived = outcomeFields(errorType, finishReasons, failed);
  const em =
      record(extra.error) && sdkErrorSchema.safeParse(extra.error).success
        ? extra.error
        : null,
    im =
      record(extra.incomplete_details) &&
      sdkIncompleteSchema.safeParse(extra.incomplete_details).success
        ? extra.incomplete_details
        : null;
  if ((extra.error != null && !em) || (extra.incomplete_details != null && !im))
    console.warn("Ignoring invalid Responses error metadata.");
  const error = truth(em) ? em : derived.error,
    incomplete = truth(im) ? im : derived.incomplete_details;
  const [readError, readFinish] = readOutcome(
    typeof error?.code === "string" ? error.code : null,
    typeof incomplete?.reason === "string" ? incomplete.reason : null,
    null,
  );
  if (readError !== errorType)
    metadata = { ...metadata, [ERROR_TYPE_KEY]: errorType || "" };
  if (!isDeepStrictEqual(readFinish, finishReasons))
    metadata = { ...metadata, [FINISH_REASONS_KEY]: pythonJson(finishReasons) };
  return sdkResponseSchema.parse({
    id:
      responseId ||
      `resp_${stableHex([seed, "response", String(step.stepId)], 24)}`,
    created_at:
      step.timestamp === null ? 0 : parseIso(step.timestamp).epochSeconds,
    model: step.modelName || "",
    object: "response",
    output,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools,
    status: status || derived.status,
    error,
    incomplete_details: incomplete,
    usage,
    metadata,
  }) as Response;
}
export function atifToResponses(traj: AtifTrajectory): ResponsesConversation {
  const seed =
      traj.sessionId || traj.trajectoryId || contentSeed(traj.toModelDict()),
    items: Row[] = [],
    responses: Response[] = [];
  const dropped = new Map<string, number>();
  for (const _sub of traj.subagentTrajectories ?? [])
    console.warn("Embedded subagents are not representable in Responses.");
  for (const step of traj.steps) {
    if (step.source === "agent") {
      const stepItems = agentItems(step, seed);
      items.push(...stepItems);
      const output = stepItems.filter(isOutputItem).map(outputItem);
      if (output.length) responses.push(responseForStep(step, seed, output));
      for (const name of [
        "costUsd",
        "promptTokenIds",
        "completionTokenIds",
        "logprobs",
      ] as const)
        if (step.metrics?.[name] != null)
          dropped.set(name, (dropped.get(name) ?? 0) + 1);
    } else {
      const extra = step.extra ?? {},
        context = extra.context_management,
        compactions = extra[COMPACTION_EXTRA_KEY];
      if (record(context) && context.type === "compaction") {
        const restored = Array.isArray(compactions)
          ? compactions.filter(
              (item): item is Row => record(item) && item.type === "compaction",
            )
          : [];
        if (
          Array.isArray(compactions) &&
          restored.length === compactions.length &&
          restored.length
        ) {
          items.push(...restored);
          continue;
        }
        console.warn(
          "Compaction step has no Responses compaction item; rendering its message.",
        );
      }
      items.push(
        ...messagesToResponsesInput(
          [
            MessageSchema.parse({
              role:
                extra.original_role === "developer" ? "developer" : step.source,
              content:
                typeof step.message === "string"
                  ? step.message
                  : atifParts(step.message),
            }),
          ],
          { wire: false },
        ),
      );
    }
  }
  if (dropped.size)
    console.warn(
      "Responses usage has no slot for some step metrics; dropping them.",
    );
  for (const item of items)
    if (Object.hasOwn(item, "role") && !Object.hasOwn(item, "type"))
      item.type = "message";
  return new ResponsesConversation({
    items,
    responses: responses.length ? responses : null,
  });
}
