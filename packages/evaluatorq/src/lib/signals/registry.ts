import { codepointCompare } from "../common/sanitize.js";
import type { AtifTrajectoryFields } from "../formats/atif.js";
import { AUTONOMY_SIGNALS } from "./autonomy.js";
import { SignalsConfig } from "./config.js";
import {
  type Group,
  PreconditionSchema,
  type SignalFn,
  SignalReport,
  type SignalResult,
  SignalResultSchema,
} from "./models.js";
import { sourceToolCoverage } from "./preconditions.js";
import { STRUCTURE_SIGNALS } from "./structure.js";
import { TAG_DEPENDENCIES, TAG_SIGNALS } from "./tags.js";
import { TOOL_SIGNALS } from "./tools.js";
import { SignalContext } from "./walk.js";

function merge(
  ...tables: readonly (readonly [Group, ReadonlyMap<string, SignalFn>])[]
): Readonly<Record<string, readonly [Group, SignalFn]>> {
  const entries: [string, readonly [Group, SignalFn]][] = [],
    seen = new Set<string>();
  for (const [group, table] of tables)
    for (const [name, fn] of table) {
      if (seen.has(name))
        throw new Error(`Signal '${name}' is registered twice`);
      seen.add(name);
      entries.push([name, Object.freeze([group, fn] as const)]);
    }
  return Object.freeze(Object.fromEntries(entries));
}
export const SIGNALS = merge(
  ["A", STRUCTURE_SIGNALS],
  ["B", TOOL_SIGNALS],
  ["C", AUTONOMY_SIGNALS],
  ["D", TAG_SIGNALS],
);
export const SIGNAL_NAMES: readonly string[] = Object.freeze(
  Object.keys(SIGNALS),
);
export const TOOL_ACTIVITY_DEPENDENT_SIGNALS: readonly string[] = Object.freeze(
  [
    "tool_call_count",
    "unique_tools_used",
    "tool_call_value_count",
    "bash_command_value_count",
    "webview_value_count",
    "loaded_skill_value_count",
    "tool_error_count",
    "tool_error_rate",
    "duplicate_tool_call_count",
    "tool_retry_count",
    "tool_succeeded_after_retry_count",
    "invalid_schema_tool_call_count",
    "consecutive_same_tool_max",
    "consecutive_command_family_max",
    "identical_tool_call_run_count",
    "tool_oscillation_count",
    "tool_loop_count",
    "distinct_tool_arg_ratio",
    "empty_tool_result_count",
    "max_tool_result_bytes",
    "total_tool_result_bytes",
    "max_autonomous_steps",
    "avg_autonomous_steps",
    "max_llm_tool_cycles",
    "terminal_answer_present",
    "human_interruption_count",
    "subagent_invocation_count",
    "subagent_step_share",
    "parallel_tool_batch_count",
    "max_parallel_tool_calls",
    "wall_time_ms",
    "active_time_ms",
    "tool_time_ms",
    "max_autonomous_duration_ms",
  ],
);
const toolDependent = new Set(TOOL_ACTIVITY_DEPENDENT_SIGNALS),
  tagToolDependent = new Set(
    Object.entries(TAG_DEPENDENCIES)
      .filter(([, dependencies]) =>
        dependencies.some((name) => toolDependent.has(name)),
      )
      .map(([name]) => name),
  );
for (const name of [...toolDependent, ...tagToolDependent])
  if (!Object.hasOwn(SIGNALS, name))
    throw new Error(`Tool-activity dependency name is not registered: ${name}`);
const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
export function computeSignals(
  trajectory: AtifTrajectoryFields,
  options: {
    config?: SignalsConfig | null;
    only?: Iterable<string> | null;
  } = {},
): SignalReport {
  const config = options.config ?? new SignalsConfig(),
    wanted = options.only == null ? null : new Set(options.only);
  if (wanted) {
    const unknown = [...wanted]
      .filter((name) => !Object.hasOwn(SIGNALS, name))
      .sort(codepointCompare);
    if (unknown.length)
      throw new RangeError(`Unknown signal names: ${unknown.join(", ")}`);
    const pending = [...wanted];
    while (pending.length)
      for (const dependency of TAG_DEPENDENCIES[pending.pop() as string] ?? [])
        if (!wanted.has(dependency)) {
          wanted.add(dependency);
          pending.push(dependency);
        }
  }
  const selected = Object.entries(SIGNALS).filter(
      ([name]) => wanted === null || wanted.has(name),
    ),
    results: Record<string, SignalResult> = {};
  const report = () =>
    new SignalReport({
      trajectoryId: trajectory.trajectoryId,
      configVersion: config.version,
      results,
    });
  let ctx: SignalContext;
  try {
    ctx = SignalContext.build(trajectory, config);
  } catch (error) {
    const why = `walk failed: ${errorText(error)}`;
    console.warn(`Walking the trajectory failed: ${errorText(error)}`);
    for (const [name, [group]] of selected)
      results[name] = SignalResultSchema.parse({ name, group, noBasis: why });
    return report();
  }
  for (const [name, [group, fn]] of selected) {
    let computed: SignalResult;
    try {
      computed = fn(ctx);
      if (toolDependent.has(name)) {
        const coverage = sourceToolCoverage(ctx);
        computed = SignalResultSchema.parse({
          ...computed,
          preconditions: [...computed.preconditions, coverage],
          ...(coverage.met === false
            ? { value: null, noBasis: coverage.detail }
            : {}),
        });
      } else if (tagToolDependent.has(name)) {
        const unavailable = (TAG_DEPENDENCIES[name] ?? []).filter(
          (dependency) =>
            ctx.results[dependency]?.preconditions.some(
              (pc) =>
                pc.name === "source tool activity represented" &&
                pc.met === false,
            ),
        );
        if (unavailable.length) {
          const detail = `tool-dependent metrics unavailable: ${unavailable.join(", ")}`;
          computed = SignalResultSchema.parse({
            ...computed,
            value: null,
            noBasis: detail,
            preconditions: [
              ...computed.preconditions,
              PreconditionSchema.parse({
                name: "source tool activity represented",
                met: false,
                detail,
              }),
            ],
          });
        }
      }
    } catch (error) {
      console.warn(`Signal ${name} failed: ${errorText(error)}`);
      computed = SignalResultSchema.parse({
        name,
        group,
        noBasis: `signal raised ${errorText(error)}`,
      });
    }
    results[name] = computed;
    ctx.results[name] = computed;
  }
  return report();
}
