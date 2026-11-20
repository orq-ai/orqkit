import { pyG } from "../common/reports/number-format.js";
import { PreconditionSchema, type SignalFn, signalResult } from "./models.js";

export interface TagClause {
  readonly metric: string;
  readonly op: ">" | "<";
  readonly quantile?: number;
  readonly fixed?: number;
}
export interface TagRule {
  readonly name: string;
  readonly doc: string;
  readonly gate: readonly TagClause[];
  readonly anyOf: readonly TagClause[];
  readonly need: number;
}
const clause = (
  metric: string,
  op: ">" | "<",
  quantile: number,
): TagClause => ({ metric, op, quantile });
const rule = (
  name: string,
  doc: string,
  gate: TagClause[] = [],
  anyOf: TagClause[] = [],
  need = 1,
): TagRule =>
  Object.freeze({
    name,
    doc,
    gate: Object.freeze(gate.map((item) => Object.freeze(item))),
    anyOf: Object.freeze(anyOf.map((item) => Object.freeze(item))),
    need,
  });
export const TAG_RULES: readonly TagRule[] = Object.freeze([
  rule(
    "long_autonomous_run",
    "Extended execution without user input.",
    [],
    [
      clause("max_autonomous_steps", ">", 0.8),
      clause("max_autonomous_duration_ms", ">", 0.8),
    ],
  ),
  rule(
    "delegation_heavy",
    "Disproportionate delegation to subagents for the cohort.",
    [clause("subagent_step_share", ">", 0.9)],
  ),
  rule("error_heavy", "Errors dominate tool execution.", [
    clause("tool_error_rate", ">", 0.9),
    { metric: "tool_error_count", op: ">", fixed: 2 },
  ]),
  rule(
    "tool_churn",
    "High tool activity with low argument diversity or frequent retries.",
    [clause("tool_call_count", ">", 0.75)],
    [
      clause("distinct_tool_arg_ratio", "<", 0.1),
      clause("tool_retry_count", ">", 0.9),
    ],
  ),
  rule(
    "tool_loop",
    "Exact repetition or oscillation, parameter drift, or a retry storm.",
    [],
    [
      clause("tool_loop_count", ">", 0.9),
      clause("consecutive_same_tool_max", ">", 0.95),
      clause("tool_retry_count", ">", 0.95),
    ],
  ),
  rule(
    "stalled",
    "The run ends without an answer after looping or repeated failure.",
    [{ metric: "terminal_answer_present", op: "<", fixed: 1 }],
    [clause("tool_loop_count", ">", 0.9), clause("tool_retry_count", ">", 0.9)],
  ),
  rule(
    "output_heavy",
    "Unusually large tool-result volume.",
    [],
    [
      clause("total_tool_result_bytes", ">", 0.95),
      clause("max_tool_result_bytes", ">", 0.95),
    ],
  ),
  rule(
    "inefficient_execution",
    "At least two structural inefficiency indicators fire together.",
    [],
    [
      clause("duplicate_tool_call_count", ">", 0.9),
      clause("tool_retry_count", ">", 0.9),
      clause("distinct_tool_arg_ratio", "<", 0.1),
      clause("empty_tool_result_count", ">", 0.9),
      clause("tool_loop_count", ">", 0.9),
      clause("tool_error_rate", ">", 0.9),
    ],
    2,
  ),
]);
export const TAG_DEPENDENCIES: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      TAG_RULES.map((rule) => [
        rule.name,
        Object.freeze([
          ...new Set(
            [...rule.gate, ...rule.anyOf].map((clause) => clause.metric),
          ),
        ]),
      ]),
    ),
  );
function tagSignal(rule: TagRule): SignalFn {
  return (ctx) => {
    const thresholds = ctx.config.resolvedTagThresholds();
    const rows = [...rule.gate, ...rule.anyOf].map((clause) => {
      const key = `${rule.name}.${clause.metric}`,
        percentile = ctx.config.tagPercentiles[key];
      const threshold =
        clause.fixed ??
        (percentile == null
          ? thresholds.thresholds[key]
          : thresholds.cohortThreshold(clause.metric, percentile));
      if (threshold == null) throw new Error(`Missing tag threshold: ${key}`);
      const metric = ctx.results[clause.metric],
        value = metric?.noBasis === null ? metric.value : null;
      if (
        value != null &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      )
        throw new TypeError(
          `Cannot compare ${typeof value} with a numeric threshold`,
        );
      const hit =
        value == null
          ? null
          : clause.op === ">"
            ? Number(value) > threshold
            : Number(value) < threshold;
      let suffix = "";
      if (clause.quantile != null)
        suffix = ` (cohort p${pyG(percentile ?? clause.quantile * 100)})`;
      const label = `${clause.metric} ${clause.op} ${Number.isInteger(threshold) ? String(threshold) : pyG(threshold)}${suffix}`;
      return { clause, threshold, value, hit, label };
    });
    const gates = rows.slice(0, rule.gate.length),
      options = rows.slice(rule.gate.length);
    const unknownGate = gates.some((row) => row.hit === null),
      hits = options.filter((row) => row.hit === true).length;
    const possible = hits + options.filter((row) => row.hit === null).length;
    const fired = gates.some((row) => row.hit === false)
      ? false
      : !options.length
        ? unknownGate
          ? null
          : true
        : possible < rule.need
          ? false
          : unknownGate
            ? null
            : hits >= rule.need
              ? true
              : null;
    const preconditions = [
      PreconditionSchema.parse({
        name: "required metrics",
        met: fired !== null,
        detail: `${rows.filter((row) => row.hit !== null).length} of ${rows.length} clause metrics available`,
      }),
      ...rows.map((row) =>
        PreconditionSchema.parse({
          name: row.label,
          met: Boolean(row.hit),
          required: false,
          detail:
            row.hit === null
              ? `missing: ${row.clause.metric}`
              : `${row.clause.metric} = ${typeof row.value === "boolean" ? (row.value ? "True" : "False") : String(row.value)}`,
        }),
      ),
    ];
    const hitRows = rows.filter((row) => row.hit === true);
    const evidence = fired
      ? hitRows.flatMap((row) =>
          (ctx.results[row.clause.metric]?.evidence ?? []).map((item) => ({
            ...item,
            reason: item.reason
              ? `${row.clause.metric}: ${item.reason}`
              : row.clause.metric,
          })),
        )
      : [];
    return signalResult(rule.name, "D", fired, evidence, preconditions, {
      reason: fired ? hitRows.map((row) => row.label).join("; ") : null,
      ruleVersion: ctx.config.version,
    });
  };
}
export const TAG_SIGNALS: ReadonlyMap<string, SignalFn> = new Map(
  TAG_RULES.map((rule) => [rule.name, tagSignal(rule)]),
);
