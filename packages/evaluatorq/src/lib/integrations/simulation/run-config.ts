import { z } from "zod/v4";

import type { ConfigModel } from "../../common/cli-config.js";
import { checkLlmParallelism } from "../../common/llm-limit.js";
import { snakeToCamel } from "../../common/python-json.js";
import { LLMCallConfig, type LLMCallConfigInput } from "../../contracts.js";
import {
  DatapointSchema,
  PersonaSchema,
  ScenarioSchema,
} from "./contract-schemas.js";
import {
  SimulationScoringConfig,
  type SimulationScoringConfigInput,
} from "./evaluators/scoring-config.js";
import {
  SimulationRecommendationConfig,
  type SimulationRecommendationConfigInput,
} from "./reports/recommendations.js";

export const DEFAULT_TARGET_AGENT_TIMEOUT_MS = 240_000;
export const DEFAULT_MAX_TARGET_RETRIES = 2;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 500;
export const DEFAULT_DATAPOINT_PARALLELISM = 10;

function camelKeys(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Input should be a valid dictionary");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [snakeToCamel(key), item]),
  );
}

function built<T>(factory: (raw: unknown) => T) {
  return z.unknown().transform((raw, ctx) => {
    try {
      return factory(raw);
    } catch (error) {
      const issues =
        error !== null &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray(error.issues)
          ? (error.issues as { path: PropertyKey[]; message: string }[])
          : [
              {
                path: [],
                message: error instanceof Error ? error.message : String(error),
              },
            ];
      for (const issue of issues)
        ctx.addIssue({
          code: "custom",
          path: issue.path.map(String),
          message: issue.message,
        });
      return z.NEVER;
    }
  });
}

const optionalString = z.string().nullable().default(null);
const positiveInt = z.number().int().min(1).nullable().default(null);

const shared = {
  run_name: optionalString,
  evaluation_name: z.string().default(""),
  target: optionalString,
  memory_entity_id: optionalString,
  max_turns: positiveInt,
  llm_config: built(
    (raw) => new LLMCallConfig(camelKeys(raw) as LLMCallConfigInput),
  )
    .nullable()
    .default(null),
  evaluator_names: z.array(z.string()).nullable().default(null),
  scoring: built(
    (raw) =>
      new SimulationScoringConfig(
        camelKeys(raw) as SimulationScoringConfigInput,
      ),
  )
    .nullable()
    .default(null),
  datapoint_parallelism: positiveInt,
  parallelism: positiveInt,
  llm_parallelism: z
    .number()
    .int()
    .nullable()
    .default(null)
    .superRefine((value, ctx) => {
      if (value === null) return;
      try {
        checkLlmParallelism(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  target_agent_timeout_ms: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_TARGET_AGENT_TIMEOUT_MS),
  max_target_retries: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_MAX_TARGET_RETRIES),
  target_reasoning_effort: optionalString,
  max_tool_result_chars: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_TOOL_RESULT_CHARS),
  per_simulation_timeout_s: z.number().positive().nullable().default(null),
  upload_results: z.boolean().default(true),
  experiment_description: optionalString,
  evaluation_description: optionalString,
  orq_folder_path: optionalString,
  orq_results_path: optionalString,
  raise_on_execution_failure: z.boolean().nullable().default(null),
  exit_on_failure: z.boolean().nullable().default(null),
  save: z.boolean().default(true),
  report_path: optionalString,
  report: optionalString,
  executive_summary: z.boolean().default(true),
  recommendations: z
    .union([
      z.boolean(),
      built(
        (raw) =>
          new SimulationRecommendationConfig(
            camelKeys(raw) as SimulationRecommendationConfigInput,
          ),
      ),
    ])
    .default(true),
};

export const SimulateCliConfigSchema = z
  .object({
    ...shared,
    personas: z.array(PersonaSchema).nullable().default(null),
    scenarios: z.array(ScenarioSchema).nullable().default(null),
    datapoints: z.array(DatapointSchema).nullable().default(null),
    dataset_id: optionalString,
    experiment_id: optionalString,
    experiment_run_id: optionalString,
    previous_run: optionalString,
  })
  .strict();

export const GenerateAndSimulateCliConfigSchema = z
  .object({
    ...shared,
    agent_description: optionalString,
    num_personas: z.number().int().min(1).default(5),
    num_scenarios: z.number().int().min(1).default(5),
    edge_case_percentage: z.number().nullable().default(null),
    persona_seeds: z.array(z.string()).nullable().default(null),
    scenario_seeds: z.array(z.string()).nullable().default(null),
    generation_instructions: z.string().default(""),
  })
  .strict();

export type SimulateCliConfig = z.infer<typeof SimulateCliConfigSchema>;
export type GenerateAndSimulateCliConfig = z.infer<
  typeof GenerateAndSimulateCliConfigSchema
>;
export type SimCliConfig = SimulateCliConfig | GenerateAndSimulateCliConfig;

function alias<T>(
  oldName: string,
  oldValue: T | null,
  newName: string,
  newValue: T | null,
): T | null {
  if (oldValue !== null && newValue !== null && oldValue !== newValue)
    throw new Error(
      `${oldName} and ${newName} must match when both are supplied`,
    );
  return newValue ?? oldValue;
}

type SharedConfig = z.infer<z.ZodObject<typeof shared>>;

function resolveAliases<T extends SharedConfig>(
  config: T,
  evaluationNameProvided: boolean,
): T {
  if (evaluationNameProvided) {
    if (config.run_name === null) config.run_name = config.evaluation_name;
    else if (
      config.evaluation_name &&
      config.evaluation_name !== config.run_name
    )
      throw new Error(
        "run_name and evaluation_name must match when both are supplied",
      );
  }
  config.experiment_description = alias(
    "evaluation_description",
    config.evaluation_description,
    "experiment_description",
    config.experiment_description,
  );
  config.orq_folder_path = alias(
    "orq_results_path",
    config.orq_results_path,
    "orq_folder_path",
    config.orq_folder_path,
  );
  config.raise_on_execution_failure = alias(
    "exit_on_failure",
    config.exit_on_failure,
    "raise_on_execution_failure",
    config.raise_on_execution_failure,
  );
  config.report_path = alias(
    "report",
    config.report,
    "report_path",
    config.report_path,
  );
  if (config.parallelism !== null && config.datapoint_parallelism === null)
    config.datapoint_parallelism = config.parallelism;
  return config;
}

export const SIMULATE_CONFIG_MODEL: ConfigModel<SimulateCliConfig> = {
  name: "SimulateCliConfig",
  build: (data) =>
    resolveAliases(
      SimulateCliConfigSchema.parse(data),
      Object.hasOwn(data, "evaluation_name"),
    ),
};

export const GENERATE_AND_SIMULATE_CONFIG_MODEL: ConfigModel<GenerateAndSimulateCliConfig> =
  {
    name: "GenerateAndSimulateCliConfig",
    build: (data) =>
      resolveAliases(
        GenerateAndSimulateCliConfigSchema.parse(data),
        Object.hasOwn(data, "evaluation_name"),
      ),
  };

export const LLM_CALL_CONFIG_MODEL: ConfigModel<Record<string, unknown>> = {
  name: "LLMCallConfig",
  build: (data) => {
    new LLMCallConfig(camelKeys(data) as LLMCallConfigInput);
    return data;
  },
};
