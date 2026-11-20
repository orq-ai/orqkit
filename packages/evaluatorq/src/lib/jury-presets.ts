import { JURY_JUDGE_RATES } from "./common/data/jury-judge-rates.js";
import { type AggregatorName, providerFamily } from "./common/jury.js";

export interface JudgeRates {
  readonly inputRate: number;
  readonly outputRate: number;
  readonly defaultReasoningEffort: string | null;
}

const RATES: ReadonlyMap<string, JudgeRates> = new Map(
  Object.entries(JURY_JUDGE_RATES.judges),
);

export function judgeRates(routerId: string): JudgeRates | undefined {
  return RATES.get(routerId);
}

export function capturedAt(): string {
  return JURY_JUDGE_RATES.capturedAt;
}

const REGION_PREFIXES = ["eu.", "us.", "apac.", "global."];
// Not the family list: a vendor whose name can open a legitimate model name
// would make modelIdentity truncate that model.
const VENDOR_TOKENS = new Set([
  "openai",
  "anthropic",
  "google",
  "zhipu",
  "moonshot",
  "minimax",
  "deepseek",
  "alibaba",
  "meta",
  "mistral",
  "xai",
]);

export function modelIdentity(routerId: string): string {
  let name = (routerId.split("/").pop() as string).toLowerCase();
  for (const prefix of REGION_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
    }
  }
  const dot = name.indexOf(".");
  if (
    dot > 0 &&
    dot < name.length - 1 &&
    VENDOR_TOKENS.has(name.slice(0, dot))
  ) {
    name = name.slice(dot + 1);
  }
  return name.replace(/-v\d+:\d+$/, "");
}

export function judgeFamily(routerId: string): string {
  const family = providerFamily(routerId);
  if (family === "unknown") {
    throw new Error(
      `unknown lineage for '${routerId}'; add a marker to FAMILY_MARKERS in common/jury`,
    );
  }
  return family;
}

const ESTIMATED_PROMPT_TOKENS = 1500n;
const ESTIMATED_COMPLETION_TOKENS = 1500n;
const RATE_SCALE_DIGITS = 9;

function scaledRate(rate: number): bigint {
  return BigInt(rate.toFixed(RATE_SCALE_DIGITS).replace(".", ""));
}

export interface JuryPresetFields {
  name: string;
  judges: readonly string[];
  reserveJudges: readonly string[];
  numericAggregation?: AggregatorName;
  useWhen: string;
  estimatedCostPer1k: number;
}

export class JuryPreset {
  readonly name: string;
  readonly judges: readonly string[];
  readonly reserveJudges: readonly string[];
  readonly numericAggregation: AggregatorName;
  readonly useWhen: string;
  readonly estimatedCostPer1k: number;

  constructor(fields: JuryPresetFields) {
    this.name = fields.name;
    this.judges = fields.judges;
    this.reserveJudges = fields.reserveJudges;
    this.numericAggregation = fields.numericAggregation ?? "mean_std";
    this.useWhen = fields.useWhen;
    this.estimatedCostPer1k = fields.estimatedCostPer1k;
    if (this.judges.length % 2 === 0) {
      throw new Error(`${this.name}: panel size ${this.judges.length} is even`);
    }
    if (new Set(this.judges).size !== this.judges.length) {
      throw new Error(`${this.name}: panel has a duplicate judge`);
    }
    if (this.reserveJudges.some((r) => this.judges.includes(r))) {
      throw new Error(`${this.name}: a reserve judge is already on the panel`);
    }
    if (
      new Set(this.reserveJudges.map(judgeFamily)).size !==
      this.reserveJudges.length
    ) {
      throw new Error(`${this.name}: reserves share a lineage with each other`);
    }
  }

  seatedEfforts(): Record<string, string | null> {
    return Object.fromEntries(
      this.judges.map((j) => [
        j,
        judgeRates(j)?.defaultReasoningEffort ?? null,
      ]),
    );
  }

  duplicatedLineages(): Record<string, readonly string[]> {
    const seated = new Map<string, string[]>();
    for (const judge of this.judges) {
      const family = judgeFamily(judge);
      seated.set(family, [...(seated.get(family) ?? []), judge]);
    }
    return Object.fromEntries([...seated].filter(([, js]) => js.length > 1));
  }

  /**
   * Exact decimal arithmetic with one rounding at the end, so a figure landing
   * on a half-cent is decided by the price and not by float representation.
   */
  costPer1k(): number {
    let total = 0n;
    for (const judge of this.judges) {
      const rates = judgeRates(judge);
      if (!rates) {
        throw new Error(
          `${this.name}: no captured pricing for '${judge}'; re-run the rate capture`,
        );
      }
      total += scaledRate(rates.inputRate) * ESTIMATED_PROMPT_TOKENS;
      total += scaledRate(rates.outputRate) * ESTIMATED_COMPLETION_TOKENS;
    }
    const perThousand = total / 1000n;
    const centUnit = 10n ** BigInt(RATE_SCALE_DIGITS - 2);
    return Number((perThousand + centUnit / 2n) / centUnit) / 100;
  }
}

export const BALANCED_TRIO = new JuryPreset({
  name: "Balanced Trio",
  judges: [
    "deepseek/deepseek-v4-pro",
    "openai/gpt-6-luna",
    "google/gemini-3.6-flash",
  ],
  reserveJudges: ["deepseek/deepseek-flash"],
  useWhen: "Default subjective eval. Three families, three error surfaces.",
  estimatedCostPer1k: 16.36,
});

export const STRONG_JURY = new JuryPreset({
  name: "Strong Jury",
  judges: [
    "anthropic/claude-opus-5-5",
    "openai/gpt-5.6-sol",
    "google/gemini-3.6-flash",
  ],
  reserveJudges: ["deepseek/deepseek-v4-pro"],
  useWhen:
    "Customer-facing benchmarks, preference data, anything that compounds.",
  estimatedCostPer1k: 85.5,
});

export const OPEN_WEIGHT_PORTABLE = new JuryPreset({
  name: "Open-Weight / Portable",
  judges: ["deepseek/deepseek-v4-pro", "wafer/Kimi-K3", "zai/glm-5.2"],
  reserveJudges: ["minimax/MiniMax-M2.7"],
  useWhen:
    "No dependence on a closed frontier vendor; migration path to self-hosting.",
  estimatedCostPer1k: 34.28,
});

export const EU_REGION = new JuryPreset({
  name: "EU Region",
  judges: [
    "aws/eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    "google/eu.gemini-3.5-flash",
    "azure/eu.gpt-5.6-luna",
  ],
  reserveJudges: ["google/eu.claude-sonnet-5"],
  useWhen:
    "Data residency: every judge serves from an EU region. Anthropic, Google and OpenAI, which is what the EU catalog can field at the current generation: the DeepSeek seat carrying Balanced Trio has no EU endpoint newer than v3.1, so this is not that panel relocated.",
  estimatedCostPer1k: 27.75,
});

export const SINGLE_PROVIDER_TRIO = new JuryPreset({
  name: "Single-Provider Trio",
  judges: ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-6-luna"],
  reserveJudges: ["openai/gpt-5.4-nano"],
  useWhen:
    "Workspaces locked to one provider contract. The three real tiers of the current OpenAI lineup rather than one tier plus two minis, so no family diversity: errors correlate and OpenAI-generated outputs face a self-preference risk the panel cannot vote away.",
  estimatedCostPer1k: 57.9,
});

export const PRESETS: ReadonlyMap<string, JuryPreset> = new Map(
  [
    BALANCED_TRIO,
    STRONG_JURY,
    OPEN_WEIGHT_PORTABLE,
    EU_REGION,
    SINGLE_PROVIDER_TRIO,
  ].map((preset) => [preset.name, preset]),
);

export const WITHHELD_PRESETS: ReadonlyMap<string, string> = new Map([
  [
    "Cheap Aggregate",
    "Not shipped yet. Five small judges across five lineages, concluding on three of five. One seat does not vote: `minimax/MiniMax-M2.7` answers a `json_schema` response format with prose, and the fallback that would resend the schema as instructions only fires on a rejected request, not on a 200 that simply has the wrong shape. The model itself complies when the schema reaches it as instructions. That leaves four voting seats, an even panel. Seating the reserve, `zai/glm-5.2`, is not a fix: at $8.70 per 1k for that seat alone it defeats a budget panel. Ships once the judge path falls back on an unparseable 200 as well as on a rejected request.",
  ],
]);

export const DROPPED_PRESETS: ReadonlyMap<string, string> = new Map([
  [
    "Value Trio",
    "Retired. A budget panel whose measured cost ran far above its published figure, because two of its judges wrote long prose verdicts. Use Balanced Trio for a default panel, or Open-Weight / Portable for vendor independence.",
  ],
]);

export function allRouterIds(): Set<string> {
  return new Set(
    [...PRESETS.values()].flatMap((p) => [...p.judges, ...p.reserveJudges]),
  );
}

export function getPreset(rawName: string): JuryPreset {
  const name = rawName.trim();
  const preset = PRESETS.get(name);
  if (preset) {
    return preset;
  }
  const dropped = DROPPED_PRESETS.get(name);
  if (dropped) {
    throw new Error(`jury preset '${name}' was retired: ${dropped}`);
  }
  const withheld = WITHHELD_PRESETS.get(name);
  if (withheld) {
    throw new Error(`jury preset '${name}' is not shipped yet: ${withheld}`);
  }
  throw new Error(
    `unknown jury preset '${name}'; available: ${[...PRESETS.keys()].sort().join(", ")}`,
  );
}
