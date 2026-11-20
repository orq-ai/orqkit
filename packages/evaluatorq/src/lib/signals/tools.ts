import { pyFixed } from "../common/reports/number-format.js";
import { codepointCompare, pythonStrip } from "../common/sanitize.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";
import {
  type Evidence,
  EvidenceSchema,
  type Precondition,
  PreconditionSchema,
  type SignalResult,
  SignalResultSchema,
  signalResult,
} from "./models.js";
import * as pre from "./preconditions.js";
import { schemaViolation } from "./schema.js";
import { shellCommandFamily } from "./shell.js";
import {
  type CallRecord,
  callToolSchemas,
  rawToolArguments,
  resultText,
  type SignalContext,
} from "./walk.js";

const callEv = (record: CallRecord, reason = ""): Evidence =>
  EvidenceSchema.parse({
    stepId: record.step.step.stepId,
    agentPath: record.step.agentPath,
    callId: record.call.toolCallId,
    reason,
  });
const related = (record: CallRecord): [string[], number][] => [
  [record.step.agentPath, record.step.step.stepId],
];
function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return (
    quote +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll(quote, `\\${quote}`)
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t") +
    quote
  );
}
function errorReason(record: CallRecord, ctx: SignalContext): string | null {
  if (record.result === null) return null;
  if (record.isError) return "status";
  if (ctx.config.errorDetection === "status_and_content") {
    const text = resultText(record.result);
    for (const pattern of ctx.config.errorPatterns)
      if (text.includes(pattern)) return `matched ${repr(pattern)}`;
  }
  return null;
}
function failed(ctx: SignalContext): [CallRecord, string][] {
  return ctx.calls.flatMap((record) => {
    const why = errorReason(record, ctx);
    return why ? [[record, why] as [CallRecord, string]] : [];
  });
}
const errorEvidence = (rows: [CallRecord, string][]): Evidence[] =>
  rows.map(([record, why]) =>
    EvidenceSchema.parse({
      ...callEv(record, why === "status" ? "" : why),
      related: related(record),
      relatedCallIds: [record.call.toolCallId],
    }),
  );
export function toolErrorCount(ctx: SignalContext): SignalResult {
  const rows = failed(ctx);
  return signalResult(
    "tool_error_count",
    "B",
    rows.length,
    errorEvidence(rows),
    [pre.explicitErrorStatus(ctx), pre.resultsMatched(ctx)],
  );
}
export function toolErrorRate(ctx: SignalContext): SignalResult {
  const rows = failed(ctx);
  return signalResult(
    "tool_error_rate",
    "B",
    ctx.calls.length
      ? Number(pyFixed(rows.length / ctx.calls.length, 4))
      : null,
    errorEvidence(rows),
    [
      pre.hasToolCalls(ctx),
      pre.explicitErrorStatus(ctx),
      pre.resultsMatched(ctx),
    ],
  );
}
const argumentsOf = (record: CallRecord): Record<string, unknown> =>
  rawToolArguments(record.call) === null ? record.call.arguments : {};
function canonical(record: CallRecord, ctx: SignalContext): string {
  const raw = rawToolArguments(record.call);
  if (raw !== null) return `raw:${raw}`;
  try {
    return `json:${pythonJson(record.call.arguments, { sortKeys: ctx.config.canonicalisation === "sorted_keys", ensureAscii: false })}`;
  } catch {
    return `json:${pythonJson(record.call.arguments, { sortKeys: true, ensureAscii: false, defaultString: true })}`;
  }
}
const fingerprint = (record: CallRecord, ctx: SignalContext): string =>
  JSON.stringify([record.call.functionName, canonical(record, ctx)]);
function repeatEvidence(ctx: SignalContext): Evidence[] {
  const first = new Map<string, CallRecord>(),
    evidence: Evidence[] = [];
  for (const record of ctx.calls) {
    const key = fingerprint(record, ctx),
      original = first.get(key);
    if (original)
      evidence.push(
        EvidenceSchema.parse({
          ...callEv(record),
          related: related(original),
          relatedCallIds: [original.call.toolCallId],
        }),
      );
    else first.set(key, record);
  }
  return evidence;
}
export function duplicateToolCallCount(ctx: SignalContext): SignalResult {
  const evidence = repeatEvidence(ctx);
  return signalResult(
    "duplicate_tool_call_count",
    "B",
    evidence.length,
    evidence,
    [pre.argsParseable(ctx)],
  );
}
function streams(ctx: SignalContext): CallRecord[][] {
  const groups = new Map<string, CallRecord[]>();
  for (const record of ctx.calls) {
    const key = JSON.stringify(record.step.agentPath),
      group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function retryCandidates(ctx: SignalContext): Map<number, CallRecord[]> {
  const candidates = new Map<number, CallRecord[]>();
  for (const stream of streams(ctx))
    for (const [position, record] of stream.entries()) {
      const window = stream.slice(
          Math.max(
            0,
            position -
              (ctx.config.retryDefinition === "consecutive_same_tool"
                ? 1
                : ctx.config.retryWindow),
          ),
          position,
        ),
        key = fingerprint(record, ctx),
        matches = window.filter((prior) =>
          ctx.config.retryDefinition === "consecutive_same_tool"
            ? prior.call.functionName === record.call.functionName
            : fingerprint(prior, ctx) === key,
        );
      if (matches.length) candidates.set(record.seq, matches);
    }
  return candidates;
}
function retryLinks(
  ctx: SignalContext,
  candidates: Map<number, CallRecord[]>,
): Map<number, CallRecord> {
  const links = new Map<number, CallRecord>();
  for (const [seq, matches] of candidates) {
    const prior = matches.filter((record) => errorReason(record, ctx)).at(-1);
    if (prior) links.set(seq, prior);
  }
  return links;
}
function retryStatusPrecondition(
  ctx: SignalContext,
  candidates: Map<number, CallRecord[]>,
  retryResults: CallRecord[] = [],
): Precondition {
  const relevant = new Map<number, CallRecord>();
  for (const matches of candidates.values())
    for (const prior of matches) relevant.set(prior.seq, prior);
  if (!relevant.size)
    return PreconditionSchema.parse({
      name: "explicit error status",
      met: true,
      detail: "no calls match an earlier call under the configured retry rule",
      required: false,
    });
  for (const retry of retryResults) relevant.set(retry.seq, retry);
  const records = [...relevant.values()],
    missing = records.filter((record) => record.result === null);
  if (missing.length)
    return PreconditionSchema.parse({
      name: "retry candidate results",
      met: false,
      detail: `${records.length - missing.length} of ${records.length} possible retry results available; missing: ${missing.map((record) => `${record.call.functionName} @step ${record.step.step.stepId}`).join(", ")}`,
      required: true,
    });
  const known = records.filter((record) => record.isError !== null).length,
    required = ctx.config.errorDetection === "status";
  return PreconditionSchema.parse({
    name: "explicit error status",
    met: known === records.length,
    detail:
      `${known} of ${records.length} possible retry results carry an error status` +
      (!required && known < records.length ? " (content sniffing only)" : ""),
    required,
  });
}
function pythonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    (typeof left === "boolean" || typeof left === "number") &&
    (typeof right === "boolean" || typeof right === "number")
  )
    return Number(left) === Number(right);
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => pythonEqual(item, right[index]))
    );
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const a = left as Record<string, unknown>,
      b = right as Record<string, unknown>;
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) => Object.hasOwn(b, key) && pythonEqual(a[key], b[key]),
      )
    );
  }
  return false;
}
function changedArgs(before: CallRecord, after: CallRecord): string[] {
  const left = argumentsOf(before),
    right = argumentsOf(after);
  if (!Object.keys(left).length && !Object.keys(right).length)
    return pythonEqual(before.call.arguments, after.call.arguments)
      ? []
      : ["<arguments>"];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => !pythonEqual(left[key] ?? null, right[key] ?? null))
    .sort(codepointCompare);
}
function retryEvidence(
  record: CallRecord,
  prior: CallRecord,
  ctx: SignalContext,
): Evidence {
  let reason = "";
  if (ctx.config.retryDefinition === "consecutive_same_tool") {
    const changed = changedArgs(prior, record);
    reason = changed.length
      ? `changed args: ${changed.join(", ")}`
      : "same args";
  }
  return EvidenceSchema.parse({
    ...callEv(record, reason),
    related: related(prior),
    relatedCallIds: [prior.call.toolCallId],
  });
}
export function toolRetryCount(ctx: SignalContext): SignalResult {
  const candidates = retryCandidates(ctx),
    links = retryLinks(ctx, candidates),
    evidence = ctx.calls.flatMap((record) => {
      const prior = links.get(record.seq);
      return prior ? [retryEvidence(record, prior, ctx)] : [];
    });
  return signalResult("tool_retry_count", "B", evidence.length, evidence, [
    retryStatusPrecondition(ctx, candidates),
    pre.resultsMatched(ctx),
  ]);
}
function compareRelated(a: [string[], number], b: [string[], number]): number {
  for (let i = 0; i < Math.min(a[0].length, b[0].length); i++) {
    const order = codepointCompare(a[0][i] ?? "", b[0][i] ?? "");
    if (order) return order;
  }
  return a[0].length - b[0].length || a[1] - b[1];
}
export function toolSucceededAfterRetryCount(ctx: SignalContext): SignalResult {
  const candidates = retryCandidates(ctx),
    links = retryLinks(ctx, candidates),
    evidence: Evidence[] = [];
  for (const record of ctx.calls) {
    const prior = links.get(record.seq);
    if (!prior || record.result === null || errorReason(record, ctx)) continue;
    const chain: CallRecord[] = [];
    let cursor: CallRecord | undefined = prior;
    while (cursor) {
      chain.push(cursor);
      cursor = links.get(cursor.seq);
    }
    chain.reverse();
    const unique = new Map(
      chain.map((item) => [
        JSON.stringify(related(item)[0]),
        related(item)[0] as [string[], number],
      ]),
    );
    evidence.push(
      EvidenceSchema.parse({
        ...callEv(record),
        related: [...unique.values()].sort(compareRelated),
        relatedCallIds: chain.map((item) => item.call.toolCallId),
      }),
    );
  }
  return signalResult(
    "tool_succeeded_after_retry_count",
    "B",
    evidence.length,
    evidence,
    [
      retryStatusPrecondition(
        ctx,
        candidates,
        ctx.calls.filter((record) => links.has(record.seq)),
      ),
      pre.resultsMatched(ctx),
    ],
  );
}
function shellFamily(record: CallRecord, ctx: SignalContext): string | null {
  if (ctx.config.toolRole(record.call.functionName) !== "bash") return null;
  const args = argumentsOf(record);
  return shellCommandFamily(
    Object.hasOwn(args, "command") ? args.command : args.cmd,
  );
}
export function consecutiveSameToolMax(ctx: SignalContext): SignalResult {
  const runs: CallRecord[][] = [];
  for (const stream of streams(ctx)) {
    let run: CallRecord[] = [];
    for (const record of stream) {
      if (
        run.length &&
        run.at(-1)?.call.functionName !== record.call.functionName
      ) {
        runs.push(run);
        run = [];
      }
      run.push(record);
    }
    if (run.length) runs.push(run);
  }
  const longest = Math.max(0, ...runs.map((run) => run.length)),
    evidence = runs
      .filter((run) => run.length === longest && longest > 1)
      .flatMap((run) => {
        const first = run[0];
        return first
          ? [
              EvidenceSchema.parse({
                ...callEv(first, `${run.length}x ${first.call.functionName}`),
                related: run.slice(1).flatMap(related),
                relatedCallIds: run
                  .slice(1)
                  .map((item) => item.call.toolCallId),
              }),
            ]
          : [];
      });
  return signalResult("consecutive_same_tool_max", "B", longest, evidence);
}
export function consecutiveCommandFamilyMax(ctx: SignalContext): SignalResult {
  const runs: [string, CallRecord[]][] = [];
  for (const stream of streams(ctx)) {
    let family: string | null = null,
      run: CallRecord[] = [];
    for (const record of stream) {
      const current = shellFamily(record, ctx);
      if (run.length && current !== family) {
        runs.push([family || "", run]);
        run = [];
      }
      if (current) run.push(record);
      family = current;
    }
    if (run.length && family) runs.push([family, run]);
  }
  const longest = Math.max(0, ...runs.map(([, run]) => run.length)),
    evidence = runs
      .filter(([, run]) => run.length === longest && longest > 1)
      .flatMap(([family, run]) => {
        const first = run[0];
        return first
          ? [
              EvidenceSchema.parse({
                ...callEv(first, `${run.length}x ${family}`),
                related: run.slice(1).flatMap(related),
                relatedCallIds: run.slice(1).map((r) => r.call.toolCallId),
              }),
            ]
          : [];
      });
  return signalResult("consecutive_command_family_max", "B", longest, evidence);
}
type Episode = ["identical retry" | "oscillation", CallRecord[]];
function episodes(ctx: SignalContext): Episode[] {
  const episodes: Episode[] = [];
  for (const stream of streams(ctx)) {
    const keys = stream.map((record) => fingerprint(record, ctx));
    let start = 0;
    while (start < stream.length) {
      let end = start + 1;
      while (end < stream.length && keys[end] === keys[start]) end++;
      if (end - start >= 3)
        episodes.push(["identical retry", stream.slice(start, end)]);
      start = end;
    }
    for (let start = 0; start < stream.length - 3; start++) {
      if (
        keys[start] === keys[start + 1] ||
        keys[start] !== keys[start + 2] ||
        keys[start + 1] !== keys[start + 3]
      )
        continue;
      if (start && keys[start - 1] === keys[start + 1]) continue;
      let end = start + 4;
      while (end < stream.length && keys[end] === keys[end - 2]) end++;
      episodes.push(["oscillation", stream.slice(start, end)]);
    }
  }
  return episodes.sort((a, b) => (a[1][0]?.seq ?? 0) - (b[1][0]?.seq ?? 0));
}
function episodeEvidence(
  kind: Episode[0],
  run: CallRecord[],
  ctx: SignalContext,
): Evidence {
  const first = run[0],
    second = run[1];
  if (!first) throw new RangeError("Empty tool episode");
  const firstLabel = shellFamily(first, ctx) || first.call.functionName,
    secondLabel = second
      ? shellFamily(second, ctx) || second.call.functionName
      : "",
    reason =
      kind === "identical retry"
        ? `${run.length}x identical ${firstLabel}`
        : `${run.length}-call oscillation: ${firstLabel !== secondLabel ? `${firstLabel} ↔ ${secondLabel}` : `${firstLabel} (two argument sets)`}`;
  return EvidenceSchema.parse({
    ...callEv(first, reason),
    related: run.slice(1).flatMap(related),
    relatedCallIds: run.slice(1).map((r) => r.call.toolCallId),
  });
}
function episodeSignal(
  ctx: SignalContext,
  name: string,
  kind: Episode[0] | null,
): SignalResult {
  const matches = episodes(ctx).filter(([k]) => kind === null || kind === k);
  return signalResult(
    name,
    "B",
    matches.length,
    matches.map(([k, run]) => episodeEvidence(k, run, ctx)),
  );
}
export const identicalToolCallRunCount = (ctx: SignalContext): SignalResult =>
  episodeSignal(ctx, "identical_tool_call_run_count", "identical retry");
export const toolOscillationCount = (ctx: SignalContext): SignalResult =>
  episodeSignal(ctx, "tool_oscillation_count", "oscillation");
export const toolLoopCount = (ctx: SignalContext): SignalResult =>
  episodeSignal(ctx, "tool_loop_count", null);
export function distinctToolArgRatio(ctx: SignalContext): SignalResult {
  const distinct = new Set(ctx.calls.map((record) => fingerprint(record, ctx)))
    .size;
  return signalResult(
    "distinct_tool_arg_ratio",
    "B",
    ctx.calls.length ? Number(pyFixed(distinct / ctx.calls.length, 4)) : null,
    repeatEvidence(ctx),
    [pre.hasToolCalls(ctx), pre.argsParseable(ctx)],
  );
}
function emptyKind(record: CallRecord, ctx: SignalContext): string | null {
  if (record.result === null) return null;
  if (
    Array.isArray(record.result.content) &&
    record.result.content.length === 0
  )
    return ctx.config.emptyValues.has("[]") ? "[]" : null;
  const text = pythonStrip(resultText(record.result));
  if (ctx.config.emptyLiterals.includes(text)) return text;
  if (text === "" && ctx.config.emptyValues.has("")) return "";
  let decoded: unknown;
  try {
    decoded = parsePythonJson(text);
  } catch {
    return null;
  }
  const kinds: [
    [string, boolean],
    [string, boolean],
    [string, boolean],
    [string, boolean],
  ] = [
    ["[]", Array.isArray(decoded) && decoded.length === 0],
    [
      "{}",
      decoded !== null &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        Object.keys(decoded).length === 0,
    ],
    ["null", decoded === null],
    ["", decoded === ""],
  ];
  return (
    kinds.find(
      ([kind, match]) => match && ctx.config.emptyValues.has(kind),
    )?.[0] ?? null
  );
}
export function emptyToolResultCount(ctx: SignalContext): SignalResult {
  const evidence = ctx.calls.flatMap((record) => {
    const kind = emptyKind(record, ctx);
    return kind !== null
      ? [
          EvidenceSchema.parse({
            ...callEv(record, `empty: ${repr(kind)}`),
            related: related(record),
          }),
        ]
      : [];
  });
  return signalResult(
    "empty_tool_result_count",
    "B",
    evidence.length,
    evidence,
    [pre.resultContentAvailable(ctx)],
  );
}
function strictBytes(text: string): number {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new TypeError("Tool result contains an unpaired Unicode surrogate");
  }
  return Buffer.byteLength(text, "utf8");
}
function sized(ctx: SignalContext): [CallRecord, number][] {
  return ctx.calls.flatMap((record) =>
    record.result !== null
      ? [
          [record, strictBytes(resultText(record.result))] as [
            CallRecord,
            number,
          ],
        ]
      : [],
  );
}
export function maxToolResultBytes(ctx: SignalContext): SignalResult {
  const sizes = sized(ctx),
    largest = sizes.length ? Math.max(...sizes.map(([, size]) => size)) : null,
    evidence = sizes
      .filter(([, size]) => size === largest)
      .map(([record, size]) =>
        EvidenceSchema.parse({
          ...callEv(record, `${size} bytes`),
          related: related(record),
        }),
      );
  return signalResult("max_tool_result_bytes", "B", largest, evidence, [
    pre.hasToolResults(ctx),
    pre.resultContentAvailable(ctx),
  ]);
}
export function totalToolResultBytes(ctx: SignalContext): SignalResult {
  const sizes = sized(ctx);
  return signalResult(
    "total_tool_result_bytes",
    "B",
    sizes.reduce((n, [, size]) => n + size, 0),
    sizes.map(([record, size]) =>
      EvidenceSchema.parse({
        ...callEv(record, `${size} bytes`),
        related: related(record),
      }),
    ),
    [pre.resultContentAvailable(ctx)],
  );
}
export function invalidSchemaToolCallCount(ctx: SignalContext): SignalResult {
  const pcs = pre.toolSchemasCoverage(ctx),
    evidence: Evidence[] = [];
  for (const record of ctx.calls) {
    const definition = callToolSchemas(record, ctx.trajectory)[
        record.call.functionName
      ],
      schema = definition?.parameters;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema))
      continue;
    let violation: string | null;
    try {
      violation = schemaViolation(
        schema as Record<string, unknown>,
        record.call.arguments,
      );
    } catch (error) {
      const detail = `${record.call.functionName}: ${error instanceof Error ? error.message : String(error)}`;
      return SignalResultSchema.parse({
        name: "invalid_schema_tool_call_count",
        group: "B",
        noBasis: detail,
        preconditions: [
          ...pcs,
          PreconditionSchema.parse({
            name: "tool schemas valid",
            met: false,
            detail,
          }),
        ],
      });
    }
    if (rawToolArguments(record.call) !== null)
      violation = "arguments are not valid JSON";
    if (violation)
      evidence.push(
        callEv(record, `${record.call.functionName}: ${violation}`),
      );
  }
  return signalResult(
    "invalid_schema_tool_call_count",
    "B",
    evidence.length,
    evidence,
    pcs,
  );
}
export const TOOL_SIGNALS: ReadonlyMap<
  string,
  (ctx: SignalContext) => SignalResult
> = new Map([
  ["tool_error_count", toolErrorCount],
  ["tool_error_rate", toolErrorRate],
  ["duplicate_tool_call_count", duplicateToolCallCount],
  ["tool_retry_count", toolRetryCount],
  ["tool_succeeded_after_retry_count", toolSucceededAfterRetryCount],
  ["invalid_schema_tool_call_count", invalidSchemaToolCallCount],
  ["consecutive_same_tool_max", consecutiveSameToolMax],
  ["consecutive_command_family_max", consecutiveCommandFamilyMax],
  ["identical_tool_call_run_count", identicalToolCallRunCount],
  ["tool_oscillation_count", toolOscillationCount],
  ["tool_loop_count", toolLoopCount],
  ["distinct_tool_arg_ratio", distinctToolArgRatio],
  ["empty_tool_result_count", emptyToolResultCount],
  ["max_tool_result_bytes", maxToolResultBytes],
  ["total_tool_result_bytes", totalToolResultBytes],
]);
