import { pythonString as pyString } from "../common/sanitize.js";
import type {
  AtifObservationResult,
  AtifStep,
  AtifSubagentRef,
  AtifToolCall,
  AtifTrajectoryFields,
} from "../formats/atif.js";
import {
  atifContentText,
  COMPACTION_EXTRA_KEY,
  RAW_ARGUMENTS_EXTRA_KEY,
} from "../formats/shared.js";
import { parseIso } from "../formats/time.js";
import type { SignalsConfig } from "./config.js";
import type { SignalResult } from "./models.js";

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

export { pythonString as pyString } from "../common/sanitize.js";
export interface WalkedStep {
  readonly step: AtifStep;
  readonly agentPath: string[];
  readonly depth: number;
  readonly trajectory: AtifTrajectoryFields;
  readonly unlinked: boolean;
}
export class CallRecord {
  constructor(
    readonly seq: number,
    readonly step: WalkedStep,
    readonly call: AtifToolCall,
    readonly result: AtifObservationResult | null,
  ) {
    Object.freeze(this);
  }
  get isError(): boolean | null {
    const extra = this.result?.extra;
    if (!extra || !Object.keys(extra).length) return null;
    if (truth(extra.error_type) || extra.status === "error") return true;
    if (extra.status != null) return false;
    return null;
  }
}
export interface LlmTimes {
  readonly start: number | null;
  readonly end: number | null;
  readonly approximate: boolean;
}
export function rawToolArguments(call: AtifToolCall): string | null {
  const raw = call.extra?.[RAW_ARGUMENTS_EXTRA_KEY];
  return typeof raw === "string" ? raw : null;
}
export function isSkipped(step: AtifStep): boolean {
  const extra = step.extra ?? {};
  return (
    Object.hasOwn(extra, COMPACTION_EXTRA_KEY) ||
    truth(extra.context_management) ||
    step.isCopiedContext === true
  );
}
const refs = (step: AtifStep): AtifSubagentRef[] =>
  (step.observation?.results ?? []).flatMap(
    (result) => result.subagentTrajectoryRef ?? [],
  );
export function walk(trajectory: AtifTrajectoryFields): WalkedStep[] {
  const registry = new Map<string, AtifTrajectoryFields[]>(),
    embedded: AtifTrajectoryFields[] = [];
  const collect = (current: AtifTrajectoryFields): void => {
    for (const sub of current.subagentTrajectories ?? [])
      if (sub.trajectoryId !== null) {
        const items = registry.get(sub.trajectoryId) ?? [];
        items.push(sub);
        registry.set(sub.trajectoryId, items);
        embedded.push(sub);
        collect(sub);
      }
  };
  collect(trajectory);
  const placed = new Set<AtifTrajectoryFields>([trajectory]),
    out: WalkedStep[] = [];
  const visit = (
    current: AtifTrajectoryFields,
    path: string[],
    depth: number,
    unlinked: boolean,
  ): void => {
    const local = new Map(
      (current.subagentTrajectories ?? []).flatMap((sub) =>
        sub.trajectoryId ? [[sub.trajectoryId, sub] as const] : [],
      ),
    );
    for (const step of current.steps) {
      if (isSkipped(step)) continue;
      out.push(
        Object.freeze({
          step,
          agentPath: path,
          depth,
          trajectory: current,
          unlinked,
        }),
      );
      for (const ref of refs(step)) {
        const id = ref.trajectoryId;
        if (id === null) continue;
        const sub =
          local.get(id) ||
          (registry.get(id) ?? []).find((item) => !placed.has(item));
        if (!sub || placed.has(sub)) continue;
        placed.add(sub);
        visit(sub, [...path, id], depth + 1, unlinked);
      }
    }
  };
  visit(trajectory, [], 0, false);
  for (const sub of embedded)
    if (!placed.has(sub) && sub.trajectoryId !== null) {
      placed.add(sub);
      visit(sub, [sub.trajectoryId], 1, true);
    }
  return out;
}
export function calls(walked: WalkedStep[]): CallRecord[] {
  const records: CallRecord[] = [];
  for (const entry of walked) {
    if (!entry.step.toolCalls?.length) continue;
    const results = new Map<string, AtifObservationResult>();
    for (const result of entry.step.observation?.results ?? [])
      if (result.sourceCallId !== null && !results.has(result.sourceCallId))
        results.set(result.sourceCallId, result);
    for (const call of entry.step.toolCalls)
      records.push(
        new CallRecord(
          records.length,
          entry,
          call,
          results.get(call.toolCallId) ?? null,
        ),
      );
  }
  return records;
}
export function resultText(result: AtifObservationResult): string {
  return result.content === null
    ? ""
    : atifContentText(result.content, "signals");
}
export function stepModel(entry: WalkedStep): string | null {
  return entry.step.modelName || entry.trajectory.agent.modelName;
}
export function isLlmStep(entry: WalkedStep): boolean {
  return (
    entry.step.source === "agent" &&
    entry.step.llmCallCount !== 0 &&
    (Boolean(entry.step.llmCallCount) || Boolean(stepModel(entry)))
  );
}
const providerPrefixes = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["gemini", "google"],
  ["mistral", "mistral"],
  ["llama", "meta"],
  ["grok", "xai"],
  ["deepseek", "deepseek"],
  ["qwen", "alibaba"],
] as const;
export function inferProvider(model: string | null): string | null {
  if (!model) return null;
  if (model.includes("/")) return model.split("/", 1)[0] ?? null;
  const lowered = model.toLowerCase();
  return (
    providerPrefixes.find(([prefix]) => lowered.startsWith(prefix))?.[1] ?? null
  );
}
export function invocation(step: AtifStep): Row {
  const value = step.extra?.invocation;
  return record(value) ? value : {};
}
export function finishReasons(step: AtifStep): string[] {
  const value = invocation(step).finish_reasons;
  return Array.isArray(value) ? value.map(pyString) : [];
}
const epoch = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
export function llmTimes(entry: WalkedStep): LlmTimes {
  const info = invocation(entry.step),
    start = epoch(info.start_timestamp),
    end = epoch(info.end_timestamp);
  if (start !== null || end !== null)
    return Object.freeze({ start, end, approximate: false });
  if (entry.step.timestamp !== null)
    return Object.freeze({
      start: parseIso(entry.step.timestamp).epochSeconds,
      end: null,
      approximate: true,
    });
  return Object.freeze({ start: null, end: null, approximate: false });
}
export function toolTimes(
  result: AtifObservationResult,
): readonly [number | null, number | null] {
  return [
    epoch(result.extra?.start_timestamp),
    epoch(result.extra?.end_timestamp),
  ];
}
function schemas(definitions: unknown[]): Record<string, Row> {
  return Object.fromEntries(
    definitions.flatMap((definition) => {
      if (!record(definition)) return [];
      const body = record(definition.function)
        ? definition.function
        : definition;
      return typeof body.name === "string" ? [[body.name, body]] : [];
    }),
  );
}
export function toolSchemas(
  trajectory: AtifTrajectoryFields,
): Record<string, Row> {
  return schemas(trajectory.agent.toolDefinitions ?? []);
}
export function callToolSchemas(
  call: CallRecord,
  root: AtifTrajectoryFields,
): Record<string, Row> {
  const tools = call.step.step.extra?.["evaluatorq.responses_tools"];
  return Array.isArray(tools)
    ? schemas(tools)
    : { ...toolSchemas(root), ...toolSchemas(call.step.trajectory) };
}
export function hasUnmappedToolActivity(walked: WalkedStep[]): string[] {
  const activity: string[] = [];
  for (const entry of walked) {
    const extra = entry.step.extra ?? {},
      items = [
        "evaluatorq.responses_output_items",
        "evaluatorq.responses_result_items",
      ].flatMap((key) => (Array.isArray(extra[key]) ? extra[key] : [])),
      represented = new Set(
        (entry.step.toolCalls ?? []).map((call) => call.toolCallId),
      );
    for (const item of items) {
      if (!record(item)) continue;
      const kind = item.type,
        unsupportedCall =
          kind === "function_call"
            ? typeof item.call_id !== "string" ||
              !item.call_id ||
              !represented.has(item.call_id)
            : typeof kind === "string" && kind.endsWith("_call"),
        unsupportedOutput =
          typeof kind === "string" &&
          kind.endsWith("_call_output") &&
          kind !== "function_call_output";
      if (unsupportedCall || unsupportedOutput)
        activity.push(
          `${pyString(item.name || item.server_label || kind)} @step ${entry.step.stepId}`,
        );
    }
  }
  return activity;
}
export class SignalContext {
  constructor(
    readonly trajectory: AtifTrajectoryFields,
    readonly config: SignalsConfig,
    readonly walked: WalkedStep[],
    readonly calls: CallRecord[],
    readonly results: Record<string, SignalResult> = {},
  ) {
    Object.freeze(this);
  }
  static build(
    trajectory: AtifTrajectoryFields,
    config: SignalsConfig,
  ): SignalContext {
    const walked = walk(trajectory);
    return new SignalContext(trajectory, config, walked, calls(walked));
  }
}
