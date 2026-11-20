import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { roleModel } from "../common/model-roles.js";
import { pyFixed } from "../common/reports/number-format.js";
import { parsePythonJson } from "../formats/json.js";
import bundled from "./bundled-thresholds.json" with { type: "json" };
import {
  signalBoolean,
  signalFloat,
  signalInteger,
  signalModel,
  signalRecord,
} from "./models.js";

export const DEFAULT_ERROR_PATTERNS = [
  "Error:",
  "Traceback",
  "<tool_use_error>",
] as const;
export const DEFAULT_EMPTY_VALUES: ReadonlySet<string> = new Set([
  "",
  "[]",
  "{}",
  "null",
]);
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "call_sub_agent",
]);
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "bash",
  "shell",
  "exec",
  "exec_command",
  "functions.exec_command",
  "shell_command",
  "run_shell_command",
  "orq_shell",
]);
export const WEBFETCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "WebFetch",
  "web_fetch",
  "WebView",
  "webview",
]);
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(["Skill"]);
export const ToolRoleSchema = z.enum([
  "bash",
  "webview",
  "skill",
  "subagent",
  "other",
]);
export type ToolRole = z.infer<typeof ToolRoleSchema>;
export function defaultToolRoles(): Record<string, ToolRole> {
  return Object.fromEntries(
    (
      [
        [SHELL_TOOL_NAMES, "bash"],
        [WEBFETCH_TOOL_NAMES, "webview"],
        [SKILL_TOOL_NAMES, "skill"],
        [SUBAGENT_TOOL_NAMES, "subagent"],
      ] as const
    ).flatMap(([names, role]) => [...names].sort().map((name) => [name, role])),
  );
}
export function defaultAlertThresholds(): Record<string, number> {
  return {
    tool_error_rate: 0.2,
    duplicate_tool_call_count: 2,
    consecutive_same_tool_max: 3,
    tool_loop_count: 0,
    invalid_schema_tool_call_count: 0,
    finish_reason_length_count: 0,
    empty_tool_result_count: 2,
  };
}
export const ClassifierConfigSchema = signalModel(
  {
    model: z
      .string()
      .default(() => roleModel("classifier", { task: "signals" })),
    enabled: signalBoolean.default(false),
  },
  true,
);
export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;
const percentileTables = signalRecord(z.array(signalFloat)).superRefine(
  (tables, ctx) => {
    for (const [metric, values] of Object.entries(tables)) {
      if (values.length !== 101)
        ctx.addIssue({
          code: "custom",
          message: `Percentile table ${metric} must contain exactly 101 values`,
        });
      if (values.some((v) => !Number.isFinite(v)))
        ctx.addIssue({
          code: "custom",
          message: `Percentile table ${metric} must contain only finite values`,
        });
      if (values.some((v, i) => i > 0 && (values[i - 1] ?? 0) > v))
        ctx.addIssue({
          code: "custom",
          message: `Percentile table ${metric} must be nondecreasing`,
        });
    }
  },
);
export const TagThresholdsSchema = signalModel(
  {
    ruleVersion: z.string(),
    thresholds: signalRecord(signalFloat),
    percentiles: percentileTables.default({}),
  },
  true,
);
export type TagThresholdsFields = z.infer<typeof TagThresholdsSchema>;
export class TagThresholds implements TagThresholdsFields {
  declare readonly ruleVersion: string;
  declare readonly thresholds: Record<string, number>;
  declare readonly percentiles: Record<string, number[]>;
  constructor(input: unknown) {
    Object.assign(this, TagThresholdsSchema.parse(input));
    Object.freeze(this);
  }
  static fromPublished(document: Record<string, unknown>): TagThresholds {
    const thresholds = document.thresholds;
    if (
      !thresholds ||
      typeof thresholds !== "object" ||
      Array.isArray(thresholds)
    )
      throw new TypeError("Published thresholds must be an object");
    return new TagThresholds({
      ruleVersion: document.rule_version,
      thresholds: Object.fromEntries(
        Object.entries(thresholds).map(([key, entry]) => [
          key,
          (entry as Record<string, unknown>).value,
        ]),
      ),
      percentiles: document.percentiles ?? {},
    });
  }
  static bundled(): TagThresholds {
    return new TagThresholds(structuredClone(defaultThresholds));
  }
  cohortThreshold(metric: string, quantile: number): number {
    const table = Object.hasOwn(this.percentiles, metric)
      ? this.percentiles[metric]
      : undefined;
    if (!table) throw new RangeError(`Missing percentile table ${metric}`);
    const position = Math.min(Math.max(quantile, 0), 100),
      low = Math.trunc(position);
    if (Number.isNaN(low)) throw new RangeError("Percentile is NaN");
    if (low >= table.length - 1) return table.at(-1) as number;
    const left = table[low],
      right = table[low + 1];
    if (left === undefined || right === undefined)
      throw new RangeError("Incomplete percentile table");
    return Number(pyFixed(left + (right - left) * (position - low), 4));
  }
}
const defaultThresholds = TagThresholds.fromPublished(bundled);
const percentiles = signalRecord(
  signalFloat.refine(
    (v) => v >= 0 && v <= 100,
    "Tag percentile must be between 0 and 100",
  ),
);
export const SignalsConfigSchema = signalModel(
  {
    errorDetection: z.enum(["status", "status_and_content"]).default("status"),
    errorPatterns: z.array(z.string()).default([...DEFAULT_ERROR_PATTERNS]),
    canonicalisation: z.enum(["sorted_keys", "exact"]).default("sorted_keys"),
    retryDefinition: z
      .enum(["consecutive_same_tool", "same_tool_args_within_n"])
      .default("consecutive_same_tool"),
    retryWindow: signalInteger.refine((v) => v >= 1).default(3),
    emptyValues: z
      .preprocess(
        (v) => (v instanceof Set ? [...v] : v),
        z.array(z.string()).transform((values) => new Set(values)),
      )
      .default(() => new Set(DEFAULT_EMPTY_VALUES)),
    emptyLiterals: z.array(z.string()).default([]),
    toolRoles: signalRecord(ToolRoleSchema).default(defaultToolRoles),
    alertThresholds: signalRecord(signalFloat).default(defaultAlertThresholds),
    tagPercentiles: percentiles.default({}),
    tagThresholds: TagThresholdsSchema.nullable().default(null),
    classifier: ClassifierConfigSchema.default(() =>
      ClassifierConfigSchema.parse({}),
    ),
  },
  true,
);
export type SignalsConfigFields = z.infer<typeof SignalsConfigSchema>;
export class SignalsConfig implements SignalsConfigFields {
  declare readonly errorDetection: SignalsConfigFields["errorDetection"];
  declare readonly errorPatterns: string[];
  declare readonly canonicalisation: SignalsConfigFields["canonicalisation"];
  declare readonly retryDefinition: SignalsConfigFields["retryDefinition"];
  declare readonly retryWindow: number;
  declare readonly emptyValues: Set<string>;
  declare readonly emptyLiterals: string[];
  declare readonly toolRoles: Record<string, ToolRole>;
  declare readonly alertThresholds: Record<string, number>;
  declare readonly tagPercentiles: Record<string, number>;
  declare readonly tagThresholds: TagThresholdsFields | null;
  declare readonly classifier: ClassifierConfig;
  constructor(input: unknown = {}) {
    Object.assign(this, SignalsConfigSchema.parse(input));
    Object.freeze(this);
  }
  static fromFile(path: string): SignalsConfig {
    const config = new SignalsConfig(
      parsePythonJson(readFileSync(path, "utf8")),
    );
    return new SignalsConfig({
      ...config,
      toolRoles: { ...defaultToolRoles(), ...config.toolRoles },
    });
  }
  toolRole(name: string): ToolRole {
    return Object.hasOwn(this.toolRoles, name)
      ? (this.toolRoles[name] as ToolRole)
      : "other";
  }
  resolvedTagThresholds(): TagThresholds {
    return this.tagThresholds
      ? new TagThresholds(this.tagThresholds)
      : TagThresholds.bundled();
  }
  get version(): string {
    return (
      defaultThresholds.ruleVersion +
      (Object.keys(this.tagPercentiles).length ||
      (this.tagThresholds !== null &&
        !isDeepStrictEqual(this.tagThresholds, { ...defaultThresholds }))
        ? "+custom"
        : "")
    );
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries([
      ...Object.entries(this),
      ["emptyValues", [...this.emptyValues]],
    ]);
  }
}
