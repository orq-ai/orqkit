import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, sep } from "node:path";

import {
  BadParameter,
  type Flag,
  flag,
  jsonFlag,
  resolveConfig,
} from "../../common/cli-config.js";
import { confirmCliRun, shouldSkipConfirm } from "../../common/cli-confirm.js";
import { parseJsonOrValue } from "../../common/messages.js";
import { roleModel } from "../../common/model-roles.js";
import { readManifest } from "../../common/run-manifest.js";
import { OpenAIModelTarget } from "../../redteam/backends/openai.js";
import { makeAgentBackend } from "../../redteam/backends/registry.js";
import { parseTarget, TargetKind } from "../../redteam/contracts.js";
import { VercelAISdkTarget } from "../ai-sdk/http-target.js";
import { dashboardCommand, echoNext, type SimIO } from "./cli.js";
import { writeDatapoints } from "./cli-generate.js";
import { DatapointSchema } from "./contract-schemas.js";
import { extractSingleDatapoint } from "./datapoint-io.js";
import { getEvaluator, SIMULATION_EVALUATORS } from "./evaluators/index.js";
import { exportSimulationHtml } from "./reports/export-html.js";
import { exportSimulationMarkdown } from "./reports/export-md.js";
import {
  GENERATE_AND_SIMULATE_CONFIG_MODEL,
  type GenerateAndSimulateCliConfig,
  LLM_CALL_CONFIG_MODEL,
  SIMULATE_CONFIG_MODEL,
  type SimCliConfig,
  type SimulateCliConfig,
} from "./run-config.js";
import {
  getSimulationRunsDir,
  type SimulationRun,
  sanitiseRunName,
} from "./run-store.js";
import type {
  GenerateAndSimulateParams,
  SimulateParams,
} from "./simulation/index.js";
import type { Datapoint, Persona, Scenario } from "./types.js";
import { exportResultsToJsonl } from "./utils/dataset-export.js";

export interface SimRunIO extends SimIO {
  env?: Record<string, string | undefined>;
  readStdin?: () => string;
  simulate?: (params: SimulateParams) => Promise<unknown>;
  generateAndSimulate?: (params: GenerateAndSimulateParams) => Promise<unknown>;
  resolveAgentDescription?: (key: string) => Promise<string | null>;
}

export interface SimSharedArgs {
  config?: string;
  target?: string;
  vercel_url?: string;
  openai_model?: string;
  memory_entity?: string;
  results_path?: string;
  report_path?: string;
  report_md?: string;
  report_html?: string;
  name?: string;
  sim_model?: string;
  max_turns?: number;
  datapoint_parallelism?: number;
  llm_parallelism?: number;
  target_reasoning_effort?: string;
  evaluator?: string[];
  save?: boolean;
  recommendations?: boolean;
  executive_summary?: boolean;
  llm_config_json?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: number;
  yes?: boolean;
}

export interface SimSimulateArgs extends SimSharedArgs {
  datapoints?: string;
  dataset_id?: string;
  experiment_id?: string;
  experiment_run_id?: string;
  from_run?: string;
}

export interface SimRunArgs extends SimSharedArgs {
  agent_description?: string;
  num_personas?: number;
  num_scenarios?: number;
  persona_seed?: string[];
  scenario_seed?: string[];
  generation_instructions?: string;
  datapoints_path?: string;
}

const SHARED_FLAGS: readonly Flag[] = [
  flag("target"),
  flag("vercel_url", { path: null, replaces: ["target"] }),
  flag("openai_model", { path: null, replaces: ["target"] }),
  flag("memory_entity", { path: "memory_entity_id" }),
  flag("report_path", { replaces: ["report"] }),
  flag("name", { path: "run_name", replaces: ["evaluation_name"] }),
  flag("max_turns"),
  flag("datapoint_parallelism", { replaces: ["parallelism"] }),
  flag("llm_parallelism"),
  flag("target_reasoning_effort"),
  flag("evaluator", { path: "evaluator_names" }),
  flag("save"),
  flag("recommendations"),
  flag("executive_summary"),
  jsonFlag("llm_config_json", "llm_config", LLM_CALL_CONFIG_MODEL, {
    flag: "--llm-config",
  }),
  flag("sim_model", { path: "llm_config.model" }),
];

const INPUT_FIELDS = [
  "datapoints",
  "personas",
  "scenarios",
  "dataset_id",
  "experiment_id",
  "experiment_run_id",
  "previous_run",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadDatapointRecords(path: string): Record<string, unknown>[] {
  if (!existsSync(path))
    throw new BadParameter(`Datapoints file not found: ${path}`);
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    if (!line.trim()) continue;
    const invalid = (reason: string): never => {
      throw new BadParameter(
        `Datapoints file ${path}, line ${index + 1}: ${reason}`,
      );
    };
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalid("Malformed JSON");
    }
    if (!isObject(raw)) invalid("Expected an object");
    const row = raw as Record<string, unknown>;
    if (Object.hasOwn(row, "persona") || Object.hasOwn(row, "scenario")) {
      if (!DatapointSchema.safeParse(row).success)
        invalid("Invalid persona/scenario datapoint");
      records.push(row);
      continue;
    }
    if (!isObject(row.inputs))
      invalid("Expected persona/scenario data or legacy inputs");
    const inputs = row.inputs as Record<string, unknown>;
    const persona = parseJsonOrValue(inputs.persona);
    const scenario = parseJsonOrValue(inputs.scenario);
    for (const [field, value, legacy] of [
      ["persona", persona, ["persona_name"]],
      ["scenario", scenario, ["scenario_name", "goal"]],
    ] as const) {
      if (Object.hasOwn(inputs, field)) {
        if (!isObject(value)) invalid(`Invalid ${field} inputs`);
      } else if (!legacy.every((key) => typeof inputs[key] === "string")) {
        invalid(`Legacy inputs require ${legacy.join(", ")}`);
      }
    }
    const candidate = {
      id: `dp_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      persona: isObject(persona)
        ? persona
        : {
            name: inputs.persona_name,
            patience: 0.5,
            assertiveness: 0.5,
            politeness: 0.5,
            technical_level: 0.5,
            communication_style: "casual",
            background: inputs.context ?? "",
          },
      scenario: isObject(scenario)
        ? scenario
        : {
            name: inputs.scenario_name,
            goal: inputs.goal ?? "",
            context: inputs.context ?? "",
          },
      user_system_prompt: inputs.user_system_prompt ?? "",
      first_message: inputs.first_message ?? "",
    };
    if (!DatapointSchema.safeParse(candidate).success)
      invalid("Invalid persona/scenario datapoint");
    records.push(candidate);
  }
  if (!records.length)
    throw new BadParameter(`No datapoints loaded from ${path}`);
  return records;
}

const SIMULATE_FLAGS: readonly Flag[] = [
  ...SHARED_FLAGS,
  flag("datapoints", {
    toValue: loadDatapointRecords as never,
    replaces: INPUT_FIELDS,
  }),
  flag("dataset_id", { replaces: INPUT_FIELDS }),
  flag("experiment_id", { replaces: INPUT_FIELDS }),
  flag("experiment_run_id"),
  flag("from_run", { path: "previous_run", replaces: INPUT_FIELDS }),
];

const RUN_FLAGS: readonly Flag[] = [
  ...SHARED_FLAGS,
  flag("agent_description"),
  flag("num_personas"),
  flag("num_scenarios"),
  flag("persona_seed", { path: "persona_seeds" }),
  flag("scenario_seed", { path: "scenario_seeds" }),
  flag("generation_instructions"),
];

function envOf(io: SimRunIO): Record<string, string | undefined> {
  return io.env ?? process.env;
}

function providerLabel(env: Record<string, string | undefined>): string {
  if (env.ORQ_API_KEY) return "Orq router";
  if (env.OPENAI_API_KEY) return "OpenAI-compatible";
  return "unresolved provider";
}

function simModel(cfg: SimCliConfig): string {
  if (cfg.llm_config?.fieldsSet.has("model")) return cfg.llm_config.model;
  return roleModel("fast", { task: "sim.user" });
}

function requireOrqKey(flagName: string, io: SimRunIO): void {
  if (!envOf(io).ORQ_API_KEY)
    throw new BadParameter(
      `${flagName} requires ORQ_API_KEY to be set in the environment.`,
    );
}

export function validateInputSources(
  cfg: SimulateCliConfig,
  datapointsFromFlag: boolean,
  io: SimRunIO,
): void {
  const sources = (
    [
      [
        datapointsFromFlag ? "--input" : "inline datapoints in --config",
        cfg.datapoints !== null,
      ],
      ["--dataset-id", cfg.dataset_id !== null],
      ["--experiment-id", cfg.experiment_id !== null],
      ["--from-run", cfg.previous_run !== null],
      [
        "inline personas/scenarios in --config",
        cfg.personas !== null || cfg.scenarios !== null,
      ],
    ] as const
  )
    .filter(([, given]) => given)
    .map(([label]) => label);
  if (sources.length !== 1) {
    const got = sources.length ? ` (got: ${sources.join(", ")})` : "";
    throw new BadParameter(
      `Provide exactly one of --input, --dataset-id, --experiment-id, or --from-run${got}.`,
    );
  }
  if (cfg.experiment_run_id !== null && cfg.experiment_id === null)
    throw new BadParameter("--experiment-run-id requires --experiment-id.");
  if (cfg.dataset_id !== null) requireOrqKey("--dataset-id", io);
  if (cfg.experiment_id !== null) requireOrqKey("--experiment-id", io);
}

type ResolvedTarget = Pick<SimulateParams, "target" | "memoryEntityId">;

export function resolveSimTarget(
  options: {
    target: string | null;
    vercelUrl?: string;
    openaiModel?: string;
    memoryEntityId: string | null;
  },
  io: SimRunIO,
): ResolvedTarget {
  const active = (
    [
      ["--target", options.target],
      ["--vercel-url", options.vercelUrl],
      ["--openai-model", options.openaiModel],
    ] as const
  )
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name]) => name);
  if (!active.length)
    throw new BadParameter(
      "Provide exactly one of: --target, --vercel-url, --openai-model",
    );
  if (active.length > 1)
    throw new BadParameter(
      `Only one target flag allowed; got: ${active.join(", ")}`,
    );
  const memory = options.memoryEntityId;
  if (memory !== null && !memory.trim())
    throw new BadParameter("--memory-entity cannot be blank.");
  const memoryMessage =
    "--memory-entity requires --target agent:<key> (or a bare <key>).";
  if (memory !== null && options.target === null)
    throw new BadParameter(memoryMessage);
  if (options.target !== null) {
    const [kind, value] = parseTarget(options.target);
    if (kind === TargetKind.AGENT)
      return {
        target: `agent:${value}`,
        ...(memory !== null ? { memoryEntityId: memory } : {}),
      };
    if (memory !== null) throw new BadParameter(memoryMessage);
    requireOrqKey("--target deployment:<key>", io);
    return { target: `deployment:${value}` };
  }
  if (options.vercelUrl !== undefined)
    return { target: new VercelAISdkTarget(options.vercelUrl) };
  const env = envOf(io);
  if (!env.OPENAI_API_KEY && !env.ORQ_API_KEY)
    throw new BadParameter(
      "--openai-model requires OPENAI_API_KEY (or ORQ_API_KEY for the AI Router) to be set in the environment.",
    );
  return { target: new OpenAIModelTarget(options.openaiModel as string) };
}

export function resolveSimEvaluators(names: string[] | null): string[] | null {
  if (!names?.length) return null;
  for (const name of names) {
    try {
      getEvaluator(name);
    } catch {
      throw new BadParameter(
        `Unknown evaluator: '${name}'. Known: ${Object.keys(SIMULATION_EVALUATORS).join(", ")}`,
      );
    }
  }
  return [...names];
}

async function resolveAgentDescription(
  description: string | null,
  target: string | null,
  io: SimRunIO,
): Promise<string> {
  if (description) return description;
  const message =
    "This command requires --agent-description unless --target is an agent target";
  if (target === null) throw new Error(message);
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

function dropNulls<T>(value: object): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null),
  ) as T;
}

function sharedParams(
  cfg: SimCliConfig,
  resolved: ResolvedTarget,
  onRun: (run: SimulationRun) => void,
  args: SimSharedArgs,
  io: SimRunIO,
): SimulateParams {
  const params: SimulateParams = {
    ...resolved,
    save: cfg.save,
    executiveSummary: cfg.executive_summary,
    recommendations: cfg.recommendations,
    uploadResults: cfg.upload_results,
    targetAgentTimeoutMs: cfg.target_agent_timeout_ms,
    maxTargetRetries: cfg.max_target_retries,
    maxToolResultChars: cfg.max_tool_result_chars,
    onRun,
  };
  if (cfg.run_name !== null) params.runName = cfg.run_name;
  if (cfg.max_turns !== null) params.maxTurns = cfg.max_turns;
  if (cfg.llm_config !== null) params.llmConfig = cfg.llm_config;
  if (cfg.evaluator_names !== null) params.evaluatorNames = cfg.evaluator_names;
  if (cfg.scoring !== null) params.scoring = cfg.scoring;
  if (cfg.datapoint_parallelism !== null)
    params.datapointParallelism = cfg.datapoint_parallelism;
  if (cfg.llm_parallelism !== null) params.llmParallelism = cfg.llm_parallelism;
  if (cfg.target_reasoning_effort !== null)
    params.targetReasoningEffort = cfg.target_reasoning_effort;
  if (cfg.per_simulation_timeout_s !== null)
    params.perSimulationTimeoutMs = cfg.per_simulation_timeout_s * 1000;
  if (cfg.experiment_description !== null)
    params.experimentDescription = cfg.experiment_description;
  if (cfg.orq_folder_path !== null) params.orqFolderPath = cfg.orq_folder_path;
  if (cfg.raise_on_execution_failure !== null)
    params.raiseOnExecutionFailure = cfg.raise_on_execution_failure;
  if (!shouldSkipConfirm(args.yes, io))
    params.hooks = [
      {
        onConfirm: async (meta) => {
          if (!args.quiet)
            io.printError(
              `Run plan: ${meta.numDatapoints} datapoints | target=${meta.target} | model=${meta.model} | max_turns=${meta.maxTurns}`,
            );
          return confirmCliRun(args.yes, io);
        },
      },
    ];
  else if (args.quiet) params.hooks = [];
  return params;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function resolveReportTarget(
  target: string,
  ext: string,
  run: SimulationRun,
): string {
  let path = target;
  const isDir =
    (existsSync(path) && statSync(path).isDirectory()) ||
    extname(path) === "" ||
    path.endsWith("/") ||
    path.endsWith(sep);
  if (isDir) {
    const created = new Date(run.createdAt);
    const stamp = `${created.getUTCFullYear()}${pad(created.getUTCMonth() + 1)}${pad(created.getUTCDate())}-${pad(created.getUTCHours())}${pad(created.getUTCMinutes())}${pad(created.getUTCSeconds())}`;
    path = join(
      path,
      `sim-report-${sanitiseRunName(run.runName)}-${stamp}.${ext}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

async function exportReport(
  run: SimulationRun,
  target: string,
  format: "md" | "html",
  io: SimIO,
): Promise<void> {
  const content =
    format === "md"
      ? await exportSimulationMarkdown(
          run.results as never,
          {
            runDate: run.createdAt,
            executiveSummary: run.executiveSummary,
            recommendations: run.recommendations,
          } as never,
        )
      : await exportSimulationHtml(run);
  const path = resolveReportTarget(target, format, run);
  writeFileSync(path, content, "utf8");
  io.printError(`Report written to ${path}`);
}

function echoSaved(label: string, path: string, io: SimIO): void {
  io.printError(`✓ ${label} saved → ${path}`);
}

async function finishRun(
  run: SimulationRun,
  cfg: SimCliConfig,
  args: SimSharedArgs,
  io: SimIO,
): Promise<void> {
  const out = args.json ? io.printError : io.print;
  if (args.results_path) {
    exportResultsToJsonl(run.results as never, args.results_path);
    out(`Results written to ${args.results_path}`);
  }
  if (args.report_md !== undefined)
    await exportReport(run, args.report_md, "md", io);
  if (args.report_html !== undefined)
    await exportReport(run, args.report_html, "html", io);
  let reportPath = cfg.report_path;
  if (reportPath !== null) {
    reportPath = resolveReportTarget(reportPath, "json", run);
    await run.save(reportPath);
    echoSaved("Report", reportPath, io);
  }
  if (args.json)
    io.print(JSON.stringify(JSON.parse(run.toPythonJson()), null, 2));
  const runsDir = getSimulationRunsDir();
  if (cfg.save) {
    const manifest = run.runId ? await readManifest(runsDir, run.runId) : null;
    if (manifest?.reportPath) {
      echoSaved("Run", manifest.reportPath, io);
      echoNext(dashboardCommand(runsDir), "explore the results", null, io);
    } else
      io.printError(
        `Warning: Run ${run.runId} was not saved: no saved report in the run manifests under ${runsDir} (the cause is logged above).`,
      );
  } else if (reportPath === null)
    io.printError(
      "Tip: run without --no-save to browse results in the dashboard.",
    );
}

function abortCode(error: unknown, io: SimIO): number | null {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CancelledError")
  ) {
    io.printError("^C aborted.");
    return 130;
  }
  return null;
}

async function execute<T extends SimCliConfig>(
  args: SimSharedArgs,
  io: SimRunIO,
  body: (cfg: T) => Promise<SimulationRun | null>,
  resolve: () => T,
): Promise<number> {
  let cfg: T;
  try {
    cfg = resolve();
  } catch (error) {
    if (error instanceof BadParameter) throw error;
    io.printError(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  io.printError(
    `Using for generations: ${providerLabel(envOf(io))} · ${simModel(cfg)}`,
  );
  let run: SimulationRun | null;
  try {
    run = await body(cfg);
  } catch (error) {
    if (error instanceof BadParameter || process.env.EQ_DEBUG) throw error;
    const code = abortCode(error, io);
    if (code !== null) return code;
    io.printError(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (run === null) {
    io.printError("Error: the simulation finished without a run record.");
    return 1;
  }
  await finishRun(run, cfg, args, io);
  return 0;
}

export async function executeSimSimulate(
  args: SimSimulateArgs,
  io: SimRunIO,
): Promise<number> {
  return execute<SimulateCliConfig>(
    args,
    io,
    async (cfg) => {
      validateInputSources(cfg, args.datapoints !== undefined, io);
      const resolved = resolveSimTarget(
        {
          target: cfg.target,
          vercelUrl: args.vercel_url,
          openaiModel: args.openai_model,
          memoryEntityId: cfg.memory_entity_id,
        },
        io,
      );
      cfg.evaluator_names = resolveSimEvaluators(cfg.evaluator_names);
      let captured: SimulationRun | null = null;
      const params = sharedParams(
        cfg,
        resolved,
        (run) => {
          captured = run;
        },
        args,
        io,
      );
      if (cfg.datapoints !== null)
        params.datapoints = cfg.datapoints.map((datapoint) =>
          extractSingleDatapoint({ inputs: { datapoint } } as never),
        ) as Datapoint[];
      if (cfg.personas !== null)
        params.personas = cfg.personas.map((p) => dropNulls<Persona>(p));
      if (cfg.scenarios !== null)
        params.scenarios = cfg.scenarios.map((s) => dropNulls<Scenario>(s));
      if (cfg.dataset_id !== null) params.datasetId = cfg.dataset_id;
      if (cfg.experiment_id !== null) params.experimentId = cfg.experiment_id;
      if (cfg.experiment_run_id !== null)
        params.experimentRunId = cfg.experiment_run_id;
      if (cfg.previous_run !== null) params.previousRun = cfg.previous_run;
      const simulate =
        io.simulate ?? (await import("./simulation/index.js")).simulate;
      await simulate(params);
      return captured;
    },
    () =>
      resolveConfig(SIMULATE_CONFIG_MODEL, SIMULATE_FLAGS, args as never, {
        configSource: args.config,
        readStdin: io.readStdin,
      }),
  );
}

export async function executeSimRun(
  args: SimRunArgs,
  io: SimRunIO,
): Promise<number> {
  return execute<GenerateAndSimulateCliConfig>(
    args,
    io,
    async (cfg) => {
      const agentDescription = await resolveAgentDescription(
        cfg.agent_description,
        cfg.target,
        io,
      );
      const resolved = resolveSimTarget(
        {
          target: cfg.target,
          vercelUrl: args.vercel_url,
          openaiModel: args.openai_model,
          memoryEntityId: cfg.memory_entity_id,
        },
        io,
      );
      cfg.evaluator_names = resolveSimEvaluators(cfg.evaluator_names);
      let captured: SimulationRun | null = null;
      const params: GenerateAndSimulateParams = {
        ...sharedParams(
          cfg,
          resolved,
          (run) => {
            captured = run;
          },
          args,
          io,
        ),
        agentDescription,
        numPersonas: cfg.num_personas,
        numScenarios: cfg.num_scenarios,
        ...(cfg.persona_seeds?.length
          ? { personaSeeds: cfg.persona_seeds }
          : {}),
        ...(cfg.scenario_seeds?.length
          ? { scenarioSeeds: cfg.scenario_seeds }
          : {}),
        ...(cfg.generation_instructions
          ? { generationInstructions: cfg.generation_instructions }
          : {}),
        ...(cfg.edge_case_percentage !== null
          ? { edgeCasePercentage: cfg.edge_case_percentage }
          : {}),
        ...(args.datapoints_path !== undefined
          ? {
              emitDatapoints: (
                datapoints: import("./types.js").Datapoint[],
              ) => {
                writeDatapoints(datapoints, args.datapoints_path as string);
                io.printError(`Datapoints saved: ${args.datapoints_path}`);
              },
            }
          : {}),
      };
      const run =
        io.generateAndSimulate ??
        (await import("./simulation/index.js")).generateAndSimulate;
      await run(params);
      return captured;
    },
    () =>
      resolveConfig(
        GENERATE_AND_SIMULATE_CONFIG_MODEL,
        RUN_FLAGS,
        args as never,
        { configSource: args.config, readStdin: io.readStdin },
      ),
  );
}
