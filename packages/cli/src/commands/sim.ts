import { BadParameter } from "@orq-ai/evaluatorq/redteam";
import {
  executeSimExport,
  executeSimFromTraces,
  executeSimGenerate,
  executeSimRun,
  executeSimRuns,
  executeSimSchema,
  executeSimSimulate,
  executeSimUploadDataset,
  executeSimValidate,
  executeSimValidateDataset,
  type SimIO,
} from "@orq-ai/evaluatorq/simulation";

const io: SimIO = {
  print: (line) => process.stdout.write(`${line}\n`),
  printError: (line) => process.stderr.write(`${line}\n`),
};

async function guarded(body: () => Promise<number> | number): Promise<void> {
  try {
    const code = await body();
    if (code) process.exitCode = code;
  } catch (error) {
    if (error instanceof BadParameter) {
      console.error(error.render());
      process.exitCode = 2;
      return;
    }
    if (process.env.EQ_DEBUG) throw error;
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "Set EQ_DEBUG=1 to see the full traceback; report at https://github.com/orq-ai/evaluatorq/issues",
    );
    process.exitCode = 1;
  }
}

export function runSimSchema(options: {
  output?: boolean;
  command?: "simulate" | "run";
}): Promise<void> {
  return guarded(() => executeSimSchema(options, io));
}

export function runSimValidate(
  path: string | undefined,
  options: { input?: string },
): Promise<void> {
  return guarded(() => executeSimValidate({ input: options.input, path }, io));
}

export function runSimValidateDataset(path: string): Promise<void> {
  return guarded(() => executeSimValidateDataset({ path }, io));
}

export function runSimRuns(
  directory: string | undefined,
  options: { limit?: number; json?: boolean },
): Promise<void> {
  return guarded(() => executeSimRuns({ directory, ...options }, io));
}

export interface SimCommandOptions {
  input?: string;
  datasetId?: string;
  experimentId?: string;
  experimentRunId?: string;
  fromRun?: string;
  target?: string;
  memoryEntity?: string;
  vercelUrl?: string;
  openaiModel?: string;
  results?: string;
  report?: string;
  reportMd?: string;
  reportHtml?: string;
  name?: string;
  simModel?: string;
  maxTurns?: number;
  datapointParallelism?: number;
  parallelism?: number;
  llmParallelism?: number;
  targetReasoningEffort?: string;
  evaluator?: string[];
  save?: boolean;
  recommendations?: boolean;
  executiveSummary?: boolean;
  config?: string;
  llmConfig?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: number;
  yes?: boolean;
  agentDescription?: string;
  numPersonas?: number;
  numScenarios?: number;
  personaSeed?: string[];
  scenarioSeed?: string[];
  generationInstructions?: string;
  datapoints?: string;
}

function sharedArgs(options: SimCommandOptions) {
  return {
    config: options.config,
    target: options.target,
    vercel_url: options.vercelUrl,
    openai_model: options.openaiModel,
    memory_entity: options.memoryEntity,
    results_path: options.results,
    report_path: options.report,
    report_md: options.reportMd,
    report_html: options.reportHtml,
    name: options.name,
    sim_model: options.simModel,
    max_turns: options.maxTurns,
    datapoint_parallelism: options.datapointParallelism ?? options.parallelism,
    llm_parallelism: options.llmParallelism,
    target_reasoning_effort: options.targetReasoningEffort,
    evaluator: options.evaluator,
    save: options.save,
    recommendations: options.recommendations,
    executive_summary: options.executiveSummary,
    llm_config_json: options.llmConfig,
    json: options.json,
    quiet: options.quiet,
    verbose: options.verbose,
    yes: options.yes,
  };
}

export function runSimSimulate(options: SimCommandOptions): Promise<void> {
  return guarded(() =>
    executeSimSimulate(
      {
        ...sharedArgs(options),
        datapoints: options.input,
        dataset_id: options.datasetId,
        experiment_id: options.experimentId,
        experiment_run_id: options.experimentRunId,
        from_run: options.fromRun,
      },
      io,
    ),
  );
}

export function runSimRun(options: SimCommandOptions): Promise<void> {
  return guarded(() =>
    executeSimRun(
      {
        ...sharedArgs(options),
        agent_description: options.agentDescription,
        num_personas: options.numPersonas,
        num_scenarios: options.numScenarios,
        persona_seed: options.personaSeed,
        scenario_seed: options.scenarioSeed,
        generation_instructions: options.generationInstructions,
        datapoints_path: options.datapoints,
      },
      io,
    ),
  );
}

export function runSimGenerate(options: {
  datapoints: string;
  agentDescription?: string;
  target?: string;
  simModel?: string;
  numPersonas?: number;
  numScenarios?: number;
  personaSeed?: string[];
  scenarioSeed?: string[];
  generationInstructions?: string;
  datasetFormat?: boolean;
  quiet?: boolean;
}): Promise<void> {
  return guarded(() =>
    executeSimGenerate(
      {
        datapoints_path: options.datapoints,
        agent_description: options.agentDescription,
        target: options.target,
        sim_model: options.simModel,
        num_personas: options.numPersonas,
        num_scenarios: options.numScenarios,
        persona_seed: options.personaSeed,
        scenario_seed: options.scenarioSeed,
        generation_instructions: options.generationInstructions,
        dataset_format: options.datasetFormat,
        quiet: options.quiet,
      },
      io,
    ),
  );
}

export function runSimFromTraces(options: {
  output: string;
  limit?: number;
  lookbackHours?: number;
  search?: string;
  extend?: number;
  agentDescription?: string;
  simModel?: string;
  replayFirstMessage?: boolean;
  redactPii?: boolean;
  maxSummaries?: number;
  llmParallelism?: number;
  quiet?: boolean;
}): Promise<void> {
  return guarded(() =>
    executeSimFromTraces(
      {
        output: options.output,
        limit: options.limit,
        lookback_hours: options.lookbackHours,
        search: options.search,
        extend: options.extend,
        agent_description: options.agentDescription,
        sim_model: options.simModel,
        replay_first_message: options.replayFirstMessage,
        redact_pii: options.redactPii,
        max_summaries: options.maxSummaries,
        llm_parallelism: options.llmParallelism,
        quiet: options.quiet,
      },
      io,
    ),
  );
}

export function runSimExport(options: {
  input: string;
  output: string;
  format?: string;
  recommendations?: boolean;
  simModel?: string;
  targetLabel?: string;
}): Promise<void> {
  return guarded(async () => {
    await executeSimExport(
      {
        input: options.input,
        output: options.output,
        format: options.format,
        recommendations: options.recommendations,
        sim_model: options.simModel,
        target_label: options.targetLabel,
      },
      io,
    );
    return 0;
  });
}

export function runSimUploadDataset(options: {
  input: string;
  name?: string;
  path?: string;
  datasetId?: string;
}): Promise<void> {
  return guarded(async () => {
    await executeSimUploadDataset(
      {
        input: options.input,
        name: options.name,
        path: options.path,
        dataset_id: options.datasetId,
      },
      io,
    );
    return 0;
  });
}
