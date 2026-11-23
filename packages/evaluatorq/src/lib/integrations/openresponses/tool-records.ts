import { createHash } from "node:crypto";

import { getField } from "../../common/fields.js";
import {
  jsonWithFallback,
  parseJsonOrValue,
  toolResultToText,
  UNKNOWN_ARGUMENTS,
} from "../../common/messages.js";

export class PairedToolCall {
  constructor(
    readonly callId: string,
    readonly itemId: string | null,
    readonly name: string,
    readonly arguments_: string | null,
    readonly result: string | null,
    readonly sourceIndex: number,
    readonly indices: readonly number[],
  ) {}
}

interface ToolRecord {
  key: string | null;
  keyedByWireId: boolean;
  wireId: string | null;
  isFunctionCall: boolean;
  isNativeOutput: boolean;
  explicitName: string | null;
  derivedName: string;
  arguments_: string | null;
  result: string | null;
  error: string | null;
  failed: boolean;
}

type Indexed = readonly [index: number, record: ToolRecord];

export function isToolRecord(itemType: unknown): boolean {
  return (
    typeof itemType === "string" &&
    (itemType === "function_call" || itemType.startsWith("orq:"))
  );
}

function hasError(raw: unknown): boolean {
  if (typeof raw === "string" || Array.isArray(raw)) {
    return raw.length > 0;
  }
  return (
    raw !== null &&
    typeof raw === "object" &&
    Object.keys(raw as object).length > 0
  );
}

function isPlaceholderArguments(text: string): boolean {
  const parsed = parseJsonOrValue(text);
  if (parsed === null || parsed === "") {
    return true;
  }
  if (typeof parsed !== "object") {
    return false;
  }
  return Object.keys(parsed).length === 0;
}

function readToolRecord(item: unknown, itemType: string): ToolRecord {
  const explicitCallId = getField(item, "call_id");
  const wireId = getField(item, "id");
  const isFunctionCall = itemType === "function_call";
  const name = getField(item, "name");
  const key = explicitCallId || (isFunctionCall ? wireId : null);
  const rawArgs = getField(item, "arguments");
  let arguments_: string | null = null;
  if (rawArgs !== null && rawArgs !== undefined && rawArgs !== "") {
    arguments_ =
      typeof rawArgs === "string" ? rawArgs : jsonWithFallback(rawArgs);
  }
  const result = getField(item, "result") ?? getField(item, "output") ?? null;
  const rawError = getField(item, "error");
  return {
    key: key ? String(key) : null,
    keyedByWireId: !explicitCallId && Boolean(key),
    wireId: typeof wireId === "string" && wireId ? wireId : null,
    isFunctionCall,
    isNativeOutput: itemType === "function_call_output",
    explicitName: name ? String(name) : null,
    derivedName: itemType.startsWith("orq:")
      ? itemType.slice(itemType.indexOf(":") + 1)
      : "",
    arguments_,
    result: result === null ? null : toolResultToText(result),
    error: hasError(rawError) ? toolResultToText(rawError) : null,
    failed: ["failed", "error"].includes(
      String(getField(item, "status")).toLowerCase(),
    ),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

function jsonKey(text: string): string {
  try {
    return `json:${JSON.stringify(sortKeys(JSON.parse(text)))}`;
  } catch {
    return `raw:${text}`;
  }
}

function pick(
  field: string,
  values: readonly string[],
  callId: string,
): string | null {
  const [kept] = values;
  if (kept === undefined) {
    return null;
  }
  const discarded = values
    .slice(1)
    .filter((value) => jsonKey(value) !== jsonKey(kept));
  if (discarded.length > 0) {
    const shown = [...new Set(discarded)].map((v) => JSON.stringify(v));
    console.warn(
      `Conflicting ${field} for call_id ${JSON.stringify(callId)}: kept ${JSON.stringify(kept)}, discarded ${shown.join(", ")}`,
    );
  }
  return kept;
}

export function failurePayload(
  result: string | null,
  error: string | null,
): string {
  return jsonWithFallback({
    status: "failed",
    error,
    ...(result === null ? {} : { result: parseJsonOrValue(result) }),
  });
}

const nonNull = (values: (string | null)[]): string[] =>
  values.filter((value): value is string => value !== null);

function merge(members: readonly Indexed[], callId: string): PairedToolCall {
  const ordered = [...members].sort(
    (a, b) => Number(b[1].isFunctionCall) - Number(a[1].isFunctionCall),
  );
  const [primaryIndex, primary] = ordered[0] as Indexed;
  const records = ordered.map(([, record]) => record);
  const argumentValues = [
    ...nonNull(
      records.filter((r) => r.isFunctionCall).map((r) => r.arguments_),
    ),
    ...nonNull(
      records.filter((r) => !r.isFunctionCall).map((r) => r.arguments_),
    ).filter((text) => text && !isPlaceholderArguments(text)),
  ];
  const name =
    pick("name", nonNull(records.map((r) => r.explicitName)), callId) ||
    (records.find((r) => r.derivedName)?.derivedName ?? "");
  let result = pick("result", nonNull(records.map((r) => r.result)), callId);
  const error = pick("error", nonNull(records.map((r) => r.error)), callId);
  if (error !== null || records.some((r) => !r.isFunctionCall && r.failed)) {
    result = failurePayload(result, error);
  }
  return new PairedToolCall(
    callId,
    primary.wireId,
    name,
    pick("arguments", argumentValues, callId),
    result,
    primaryIndex,
    members.map(([index]) => index).sort((a, b) => a - b),
  );
}

function warnUnmatched(
  records: readonly ToolRecord[],
  call: PairedToolCall,
  scopeOrqNames: ReadonlySet<string>,
): void {
  const hasArgs = records.some((r) => r.arguments_ !== null);
  const hasResult = records.some(
    (r) => r.result !== null || r.error !== null || r.failed,
  );
  const shownCall = JSON.stringify(call.callId);
  if (hasArgs && !hasResult) {
    // A lone function_call is the normal Responses shape when the caller runs the
    // tool itself; only a call the router plausibly ran is worth a warning.
    if (
      records.some(
        (r) =>
          r.isFunctionCall &&
          r.explicitName !== null &&
          scopeOrqNames.has(r.explicitName),
      )
    ) {
      console.warn(`Tool call ${shownCall} has no result record`);
    }
  } else if (hasResult && call.arguments_ === null) {
    const reason = records.some((r) => r.isFunctionCall)
      ? `: its call record carried no arguments`
      : " has no matching call record";
    console.warn(
      `Tool result for ${JSON.stringify(call.name)} (call_id ${shownCall})${reason}; its arguments are unavailable`,
    );
  }
}

function startsTurn(item: unknown): boolean {
  const itemType = getField(item, "type");
  const role = getField(item, "role");
  const untyped = itemType === null || itemType === undefined;
  const isMessage =
    itemType === "message" || (untyped && role !== null && role !== undefined);
  return isMessage && role === "user";
}

type Scoped = readonly [scope: number, index: number, record: ToolRecord];

// The digest input matches Python's json.dumps, so an unpaired record gets the
// same id in both SDKs.
function pythonJsonArray(values: readonly unknown[]): string {
  const body = values.map((value) => JSON.stringify(value)).join(", ");
  return `[${body}]`.replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function mintIds(records: readonly Scoped[]): Map<number, string> {
  const minted = new Map<number, string>();
  const used = new Set<string>();
  for (const [, index, record] of records) {
    if (record.key) {
      continue;
    }
    const digest = createHash("sha1")
      .update(
        pythonJsonArray([
          record.isFunctionCall,
          record.isNativeOutput,
          record.explicitName || record.derivedName,
          record.arguments_,
          record.result,
          record.error,
        ]),
      )
      .digest("hex")
      .slice(0, 8);
    let callId = `call_unpaired_${digest}`;
    if (used.has(callId)) {
      callId = `${callId}_${index}`;
    }
    used.add(callId);
    minted.set(index, callId);
  }
  return minted;
}

function pair(items: readonly unknown[]): {
  calls: PairedToolCall[];
  minted: Map<number, string>;
} {
  const records: Scoped[] = [];
  let scope = 0;
  items.forEach((item, index) => {
    if (startsTurn(item)) {
      scope += 1;
    }
    const itemType = getField(item, "type");
    if (isToolRecord(itemType) || itemType === "function_call_output") {
      records.push([scope, index, readToolRecord(item, String(itemType))]);
    }
  });
  const minted = mintIds(records);
  const scopeOrqNames = new Map<number, Set<string>>();
  for (const [recordScope, , record] of records) {
    if (!record.isFunctionCall && !record.isNativeOutput) {
      const names = scopeOrqNames.get(recordScope) ?? new Set<string>();
      scopeOrqNames.set(recordScope, names);
      names.add(record.derivedName);
    }
  }
  const groups = new Map<string, { scope: number; members: Indexed[] }>();
  const generation = new Map<string, number>();
  const hasCall = new Set<string>();
  for (const [recordScope, index, record] of records) {
    if (!record.key) {
      groups.set(`unkeyed:${index}`, {
        scope: recordScope,
        members: [[index, record]],
      });
      continue;
    }
    const base = JSON.stringify([
      recordScope,
      record.keyedByWireId,
      record.key,
    ]);
    if (record.isFunctionCall) {
      if (hasCall.has(`${base}#${generation.get(base) ?? 0}`)) {
        generation.set(base, (generation.get(base) ?? 0) + 1);
      }
      hasCall.add(`${base}#${generation.get(base) ?? 0}`);
    }
    const groupKey = `${base}#${generation.get(base) ?? 0}`;
    const group = groups.get(groupKey) ?? { scope: recordScope, members: [] };
    groups.set(groupKey, group);
    group.members.push([index, record]);
  }
  const calls: PairedToolCall[] = [];
  for (const { scope: groupScope, members } of groups.values()) {
    if (members.every(([, r]) => r.isNativeOutput)) {
      continue;
    }
    const [firstIndex, first] = members[0] as Indexed;
    const call = merge(
      members,
      first.key ?? (minted.get(firstIndex) as string),
    );
    calls.push(call);
    warnUnmatched(
      members.map(([, r]) => r),
      call,
      scopeOrqNames.get(groupScope) ?? new Set(),
    );
  }
  calls.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return { calls, minted };
}

export function pairToolRecords(items: Iterable<unknown>): PairedToolCall[] {
  return pair([...items]).calls;
}

function failedOutput(record: ToolRecord, callId: string) {
  return {
    type: "function_call_output",
    call_id: callId,
    output: failurePayload(record.result, record.error),
  };
}

function nativeOutput(
  item: unknown,
  index: number,
  minted: ReadonlyMap<number, string>,
): unknown {
  const record = readToolRecord(item, "function_call_output");
  return record.error !== null || record.failed
    ? failedOutput(record, record.key ?? (minted.get(index) as string))
    : item;
}

export function* iterPaired(
  source: Iterable<unknown>,
): Generator<unknown, void, undefined> {
  const items = [...source];
  const { calls: list, minted } = pair(items);
  const calls = new Map(list.map((call) => [call.sourceIndex, call]));
  const consumed = new Set(list.flatMap((call) => [...call.indices]));
  for (const [index, item] of items.entries()) {
    const call = calls.get(index);
    if (call) {
      yield call;
    } else if (consumed.has(index)) {
    } else if (getField(item, "type") === "function_call_output") {
      yield nativeOutput(item, index, minted);
    } else {
      yield item;
    }
  }
}

export function normalizeToolRecords(source: Iterable<unknown>): unknown[] {
  const items = [...source];
  const { calls, minted } = pair(items);
  const rewritten = new Map(
    calls
      .filter((call) =>
        call.indices.some((i) =>
          String(getField(items[i], "type")).startsWith("orq:"),
        ),
      )
      .map((call) => [call.sourceIndex, call]),
  );
  const consumed = new Set(
    [...rewritten.values()].flatMap((call) => [...call.indices]),
  );
  const normalized: unknown[] = [];
  items.forEach((item, index) => {
    const entry = rewritten.get(index);
    if (entry) {
      normalized.push({
        type: "function_call",
        ...(entry.itemId ? { id: entry.itemId } : {}),
        call_id: entry.callId,
        name: entry.name,
        arguments: entry.arguments_ ?? UNKNOWN_ARGUMENTS,
      });
      if (entry.result !== null) {
        normalized.push({
          type: "function_call_output",
          call_id: entry.callId,
          output: entry.result,
        });
      }
    } else if (consumed.has(index)) {
      return;
    } else if (getField(item, "type") === "function_call_output") {
      normalized.push(nativeOutput(item, index, minted));
    } else {
      normalized.push(item);
    }
  });
  return normalized;
}
