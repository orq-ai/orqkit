import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { BadParameter } from "../../common/cli-config.js";
import {
  checkLlmParallelism,
  llmConcurrencyLimit,
} from "../../common/llm-limit.js";
import { roleModel } from "../../common/model-roles.js";
import { LLMCallConfig } from "../../contracts.js";
import { makeAgentBackend } from "../../redteam/backends/registry.js";
import { parseTarget, TargetKind } from "../../redteam/contracts.js";
import { echoNext, type SimIO, simulateCommand, TARGET_HINT } from "./cli.js";
import type { TraceAnalysisConfig, TraceConversation } from "./traces.js";
import type { Datapoint } from "./types.js";
import { toOrqDatasetRows } from "./utils/dataset-export.js";

const DASH = "\u2014";

export function pythonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pythonDumps).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${pythonDumps(key)}: ${pythonDumps(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export { toOrqDatasetRows };

export function writeDatapoints(
  datapoints: readonly Datapoint[],
  output: string,
  datasetFormat = false,
): void {
  mkdirSync(dirname(output), { recursive: true });
  const lines = datasetFormat
    ? toOrqDatasetRows(datapoints).map(pythonDumps)
    : datapoints.map((dp) => JSON.stringify(dp));
  writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
}

function providerLabel(env: Record<string, string | undefined>): string {
  if (env.ORQ_API_KEY) return "Orq router";
  if (env.OPENAI_API_KEY) return "OpenAI-compatible";
  return "unresolved provider";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SimGenerateIO extends SimIO {
  env?: Record<string, string | undefined>;
  generate?: (params: {
    agentDescription: string;
    numPersonas: number;
    numScenarios: number;
    llmConfig: LLMCallConfig;
    personaSeeds?: string[];
    scenarioSeeds?: string[];
    generationInstructions?: string;
  }) => Promise<Datapoint[]>;
  resolveAgentDescription?: (key: string) => Promise<string | null>;
}

export interface SimGenerateArgs {
  datapoints_path: string;
  agent_description?: string;
  target?: string;
  sim_model?: string;
  num_personas?: number;
  num_scenarios?: number;
  persona_seed?: string[];
  scenario_seed?: string[];
  generation_instructions?: string;
  dataset_format?: boolean;
  quiet?: boolean;
}

async function agentDescription(
  description: string | undefined,
  target: string | undefined,
  io: SimGenerateIO,
): Promise<string> {
  if (description) return description;
  const message =
    "This command requires --agent-description unless --target is an agent target";
  if (target === undefined) throw new Error(message);
  const [kind, value] = parseTarget(target);
  if (kind !== TargetKind.AGENT) throw new Error(message);
  const fetched = io.resolveAgentDescription
    ? await io.resolveAgentDescription(value)
    : (await makeAgentBackend().resolveContext(value)).description;
  if (!fetched)
    throw new Error(
      `Agent '${value}' has no description; pass --agent-description explicitly.`,
    );
  return fetched;
}

function preview(datapoints: readonly Datapoint[], io: SimIO): void {
  const personas = new Map<string, Datapoint["persona"]>();
  const scenarios = new Map<string, Datapoint["scenario"]>();
  for (const dp of datapoints) {
    if (!personas.has(dp.persona.name))
      personas.set(dp.persona.name, dp.persona);
    if (!scenarios.has(dp.scenario.name))
      scenarios.set(dp.scenario.name, dp.scenario);
  }
  if (personas.size) {
    io.printError("Personas");
    io.printError("Name | Patience | Assertive | Style");
    for (const p of personas.values())
      io.printError(
        `${p.name} | ${p.patience} | ${p.assertiveness} | ${p.communication_style}`,
      );
  }
  if (scenarios.size) {
    io.printError("Scenarios");
    io.printError("Name | Goal");
    for (const s of scenarios.values())
      io.printError(`${s.name} | ${s.goal ?? ""}`);
  }
}

export async function executeSimGenerate(
  args: SimGenerateArgs,
  io: SimGenerateIO,
): Promise<number> {
  const numPersonas = args.num_personas ?? 5;
  const numScenarios = args.num_scenarios ?? 5;
  for (const [name, value] of [
    ["num-personas", numPersonas],
    ["num-scenarios", numScenarios],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new BadParameter(
        "Must be an integer of at least 1.",
        `'--${name}'`,
      );
  if (!args.quiet) {
    const model =
      args.sim_model || roleModel("fast", { task: "sim.generator" });
    io.printError("Generate Plan");
    io.printError(
      `  Source    ${args.agent_description ? "inline description" : (args.target ?? DASH)}`,
    );
    io.printError(
      `  Provider  ${providerLabel(io.env ?? process.env)} · ${model}`,
    );
    io.printError(
      `  Building  ${numPersonas} personas x ${numScenarios} scenarios = ${numPersonas * numScenarios} datapoints`,
    );
    io.printError(`  Output    ${args.datapoints_path}`);
  }
  let datapoints: Datapoint[];
  try {
    const description = await agentDescription(
      args.agent_description,
      args.target,
      io,
    );
    const llmConfig = new LLMCallConfig(
      args.sim_model ? { model: args.sim_model } : {},
    );
    const generate =
      io.generate ??
      (async (params) => {
        const { DatapointGenerator } = await import(
          "./generators/datapoint-generator.js"
        );
        return new DatapointGenerator({
          llmConfig: params.llmConfig,
        }).generateFromDescription(params);
      });
    datapoints = await generate({
      agentDescription: description,
      numPersonas,
      numScenarios,
      llmConfig,
      personaSeeds: args.persona_seed,
      scenarioSeeds: args.scenario_seed,
      generationInstructions: args.generation_instructions,
    });
  } catch (error) {
    if (error instanceof BadParameter) throw error;
    io.printError(`Error: ${errorText(error)}`);
    return 1;
  }
  writeDatapoints(datapoints, args.datapoints_path, args.dataset_format);
  if (!args.quiet) preview(datapoints, io);
  io.printError(
    `✓ Generated ${datapoints.length} datapoint(s) → ${args.datapoints_path}`,
  );
  if (!args.quiet)
    echoNext(
      simulateCommand(args.datapoints_path, args.target ?? null),
      "run the simulation against your agent",
      args.target ? null : TARGET_HINT,
      io,
    );
  return 0;
}

export interface SimTracesApi {
  fetchTraceConversations: (options: {
    limit: number;
    startDateMs?: number;
    search: string;
  }) => Promise<TraceConversation[]>;
  summarizeConversations: (
    conversations: readonly TraceConversation[],
    options: { model?: string; config: TraceAnalysisConfig },
  ) => Promise<Record<string, string>>;
  datapointsFromTraces: (
    conversations: readonly TraceConversation[],
    options: {
      model?: string;
      config: TraceAnalysisConfig;
      summaries: Record<string, string>;
    },
  ) => Promise<Datapoint[]>;
  extendFromTraces: (
    conversations: readonly TraceConversation[],
    options: {
      numDatapoints: number;
      agentDescription?: string;
      model?: string;
      config: TraceAnalysisConfig;
      summaries: Record<string, string>;
    },
  ) => Promise<Datapoint[]>;
}

export interface SimFromTracesIO extends SimIO {
  traces?: SimTracesApi;
  now?: () => number;
}

export interface SimFromTracesArgs {
  output: string;
  limit?: number;
  lookback_hours?: number;
  search?: string;
  extend?: number;
  agent_description?: string;
  sim_model?: string;
  replay_first_message?: boolean;
  redact_pii?: boolean;
  max_summaries?: number;
  llm_parallelism?: number;
  quiet?: boolean;
}

async function defaultTracesApi(): Promise<SimTracesApi> {
  const traces = await import("./traces.js");
  return {
    fetchTraceConversations: ({ limit, startDateMs, search }) =>
      traces.fetchTraceConversations({
        limit,
        search,
        ...(startDateMs === undefined ? {} : { startDateMs }),
      }),
    summarizeConversations: (conversations, options) =>
      traces.summarizeConversations(conversations, options),
    datapointsFromTraces: (conversations, options) =>
      traces.datapointsFromTraces(conversations, options),
    extendFromTraces: (conversations, options) =>
      traces.extendFromTraces(conversations, options),
  };
}

export async function executeSimFromTraces(
  args: SimFromTracesArgs,
  io: SimFromTracesIO,
): Promise<number> {
  if (args.llm_parallelism !== undefined) {
    try {
      checkLlmParallelism(args.llm_parallelism);
    } catch (error) {
      throw new BadParameter(errorText(error), "'--llm-parallelism'");
    }
  }
  for (const [name, value, minimum] of [
    ["limit", args.limit ?? 20, 1],
    ["max-summaries", args.max_summaries ?? 50, 1],
    ["extend", args.extend ?? 0, 0],
  ] as const)
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new BadParameter(
        `Must be an integer of at least ${minimum}.`,
        `'--${name}'`,
      );
  if (
    args.lookback_hours !== undefined &&
    (!Number.isFinite(args.lookback_hours) || args.lookback_hours < 0)
  )
    throw new BadParameter(
      "Must be a finite number of at least 0.",
      "'--lookback-hours'",
    );
  const { TraceAnalysisConfig } = await import("./traces.js");
  const config = new TraceAnalysisConfig({
    generateFirstMessage: !args.replay_first_message,
    maxReduceSummaries: args.max_summaries ?? 50,
    redactPii: args.redact_pii ?? true,
  });
  const api = io.traces ?? (await defaultTracesApi());
  const model = args.sim_model;
  const extend = args.extend ?? 0;
  let numTraces: number;
  let numDirect = 0;
  let datapoints: Datapoint[];
  try {
    const startDateMs =
      args.lookback_hours === undefined
        ? undefined
        : Math.trunc((io.now ?? Date.now)() - args.lookback_hours * 3_600_000);
    const conversations = await api.fetchTraceConversations({
      limit: args.limit ?? 20,
      search: args.search ?? "",
      ...(startDateMs === undefined ? {} : { startDateMs }),
    });
    if (!conversations.length)
      throw new Error(
        "No traces with a usable conversation found. Widen --lookback-hours, raise --limit, or drop --search.",
      );
    numTraces = conversations.length;
    datapoints = await llmConcurrencyLimit(args.llm_parallelism, async () => {
      const summaries = await api.summarizeConversations(conversations, {
        model,
        config,
      });
      const built = await api.datapointsFromTraces(conversations, {
        model,
        config,
        summaries,
      });
      numDirect = built.length;
      if (extend > 0)
        built.push(
          ...(await api.extendFromTraces(conversations, {
            numDatapoints: extend,
            ...(args.agent_description
              ? { agentDescription: args.agent_description }
              : {}),
            model,
            config,
            summaries,
          })),
        );
      return built;
    });
  } catch (error) {
    if (error instanceof BadParameter) throw error;
    io.printError(`Error: ${errorText(error)}`);
    return 1;
  }
  if (!datapoints.length) {
    io.printError(
      "Error: no datapoints could be built from the fetched traces.",
    );
    return 1;
  }
  writeDatapoints(datapoints, args.output);
  const direct = numDirect;
  const extension = datapoints.length - direct;
  let summary = `Built ${direct} datapoint(s) from ${numTraces} trace(s)`;
  if (extension)
    summary += ` + ${extension} distribution-matched datapoint(s) (--extend)`;
  io.printError(`${summary} -> ${args.output}`);
  return 0;
}
