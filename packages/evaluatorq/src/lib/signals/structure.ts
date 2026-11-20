import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";

import { pyFixed } from "../common/reports/number-format.js";
import { pythonStrip } from "../common/sanitize.js";
import type { AtifTrajectoryFields } from "../formats/atif.js";
import {
  type Evidence,
  EvidenceSchema,
  PreconditionSchema,
  type SignalResult,
  signalResult,
} from "./models.js";
import * as pre from "./preconditions.js";
import { shellCommandFamily } from "./shell.js";
import {
  type CallRecord,
  finishReasons,
  inferProvider,
  isLlmStep,
  rawToolArguments,
  type SignalContext,
  stepModel,
  type WalkedStep,
} from "./walk.js";

const ev = (entry: WalkedStep, reason = ""): Evidence =>
  EvidenceSchema.parse({
    stepId: entry.step.stepId,
    agentPath: entry.agentPath,
    reason,
  });
const callEv = (record: CallRecord, reason = ""): Evidence =>
  EvidenceSchema.parse({
    stepId: record.step.step.stepId,
    agentPath: record.step.agentPath,
    callId: record.call.toolCallId,
    reason,
  });
const llm = (ctx: SignalContext): WalkedStep[] => ctx.walked.filter(isLlmStep);
const tokenInput = (entry: WalkedStep): number =>
  entry.step.metrics?.promptTokens != null
    ? Math.max(
        0,
        entry.step.metrics.promptTokens -
          (entry.step.metrics.cachedTokens || 0),
      )
    : 0;
const count = (
  name: string,
  value: unknown,
  evidence: Evidence[],
): SignalResult => signalResult(name, "A", value, evidence);
export function maxDepth(ctx: SignalContext): SignalResult {
  const levels: {
    depth: number;
    path: string[];
    trajectory: AtifTrajectoryFields;
  }[] = [];
  const visit = (
    trajectory: AtifTrajectoryFields,
    depth: number,
    path: string[],
  ) => {
    levels.push({ depth, path, trajectory });
    for (const child of trajectory.subagentTrajectories ?? [])
      visit(
        child,
        depth + 1,
        child.trajectoryId ? [...path, child.trajectoryId] : path,
      );
  };
  visit(ctx.trajectory, 0, []);
  const depth = Math.max(...levels.map((level) => level.depth)),
    evidence = levels
      .filter((level) => level.depth === depth)
      .flatMap((level) => {
        const first = ctx.walked.find((e) => e.trajectory === level.trajectory);
        return first
          ? [
              EvidenceSchema.parse({
                stepId: first.step.stepId,
                agentPath: level.path,
              }),
            ]
          : [];
      });
  return count("max_depth", depth, evidence);
}
export function llmCallCount(ctx: SignalContext): SignalResult {
  const entries = ctx.walked.filter((w) => w.step.source === "agent");
  return count(
    "llm_call_count",
    entries.reduce((n, w) => n + (w.step.llmCallCount ?? 1), 0),
    entries.map((w) => ev(w, `${w.step.llmCallCount ?? 1} LLM calls`)),
  );
}
export function userMessageCount(ctx: SignalContext): SignalResult {
  const entries = ctx.walked.filter((w) => w.step.source === "user");
  return count(
    "user_message_count",
    entries.length,
    entries.map((w) => ev(w)),
  );
}
export function assistantMessageCount(ctx: SignalContext): SignalResult {
  const entries = ctx.walked.filter((w) => w.step.source === "agent");
  return count(
    "assistant_message_count",
    entries.length,
    entries.map((w) => ev(w)),
  );
}
export function turnCount(ctx: SignalContext): SignalResult {
  const evidence: Evidence[] = [];
  for (const [i, entry] of ctx.walked.entries()) {
    if (entry.step.source !== "user") continue;
    const following = ctx.walked
      .slice(i + 1)
      .find(
        (w) =>
          isDeepStrictEqual(w.agentPath, entry.agentPath) &&
          ["user", "agent"].includes(w.step.source),
      );
    if (following?.step.source === "agent")
      evidence.push(
        EvidenceSchema.parse({
          stepId: entry.step.stepId,
          agentPath: entry.agentPath,
          related: [[following.agentPath, following.step.stepId]],
        }),
      );
  }
  return count("turn_count", evidence.length, evidence);
}
function tokenSignal(
  ctx: SignalContext,
  name: string,
  field: "input" | "output" | "total",
): SignalResult {
  const entries = llm(ctx),
    readValue = (entry: WalkedStep): number =>
      field === "input"
        ? tokenInput(entry)
        : field === "output"
          ? (entry.step.metrics?.completionTokens ?? 0)
          : tokenInput(entry) + (entry.step.metrics?.completionTokens ?? 0);
  return signalResult(
    name,
    "A",
    entries.reduce((n, w) => n + readValue(w), 0),
    entries
      .filter((w) => w.step.metrics !== null)
      .map((w) => ev(w, `${readValue(w)} ${field} tokens`)),
    [pre.tokenUsageComplete(ctx)],
  );
}
export const totalInputTokens = (ctx: SignalContext): SignalResult =>
  tokenSignal(ctx, "total_input_tokens", "input");
export const totalOutputTokens = (ctx: SignalContext): SignalResult =>
  tokenSignal(ctx, "total_output_tokens", "output");
export const totalTokens = (ctx: SignalContext): SignalResult =>
  tokenSignal(ctx, "total_tokens", "total");
export function cacheReadTokenShare(ctx: SignalContext): SignalResult {
  const entries = llm(ctx),
    prompt = entries.reduce(
      (n, w) => n + (w.step.metrics?.promptTokens ?? 0),
      0,
    ),
    cached = entries.reduce(
      (n, w) => n + (w.step.metrics?.cachedTokens || 0),
      0,
    ),
    within = entries
      .filter((w) => w.step.metrics?.promptTokens != null)
      .every(
        (w) =>
          (w.step.metrics?.cachedTokens || 0) <=
          (w.step.metrics?.promptTokens || 0),
      );
  return signalResult(
    "cache_read_token_share",
    "A",
    prompt ? cached / prompt : null,
    entries
      .filter((w) => w.step.metrics !== null)
      .map((w) =>
        ev(
          w,
          `${w.step.metrics?.cachedTokens || 0} cached of ${w.step.metrics?.promptTokens ?? "None"} prompt tokens`,
        ),
      ),
    [
      pre.tokenUsageComplete(ctx),
      PreconditionSchema.parse({
        name: "has input tokens",
        met: prompt > 0,
        detail: `${prompt} prompt tokens`,
      }),
      PreconditionSchema.parse({
        name: "cached tokens do not exceed prompt tokens",
        met: within,
        detail: within ? "" : "cached token usage exceeds prompt token usage",
      }),
    ],
  );
}
export function peakContextTokens(ctx: SignalContext): SignalResult {
  const entries = llm(ctx),
    values = entries
      .filter((w) => w.step.metrics !== null)
      .map((w) => w.step.metrics?.promptTokens || 0),
    peak = values.length ? Math.max(...values) : 0;
  return signalResult(
    "peak_context_tokens",
    "A",
    peak,
    entries
      .filter(
        (w) => w.step.metrics !== null && w.step.metrics.promptTokens === peak,
      )
      .map((w) => ev(w, `${peak} prompt tokens`)),
    [pre.tokenUsageComplete(ctx)],
  );
}
export const toolCallCount = (ctx: SignalContext): SignalResult =>
  count(
    "tool_call_count",
    ctx.calls.length,
    ctx.calls.map((c) => callEv(c)),
  );
export function uniqueToolsUsed(ctx: SignalContext): SignalResult {
  const first = new Map<string, CallRecord>();
  for (const record of ctx.calls)
    if (!first.has(record.call.functionName))
      first.set(record.call.functionName, record);
  return count(
    "unique_tools_used",
    first.size,
    [...first].map(([name, record]) => callEv(record, name)),
  );
}
const frequencies = (values: string[]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
};
export function toolCallValueCount(ctx: SignalContext): SignalResult {
  return count(
    "tool_call_value_count",
    frequencies(ctx.calls.map((c) => c.call.functionName)),
    ctx.calls.map((c) => callEv(c, c.call.functionName)),
  );
}
const argumentsOf = (record: CallRecord): Record<string, unknown> =>
  rawToolArguments(record.call) === null ? record.call.arguments : {};
function roleCounts(
  ctx: SignalContext,
  name: string,
  role: string,
  readValue: (record: CallRecord) => string,
): SignalResult {
  const pairs = ctx.calls
    .filter((c) => ctx.config.toolRole(c.call.functionName) === role)
    .map((c) => [c, readValue(c)] as const);
  return count(
    name,
    frequencies(pairs.map(([, v]) => v)),
    pairs.map(([c, v]) => callEv(c, v)),
  );
}
export function bashCommandValueCount(ctx: SignalContext): SignalResult {
  return roleCounts(ctx, "bash_command_value_count", "bash", (c) => {
    const args = argumentsOf(c);
    return (
      shellCommandFamily(
        Object.hasOwn(args, "command") ? args.command : args.cmd,
      ) || "unknown command"
    );
  });
}
function hostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let first = 0;
  while (first < value.length && value.charCodeAt(first) <= 32) first++;
  const text = value.slice(first).replace(/[\t\n\r]/g, ""),
    scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text);
  if (!scheme || !["http", "https"].includes((scheme[1] ?? "").toLowerCase()))
    return null;
  const rest = text.slice(scheme[0].length);
  if (!rest.startsWith("//")) return null;
  const netloc = rest.slice(2).split(/[/?#]/, 1)[0] ?? "";
  if (/[/?#@:]/.test(netloc.replace(/[@:#?]/g, "").normalize("NFKC")))
    return null;
  const hostport = netloc.split("@").at(-1) ?? "";
  let host: string;
  if (hostport.includes("[") || hostport.includes("]")) {
    const match = /^\[([^\]]+)\](?::.*)?$/.exec(hostport);
    if (!match) return null;
    host = match[1] ?? "";
    if (
      !/^v[0-9a-f]+\..+$/i.test(host) &&
      isIP(host.split("%", 1)[0] ?? "") !== 6
    )
      return null;
  } else host = hostport.split(":", 1)[0] ?? "";
  return host ? host.replace(/\.+$/, "").toLowerCase() : null;
}
export const webviewValueCount = (ctx: SignalContext): SignalResult =>
  roleCounts(
    ctx,
    "webview_value_count",
    "webview",
    (c) => hostname(argumentsOf(c).url) || "unknown domain",
  );
export const loadedSkillValueCount = (ctx: SignalContext): SignalResult =>
  roleCounts(ctx, "loaded_skill_value_count", "skill", (c) => {
    const args = argumentsOf(c),
      name = Object.hasOwn(args, "skill") ? args.skill : args.name;
    return typeof name === "string" && pythonStrip(name)
      ? pythonStrip(name)
      : "unknown skill";
  });
function subagents(ctx: SignalContext): [string[], AtifTrajectoryFields][] {
  const found: [string[], AtifTrajectoryFields][] = [],
    seen = new Set<AtifTrajectoryFields>();
  const visit = (trajectory: AtifTrajectoryFields, path: string[]) => {
    for (const child of trajectory.subagentTrajectories ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const childPath =
        child.trajectoryId !== null ? [...path, child.trajectoryId] : path;
      found.push([childPath, child]);
      visit(child, childPath);
    }
  };
  visit(ctx.trajectory, []);
  return found;
}
export function subagentInvocationCount(ctx: SignalContext): SignalResult {
  const children = subagents(ctx),
    first = new Map<AtifTrajectoryFields, WalkedStep>();
  for (const entry of ctx.walked)
    if (entry.agentPath.length && !first.has(entry.trajectory))
      first.set(entry.trajectory, entry);
  const byPath = new Map(
      children.map(([path, trajectory]) => [JSON.stringify(path), trajectory]),
    ),
    evidence: Evidence[] = [],
    linked = new Set<AtifTrajectoryFields>();
  for (const call of ctx.calls)
    for (const ref of call.result?.subagentTrajectoryRef ?? []) {
      if (ref.trajectoryId === null) continue;
      const trajectory = byPath.get(
        JSON.stringify([...call.step.agentPath, ref.trajectoryId]),
      );
      if (!trajectory) continue;
      linked.add(trajectory);
      const entry = first.get(trajectory);
      evidence.push(
        entry
          ? EvidenceSchema.parse({
              stepId: entry.step.stepId,
              agentPath: entry.agentPath,
              related: [[call.step.agentPath, call.step.step.stepId]],
              relatedCallIds: [call.call.toolCallId],
            })
          : callEv(call, "subagent has no visible steps"),
      );
    }
  for (const [, trajectory] of children) {
    if (linked.has(trajectory)) continue;
    const entry = first.get(trajectory);
    if (entry) evidence.push(ev(entry, "unlinked subagent"));
  }
  return signalResult(
    "subagent_invocation_count",
    "A",
    children.length,
    evidence,
    [pre.subagentLinkage(ctx)],
  );
}
export function totalSubagentMessages(ctx: SignalContext): SignalResult {
  const entries = ctx.walked.filter((w) => w.agentPath.length);
  return signalResult(
    "total_subagent_messages",
    "A",
    entries.length,
    entries.map((w) => ev(w)),
    [pre.subagentLinkage(ctx)],
  );
}
export function avgMessagesPerSubagentInvocation(
  ctx: SignalContext,
): SignalResult {
  const children = subagents(ctx),
    entries = ctx.walked.filter((w) => w.agentPath.length);
  return signalResult(
    "avg_messages_per_subagent_invocation",
    "A",
    children.length
      ? Number(pyFixed(entries.length / children.length, 3))
      : null,
    [],
    [pre.hasSubagents(children.length), pre.subagentLinkage(ctx)],
  );
}
export function modelCount(ctx: SignalContext): SignalResult {
  const first = new Map<string, WalkedStep>();
  for (const entry of llm(ctx)) {
    const model = stepModel(entry);
    if (model && !first.has(model)) first.set(model, entry);
  }
  return signalResult(
    "model_count",
    "A",
    first.size,
    [...first].map(([model, entry]) => ev(entry, model)),
    [pre.modelPresent(ctx)],
  );
}
export function providerCount(ctx: SignalContext): SignalResult {
  const first = new Map<string, WalkedStep>();
  for (const entry of llm(ctx)) {
    const provider = inferProvider(stepModel(entry));
    if (provider && !first.has(provider)) first.set(provider, entry);
  }
  return signalResult(
    "provider_count",
    "A",
    first.size,
    [...first].map(([provider, entry]) => ev(entry, provider)),
    [pre.providerDerivable(ctx)],
  );
}
export function finishReasonLengthCount(ctx: SignalContext): SignalResult {
  const entries = llm(ctx).filter((w) =>
    finishReasons(w.step).includes("length"),
  );
  return signalResult(
    "finish_reason_length_count",
    "A",
    entries.length,
    entries.map((w) => ev(w)),
    [pre.finishReasonPresent(ctx)],
  );
}
export const STRUCTURE_SIGNALS: ReadonlyMap<
  string,
  (ctx: SignalContext) => SignalResult
> = new Map([
  ["max_depth", maxDepth],
  ["llm_call_count", llmCallCount],
  ["user_message_count", userMessageCount],
  ["assistant_message_count", assistantMessageCount],
  ["turn_count", turnCount],
  ["total_input_tokens", totalInputTokens],
  ["total_output_tokens", totalOutputTokens],
  ["total_tokens", totalTokens],
  ["cache_read_token_share", cacheReadTokenShare],
  ["peak_context_tokens", peakContextTokens],
  ["tool_call_count", toolCallCount],
  ["unique_tools_used", uniqueToolsUsed],
  ["tool_call_value_count", toolCallValueCount],
  ["bash_command_value_count", bashCommandValueCount],
  ["webview_value_count", webviewValueCount],
  ["loaded_skill_value_count", loadedSkillValueCount],
  ["subagent_invocation_count", subagentInvocationCount],
  ["total_subagent_messages", totalSubagentMessages],
  ["avg_messages_per_subagent_invocation", avgMessagesPerSubagentInvocation],
  ["model_count", modelCount],
  ["provider_count", providerCount],
  ["finish_reason_length_count", finishReasonLengthCount],
]);
