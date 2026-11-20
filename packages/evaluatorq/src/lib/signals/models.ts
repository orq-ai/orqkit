import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { codepointCompare, pythonStrip } from "../common/sanitize.js";
import type { SignalContext } from "./walk.js";

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function signalModel<S extends z.ZodRawShape>(shape: S, strict = false) {
  const object = strict ? z.strictObject(shape) : z.object(shape);
  return z.preprocess((value) => {
    if (!record(value)) return value;
    const out = { ...value };
    for (const key of Object.keys(shape)) {
      const legacy = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (legacy === key || !Object.hasOwn(out, legacy)) continue;
      if (Object.hasOwn(out, key) && !isDeepStrictEqual(out[key], out[legacy]))
        throw new TypeError(`Conflicting ${key} and ${legacy}`);
      out[key] = out[legacy];
      delete out[legacy];
    }
    return out;
  }, object.readonly());
}
export const signalFloat = z.preprocess(
  (value) => {
    if (typeof value === "boolean") return Number(value);
    if (typeof value === "string") {
      const stripped = pythonStrip(value);
      if (
        /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i.test(
          stripped,
        )
      ) {
        const text = stripped.replaceAll("_", "");
        if (/^[+-]?inf(?:inity)?$/i.test(text))
          return text.startsWith("-") ? -Infinity : Infinity;
        return Number(text);
      }
    }
    return value;
  },
  z.custom<number>((v) => typeof v === "number"),
);
export const signalInteger = z.preprocess(
  (value) =>
    typeof value === "boolean"
      ? Number(value)
      : typeof value === "string" &&
          /^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(pythonStrip(value))
        ? Number(pythonStrip(value).replaceAll("_", ""))
        : value,
  z.number().int(),
);
export const signalBoolean = z.preprocess((value) => {
  if (value === 0 || value === 1) return Boolean(value);
  if (typeof value === "string") {
    if (["true", "t", "yes", "y", "on", "1"].includes(value.toLowerCase()))
      return true;
    if (["false", "f", "no", "n", "off", "0"].includes(value.toLowerCase()))
      return false;
  }
  return value;
}, z.boolean());
export const signalDictionary = z
  .custom<Record<string, unknown>>(record)
  .transform((value) => Object.fromEntries(Object.entries(value)));
export function signalRecord<T>(
  schema: z.ZodType<T>,
): z.ZodType<Record<string, T>> {
  return signalDictionary.transform((value, ctx) => {
    const entries: [string, T][] = [];
    for (const [key, item] of Object.entries(value)) {
      const result = schema.safeParse(item);
      if (!result.success) {
        for (const issue of result.error.issues)
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
      } else entries.push([key, result.data]);
    }
    return Object.fromEntries(entries);
  });
}
export const GroupSchema = z.enum(["A", "B", "C", "D"]);
export type Group = z.infer<typeof GroupSchema>;
export const EvidenceSchema = signalModel({
  stepId: signalInteger,
  agentPath: z.array(z.string()).default(() => []),
  callId: z.string().nullable().default(null),
  related: z
    .array(z.tuple([z.array(z.string()), signalInteger]))
    .default(() => []),
  relatedCallIds: z.array(z.string()).default(() => []),
  reason: z.string().default(""),
  subgroup: z.string().nullable().default(null),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export const PreconditionSchema = signalModel({
  name: z.string(),
  met: z.union([signalBoolean, z.literal("partial")]),
  detail: z.string().default(""),
  required: signalBoolean.default(true),
});
export type Precondition = z.infer<typeof PreconditionSchema>;
export const SignalResultSchema = signalModel({
  name: z.string(),
  group: GroupSchema,
  value: z.unknown().default(null),
  evidence: z.array(EvidenceSchema).default(() => []),
  approximate: signalBoolean.default(false),
  noBasis: z.string().nullable().default(null),
  preconditions: z.array(PreconditionSchema).default(() => []),
  reason: z.string().nullable().default(null),
  ruleVersion: z.string().nullable().default(null),
}).superRefine((result, ctx) => {
  if (result.noBasis !== null && result.value !== null)
    ctx.addIssue({
      code: "custom",
      message: `Signal ${result.name} has noBasis set, so value must be null`,
    });
});
export type SignalResult = z.infer<typeof SignalResultSchema>;
export const SignalReportSchema = signalModel({
  trajectoryId: z.string().nullable(),
  results: signalRecord(SignalResultSchema),
  configVersion: z.string(),
});
export type SignalReportFields = z.infer<typeof SignalReportSchema>;
export class SignalReport implements SignalReportFields {
  declare readonly trajectoryId: string | null;
  declare readonly results: Record<string, SignalResult>;
  declare readonly configVersion: string;
  constructor(input: unknown) {
    Object.assign(this, SignalReportSchema.parse(input));
    Object.freeze(this);
  }
  values(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.results)
        .filter(([, r]) => r.noBasis === null)
        .map(([name, r]) => [name, r.value]),
    );
  }
}
function compareEvidence(a: Evidence, b: Evidence): number {
  for (let i = 0; i < Math.min(a.agentPath.length, b.agentPath.length); i++) {
    const order = codepointCompare(a.agentPath[i] ?? "", b.agentPath[i] ?? "");
    if (order) return order;
  }
  return a.agentPath.length - b.agentPath.length || a.stepId - b.stepId;
}
export function signalResult(
  name: string,
  group: Group,
  value: unknown,
  evidence: Evidence[] | null = null,
  preconditions: Precondition[] | null = null,
  options: {
    approximate?: boolean;
    reason?: string | null;
    ruleVersion?: string | null;
  } = {},
): SignalResult {
  const conditions = preconditions ?? [],
    failed = conditions.filter((p) => p.required && p.met === false);
  if (failed.length)
    return SignalResultSchema.parse({
      name,
      group,
      approximate: options.approximate ?? false,
      noBasis: failed.map((p) => `${p.name}: ${p.detail}`).join("; "),
      preconditions: conditions,
    });
  return SignalResultSchema.parse({
    name,
    group,
    value,
    evidence: [...(evidence ?? [])].sort(compareEvidence),
    preconditions: conditions,
    approximate: options.approximate ?? false,
    reason: options.reason ?? null,
    ruleVersion: options.ruleVersion ?? null,
  });
}

export type SignalFn = (context: SignalContext) => SignalResult;
