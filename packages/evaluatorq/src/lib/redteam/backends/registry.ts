import type OpenAI from "openai";

import { pythonStrip } from "../../common/sanitize.js";
import { DEFAULT_TARGET_MAX_TOKENS } from "../../contracts.js";
import type { LLMConfig } from "../config.js";
import { BackendError } from "../exceptions.js";
import type { TargetConfig } from "../input.js";
import { type Backend, HybridAgentBackend } from "./base.js";
import { OpenAIBackend } from "./openai.js";
import { OpenResponsesBackend } from "./openresponses.js";
import { OrqBackend } from "./orq.js";
import { warnIgnoredTargetRetries } from "./retry.js";

export interface BackendResolutionOptions {
  llmClient?: OpenAI;
  targetConfig?: TargetConfig | null;
  pipelineConfig?: LLMConfig | null;
}
export type BackendFactory = (options: BackendResolutionOptions) => Backend;
const registry = new Map<string, BackendFactory>();
export function registerBackend(name: string, factory: BackendFactory): void {
  registry.set(pythonStrip(name).toLowerCase(), factory);
}
export function resolveBackend(
  name = "orq",
  options: BackendResolutionOptions = {},
): Backend {
  const factory = registry.get(pythonStrip(name).toLowerCase());
  if (!factory)
    throw new BackendError(
      `Unsupported backend: '${name}'. Available: ${JSON.stringify([...registry.keys()].sort())}`,
    );
  return factory(options);
}
export function createOpenAIBackend(
  options: BackendResolutionOptions & {
    retryCount?: number | null;
    retryOnCodes?: number[] | null;
  } = {},
): OpenAIBackend {
  const config = options.pipelineConfig;
  warnIgnoredTargetRetries("OpenAI", {
    retryCount: options.retryCount ?? config?.retryCount,
    retryOnCodes: options.retryOnCodes ?? config?.retryOnCodes,
  });
  return new OpenAIBackend({
    client: options.llmClient,
    systemPrompt: options.targetConfig?.systemPrompt,
    timeoutMs: config?.targetAgentTimeoutMs,
    maxTokens: DEFAULT_TARGET_MAX_TOKENS,
    reasoningEffort: config?.targetReasoningEffort,
  });
}
export function createOrqBackend(
  options: BackendResolutionOptions = {},
): OrqBackend {
  const config = options.pipelineConfig;
  return new OrqBackend({
    timeoutMs: config?.targetAgentTimeoutMs,
    retryCount: config?.retryCount,
    retryOnCodes: config?.retryOnCodes,
    maxToolContinuations: config?.maxToolContinuations,
  });
}
export function createOpenResponsesBackend(
  options: BackendResolutionOptions = {},
): OpenResponsesBackend {
  const config = options.pipelineConfig;
  if (config) warnIgnoredTargetRetries("OpenResponses", config);
  return new OpenResponsesBackend({
    client: options.llmClient,
    instructions: options.targetConfig?.systemPrompt,
    timeoutMs: config?.targetAgentTimeoutMs,
    reasoningEffort: config?.targetReasoningEffort,
  });
}
export function makeAgentBackend(
  options: Pick<
    BackendResolutionOptions,
    "targetConfig" | "pipelineConfig"
  > = {},
): HybridAgentBackend {
  return new HybridAgentBackend({
    execBackend: resolveBackend("openresponses", options),
    contextBackendFactory: () => resolveBackend("orq", options),
  });
}
registerBackend("openai", createOpenAIBackend);
registerBackend("orq", createOrqBackend);
registerBackend("openresponses", createOpenResponsesBackend);
