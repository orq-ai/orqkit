import type OpenAI from "openai";

import {
  type AgentContext,
  AgentContextSchema,
  DEFAULT_TARGET_TIMEOUT_MS,
  LLMCallConfig,
} from "../../contracts.js";
import { OrqResponsesTarget } from "../../integrations/openresponses/target.js";
import { Backend } from "./base.js";
import { mapProviderError } from "./errors.js";
export interface OpenResponsesBackendOptions {
  client?: OpenAI;
  instructions?: string | null;
  timeoutMs?: number | null;
  retryAttempts?: number;
  retryStatuses?: Iterable<number>;
  reasoningEffort?: string | null;
  requireOrq?: boolean;
}
export class OpenResponsesBackend extends Backend {
  constructor(readonly options: OpenResponsesBackendOptions = {}) {
    super("openresponses");
  }
  override createTarget(key: string): OrqResponsesTarget {
    return new OrqResponsesTarget(
      new LLMCallConfig({
        model: key,
        api: "responses",
        timeoutMs: this.options.timeoutMs || DEFAULT_TARGET_TIMEOUT_MS,
        reasoningEffort: this.options.reasoningEffort ?? null,
      }),
      {
        client: this.options.client,
        instructions: this.options.instructions,
        retryAttempts: this.options.retryAttempts ?? 1,
        retryStatuses: this.options.retryStatuses,
        requireOrq: this.options.requireOrq ?? true,
      },
    );
  }
  override async cleanupMemory(
    _context: AgentContext,
    _ids: string[],
  ): Promise<void> {}
  override mapError(error: unknown) {
    return mapProviderError("openresponses", error);
  }
  override async resolveContext(key: string): Promise<AgentContext> {
    const known = this.contextCache.get(key);
    if (known) return known;
    const context = AgentContextSchema.parse({
      key,
      displayName: key,
      description: "OpenResponses agent target",
      systemPrompt: this.options.instructions || "",
      model: key,
    });
    this.contextCache.set(key, context);
    return context;
  }
}
