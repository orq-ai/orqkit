import {
  CACHED_TOKENS_LABEL,
  costCoverage,
  fmtCachedTokens,
  fmtCost,
} from "../../../common/reports/md-helpers.js";
import {
  groupThousands,
  pyFixed,
} from "../../../common/reports/number-format.js";

export function buildSimulationTokenUsageRows(
  data: Record<string, unknown>,
): string[][] {
  const value = (key: string, legacy?: string): number => {
    const raw = data[key] ?? (legacy ? data[legacy] : undefined);
    return typeof raw === "number" ? raw : 0;
  };
  const integer = (key: string, legacy?: string) =>
    groupThousands(String(value(key, legacy)));
  const rows = [
    ["Input Tokens (total)", integer("input_tokens", "prompt_tokens")],
    ["Output Tokens (total)", integer("output_tokens", "completion_tokens")],
    ["Total Tokens", integer("total_tokens")],
    [
      "Avg Total / Conversation",
      pyFixed(value("avg_total_per_conversation"), 0),
    ],
    [
      "Avg Input / Conversation",
      pyFixed(
        value("avg_input_per_conversation", "avg_prompt_per_conversation"),
        0,
      ),
    ],
    [
      "Avg Output / Conversation",
      pyFixed(
        value("avg_output_per_conversation", "avg_completion_per_conversation"),
        0,
      ),
    ],
  ];
  const unknown = value("unknown_usage_conversations");
  if (Number.isInteger(unknown) && unknown > 0)
    rows.push([
      "Usage Coverage",
      `unknown for ${unknown} conversation${unknown === 1 ? "" : "s"}`,
    ]);
  if (value("cached_tokens"))
    rows.push([
      CACHED_TOKENS_LABEL,
      fmtCachedTokens(
        value("cached_tokens"),
        value("input_tokens", "prompt_tokens"),
      ),
    ]);
  if (value("cache_creation_tokens"))
    rows.push(["Cache-Write Tokens", integer("cache_creation_tokens")]);
  if (value("reasoning_tokens"))
    rows.push(["Reasoning Tokens", integer("reasoning_tokens")]);
  for (const [key, label] of [
    ["input_cost", "Input Cost"],
    ["output_cost", "Output Cost"],
    ["total_cost", "Total Cost"],
  ] as const) {
    const cost = data[key];
    if (typeof cost === "number")
      rows.push([
        label,
        fmtCost(cost) +
          (key === "total_cost"
            ? costCoverage(
                Math.trunc(value("priced_calls")),
                Math.trunc(value("calls")),
              )
            : ""),
      ]);
  }
  if ("run_total_total_tokens" in data) {
    rows.push([
      "Run Total Tokens (incl. generation & summary)",
      integer("run_total_total_tokens"),
    ]);
    if (typeof data.run_total_cost === "number")
      rows.push([
        "Run Total Cost (incl. generation & summary)",
        fmtCost(data.run_total_cost) +
          costCoverage(
            Math.trunc(value("run_total_priced_calls")),
            Math.trunc(value("run_total_calls")),
          ),
      ]);
  }
  return rows;
}
