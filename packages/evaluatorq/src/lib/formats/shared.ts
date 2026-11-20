import { contentPartText } from "../common/messages.js";
import {
  type AtifContentPart,
  type AtifFinalMetrics,
  AtifFinalMetricsSchema,
  type AtifStep,
} from "./atif.js";
import { parsePythonJson, pythonJson } from "./json.js";

export const RAW_ARGUMENTS_EXTRA_KEY = "evaluatorq.raw_arguments",
  COMPACTION_EXTRA_KEY = "evaluatorq.compaction";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
export function joinText(texts: Iterable<string>): string {
  return [...texts].filter(Boolean).join("\n");
}
export function partText(part: unknown, where: string): string {
  const text = contentPartText(part);
  if (
    text === null ||
    (!text &&
      !(
        record(part) &&
        ["text", "refusal", "content"].some(
          (key) => typeof part[key] === "string",
        )
      ))
  ) {
    const kind = record(part) ? part.type : typeof part;
    console.warn(
      `${where} content part of type ${String(kind)} carries no text; dropping it.`,
    );
    return "";
  }
  return text;
}
export function compactionExtra(
  compactions: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    context_management: { type: "compaction", boundary: "replace" },
    [COMPACTION_EXTRA_KEY]: compactions,
  };
}
export function atifToolArguments(
  raw: unknown,
  name: unknown,
): readonly [Record<string, unknown>, string | null] {
  if (record(raw)) return [raw, null];
  if (typeof raw === "string") {
    try {
      const decoded: unknown = parsePythonJson(raw);
      if (record(decoded)) return [decoded, null];
    } catch {}
  }
  console.warn(
    `Tool call ${String(name)} arguments are not a JSON object; preserving their original text in ATIF extra.`,
  );
  return [
    {},
    typeof raw === "string" ? raw : pythonJson(raw, { defaultString: true }),
  ];
}
export function jsonArgumentsText(arguments_: Record<string, unknown>): string {
  try {
    return pythonJson(arguments_, { sortKeys: true, compact: true });
  } catch {
    console.warn(
      "Tool call arguments are not JSON-encodable; writing unencodable values as text.",
    );
    return pythonJson(arguments_, {
      sortKeys: true,
      compact: true,
      defaultString: true,
    });
  }
}

export { parseIso } from "./time.js";

export function pythonFloatSum(values: number[]): number {
  let total = 0,
    correction = 0;
  for (const value of values) {
    const next = total + value;
    correction +=
      Math.abs(total) >= Math.abs(value)
        ? total - next + value
        : value - next + total;
    total = next;
  }
  return correction && Number.isFinite(correction) ? total + correction : total;
}
export function finalMetrics(steps: AtifStep[]): AtifFinalMetrics | null {
  const measured = steps.flatMap((step) =>
    step.metrics === null ? [] : [step.metrics],
  );
  if (!measured.length) return null;
  const total = (values: (number | null)[]) => {
    const present = values.filter((v): v is number => v !== null);
    return present.length ? present.reduce((a, b) => a + b, 0) : null;
  };
  return AtifFinalMetricsSchema.parse({
    totalPromptTokens: total(measured.map((m) => m.promptTokens)),
    totalCompletionTokens: total(measured.map((m) => m.completionTokens)),
    totalCachedTokens: total(measured.map((m) => m.cachedTokens)),
    totalCostUsd: measured.some((m) => m.costUsd !== null)
      ? pythonFloatSum(
          measured.flatMap((m) => (m.costUsd === null ? [] : [m.costUsd])),
        )
      : null,
    totalSteps: steps.length,
  });
}
export function mediaMarker(part: AtifContentPart, target: string): string {
  const path = part.source?.path ?? "";
  console.warn(
    `ATIF ${part.type} part at ${path} has no ${target} equivalent; rendering a marker.`,
  );
  return `[${part.type}: ${path}]`;
}
export function atifContentText(
  content: string | AtifContentPart[],
  target: string,
): string {
  return typeof content === "string"
    ? content
    : joinText(
        content.map((part) =>
          part.type === "text" ? part.text || "" : mediaMarker(part, target),
        ),
      );
}
