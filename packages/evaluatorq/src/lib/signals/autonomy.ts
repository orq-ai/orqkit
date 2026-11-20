import { isDeepStrictEqual } from "node:util";

import { pyFixed, pyRound } from "../common/reports/number-format.js";
import { pythonStrip } from "../common/sanitize.js";
import { atifContentText, pythonFloatSum } from "../formats/shared.js";
import { parseIso } from "../formats/time.js";
import {
  type Evidence,
  EvidenceSchema,
  type Precondition,
  PreconditionSchema,
  type SignalResult,
  signalResult,
} from "./models.js";
import {
  subagentLinkage,
  timestamps,
  toolTimestamps,
} from "./preconditions.js";
import {
  type CallRecord,
  invocation,
  isLlmStep,
  llmTimes,
  type SignalContext,
  toolTimes,
  type WalkedStep,
} from "./walk.js";

const allAgents = (ctx: SignalContext): WalkedStep[] =>
  ctx.walked.filter((entry) => entry.step.source === "agent");
const agents = (ctx: SignalContext): WalkedStep[] =>
  allAgents(ctx).filter((entry) => entry.step.llmCallCount !== 0);
const users = (ctx: SignalContext): WalkedStep[] =>
  ctx.walked.filter(
    (entry) => entry.agentPath.length === 0 && entry.step.source === "user",
  );
const callsAt = (ctx: SignalContext, entry: WalkedStep): CallRecord[] =>
  ctx.calls.filter((record) => record.step === entry);
const stepsPerAgent = (entry: WalkedStep, ctx: SignalContext): number =>
  entry.step.source !== "agent"
    ? 0
    : Number(entry.step.llmCallCount !== 0) + callsAt(ctx, entry).length;
function segments(ctx: SignalContext): [WalkedStep, WalkedStep[]][] {
  const rootUsers = users(ctx),
    positions = new Map(ctx.walked.map((entry, i) => [entry, i]));
  return rootUsers.map((start, i) => [
    start,
    ctx.walked
      .slice(
        (positions.get(start) ?? 0) + 1,
        rootUsers[i + 1]
          ? positions.get(rootUsers[i + 1] as WalkedStep)
          : ctx.walked.length,
      )
      .filter((entry) => entry.step.source === "agent"),
  ]);
}
function evidence(
  entry: WalkedStep,
  options: {
    reason?: string;
    related?: WalkedStep[];
    callId?: string | null;
    relatedCallIds?: string[];
  } = {},
): Evidence {
  return EvidenceSchema.parse({
    stepId: entry.step.stepId,
    agentPath: entry.agentPath,
    callId: options.callId ?? null,
    related: (options.related ?? []).map((item) => [
      item.agentPath,
      item.step.stepId,
    ]),
    relatedCallIds: options.relatedCallIds ?? [],
    reason: options.reason ?? "",
  });
}
const hasUsers = (ctx: SignalContext): Precondition =>
  PreconditionSchema.parse({
    name: "has user messages",
    met: users(ctx).length > 0,
    detail: `${users(ctx).length} root user messages`,
  });
function roundInt(value: number): number {
  if (!Number.isFinite(value))
    throw new RangeError(
      "Non-finite timing value cannot be rounded to an integer",
    );
  return pyRound(value) || 0;
}
export function autonomousSegmentCount(ctx: SignalContext): SignalResult {
  const entries = users(ctx);
  return signalResult(
    "autonomous_segment_count",
    "C",
    entries.length,
    entries.map((entry) => evidence(entry)),
  );
}
export function maxAutonomousSteps(ctx: SignalContext): SignalResult {
  const counts = segments(ctx).map(([start, entries]) => ({
      start,
      entries,
      count: entries.reduce((n, entry) => n + stepsPerAgent(entry, ctx), 0),
    })),
    maximum = Math.max(0, ...counts.map((item) => item.count));
  return signalResult(
    "max_autonomous_steps",
    "C",
    maximum,
    counts
      .filter((item) => item.count === maximum && item.count > 0)
      .map(({ start, entries, count }) =>
        evidence(start, {
          reason: `${count} steps`,
          related: entries,
          relatedCallIds: entries.flatMap((entry) =>
            callsAt(ctx, entry).map((record) => record.call.toolCallId),
          ),
        }),
      ),
    [hasUsers(ctx)],
  );
}
export function avgAutonomousSteps(ctx: SignalContext): SignalResult {
  const runs = segments(ctx),
    value = runs.length
      ? Number(
          pyFixed(
            runs.reduce(
              (n, [, entries]) =>
                n +
                entries.reduce((m, entry) => m + stepsPerAgent(entry, ctx), 0),
              0,
            ) / runs.length,
            3,
          ),
        )
      : null;
  return signalResult("avg_autonomous_steps", "C", value, null, [
    hasUsers(ctx),
  ]);
}
export function maxLlmToolCycles(ctx: SignalContext): SignalResult {
  const byPath = new Map<string, WalkedStep[]>();
  for (const entry of agents(ctx)) {
    const key = JSON.stringify(entry.agentPath),
      list = byPath.get(key) ?? [];
    list.push(entry);
    byPath.set(key, list);
  }
  let best: WalkedStep[] = [];
  for (const entries of byPath.values()) {
    let run: WalkedStep[] = [];
    for (const entry of entries)
      if (callsAt(ctx, entry).length) {
        run.push(entry);
        if (run.length > best.length) best = [...run];
      } else run = [];
  }
  const first = best[0];
  return signalResult(
    "max_llm_tool_cycles",
    "C",
    best.length,
    first
      ? [
          evidence(first, {
            reason: `${best.length} cycles`,
            related: best.slice(1),
            relatedCallIds: best.flatMap((entry) =>
              callsAt(ctx, entry).map((record) => record.call.toolCallId),
            ),
          }),
        ]
      : [],
  );
}
const lastRootAgent = (ctx: SignalContext, before: number): WalkedStep | null =>
  ctx.walked
    .slice(0, before)
    .reverse()
    .find(
      (entry) => entry.agentPath.length === 0 && entry.step.source === "agent",
    ) ?? null;
const answer = (entry: WalkedStep | null): boolean =>
  entry !== null &&
  !entry.step.toolCalls?.length &&
  Boolean(pythonStrip(atifContentText(entry.step.message, "signals")));
export function terminalAnswerPresent(ctx: SignalContext): SignalResult {
  const last = lastRootAgent(ctx, ctx.walked.length);
  return signalResult(
    "terminal_answer_present",
    "C",
    answer(last),
    last ? [evidence(last)] : [],
    [
      PreconditionSchema.parse({
        name: "has agent turns",
        met: last !== null,
        detail: "root agent steps",
      }),
    ],
  );
}
export function humanInterruptionCount(ctx: SignalContext): SignalResult {
  const rows: Evidence[] = [];
  for (const user of users(ctx)) {
    const prior = lastRootAgent(ctx, ctx.walked.indexOf(user));
    if (prior && !answer(prior))
      rows.push(
        evidence(user, {
          related: [prior],
          relatedCallIds: callsAt(ctx, prior).map(
            (record) => record.call.toolCallId,
          ),
        }),
      );
  }
  return signalResult("human_interruption_count", "C", rows.length, rows, [
    hasUsers(ctx),
  ]);
}
export function subagentStepShare(ctx: SignalContext): SignalResult {
  const steps = allAgents(ctx),
    total = steps.reduce((n, entry) => n + stepsPerAgent(entry, ctx), 0),
    sub = steps.filter((entry) => entry.agentPath.length),
    numerator = sub.reduce((n, entry) => n + stepsPerAgent(entry, ctx), 0);
  return signalResult(
    "subagent_step_share",
    "C",
    total ? Number(pyFixed(numerator / total, 4)) : null,
    sub.map((entry) =>
      evidence(entry, {
        relatedCallIds: callsAt(ctx, entry).map(
          (record) => record.call.toolCallId,
        ),
      }),
    ),
    [
      PreconditionSchema.parse({
        name: "has steps",
        met: total > 0,
        detail: `${total} agent and tool steps`,
      }),
      subagentLinkage(ctx),
    ],
  );
}
export function subagentMessageShare(ctx: SignalContext): SignalResult {
  const total = ctx.walked.length,
    sub = ctx.walked.filter((entry) => entry.agentPath.length);
  return signalResult(
    "subagent_message_share",
    "C",
    total ? Number(pyFixed(sub.length / total, 4)) : null,
    sub.map((entry) => evidence(entry)),
    [
      PreconditionSchema.parse({
        name: "has messages",
        met: total > 0,
        detail: `${total} steps`,
      }),
    ],
  );
}
export function parallelToolBatchCount(ctx: SignalContext): SignalResult {
  const rows = allAgents(ctx)
    .filter((entry) => (entry.step.toolCalls?.length ?? 0) > 1)
    .map((entry) =>
      evidence(entry, {
        reason: `${entry.step.toolCalls?.length ?? 0} calls`,
        relatedCallIds: callsAt(ctx, entry).map(
          (record) => record.call.toolCallId,
        ),
      }),
    );
  return signalResult("parallel_tool_batch_count", "C", rows.length, rows);
}
export function maxParallelToolCalls(ctx: SignalContext): SignalResult {
  const maximum = Math.max(
      0,
      ...allAgents(ctx).map((entry) => entry.step.toolCalls?.length ?? 0),
    ),
    rows = allAgents(ctx)
      .filter(
        (entry) => maximum > 1 && entry.step.toolCalls?.length === maximum,
      )
      .map((entry) =>
        evidence(entry, {
          relatedCallIds: callsAt(ctx, entry).map(
            (record) => record.call.toolCallId,
          ),
        }),
      );
  return signalResult("max_parallel_tool_calls", "C", maximum, rows);
}
interface Interval {
  start: number;
  end: number;
  entry: WalkedStep;
  kind: "llm" | "tool";
  callId: string | null;
  approximate: boolean;
}
const stepEpoch = (entry: WalkedStep): number | null => {
  if (entry.step.timestamp === null) return null;
  try {
    return parseIso(entry.step.timestamp).epochSeconds;
  } catch {
    return null;
  }
};
function llmIntervals(ctx: SignalContext): {
  intervals: Interval[];
  exact: number[];
  iso: number[];
} {
  const intervals: Interval[] = [],
    exact: number[] = [],
    iso: number[] = [],
    prior = new Map<string, number>();
  for (const entry of ctx.walked) {
    const current = stepEpoch(entry),
      time = llmTimes(entry),
      info = invocation(entry.step),
      path = JSON.stringify(entry.agentPath);
    if (
      time.start !== null &&
      !time.approximate &&
      info.start_timestamp != null
    )
      exact.push(time.start);
    if (time.end !== null && !time.approximate && info.end_timestamp != null)
      exact.push(time.end);
    if (current !== null) iso.push(current);
    if (isLlmStep(entry)) {
      if (time.start !== null && time.end !== null && time.end >= time.start)
        intervals.push({
          start: time.start,
          end: time.end,
          entry,
          kind: "llm",
          callId: null,
          approximate: false,
        });
      else {
        const before = prior.get(path);
        if (
          info.start_timestamp == null &&
          info.end_timestamp == null &&
          current !== null &&
          before !== undefined &&
          current >= before
        )
          intervals.push({
            start: before,
            end: current,
            entry,
            kind: "llm",
            callId: null,
            approximate: true,
          });
      }
      if (current !== null) prior.set(path, current);
    }
  }
  return { intervals, exact, iso };
}
function toolIntervals(ctx: SignalContext): {
  intervals: Interval[];
  stamps: number[];
} {
  const intervals: Interval[] = [],
    stamps: number[] = [];
  for (const [i, entry] of ctx.walked.entries()) {
    const following = ctx.walked
        .slice(i + 1)
        .find((item) => isDeepStrictEqual(item.agentPath, entry.agentPath)),
      nextTime = following ? stepEpoch(following) : null;
    for (const record of callsAt(ctx, entry)) {
      if (record.result === null) continue;
      const [start, end] = toolTimes(record.result);
      if (start !== null) stamps.push(start);
      if (end !== null) stamps.push(end);
      if (start !== null && end !== null && end >= start)
        intervals.push({
          start,
          end,
          entry,
          kind: "tool",
          callId: record.call.toolCallId,
          approximate: false,
        });
      else if (start === null && end === null) {
        const callTime = stepEpoch(entry);
        if (callTime !== null && nextTime !== null && nextTime >= callTime)
          intervals.push({
            start: callTime,
            end: nextTime,
            entry,
            kind: "tool",
            callId: record.call.toolCallId,
            approximate: true,
          });
      }
    }
  }
  return { intervals, stamps };
}
function intervals(ctx: SignalContext): {
  llm: Interval[];
  tool: Interval[];
  exact: number[];
  iso: number[];
} {
  const llm = llmIntervals(ctx),
    tool = toolIntervals(ctx);
  return {
    llm: llm.intervals,
    tool: tool.intervals,
    exact: [...llm.exact, ...tool.stamps],
    iso: llm.iso,
  };
}
function union(intervals: Interval[]): [number, number][] {
  const merged: [number, number][] = [];
  for (const interval of [...intervals].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    const last = merged.at(-1);
    if (last && interval.start <= last[1])
      last[1] = Math.max(last[1], interval.end);
    else merged.push([interval.start, interval.end]);
  }
  return merged;
}
const length = (intervals: [number, number][]): number =>
  pythonFloatSum(intervals.map(([start, end]) => end - start));
function minus(
  intervals: [number, number][],
  cuts: [number, number][],
): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of intervals) {
    let cursor = start;
    for (const [cutStart, cutEnd] of cuts) {
      if (cutEnd <= cursor || cutStart >= end) continue;
      if (cutStart > cursor) out.push([cursor, cutStart]);
      cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}
function close(left: number, right: number): boolean {
  return (
    left === right ||
    (Number.isFinite(left) &&
      Number.isFinite(right) &&
      Math.abs(left - right) <=
        Math.max(1e-6, 1e-9 * Math.max(Math.abs(left), Math.abs(right))))
  );
}
interface Timing {
  wall: number;
  wallApproximate: boolean;
  active: number;
  llm: number;
  tool: number;
  llmIntervals: Interval[];
  toolIntervals: Interval[];
  llmIncomplete: boolean;
  toolIncomplete: boolean;
}
function timing(ctx: SignalContext): [Timing | null, Precondition[]] {
  const { llm, tool, exact, iso } = intervals(ctx),
    stamps = [...exact, ...iso],
    llmCoverage = timestamps(ctx),
    toolCoverage = toolTimestamps(ctx),
    pcs = [
      PreconditionSchema.parse({
        name: "usable timestamps",
        met: stamps.length > 0,
        detail: `${stamps.length} usable timestamps`,
      }),
      llmCoverage,
      toolCoverage,
    ];
  if (!stamps.length || (!llm.length && !tool.length)) {
    pcs.push(
      PreconditionSchema.parse({
        name: "activity intervals",
        met: false,
        detail: "no LLM or tool interval could be timed",
      }),
    );
    return [null, pcs];
  }
  const llmUnion = union(llm),
    earliest = Math.min(...stamps),
    latest = Math.max(...stamps);
  return [
    {
      wall: latest - earliest,
      wallApproximate:
        !exact.some((stamp) => close(earliest, stamp)) ||
        !exact.some((stamp) => close(latest, stamp)),
      active: length(union([...llm, ...tool])),
      llm: length(llmUnion),
      tool: length(minus(union(tool), llmUnion)),
      llmIntervals: llm,
      toolIntervals: tool,
      llmIncomplete: llmCoverage.met !== true,
      toolIncomplete: toolCoverage.met !== true,
    },
    pcs,
  ];
}
function timeSignal(
  name: string,
  ctx: SignalContext,
  key: "wall" | "active" | "llm" | "tool",
  kinds: ("llm" | "tool")[],
): SignalResult {
  const [values, pcs] = timing(ctx),
    read = (kind: "llm" | "tool"): Interval[] =>
      values?.[kind === "llm" ? "llmIntervals" : "toolIntervals"] ?? [],
    approximate =
      key === "wall"
        ? Boolean(
            values?.wallApproximate ||
              values?.llmIncomplete ||
              values?.toolIncomplete,
          )
        : kinds.some(
            (kind) =>
              read(kind).some((interval) => interval.approximate) ||
              values?.[kind === "llm" ? "llmIncomplete" : "toolIncomplete"],
          );
  if (!values) return signalResult(name, "C", null, null, pcs, { approximate });
  const rows = kinds.flatMap((kind) =>
    read(kind).map((interval) =>
      evidence(interval.entry, {
        reason: `${roundInt((interval.end - interval.start) * 1000)} ms`,
        callId: interval.callId,
      }),
    ),
  );
  return signalResult(name, "C", roundInt(values[key] * 1000), rows, pcs, {
    approximate,
  });
}
export const wallTimeMs = (ctx: SignalContext): SignalResult =>
  timeSignal("wall_time_ms", ctx, "wall", []);
export const activeTimeMs = (ctx: SignalContext): SignalResult =>
  timeSignal("active_time_ms", ctx, "active", ["llm", "tool"]);
export const llmTimeMs = (ctx: SignalContext): SignalResult =>
  timeSignal("llm_time_ms", ctx, "llm", ["llm"]);
export const toolTimeMs = (ctx: SignalContext): SignalResult =>
  timeSignal("tool_time_ms", ctx, "tool", ["tool"]);
export function maxAutonomousDurationMs(ctx: SignalContext): SignalResult {
  const candidates: {
      duration: number;
      start: WalkedStep;
      entries: WalkedStep[];
    }[] = [],
    pcs = [hasUsers(ctx), timestamps(ctx), toolTimestamps(ctx)];
  for (const [start, allEntries] of segments(ctx)) {
    const entries = allEntries.filter((entry) => entry.agentPath.length === 0),
      startTime = stepEpoch(start);
    if (startTime === null) continue;
    const endTimes = entries.flatMap((entry) => {
      const time = llmTimes(entry),
        endpoints = [
          stepEpoch(entry),
          time.start,
          time.end,
          ...callsAt(ctx, entry).flatMap((record) =>
            record.result !== null ? [...toolTimes(record.result)] : [],
          ),
        ];
      return endpoints.filter((value): value is number => value !== null);
    });
    candidates.push({
      duration:
        (endTimes.length ? Math.max(...endTimes) : startTime) - startTime,
      start,
      entries,
    });
  }
  if (!candidates.length) {
    pcs.push(
      PreconditionSchema.parse({
        name: "timed segments",
        met: false,
        detail: "no autonomous segment has usable timestamps",
      }),
    );
    return signalResult("max_autonomous_duration_ms", "C", null, null, pcs);
  }
  const candidate = candidates.reduce((best, current) =>
      current.duration > best.duration ? current : best,
    ),
    entries = new Set(candidate.entries),
    all = intervals(ctx),
    timed = [...all.llm, ...all.tool].filter((interval) =>
      entries.has(interval.entry),
    ),
    callsWithTimes = candidate.entries.flatMap((entry) =>
      callsAt(ctx, entry).flatMap((record) =>
        record.result !== null &&
        toolTimes(record.result).some((value) => value !== null)
          ? [record.call.toolCallId]
          : [],
      ),
    ),
    callIds = [
      ...new Set([
        ...callsWithTimes,
        ...timed.flatMap((interval) =>
          interval.callId !== null ? [interval.callId] : [],
        ),
      ]),
    ],
    duration = roundInt(candidate.duration * 1000);
  return signalResult(
    "max_autonomous_duration_ms",
    "C",
    duration,
    [
      evidence(candidate.start, {
        reason: `${duration} ms`,
        related: candidate.entries,
        relatedCallIds: callIds,
      }),
    ],
    pcs,
    { approximate: true },
  );
}
export const AUTONOMY_SIGNALS: ReadonlyMap<
  string,
  (ctx: SignalContext) => SignalResult
> = new Map([
  ["autonomous_segment_count", autonomousSegmentCount],
  ["max_autonomous_steps", maxAutonomousSteps],
  ["avg_autonomous_steps", avgAutonomousSteps],
  ["max_llm_tool_cycles", maxLlmToolCycles],
  ["terminal_answer_present", terminalAnswerPresent],
  ["human_interruption_count", humanInterruptionCount],
  ["subagent_step_share", subagentStepShare],
  ["subagent_message_share", subagentMessageShare],
  ["parallel_tool_batch_count", parallelToolBatchCount],
  ["max_parallel_tool_calls", maxParallelToolCalls],
  ["wall_time_ms", wallTimeMs],
  ["active_time_ms", activeTimeMs],
  ["llm_time_ms", llmTimeMs],
  ["tool_time_ms", toolTimeMs],
  ["max_autonomous_duration_ms", maxAutonomousDurationMs],
]);
