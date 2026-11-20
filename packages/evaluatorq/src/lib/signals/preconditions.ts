import { codepointCompare } from "../common/sanitize.js";
import { type Precondition, PreconditionSchema } from "./models.js";
import {
  type CallRecord,
  callToolSchemas,
  finishReasons,
  hasUnmappedToolActivity,
  inferProvider,
  isLlmStep,
  llmTimes,
  rawToolArguments,
  type SignalContext,
  stepModel,
  toolSchemas,
  toolTimes,
  type WalkedStep,
} from "./walk.js";
export const TRUNCATED_EXTRA_KEY = "content_truncated";
const pc = (input: unknown): Precondition => PreconditionSchema.parse(input);
const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === "object"
      ? Object.keys(value).length > 0
      : Boolean(value));
function listing(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  const shown = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8),
    more = counts.size - shown.length;
  return (
    shown.map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(", ") +
    (more > 0 ? `, +${more} more` : "")
  );
}
const where = (entry: WalkedStep): string =>
  `step ${entry.step.stepId}` +
  (entry.agentPath.join("/") ? ` of ${entry.agentPath.join("/")}` : "");
const at = (record: CallRecord): string =>
  `${record.call.functionName} @${where(record.step)}`;
function coverage(
  name: string,
  have: number,
  total: number,
  detail: string,
  required: boolean,
  missing = "",
): Precondition {
  if (total === 0)
    return pc({
      name,
      met: false,
      detail: `nothing to check: ${detail}`,
      required,
    });
  return pc({
    name,
    met: have === total ? true : have ? "partial" : false,
    detail:
      `${have} of ${total} ${detail}` +
      (missing ? `; missing: ${missing}` : ""),
    required,
  });
}
export function hasToolCalls(ctx: SignalContext): Precondition {
  return pc({
    name: "has tool calls",
    met: ctx.calls.length > 0,
    detail: `${ctx.calls.length} tool calls`,
  });
}
export function sourceToolCoverage(ctx: SignalContext): Precondition {
  const missing = hasUnmappedToolActivity(ctx.walked);
  return pc({
    name: "source tool activity represented",
    met: missing.length === 0,
    detail: missing.length
      ? `unrepresented: ${listing(missing)}`
      : "all source tool activity is represented",
    required: true,
  });
}
export function hasToolResults(ctx: SignalContext): Precondition {
  const n = ctx.calls.filter((r) => r.result !== null).length;
  return pc({
    name: "has tool results",
    met: n > 0,
    detail: `${n} tool results`,
  });
}
export function resultsMatched(ctx: SignalContext): Precondition {
  const calls = ctx.calls;
  if (!calls.length)
    return pc({
      name: "calls matched to results",
      met: true,
      detail: "no tool calls",
      required: false,
    });
  const orphans = calls.filter((r) => r.result === null);
  return coverage(
    "calls matched to results",
    calls.length - orphans.length,
    calls.length,
    "tool calls have a result",
    false,
    listing(orphans.map(at)),
  );
}
export function explicitErrorStatus(ctx: SignalContext): Precondition {
  const results = ctx.calls.filter((r) => r.result !== null),
    required = ctx.config.errorDetection === "status";
  if (!results.length)
    return pc({
      name: "explicit error status",
      met: true,
      detail: "no tool results",
      required: false,
    });
  const withStatus = results.filter((r) => r.isError !== null),
    p = coverage(
      "explicit error status",
      withStatus.length,
      results.length,
      "tool results carry an error status",
      required,
    );
  return p.met === false && !required
    ? pc({ ...p, detail: `${p.detail} (content sniffing only)` })
    : p;
}
export function argsParseable(ctx: SignalContext): Precondition {
  const calls = ctx.calls;
  if (!calls.length)
    return pc({
      name: "arguments parse as JSON",
      met: true,
      detail: "no tool calls",
      required: false,
    });
  const bad = calls.filter((r) => rawToolArguments(r.call) !== null);
  return coverage(
    "arguments parse as JSON",
    calls.length - bad.length,
    calls.length,
    "calls have JSON arguments",
    false,
    listing(bad.map(at)),
  );
}
export function resultContentAvailable(ctx: SignalContext): Precondition {
  const results = ctx.calls.filter((r) => r.result !== null);
  if (!results.length)
    return pc({
      name: "result content available",
      met: true,
      detail: "no tool results",
      required: false,
    });
  const truncated = results.filter((r) =>
    truth(r.result?.extra?.[TRUNCATED_EXTRA_KEY]),
  );
  return coverage(
    "result content available",
    results.length - truncated.length,
    results.length,
    "results have full content",
    false,
    listing(truncated.map((r) => `${at(r)} (truncated preview)`)),
  );
}
export function toolSchemasCoverage(ctx: SignalContext): Precondition[] {
  const root = toolSchemas(ctx.trajectory),
    own = ctx.calls.map((r) => toolSchemas(r.step.trajectory)),
    active = new Map(
      ctx.calls.map((r) => [r, callToolSchemas(r, ctx.trajectory)]),
    );
  if (
    !Object.keys(root).length &&
    !own.some((s) => Object.keys(s).length) &&
    ![...active.values()].some((s) => Object.keys(s).length)
  )
    return [
      pc({
        name: "tool schemas present",
        met: false,
        detail: "the trajectory carries no tool schemas",
      }),
    ];
  const known = new Set(
      [
        Object.keys(root),
        ...own.map(Object.keys),
        ...[...active.values()].map(Object.keys),
      ].flat(),
    ),
    present = pc({
      name: "tool schemas present",
      met: true,
      detail: `schemas for ${known.size} tools`,
    });
  if (!ctx.calls.length) return [present];
  const uncovered = ctx.calls.filter(
    (r) => !Object.hasOwn(active.get(r) ?? {}, r.call.functionName),
  );
  return [
    present,
    coverage(
      "schema active at call time",
      ctx.calls.length - uncovered.length,
      ctx.calls.length,
      "calls have a schema active at call time (the rest are excluded)",
      true,
      listing(uncovered.map((r) => r.call.functionName)),
    ),
  ];
}
export function modelPresent(ctx: SignalContext): Precondition {
  const llm = ctx.walked.filter(isLlmStep);
  return coverage(
    "model on LLM steps",
    llm.filter((w) => Boolean(stepModel(w))).length,
    llm.length,
    "agent steps carry a model",
    true,
  );
}
export function tokenUsageComplete(ctx: SignalContext): Precondition {
  const llm = ctx.walked.filter(isLlmStep),
    have = llm.filter(
      (w) =>
        w.step.metrics !== null &&
        w.step.metrics.promptTokens !== null &&
        w.step.metrics.completionTokens !== null,
    ).length;
  return pc({
    name: "token usage complete",
    met: llm.length > 0 && have === llm.length,
    detail: `${have} of ${llm.length} agent steps carry token usage`,
    required: true,
  });
}
export function providerDerivable(ctx: SignalContext): Precondition {
  const llm = ctx.walked.filter(isLlmStep),
    models = llm.map(stepModel),
    have = models.filter((m) => inferProvider(m) !== null).length,
    guessed = models.filter(
      (m) => inferProvider(m) !== null && !(m ?? "").includes("/"),
    ).length,
    p = coverage(
      "provider derivable",
      have,
      llm.length,
      "agent steps have a provider",
      true,
    );
  return guessed
    ? pc({
        ...p,
        detail: `${p.detail} (${guessed} inferred from the model name)`,
        met: p.met === true ? "partial" : p.met,
      })
    : p;
}
export function finishReasonPresent(ctx: SignalContext): Precondition {
  const llm = ctx.walked.filter(isLlmStep);
  return coverage(
    "finish_reason present",
    llm.filter((w) => finishReasons(w.step).length > 0).length,
    llm.length,
    "agent steps have a finish_reason",
    true,
  );
}
export function subagentLinkage(ctx: SignalContext): Precondition {
  const linked = (r: CallRecord) =>
      Boolean(r.result?.subagentTrajectoryRef?.length),
    spawns = ctx.calls.filter(
      (r) =>
        ctx.config.toolRole(r.call.functionName) === "subagent" || linked(r),
    ),
    unlinkedAgents = [
      ...new Set(
        ctx.walked.flatMap((w) =>
          w.unlinked && w.agentPath.length
            ? [w.agentPath.at(-1) as string]
            : [],
        ),
      ),
    ].sort(codepointCompare);
  if (!spawns.length)
    return pc({
      name: "subagent linkage",
      met: !unlinkedAgents.length,
      detail:
        "no subagent-spawning calls" +
        (unlinkedAgents.length
          ? `; subagents without a spawning call: ${listing(unlinkedAgents)}`
          : ""),
      required: false,
    });
  const unlinked = spawns.filter((r) => !linked(r)),
    p = coverage(
      "subagent linkage",
      spawns.length - unlinked.length,
      spawns.length,
      "subagent-spawning calls linked to a subagent trajectory",
      false,
      listing(unlinked.map(at)),
    );
  return unlinkedAgents.length
    ? pc({
        ...p,
        detail: `${p.detail}; subagents without a spawning call: ${listing(unlinkedAgents)}`,
        met: p.met === true ? "partial" : p.met,
      })
    : p;
}
export function hasSubagents(count: number): Precondition {
  return pc({
    name: "has subagent invocations",
    met: count > 0,
    detail: `${count} subagent invocations`,
  });
}
export function timestamps(ctx: SignalContext): Precondition {
  const llm = ctx.walked.filter(isLlmStep);
  if (!llm.length)
    return pc({
      name: "LLM timestamp coverage",
      met: true,
      detail: "no LLM steps",
      required: false,
    });
  const times = llm.map(llmTimes),
    exact = times.filter((t) => t.start !== null && t.end !== null).length,
    anyTime = times.filter((t) => t.start !== null || t.end !== null).length;
  if (exact === llm.length)
    return pc({
      name: "LLM timestamp coverage",
      met: true,
      detail: `${exact} of ${llm.length} agent steps have invocation timestamps`,
      required: false,
    });
  if (anyTime)
    return pc({
      name: "LLM timestamp coverage",
      met: "partial",
      detail: `${exact} exact, ${anyTime - exact} partial, ${llm.length - anyTime} without timestamps among ${llm.length} agent steps`,
      required: false,
    });
  return coverage(
    "LLM timestamp coverage",
    0,
    llm.length,
    "agent steps have a timestamp",
    false,
  );
}
export function toolTimestamps(ctx: SignalContext): Precondition {
  if (!ctx.calls.length)
    return pc({
      name: "tool timestamp coverage",
      met: true,
      detail: "no tool calls",
      required: false,
    });
  let exact = 0,
    partial = 0;
  for (const r of ctx.calls) {
    const [start, end] = r.result ? toolTimes(r.result) : [null, null];
    if (start !== null && end !== null && end >= start) exact++;
    else if (start !== null || end !== null) partial++;
  }
  return pc({
    name: "tool timestamp coverage",
    met:
      exact === ctx.calls.length ? true : exact || partial ? "partial" : false,
    detail: `${exact} exact, ${partial} partial, ${ctx.calls.length - exact - partial} without timing among ${ctx.calls.length} tool calls`,
    required: false,
  });
}
