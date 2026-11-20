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

const SNAKE: Record<string, keyof RedteamRunArguments> = {
  category: "categories",
  vulnerability: "vulnerabilities",
  strategy: "strategies",
  deliveryMethod: "delivery_methods",
  config: "config",
  llmConfig: "llm_config_json",
  report: "report",
  parallelism: "datapoint_parallelism",
};

export function redteamRunArguments(
  options: Record<string, unknown>,
): RedteamRunArguments {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const name =
      SNAKE[key] ?? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    args[name] = value;
  }
  return args as RedteamRunArguments;
}

export function runRedteam(
  options: Record<string, unknown>,
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
