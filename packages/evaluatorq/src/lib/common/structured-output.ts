import type { Span } from "@opentelemetry/api";
import type OpenAI from "openai";
import type { z } from "zod/v4";

import {
  addUsage,
  checkReservedKeys,
  costIsPartial,
  extractUsage,
  type LLMCallConfig,
  type LlmApi,
  RESERVED_COMPLETION_KEYS,
  RESERVED_RESPONSES_KEYS,
  type Usage,
  UsageSchema,
} from "../contracts.js";
import { toStrictSchema } from "../integrations/simulation/utils/strict-schema.js";
import { extractJsonFromResponse } from "./extract-json.js";
import { getField } from "./fields.js";
import {
  type ChatCompletionLike,
  type ChatMessageLike,
  type ChatParseOptions,
  errorBodyText,
  executeChatCompletion,
  executeChatParse,
  executeResponse,
  LengthFinishReasonError,
  type NamedSchema,
} from "./llm-call.js";
import { priceUsage } from "./model-catalogue.js";
import {
  firstResponsesRefusal,
  parseResponsesResponse,
  responsesOutputText,
  responsesStopReason,
} from "./responses.js";
import { withoutClientRetries, withRetry } from "./retry.js";
import { withLlmSpan } from "./tracing.js";

const LEG_PARSE = "parse";
const LEG_JSON_SCHEMA = "json_schema";
const LEG_TOOL = "tools";
const LEG_JSON_OBJECT = "json_object";

/**
 * `parsed` is null when no rung validated, and `raw` is then the last non-empty
 * text seen. `usage` sums every rung that reached the provider; null means none did.
 */
export interface StructuredResult<T> {
  parsed: T | null;
  raw: string;
  usage: Usage | null;
}

export class StructuredGenerationError extends Error {
  override readonly name = "StructuredGenerationError";
  usage: Usage | null;

  constructor(
    message: string,
    options: { usage?: Usage | null; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.usage = options.usage ?? null;
  }
}

function isUsage(value: unknown): value is Usage {
  return UsageSchema.safeParse(value).success;
}

/** Spend the ladder billed before it raised, or null if it billed nothing. */
export function usageFromException(error: unknown): Usage | null {
  const usage = getField(error, "usage");
  return isUsage(usage) ? usage : null;
}

function attachUsage(error: unknown, usage: Usage | null): void {
  if (usage !== null && typeof error === "object" && error !== null) {
    (error as { usage?: Usage }).usage = usage;
  }
}

export function sumStructuredUsage(
  usages: ReadonlyArray<Usage | null | undefined>,
): Usage | null {
  const known = usages.filter((usage): usage is Usage => !!usage);
  if (known.length === 0) {
    return null;
  }
  return known
    .slice(1)
    .reduce((total, usage) => addUsage(total, usage), known[0] as Usage);
}

export function logStructuredUsage(
  usage: Usage | null,
  options: { phase: string },
): void {
  if (usage === null) {
    console.error(`${options.phase}: no usage reported by the provider`);
    return;
  }
  let cost =
    usage.totalCost !== null
      ? `$${usage.totalCost.toFixed(4)}`
      : "cost unknown";
  if (costIsPartial(usage)) {
    cost += ` (priced for ${usage.pricedCalls} of ${usage.calls} calls)`;
  }
  console.error(
    `${options.phase}: ${usage.totalTokens} tokens over ${usage.calls} LLM call(s), ${cost}`,
  );
}

/** An unreadable usage block counts as one unpriced call, never as $0. */
function rungUsage(
  usage: Usage | null,
  response: unknown,
  label: string,
  leg: string,
): Usage {
  if (usage !== null) {
    return usage;
  }
  console.warn(
    `${label}: the ${leg} rung returned no readable usage block (${JSON.stringify(getField(response, "usage") ?? null)}); counting it as one unpriced call rather than as zero cost`,
  );
  return UsageSchema.parse({ calls: 1 });
}

async function truncationUsage(
  error: LengthFinishReasonError,
  call: ChatLadderCall,
  leg: string,
): Promise<Usage> {
  const { completion } = error;
  const usage = await priceUsage(
    extractUsage(completion.usage ?? null, 1),
    call.model,
    call.client,
    { servedModel: completion.model ?? null },
  );
  return rungUsage(usage, completion, call.label, leg);
}

const CHAT_STRUCTURAL_KEYS = [
  ...RESERVED_COMPLETION_KEYS,
  "max_completion_tokens",
];
const STRUCTURAL_KEYS: Record<LlmApi, ReadonlySet<string>> = {
  chat_completions: new Set(CHAT_STRUCTURAL_KEYS),
  // A responses call can fall through to chat, so a key must be safe on both.
  responses: new Set([
    ...CHAT_STRUCTURAL_KEYS,
    ...RESERVED_RESPONSES_KEYS,
    "text_format",
    "max_output_tokens",
  ]),
};

const SCHEMA_KEYWORDS = [
  "response_format",
  "json_schema",
  "text_format",
  "text.format",
  "structured output",
];
const TOOL_KEYWORDS = [
  "tool_choice",
  "tools",
  "function call",
  "function_call",
];

function statusOf(error: unknown): unknown {
  return getField(error, "status");
}

function looksLikeRejection(
  error: unknown,
  keywords: readonly string[],
): boolean {
  const body = errorBodyText(error);
  return keywords.some((keyword) => body.includes(keyword));
}

function rejectionMessage(error: unknown): string {
  // Provider bodies can echo prompts, so only fixed clues reach the logs.
  const body = errorBodyText(error);
  if (body.includes("oneof")) {
    return "schema uses oneOf, which the provider rejected";
  }
  for (const keyword of [...SCHEMA_KEYWORDS, ...TOOL_KEYWORDS]) {
    if (body.includes(keyword)) {
      return `provider rejected ${keyword}`;
    }
  }
  return "provider rejected the requested capability";
}

const STRUCTURED_TIMEOUT_MS = 300_000;

const CONSUMED_CONFIG_FIELDS = [
  "temperature",
  "extraKwargs",
  "extraBody",
  "reasoningEffort",
  "timeoutMs",
];
const CALL_SITE_ARGUMENTS = new Set(["model", "client"]);
const warnedUnread = new Set<string>();

export function resetStructuredWarnings(): void {
  warnedUnread.clear();
}

export function warnUnreadConfigFields(
  config: LLMCallConfig | null | undefined,
  read: Iterable<string>,
  options: { caller: string },
): void {
  if (!config) {
    return;
  }
  const readSet = new Set(read);
  const ignored = [...config.fieldsSet]
    .filter((name) => !readSet.has(name) && !CALL_SITE_ARGUMENTS.has(name))
    .sort();
  if (ignored.length === 0) {
    return;
  }
  const key = JSON.stringify([options.caller, ignored]);
  if (warnedUnread.has(key)) {
    return;
  }
  warnedUnread.add(key);
  console.warn(
    `${options.caller} ignores llmConfig ${ignored.join(", ")}; this call site owns those. It reads ${[...readSet].sort().join(", ") || "no field on this config"}.`,
  );
}

export function warnConfigRedirect(
  config: LLMCallConfig | null | undefined,
  options: { resolvedModel: string; caller: string },
): void {
  const { resolvedModel, caller } = options;
  if (!config?.fieldsSet.has("model") || config.model === resolvedModel) {
    return;
  }
  const key = JSON.stringify([caller, "model", resolvedModel, config.model]);
  if (warnedUnread.has(key)) {
    return;
  }
  warnedUnread.add(key);
  console.warn(
    `${caller} runs on model='${resolvedModel}'; llmConfig.model='${config.model}' does not redirect this call.`,
  );
}

export function tokenBudgetForItems(
  count: number,
  options: { perItem: number; minimum: number },
): number {
  return Math.max(options.minimum, options.perItem * count);
}

function truncatedOutputError(
  label: string,
  maxTokens: number,
  usage: Usage | null,
  cause?: unknown,
): StructuredGenerationError {
  console.error(
    `${label}: output truncated at the token limit (max_tokens=${maxTokens})`,
  );
  return new StructuredGenerationError(
    `${label}: the model hit the token limit (max_tokens=${maxTokens}) and the structured output is unusable. Raise the maxTokens budget passed to this call and retry.`,
    { usage, cause },
  );
}

type Extras = Readonly<Record<string, unknown>> | null | undefined;

interface ChatLadderCall {
  client: OpenAI;
  model: string;
  messages: readonly unknown[];
  maxTokens: number;
  label: string;
  span: Span | undefined;
  temperature: number | null | undefined;
  reasoningEffort: string | null | undefined;
  timeoutMs: number;
  extraBody: Extras;
  extraKwargs: Extras;
}

type EmptyResult = StructuredResult<never>;

function emptyResult(usage: Usage | null = null): EmptyResult {
  return { parsed: null, raw: "", usage };
}

function executorOptions(call: ChatLadderCall) {
  return {
    client: call.client,
    model: call.model,
    messages: call.messages,
    span: call.span,
    timeoutMs: call.timeoutMs,
    temperature: call.temperature,
    // max_tokens is rejected outright by the o-series and gpt-5 families.
    maxCompletionTokens: call.maxTokens,
    reasoningEffort: call.reasoningEffort,
    extraBody: call.extraBody,
    extraKwargs: call.extraKwargs,
  };
}

function markLeg(span: Span | undefined, leg: string): void {
  span?.setAttribute("orq.structured_output.leg", leg);
  span?.setAttribute("orq.structured_output.fallback", leg !== LEG_PARSE);
}

function validateContent<S extends z.ZodObject>(
  content: string,
  format: NamedSchema<S>,
  label: string,
  leg: string,
): z.infer<S> | null {
  if (!content) {
    console.warn(
      `${label}: the ${leg} rung returned empty content, continuing the ladder`,
    );
    return null;
  }
  try {
    return format.schema.parse(
      JSON.parse(extractJsonFromResponse(content)),
    ) as z.infer<S>;
  } catch (error) {
    console.warn(
      `${label}: ${leg} output did not validate against ${format.name} (${error})`,
    );
    return null;
  }
}

async function generateViaResponses<S extends z.ZodObject>(
  client: OpenAI,
  options: {
    model: string;
    messages: readonly unknown[];
    format: NamedSchema<S>;
    maxTokens: number;
    label: string;
    temperature: number | null | undefined;
    extraKwargs: Extras;
    reasoningEffort: string | null | undefined;
    timeoutMs: number;
    extraBody: Extras;
  },
): Promise<StructuredResult<z.infer<S>>> {
  const { model, messages, format, maxTokens, label, temperature } = options;
  return withLlmSpan(
    {
      model,
      operation: "responses",
      temperature,
      maxTokens,
      inputMessages: messages,
      attributes: { "orq.llm.purpose": label },
    },
    async (span) => {
      let outcome: Awaited<ReturnType<typeof executeResponse>>;
      try {
        outcome = await withRetry(
          () =>
            executeResponse({
              client,
              model,
              messages,
              span,
              timeoutMs: options.timeoutMs,
              responseTextFormat: format,
              temperature,
              maxOutputTokens: maxTokens,
              reasoningEffort: options.reasoningEffort,
              extraBody: options.extraBody,
              extraKwargs: options.extraKwargs,
            }),
          { label },
        );
      } catch (error) {
        let cause: string;
        if (statusOf(error) === 404) {
          cause = "no Responses endpoint (HTTP 404)";
        } else if (
          statusOf(error) === 400 &&
          looksLikeRejection(error, SCHEMA_KEYWORDS)
        ) {
          cause = `Responses structured output rejected (HTTP 400: ${rejectionMessage(error)})`;
        } else {
          throw error;
        }
        console.warn(`${label}: ${cause}, falling back to chat.completions`);
        return emptyResult();
      }
      const { response } = outcome;
      const usage = rungUsage(outcome.usage, response, label, "Responses");
      if (responsesStopReason(response) === "length") {
        throw truncatedOutputError(label, maxTokens, usage);
      }
      const refusal = firstResponsesRefusal(response);
      if (refusal !== null) {
        throw new StructuredGenerationError(
          `${label}: model refused to generate: ${refusal}`,
          { usage },
        );
      }
      if (!responsesOutputText(response)) {
        console.warn(
          `${label}: Responses returned no output, falling back to chat.completions`,
        );
        return emptyResult(usage);
      }
      let parsed: z.infer<S> | null;
      try {
        parsed = parseResponsesResponse(response, format.schema)
          .outputParsed as z.infer<S> | null;
      } catch (error) {
        console.error(
          `${label}: Responses output did not validate against ${format.name}`,
          error,
        );
        throw new StructuredGenerationError(
          `${label}: the Responses output did not validate against ${format.name}.`,
          { usage, cause: error },
        );
      }
      if (parsed === null) {
        console.warn(
          `${label}: Responses returned no parsed output, falling back to chat.completions`,
        );
        return emptyResult(usage);
      }
      return { parsed, raw: "", usage };
    },
  );
}

async function parseRung(
  call: ChatLadderCall,
  options: {
    leg: string;
    retryLabel: string;
    rejectionKeywords: readonly string[];
    rejected: string;
    noChoices: string;
    rung: Partial<ChatParseOptions>;
  },
): Promise<{ message: ChatMessageLike | null; usage: Usage | null }> {
  const { label } = call;
  const { leg, rung } = options;
  let result: Awaited<ReturnType<typeof executeChatParse>>;
  try {
    result = await withRetry(
      () => executeChatParse({ ...executorOptions(call), ...rung }),
      { label: options.retryLabel },
    );
  } catch (error) {
    if (error instanceof LengthFinishReasonError) {
      throw truncatedOutputError(
        label,
        call.maxTokens,
        await truncationUsage(error, call, leg),
        error,
      );
    }
    if (
      statusOf(error) === 400 &&
      looksLikeRejection(error, options.rejectionKeywords)
    ) {
      console.warn(
        `${label}: ${options.rejected} (provider said: ${rejectionMessage(error)})`,
      );
      return { message: null, usage: null };
    }
    throw error;
  }
  const usage = rungUsage(result.usage, result.response, label, leg);
  const message = result.response.choices[0]?.message;
  if (!message) {
    console.warn(`${label}: ${options.noChoices}`);
    return { message: null, usage };
  }
  if (message.refusal) {
    throw new StructuredGenerationError(
      `${label}: model refused to generate: ${message.refusal}`,
      { usage },
    );
  }
  return { message, usage };
}

function contentResult<S extends z.ZodObject>(
  response: ChatCompletionLike,
  rawUsage: Usage | null,
  call: ChatLadderCall,
  format: NamedSchema<S>,
  leg: string,
): StructuredResult<z.infer<S>> {
  const usage = rungUsage(rawUsage, response, call.label, leg);
  const choice = response.choices?.[0];
  if (!choice) {
    console.warn(
      `${call.label}: the ${leg} rung returned no choices, continuing the ladder`,
    );
    return emptyResult(usage);
  }
  // Only the parse rungs throw on truncation; here a cut-off body looks like content.
  if (choice.finish_reason === "length") {
    throw truncatedOutputError(call.label, call.maxTokens, usage);
  }
  const content = choice.message.content ?? "";
  const parsed = validateContent(content, format, call.label, leg);
  if (parsed !== null) {
    markLeg(call.span, leg);
  }
  return { parsed, raw: content, usage };
}

async function legStrictParse<S extends z.ZodObject>(
  call: ChatLadderCall,
  format: NamedSchema<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const { message, usage } = await parseRung(call, {
    leg: LEG_PARSE,
    retryLabel: call.label,
    rejectionKeywords: SCHEMA_KEYWORDS,
    rejected:
      "structured output not supported by model, trying the non-strict schema",
    noChoices: "parse() returned no choices, trying the non-strict schema",
    rung: { responseModel: format },
  });
  if (!message) {
    return emptyResult(usage);
  }
  const { parsed } = message;
  if (parsed === null || parsed === undefined) {
    console.error(
      `${call.label}: parse() returned nothing, trying the non-strict schema`,
    );
    return emptyResult(usage);
  }
  markLeg(call.span, LEG_PARSE);
  return { parsed: parsed as z.infer<S>, raw: "", usage };
}

async function legJsonSchema<S extends z.ZodObject>(
  call: ChatLadderCall,
  format: NamedSchema<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const { label } = call;
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: format.name,
      strict: false,
      schema: toStrictSchema(format.schema),
    },
  };
  let result: Awaited<ReturnType<typeof executeChatCompletion>>;
  try {
    result = await withRetry(
      () => executeChatCompletion({ ...executorOptions(call), responseFormat }),
      { label: `${label} (json_schema fallback)` },
    );
  } catch (error) {
    if (
      statusOf(error) !== 400 ||
      !looksLikeRejection(error, SCHEMA_KEYWORDS)
    ) {
      throw error;
    }
    console.warn(
      `${label}: json_schema not accepted, trying a forced tool call`,
    );
    return emptyResult();
  }
  return contentResult(
    result.response,
    result.usage,
    call,
    format,
    LEG_JSON_SCHEMA,
  );
}

/**
 * The only rung that edits the prompt: one appended user turn, which rescues
 * providers that accept `tools` but downgrade a named `tool_choice` to auto.
 */
async function legForcedTool<S extends z.ZodObject>(
  call: ChatLadderCall,
  format: NamedSchema<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const { label, extraKwargs } = call;
  if (extraKwargs && ("tools" in extraKwargs || "tool_choice" in extraKwargs)) {
    console.error(
      `${label}: caller supplied tools, skipping the forced tool call leg`,
    );
    return emptyResult();
  }
  const { description } = format.schema;
  const tool = {
    type: "function",
    function: {
      name: format.name,
      strict: true,
      parameters: toStrictSchema(format.schema),
      ...(description ? { description } : {}),
    },
  };
  const nudge = `Respond by calling the \`${format.name}\` tool with the requested fields. Do not reply with text.`;
  // A dedicated attribute, because a later rung overwrites gen_ai.input.messages.
  call.span?.setAttribute("orq.structured_output.tool_nudge", nudge);
  const { message, usage } = await parseRung(call, {
    leg: LEG_TOOL,
    retryLabel: `${label} (forced tool call)`,
    rejectionKeywords: [...SCHEMA_KEYWORDS, ...TOOL_KEYWORDS],
    rejected: "forced tool call not accepted, falling back to json_object",
    noChoices:
      "forced tool call returned no choices, falling back to json_object",
    rung: {
      messages: [...call.messages, { role: "user", content: nudge }],
      tools: [tool],
      toolChoice: { type: "function", function: { name: format.name } },
    },
  });
  if (!message) {
    return emptyResult(usage);
  }
  const fn = message.tool_calls?.[0]?.function;
  if (!fn) {
    console.warn(
      `${label}: forced tool call returned no tool_calls, falling back to json_object`,
    );
    return emptyResult(usage);
  }
  const raw = fn.arguments ?? "";
  const parsed = validateContent(raw, format, label, LEG_TOOL);
  if (parsed === null) {
    return { parsed: null, raw, usage };
  }
  markLeg(call.span, LEG_TOOL);
  return { parsed, raw, usage };
}

async function legJsonObject<S extends z.ZodObject>(
  call: ChatLadderCall,
  format: NamedSchema<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const result = await withRetry(
    () =>
      executeChatCompletion({
        ...executorOptions(call),
        responseFormat: { type: "json_object" },
      }),
    { label: `${call.label} (json_object fallback)` },
  );
  return contentResult(
    result.response,
    result.usage,
    call,
    format,
    LEG_JSON_OBJECT,
  );
}

export interface GenerateStructuredOptions<S extends z.ZodObject> {
  model: string;
  messages: readonly unknown[];
  responseFormat: NamedSchema<S>;
  maxTokens: number;
  label: string;
  temperature?: number | null;
  extraKwargs?: Extras;
  api?: LlmApi;
  reasoningEffort?: string | null;
  timeoutMs?: number;
  extraBody?: Extras;
  config?: LLMCallConfig | null;
}

interface CallSettings {
  temperature: number | null | undefined;
  extraKwargs: Extras;
  extraBody: Extras;
  reasoningEffort: string | null | undefined;
  timeoutMs: number;
}

/** An explicit option beats `config`, and null counts as explicit (omit the param). */
function foldConfig<S extends z.ZodObject>(
  options: GenerateStructuredOptions<S>,
): CallSettings {
  const { config, model, label } = options;
  const fromConfig = config
    ? config.setValues(
        "temperature",
        "extraKwargs",
        "extraBody",
        "reasoningEffort",
      )
    : {};
  const beaten = new Set(
    CONSUMED_CONFIG_FIELDS.filter(
      (name) => options[name as keyof typeof options] !== undefined,
    ),
  );
  const caller = `generateStructured(${label})`;
  warnConfigRedirect(config, { resolvedModel: model, caller });
  warnUnreadConfigFields(
    config,
    CONSUMED_CONFIG_FIELDS.filter((name) => !beaten.has(name)),
    { caller },
  );
  return {
    temperature:
      options.temperature === undefined
        ? fromConfig.temperature
        : options.temperature,
    extraKwargs:
      options.extraKwargs === undefined
        ? fromConfig.extraKwargs
        : options.extraKwargs,
    extraBody:
      options.extraBody === undefined
        ? fromConfig.extraBody
        : options.extraBody,
    reasoningEffort:
      options.reasoningEffort === undefined
        ? fromConfig.reasoningEffort
        : options.reasoningEffort,
    timeoutMs:
      options.timeoutMs ??
      config?.resolveTimeoutMs(STRUCTURED_TIMEOUT_MS) ??
      STRUCTURED_TIMEOUT_MS,
  };
}

/**
 * Generates structured output, degrading through strict parse, non-strict
 * json_schema, a forced tool call, and json_object. `api: "responses"` puts a
 * Responses call in front and falls through to the chat rungs. `usage` is the
 * sum over every rung that billed, and every thrown error carries that total.
 * `timeoutMs` bounds one request, not the whole call.
 */
export async function generateStructured<S extends z.ZodObject>(
  client: OpenAI,
  options: GenerateStructuredOptions<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const { model, messages, responseFormat: format, maxTokens, label } = options;
  const api = options.api ?? "chat_completions";
  const settings = foldConfig(options);
  const { temperature, extraKwargs, extraBody, reasoningEffort, timeoutMs } =
    settings;
  const unretried = withoutClientRetries(client);
  checkReservedKeys(extraKwargs ?? {}, STRUCTURAL_KEYS[api]);
  const usages: Array<Usage | null> = [];
  try {
    if (api === "responses") {
      const viaResponses = await generateViaResponses(unretried, {
        model,
        messages,
        format,
        maxTokens,
        label,
        temperature,
        extraKwargs,
        reasoningEffort,
        timeoutMs,
        extraBody,
      });
      usages.push(viaResponses.usage);
      if (viaResponses.parsed !== null) {
        return viaResponses;
      }
    }
    return await withLlmSpan(
      {
        model,
        operation: "chat",
        temperature,
        maxTokens,
        inputMessages: messages,
        attributes: { "orq.llm.purpose": label },
      },
      async (span) => {
        const call: ChatLadderCall = {
          client: unretried,
          model,
          messages,
          maxTokens,
          label,
          span,
          temperature,
          reasoningEffort,
          timeoutMs,
          extraBody,
          extraKwargs,
        };
        let lastRaw = "";
        for (const leg of [
          legStrictParse,
          legJsonSchema,
          legForcedTool,
          legJsonObject,
        ]) {
          const result = await leg(call, format);
          usages.push(result.usage);
          lastRaw = result.raw || lastRaw;
          if (result.parsed !== null) {
            return {
              parsed: result.parsed as z.infer<S>,
              raw: result.raw,
              usage: sumStructuredUsage(usages),
            };
          }
        }
        console.warn(
          `${label}: all four chat rungs ran and none produced output validating against ${format.name} (${usages.filter(Boolean).length} provider call(s) billed); returning the last raw text for salvage`,
        );
        return {
          parsed: null,
          raw: lastRaw,
          usage: sumStructuredUsage(usages),
        };
      },
    );
  } catch (error) {
    attachUsage(
      error,
      sumStructuredUsage([...usages, usageFromException(error)]),
    );
    throw error;
  }
}
