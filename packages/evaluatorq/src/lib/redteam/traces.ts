import { z } from "zod/v4";

import {
  type CallTargetOptions,
  callTargetWithRetry,
  type TargetErrorPayload,
} from "../common/target-call.js";
import { type FetchTracesOptions, loadTraces } from "../common/trace-input.js";
import {
  AgentResponse,
  type AgentTarget,
  type Message,
  MessageSchema,
  type Usage,
  usageWithCalls,
} from "../contracts.js";
import type { Trace, TraceInput } from "../trace.js";
import type { DataPoint } from "../types.js";
import { RedTeamError } from "./exceptions.js";
import { Turn, turnsToMessages } from "./turn.js";
export const TraceStart = Object.freeze({
  FIRST_USER: "first_user",
  LAST_ASSISTANT: "last_assistant",
} as const);
export type TraceStart = (typeof TraceStart)[keyof typeof TraceStart];
export const TraceStartSchema = z.enum(TraceStart);
export const TRACE_SEED_MESSAGES_KEY = "traceSeedMessages";
export const TRACE_START_FROM_KEY = "traceStartFrom";
function messageDump(message: Message): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message).filter(([, value]) => value !== null),
  );
}
export function seedMessages(
  trace: Trace,
  startFrom: TraceStart,
): Record<string, unknown>[] | null {
  const messages = trace.messages,
    firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) {
    console.warn(
      `Trace '${trace.traceId}' has no user turn to seed a red-team attack; skipping`,
    );
    return null;
  }
  if (startFrom === TraceStart.FIRST_USER) {
    const message = messages[firstUser];
    return message ? [messageDump(message)] : null;
  }
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  if (lastAssistant < 0) {
    console.warn(
      `Trace '${trace.traceId}' has no assistant turn for last_assistant continuation; skipping`,
    );
    return null;
  }
  return messages.slice(0, lastAssistant + 1).map(messageDump);
}
export async function datapointsFromTraces(
  source: TraceInput | Iterable<Trace>,
  options: FetchTracesOptions & { startFrom?: TraceStart } = {},
): Promise<DataPoint[]> {
  const { startFrom = TraceStart.FIRST_USER, ...fetchOptions } = options;
  const { usable, failed } = await loadTraces(source, {
    ...fetchOptions,
    caller: "redteam.datapointsFromTraces",
  });
  if (!usable.length)
    throw new Error(
      failed.length
        ? `All ${failed.length} imported trace(s) failed to import; no trace seeds could be built.`
        : "No traces were supplied; no trace seeds could be built.",
    );
  const replayPoint = TraceStartSchema.parse(startFrom);
  const seeds = usable.flatMap((trace) => {
    const messages = seedMessages(trace, replayPoint);
    if (!messages) return [];
    const datapoint = trace.toDatapoint();
    datapoint.inputs[TRACE_SEED_MESSAGES_KEY] = messages;
    datapoint.inputs[TRACE_START_FROM_KEY] = replayPoint;
    return [datapoint];
  });
  if (!seeds.length)
    throw new Error(
      `None of the ${usable.length} imported trace(s) had a seedable turn for startFrom='${replayPoint}'.`,
    );
  return seeds;
}
export function parseTraceSeed(
  inputs: Record<string, unknown>,
  options: { label: string; required?: boolean },
): [Message[], TraceStart] | [null, null] {
  const hasMessages =
    Object.hasOwn(inputs, TRACE_SEED_MESSAGES_KEY) ||
    Object.hasOwn(inputs, "trace_seed_messages");
  if (!hasMessages) {
    if (options.required ?? true)
      throw new Error(
        `${options.label} is missing trace seed metadata: expected '${TRACE_SEED_MESSAGES_KEY}' and '${TRACE_START_FROM_KEY}'.`,
      );
    return [null, null];
  }
  const rawMessages = Object.hasOwn(inputs, TRACE_SEED_MESSAGES_KEY)
    ? inputs[TRACE_SEED_MESSAGES_KEY]
    : inputs.trace_seed_messages;
  if (!Array.isArray(rawMessages) || !rawMessages.length)
    throw new Error(
      `${options.label}.${TRACE_SEED_MESSAGES_KEY} must be a non-empty list of Message mappings.`,
    );
  const messages = rawMessages.map((message, index) => {
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    )
      throw new TypeError(
        `${options.label}.${TRACE_SEED_MESSAGES_KEY}[${index}] must be a Message mapping.`,
      );
    const parsed = MessageSchema.safeParse(message);
    if (!parsed.success)
      throw new Error(
        `${options.label}.${TRACE_SEED_MESSAGES_KEY}[${index}] is not parseable as a Message: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    return parsed.data;
  });
  if (
    !Object.hasOwn(inputs, TRACE_START_FROM_KEY) &&
    !Object.hasOwn(inputs, "trace_start_from")
  )
    throw new Error(
      `${options.label} has ${TRACE_SEED_MESSAGES_KEY} but no ${TRACE_START_FROM_KEY}; it is never defaulted because this would silently drop imported context.`,
    );
  const rawStart = Object.hasOwn(inputs, TRACE_START_FROM_KEY)
    ? inputs[TRACE_START_FROM_KEY]
    : inputs.trace_start_from;
  const parsedStart = TraceStartSchema.safeParse(rawStart);
  if (!parsedStart.success)
    throw new Error(
      `${options.label}.${TRACE_START_FROM_KEY} is not a valid TraceStart value.`,
    );
  const start = parsedStart.data;
  if (
    start === TraceStart.LAST_ASSISTANT &&
    messages.at(-1)?.role !== "assistant"
  )
    throw new Error(
      `${options.label}.${TRACE_SEED_MESSAGES_KEY} must end with an assistant message when ${TRACE_START_FROM_KEY} is '${TraceStart.LAST_ASSISTANT}'.`,
    );
  return [messages, start];
}
export async function replaySeedContext(
  target: AgentTarget,
  messages: Message[],
  start: TraceStart,
  options: CallTargetOptions,
): Promise<[Message[], Usage | null, TargetErrorPayload | null]> {
  if (start === TraceStart.LAST_ASSISTANT) {
    if (target.historyMode === "target")
      throw new RedTeamError(
        "last_assistant replay cannot import conversation history from a target-owned history adapter",
      );
    if (!messages.length)
      throw new RedTeamError("Trace replay requires at least one seed message");
    return [[...messages], null, null];
  }
  const opening = messages[0];
  if (!opening)
    throw new RedTeamError("Trace replay requires at least one seed message");
  if (opening.role !== "user")
    throw new RedTeamError("first_user replay requires a user opening message");
  const bootstrap = await callTargetWithRetry(target, [opening], options);
  let usage = bootstrap.response.usage;
  if (usage && usage.calls === 0) usage = usageWithCalls(usage, 1);
  if (!bootstrap.succeeded)
    return [
      [opening],
      usage,
      bootstrap.errorPayload({ context: " during trace bootstrap" }),
    ];
  const turn = new Turn({
    attacker: new AgentResponse(),
    target: bootstrap.response,
  });
  return [[opening, ...turnsToMessages([turn]).slice(1)], usage, null];
}
export function targetHistoryMode(
  target: AgentTarget,
  invalidMessage: string,
): "caller" | "target" {
  const mode = target.historyMode;
  if (mode !== "caller" && mode !== "target")
    throw new RedTeamError(invalidMessage);
  return mode;
}
export function ensureTargetCanBacktrack(target: AgentTarget): void {
  if (
    targetHistoryMode(
      target,
      "Backtracking requires caller-owned history on the target",
    ) !== "caller"
  )
    throw new RedTeamError(
      "Backtracking requires caller-owned history on the target",
    );
}
