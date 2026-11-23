import {
  applyModelFlags,
  BadParameter,
  executeRedteamRun,
  executeRedteamRuns,
  executeRedteamSchema,
  executeRedteamValidateDataset,
  type RedteamIO,
  type RedteamRunArguments,
} from "@orq-ai/evaluatorq/redteam";

export interface RootModelOptions {
  fastModel?: string;
  smartModel?: string;
  classifierModel?: string;
  embeddingModel?: string;
  modelOverride?: string[];
}

const io: RedteamIO = {
  print: (line) => process.stdout.write(`${line}\n`),
  printError: (line) => process.stderr.write(`${line}\n`),
};

export function applyRootModelFlags(options: RootModelOptions): void {
  try {
    applyModelFlags(
      {
        fast: options.fastModel,
        smart: options.smartModel,
        classifier: options.classifierModel,
        embedding: options.embeddingModel,
        overrides: options.modelOverride,
      },
      { replace: true },
    );
  } catch (error) {
    if (!(error instanceof BadParameter)) throw error;
    console.error(error.render());
    process.exit(2);
  }
}

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
      "Set EQ_DEBUG=1 to see the full traceback; report at https://github.com/orq-ai/orqkit/issues",
    );
    process.exitCode = 1;
  }
}

export interface RedteamCommandOptions {
  target?: string[];
  name?: string;
  mode?: string;
  category?: string[];
  vulnerability?: string[];
  strategy?: string[];
  deliveryMethod?: string[];
  maxTurns?: number;
  maxPerCategory?: number;
  attackModel?: string;
  attackerInstructions?: string;
  evaluatorModel?: string;
  minEvaluationCoverage?: number;
  targetTimeoutMs?: number;
  maxTargetRetries?: number;
  maxBacktracks?: number;
  retryCount?: number;
  maxToolContinuations?: number;
  targetReasoningEffort?: string;
  datapointParallelism?: number;
  parallelism?: number;
  llmParallelism?: number;
  generatedStrategyCount?: number;
  generateStrategies?: boolean;
  maxDynamicDatapoints?: number;
  maxStaticDatapoints?: number;
  cleanupMemory?: boolean;
  dataset?: string;
  fromRun?: string;
  artifactsDir?: string;
  save?: string;
  yes?: boolean;
  verbose?: number;
  quiet?: boolean;
  report?: string;
  reportMd?: string;
  reportHtml?: string;
  executiveSummary?: boolean;
  recommendations?: boolean;
  systemPrompt?: string;
  config?: string;
  llmConfig?: string;
  json?: boolean;
}

export function redteamRunArguments(
  options: RedteamCommandOptions,
): RedteamRunArguments {
  return {
    target: options.target,
    name: options.name,
    mode: options.mode,
    categories: options.category,
    vulnerabilities: options.vulnerability,
    strategies: options.strategy,
    delivery_methods: options.deliveryMethod,
    max_turns: options.maxTurns,
    max_per_category: options.maxPerCategory,
    attack_model: options.attackModel,
    attacker_instructions: options.attackerInstructions,
    evaluator_model: options.evaluatorModel,
    min_evaluation_coverage: options.minEvaluationCoverage,
    target_timeout_ms: options.targetTimeoutMs,
    max_target_retries: options.maxTargetRetries,
    max_backtracks: options.maxBacktracks,
    retry_count: options.retryCount,
    max_tool_continuations: options.maxToolContinuations,
    target_reasoning_effort: options.targetReasoningEffort,
    datapoint_parallelism: options.datapointParallelism ?? options.parallelism,
    llm_parallelism: options.llmParallelism,
    generated_strategy_count: options.generatedStrategyCount,
    generate_strategies: options.generateStrategies,
    max_dynamic_datapoints: options.maxDynamicDatapoints,
    max_static_datapoints: options.maxStaticDatapoints,
    cleanup_memory: options.cleanupMemory,
    dataset: options.dataset,
    from_run: options.fromRun,
    artifacts_dir: options.artifactsDir,
    save: options.save,
    yes: options.yes,
    verbose: options.verbose,
    quiet: options.quiet,
    report: options.report,
    report_md: options.reportMd,
    report_html: options.reportHtml,
    executive_summary: options.executiveSummary,
    recommendations: options.recommendations,
    system_prompt: options.systemPrompt,
    config: options.config,
    llm_config_json: options.llmConfig,
    json: options.json,
  };
}

export function runRedteam(
  options: RedteamCommandOptions,
  command?: { outputHelp: () => void },
): Promise<void> {
  if (command && Object.values(options).every((value) => value === undefined)) {
    command.outputHelp();
    process.exitCode = 2;
    return Promise.resolve();
  }
  return guarded(() => executeRedteamRun(redteamRunArguments(options), io));
}

export function runRedteamSchema(options: { output?: boolean }): Promise<void> {
  return guarded(() => executeRedteamSchema(options, io));
}

export function runRedteamValidateDataset(
  dataset: string | undefined,
): Promise<void> {
  return guarded(() => executeRedteamValidateDataset({ dataset }, io));
}

export function runRedteamRuns(
  path: string | undefined,
  options: { limit?: number; json?: boolean },
): Promise<void> {
  return guarded(() => executeRedteamRuns({ path, ...options }, io));
}
