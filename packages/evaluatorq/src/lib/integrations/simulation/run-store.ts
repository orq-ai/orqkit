import { mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { orqServerUrl } from "../../common/orq-client.js";
import { writeAtomic } from "../../common/private-files.js";
import { toPythonKeys } from "../../common/python-json.js";
import {
  loadRunPayload,
  REPLAY_VERSION,
  ReplayError,
} from "../../common/replay.js";
import { getStoreDir } from "../../common/run-store-dir.js";
import {
  type Message,
  MessageSchema,
  parseUsage,
  type RunSummary,
  type Usage,
  UsageSchema,
} from "../../contracts.js";
import { extractSingleDatapoint } from "./datapoint-io.js";
import type {
  Datapoint,
  SimulationResult,
  TokenUsage,
  TurnMetrics,
} from "./types.js";

const snake = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
function aliases(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Expected a run object");
  const source = raw as Record<string, unknown>,
    out = { ...source };
  for (const key of keys) {
    const old = snake(key);
    if (old === key || !Object.hasOwn(source, old)) continue;
    if (
      Object.hasOwn(source, key) &&
      !isDeepStrictEqual(source[key], source[old])
    )
      throw new Error(`Conflicting '${key}' and '${old}' values`);
    out[key] = source[old];
    delete out[old];
  }
  return out;
}
export function canonicalUsage(raw: unknown): Usage {
  return parseUsage(raw);
}
export function legacyUsage(usage: Usage): TokenUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}
const nullableString = z.string().nullable().default(null);
const AgentInfoSchema = z.object({
  key: z.string().optional(),
  id: nullableString,
  role: nullableString,
  description: nullableString,
  model: nullableString,
  version: nullableString,
  tools: z.array(z.string()).default(() => []),
  skills: z.array(z.string()).default(() => []),
  knowledgeBases: z.array(z.string()).default(() => []),
  memoryStores: z.array(z.string()).default(() => []),
  subAgents: z.array(z.string()).default(() => []),
  agentType: nullableString,
  engine: nullableString,
  workspaceId: nullableString,
  workspaceKey: nullableString,
  baseUrl: z.string().optional(),
  url: nullableString,
});
export type AgentInfoSnapshot = z.infer<typeof AgentInfoSchema>;
const RecommendationSchema = z.object({
  resultIndex: z.number().int(),
  datapointId: nullableString,
  persona: z.string(),
  scenario: z.string(),
  triggers: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type SimulationRecommendation = z.infer<typeof RecommendationSchema>;
const PERSONA_KEYS = [
  "technicalLevel",
  "communicationStyle",
  "emotionalArc",
  "culturalContext",
];
const SCENARIO_KEYS = [
  "startingEmotion",
  "isEdgeCase",
  "conversationStrategy",
  "groundTruth",
  "inputFormat",
];
function fromCamel(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const mapped = aliases(raw, keys),
    out = { ...mapped };
  for (const key of keys)
    if (Object.hasOwn(mapped, key)) {
      out[snake(key)] = mapped[key];
      delete out[key];
    }
  return out;
}
function datapointInput(raw: unknown): unknown {
  const row = fromCamel(raw, ["userSystemPrompt", "firstMessage"]);
  if (row.persona) row.persona = fromCamel(row.persona, PERSONA_KEYS);
  if (row.scenario) row.scenario = fromCamel(row.scenario, SCENARIO_KEYS);
  return row;
}
export function parseSavedDatapoint(raw: unknown): Datapoint {
  return extractSingleDatapoint(
    { inputs: { datapoint: datapointInput(raw) } },
    "saved run",
  );
}
function messageInput(raw: unknown): unknown {
  const message = fromCamel(raw, ["toolCalls", "toolCallId"]);
  if (Array.isArray(message.tool_calls))
    message.tool_calls = message.tool_calls.map((call) =>
      fromCamel(call, ["itemId"]),
    );
  return message;
}
const TurnSchema = z.object({
  turn_number: z.number().int(),
  token_usage: z.unknown(),
  usage: UsageSchema.nullish(),
  response_quality: z.number().nullish(),
  hallucination_risk: z.number().nullish(),
  tone_appropriateness: z.number().nullish(),
  factual_accuracy: z.number().nullish(),
  judge_reason: z.string(),
});
const TURN_KEYS = [
  "turnNumber",
  "tokenUsage",
  "responseQuality",
  "hallucinationRisk",
  "toneAppropriateness",
  "factualAccuracy",
  "judgeReason",
];
const RESULT_KEYS = [
  "terminatedBy",
  "goalAchieved",
  "goalCompletionScore",
  "rulesBroken",
  "turnCount",
  "tokenUsage",
  "turnMetrics",
  "criteriaResults",
  "criteriaVerified",
  "totalTurns",
  "tokenUsageKnown",
  "threadId",
  "responseTraces",
  "evaluatorDetails",
];
const ResultSchema = z.object({
  messages: z.array(z.unknown()),
  terminated_by: z.enum(["judge", "max_turns", "error", "timeout"]),
  reason: z.string(),
  goal_achieved: z.boolean(),
  goal_completion_score: z.number(),
  rules_broken: z.array(z.string()),
  turn_count: z.number().int(),
  token_usage: z.unknown(),
  turn_metrics: z.array(z.unknown()),
  metadata: z.record(z.unknown()).default(() => ({})),
  criteria_results: z.record(z.boolean()).nullish(),
  criteria_verified: z.boolean().nullish(),
  total_turns: z.number().int().nullish(),
  token_usage_known: z.boolean().default(true),
  thread_id: z.string().nullish(),
  response_traces: z.array(z.unknown()).default(() => []),
  evaluator_details: z.record(z.unknown()).default(() => ({})),
  usage: UsageSchema.nullish(),
});
export type StoredSimulationResult = Omit<SimulationResult, "messages"> & {
  messages: Message[];
};
export function parseSimulationResult(raw: unknown): StoredSimulationResult {
  const result = ResultSchema.parse(fromCamel(raw, RESULT_KEYS));
  const usage = result.usage ?? canonicalUsage(result.token_usage);
  const turns: TurnMetrics[] = result.turn_metrics.map((value) => {
    const turn = TurnSchema.parse(fromCamel(value, TURN_KEYS));
    const detailed = turn.usage ?? canonicalUsage(turn.token_usage);
    return { ...turn, token_usage: legacyUsage(detailed), usage: detailed };
  });
  return {
    ...result,
    messages: result.messages.map((message) =>
      MessageSchema.parse(messageInput(message)),
    ),
    token_usage: legacyUsage(usage),
    usage,
    turn_metrics: turns,
    criteria_results: result.criteria_results ?? undefined,
    criteria_verified: result.criteria_verified ?? undefined,
    total_turns: result.total_turns ?? undefined,
    response_traces: result.response_traces.map((trace) => {
      const value = aliases(trace, ["traceId", "spanId"]);
      return z
        .object({ traceId: z.string(), spanId: z.string().nullish() })
        .parse(value);
    }),
  };
}
const RunSchema = z.object({
  runName: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  mode: z.enum(["run", "simulate", "generate"]),
  targetKind: z.enum([
    "orq_agent",
    "orq_deployment",
    "vercel",
    "openai_model",
    "callback",
  ]),
  target: nullableString,
  targetModel: nullableString,
  maxTurns: z.number().int().nullable().default(null),
  agentInfo: z.unknown().nullable().default(null),
  orqBaseUrl: nullableString,
  evaluatorNames: z.array(z.string()),
  totalResults: z.number().int(),
  scorerAverages: z.custom<Record<string, number>>(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(
        (score) => typeof score === "number" && Number.isFinite(score),
      ),
  ),
  results: z.array(z.unknown()),
  datapoints: z.array(z.unknown()).nullable().default(null),
  replayVersion: z.number().int().nullable().default(null),
  executiveSummary: nullableString,
  tokenUsageTotal: z.unknown().nullable().default(null),
  runId: nullableString,
  experimentUrl: nullableString,
  recommendations: z.array(z.unknown()).nullable().default(null),
  appliedSuggestions: z.array(z.string()).default(() => []),
});
const RUN_KEYS = Object.keys(RunSchema.shape);
export interface SimulationRunInput {
  runName: string;
  createdAt: Date | string;
  mode: "run" | "simulate" | "generate";
  targetKind:
    | "orq_agent"
    | "orq_deployment"
    | "vercel"
    | "openai_model"
    | "callback";
  target?: string | null;
  targetModel?: string | null;
  maxTurns?: number | null;
  agentInfo?: AgentInfoSnapshot | null;
  orqBaseUrl?: string | null;
  evaluatorNames: string[];
  totalResults: number;
  scorerAverages: Record<string, number>;
  results: (SimulationResult | StoredSimulationResult)[];
  datapoints?: Datapoint[] | null;
  replayVersion?: number | null;
  executiveSummary?: string | null;
  tokenUsageTotal?: Usage | null;
  runId?: string | null;
  experimentUrl?: string | null;
  recommendations?: SimulationRecommendation[] | null;
  appliedSuggestions?: string[];
}
function camelObject(
  raw: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return aliases(raw, keys);
}
function wireDatapoint(dp: Datapoint): unknown {
  return {
    ...camelObject(dp as unknown as Record<string, unknown>, [
      "userSystemPrompt",
      "firstMessage",
    ]),
    persona: camelObject(
      dp.persona as unknown as Record<string, unknown>,
      PERSONA_KEYS,
    ),
    scenario: camelObject(
      dp.scenario as unknown as Record<string, unknown>,
      SCENARIO_KEYS,
    ),
  };
}
function wireMessage(
  raw: SimulationResult["messages"][number] | Message,
): unknown {
  const value = camelObject(raw as unknown as Record<string, unknown>, [
    "toolCalls",
    "toolCallId",
  ]);
  if (raw.tool_calls)
    value.toolCalls = raw.tool_calls.map((call) =>
      camelObject(call as unknown as Record<string, unknown>, ["itemId"]),
    );
  return value;
}
function wireResult(
  result: SimulationResult | StoredSimulationResult,
): unknown {
  const mapped = camelObject(
    result as unknown as Record<string, unknown>,
    RESULT_KEYS,
  );
  delete mapped.usage;
  return {
    ...mapped,
    messages: result.messages.map(wireMessage),
    tokenUsage: result.usage ?? canonicalUsage(result.token_usage),
    turnMetrics: result.turn_metrics.map((turn) => {
      const mappedTurn = camelObject(
        turn as unknown as Record<string, unknown>,
        TURN_KEYS,
      );
      delete mappedTurn.usage;
      return {
        ...mappedTurn,
        tokenUsage: turn.usage ?? canonicalUsage(turn.token_usage),
      };
    }),
  };
}
export class SimulationRun implements SimulationRunInput {
  runName!: string;
  createdAt!: string;
  mode!: SimulationRunInput["mode"];
  targetKind!: SimulationRunInput["targetKind"];
  target!: string | null;
  targetModel!: string | null;
  maxTurns!: number | null;
  agentInfo!: AgentInfoSnapshot | null;
  orqBaseUrl!: string | null;
  evaluatorNames!: string[];
  totalResults!: number;
  scorerAverages!: Record<string, number>;
  results!: StoredSimulationResult[];
  datapoints!: Datapoint[] | null;
  replayVersion!: number | null;
  executiveSummary!: string | null;
  tokenUsageTotal!: Usage | null;
  runId!: string | null;
  experimentUrl!: string | null;
  recommendations!: SimulationRecommendation[] | null;
  appliedSuggestions!: string[];
  constructor(input: SimulationRunInput | Record<string, unknown>) {
    const raw = aliases(input, RUN_KEYS);
    if (raw.createdAt instanceof Date)
      raw.createdAt = raw.createdAt.toISOString();
    const parsed = RunSchema.parse(raw);
    Object.assign(this, parsed, {
      results: parsed.results.map(parseSimulationResult),
      datapoints: parsed.datapoints?.map(parseSavedDatapoint) ?? null,
      tokenUsageTotal:
        parsed.tokenUsageTotal === null
          ? null
          : canonicalUsage(parsed.tokenUsageTotal),
      agentInfo:
        parsed.agentInfo === null
          ? null
          : AgentInfoSchema.parse(
              aliases(parsed.agentInfo, Object.keys(AgentInfoSchema.shape)),
            ),
      recommendations:
        parsed.recommendations?.map((value) =>
          RecommendationSchema.parse(
            aliases(value, Object.keys(RecommendationSchema.shape)),
          ),
        ) ?? null,
    });
  }
  manifestSummary(): RunSummary {
    return {
      mode: this.mode,
      targetKind: this.targetKind,
      totalResults: this.totalResults,
      scorerAverages: { ...this.scorerAverages },
    };
  }
  toJSON(): Record<string, unknown> {
    return {
      ...Object.fromEntries(Object.entries(this)),
      results: this.results.map(wireResult),
      datapoints: this.datapoints?.map(wireDatapoint) ?? null,
    };
  }
  toPythonJson(): string {
    return JSON.stringify(
      toPythonKeys(this.toJSON(), "SimulationRun"),
      null,
      2,
    );
  }
  async save(path: string): Promise<void> {
    await writeAtomic(path, this.toPythonJson());
  }
  static async load(path: string): Promise<SimulationRun> {
    return new SimulationRun(JSON.parse(await readFile(path, "utf8")));
  }
}
export function getSimulationRunsDir(): string {
  return getStoreDir("sim-runs");
}
export function sanitiseRunName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "sim"
  );
}
export function buildSimulationRun(
  options: Omit<
    SimulationRunInput,
    "createdAt" | "totalResults" | "scorerAverages"
  > & { createdAt?: Date | string },
): SimulationRun {
  const scores: Record<string, number[]> = Object.create(null);
  for (const result of options.results) {
    const raw = result.metadata.evaluator_scores;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    for (const [name, score] of Object.entries(raw)) {
      if (
        (typeof score === "number" && Number.isFinite(score)) ||
        typeof score === "boolean"
      ) {
        if (!scores[name]) scores[name] = [];
        scores[name].push(Number(score));
      } else console.warn(`Dropping non-numeric score from scorer '${name}'`);
    }
  }
  return new SimulationRun({
    ...options,
    createdAt: options.createdAt ?? new Date(),
    totalResults: options.results.length,
    scorerAverages: Object.fromEntries(
      Object.entries(scores).map(([key, values]) => [
        key,
        values.reduce((a, b) => a + b, 0) / values.length,
      ]),
    ),
    orqBaseUrl:
      options.orqBaseUrl ??
      (["orq_agent", "orq_deployment"].includes(options.targetKind)
        ? orqServerUrl()
        : null),
    datapoints: options.datapoints?.length ? options.datapoints : null,
    replayVersion: options.datapoints?.length ? REPLAY_VERSION : null,
  });
}
export async function autoSaveSimulationRun(
  run: SimulationRun,
  options: { runName?: string; runsDir?: string; now?: Date } = {},
): Promise<string> {
  const dir = options.runsDir ?? getSimulationRunsDir();
  await mkdir(dir, { recursive: true });
  const timestamp = (options.now ?? new Date())
    .toISOString()
    .slice(0, 19)
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-");
  const base = `${sanitiseRunName(options.runName ?? run.runName)}_${timestamp}`;
  const text = run.toPythonJson();
  for (let counter = 0; counter < 1000; counter++) {
    const path = join(
      dir,
      `${base}${counter ? `_${String(counter).padStart(3, "0")}` : ""}.json`,
    );
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(text, "utf8");
      await handle.close();
      return path;
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
      throw error;
    }
  }
  throw new Error(
    `Could not find a free run-store filename for '${base}' after 1000 attempts`,
  );
}
export interface SimulationReplay {
  datapoints: Datapoint[];
  maxTurns: number | null;
}
export async function loadSimulationReplay(
  reference: string,
  runsDir = getSimulationRunsDir(),
): Promise<SimulationReplay> {
  const { payload, path } = await loadRunPayload(reference, runsDir, {
    surface: "simulation",
  });
  if (payload.pipeline !== undefined && payload.pipeline !== null)
    throw new ReplayError(
      `${basename(path)} is a red team run, not a simulation run. Replay it with: eq redteam run --from-run ${basename(path)} --target <target>`,
    );
  if (!Array.isArray(payload.datapoints) || !payload.datapoints.length)
    throw new ReplayError(
      `${basename(path)} records no simulation datapoints, so it cannot be replayed. Re-run the original configuration once to produce a replayable run.`,
    );
  let datapoints: Datapoint[];
  try {
    datapoints = payload.datapoints.map(parseSavedDatapoint);
  } catch (error) {
    throw new ReplayError(
      `Previous simulation run ${basename(path)} has unreadable datapoints: ${String(error)}`,
    );
  }
  if (datapoints.some((dp) => !dp.first_message))
    throw new ReplayError(
      `${basename(path)} has a case with no recorded opening; replay would require generation.`,
    );
  const raw = aliases(payload, ["maxTurns"]);
  return {
    datapoints,
    maxTurns:
      typeof raw.maxTurns === "number" && Number.isInteger(raw.maxTurns)
        ? raw.maxTurns
        : null,
  };
}
export { ReplayError };
