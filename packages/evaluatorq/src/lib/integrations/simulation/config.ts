import { roleModel, TASKS } from "../../common/model-roles.js";
import { LLMCallConfig, type LLMCallConfigInput } from "../../contracts.js";

export function explicitConfig(config: LLMCallConfig): LLMCallConfigInput {
  return Object.fromEntries(
    [...config.fieldsSet].map((key) => [
      key,
      config[key as keyof LLMCallConfig],
    ]),
  ) as LLMCallConfigInput;
}

export function resolveSimLlmConfig(
  options: {
    model?: string;
    llmConfig?: LLMCallConfig;
    client?: unknown;
  },
  caller: string,
): LLMCallConfig {
  const config = options.llmConfig ?? new LLMCallConfig();
  const input = explicitConfig(config);
  if (options.model !== undefined) {
    if (!config.fieldsSet.has("model")) input.model = options.model;
    else if (config.model !== options.model)
      console.warn(
        `${caller}(): model contradicts llmConfig.model; using llmConfig.model.`,
      );
  }
  if (options.client !== undefined) input.client = options.client;
  return new LLMCallConfig(input);
}

export function simRoleConfig(
  config: LLMCallConfig | undefined,
  task: string,
): LLMCallConfig {
  const role = TASKS[task];
  if (!role) throw new Error(`unknown task '${task}'`);
  const resolved = config ?? new LLMCallConfig();
  if (resolved.fieldsSet.has("model")) return resolved;
  return new LLMCallConfig({
    ...explicitConfig(resolved),
    model: roleModel(role, { task }),
  });
}
