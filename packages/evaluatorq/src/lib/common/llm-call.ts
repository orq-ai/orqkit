import type { Span } from "@opentelemetry/api";
import type OpenAI from "openai";
import type { z } from "zod/v4";

import {
  checkReservedKeys,
  extractUsage,
  RESERVED_COMPLETION_KEYS,
  RESERVED_RESPONSES_KEYS,
  type Usage,
  UsageSchema,
} from "../contracts.js";
import { toStrictSchema } from "../integrations/simulation/utils/strict-schema.js";
import { getField } from "./fields.js";
import type { ClassifyQuestion, ClassifyRequest } from "./judge.js";
import { llmSlot } from "./llm-limit.js";
import { priceUsage } from "./model-catalogue.js";
import { classifierQuestionWirePayloads } from "./model-input.js";
import { parseResponsesResponse, responsesTextConfig } from "./responses.js";
import { runAbortSignal } from "./run-lifecycle.js";
import { pipelineMetadata } from "./thread-context.js";
import {
  getTraceContextHeaders,
  recordLlmInput,
  recordLlmResponse,
  recordTokenUsage,
} from "./tracing.js";

export const DECISIONS_PATH = "/decisions";

type Params = Record<string, unknown>;
type Extras = Readonly<Record<string, unknown>> | null;

/** A zod object plus the name the provider sees, which zod objects do not carry. */
export interface NamedSchema<S extends z.ZodObject = z.ZodObject> {
  name: string;
  schema: S;
  scrubWire?: boolean;
}

export interface LlmCallResult<T> {
  response: T;
  usage: Usage | null;
}

export interface ChatMessageLike {
  content?: string | null;
  refusal?: string | null;
  parsed?: unknown;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string | null };
  }> | null;
}

export interface ChatCompletionLike {
  id?: string;
  model?: string;
  usage?: unknown;
  choices: Array<{
    finish_reason?: string | null;
    message: ChatMessageLike;
  }>;
}

interface WireClient {
  chat: {
    completions: {
      create(body: Params, options: Params): PromiseLike<ChatCompletionLike>;
    };
  };
  responses: {
    create(
      body: Params,
      options: Params,
    ): PromiseLike<unknown> & {
      withResponse?: () => Promise<{
        data: unknown;
        response: { headers: Headers };
      }>;
    };
  };
  post(path: string, options: Params): PromiseLike<unknown>;
}

function wire(client: OpenAI): WireClient {
  return client as unknown as WireClient;
}

export class LlmTimeoutError extends Error {
  override readonly name = "TimeoutError";
}

export class LengthFinishReasonError extends Error {
  override readonly name = "LengthFinishReasonError";

  constructor(readonly completion: ChatCompletionLike) {
    super("Could not parse response content as the length limit was reached");
  }
}

export class ContentFilterFinishReasonError extends Error {
  override readonly name = "ContentFilterFinishReasonError";

  constructor() {
    super(
      "Could not parse response content as the request was rejected by the content filter",
    );
  }
}

const reasoningEffortRejectors = new Set<string>();
const responsesReasoningRejectors = new Set<string>();
const announcedStrips = new Set<string>();

export function resetReasoningRejectors(): void {
  reasoningEffortRejectors.clear();
  responsesReasoningRejectors.clear();
  announcedStrips.clear();
}

function hasTools(params: Params): boolean {
  const { tools } = params;
  return Array.isArray(tools) ? tools.length > 0 : Boolean(tools);
}

function reasoningKey(model: string, params: Params): string {
  return JSON.stringify([model, hasTools(params)]);
}

function announceStrip(
  endpoint: string,
  model: string,
  params: Params,
  field: string,
): void {
  const tools = hasTools(params);
  const key = JSON.stringify([endpoint, model, tools]);
  if (announcedStrips.has(key)) {
    console.error(
      `Model ${model}: ${field} stripped again (known rejector, tools=${tools})`,
    );
    return;
  }
  announcedStrips.add(key);
  console.warn(
    `Model ${model} previously rejected ${field} (tools=${tools}); stripping it up front. This call runs at the provider default effort, not the configured one`,
  );
}

function stripKnownRejectedReasoning(model: string, params: Params): void {
  if (!reasoningEffortRejectors.has(reasoningKey(model, params))) {
    return;
  }
  const carried = params.reasoning_effort;
  delete params.reasoning_effort;
  if (carried !== null && carried !== undefined) {
    announceStrip("chat_completions", model, params, "reasoning_effort");
  }
}

export function stripKnownRejectedResponsesReasoning(
  model: string,
  params: Params,
): void {
  if (!responsesReasoningRejectors.has(reasoningKey(model, params))) {
    return;
  }
  const carried = params.reasoning;
  delete params.reasoning;
  if (carried !== null && carried !== undefined) {
    announceStrip("responses", model, params, "the reasoning block");
  }
}

export function isBadRequest(error: unknown): boolean {
  return getField(error, "status") === 400;
}

export function errorBodyText(error: unknown): string {
  const body = getField(error, "error");
  if (body) {
    return (
      typeof body === "string" ? body : JSON.stringify(body)
    ).toLowerCase();
  }
  return String(getField(error, "message") ?? "").toLowerCase();
}

const UNSUPPORTED_PARAMETER_MARKERS = [
  "unsupported",
  "not supported",
  "unrecognized",
  "unknown parameter",
];

function isReasoningEffortRejection(params: Params, error: unknown): boolean {
  if (!isBadRequest(error) || !("reasoning_effort" in params)) {
    return false;
  }
  const body = errorBodyText(error);
  return (
    body.includes("reasoning") &&
    UNSUPPORTED_PARAMETER_MARKERS.some((marker) => body.includes(marker))
  );
}

export function isResponsesReasoningRejection(
  params: Params,
  error: unknown,
): boolean {
  return (
    isBadRequest(error) &&
    "reasoning" in params &&
    errorBodyText(error).includes("reasoning")
  );
}

export function rememberResponsesReasoningRejection(
  model: string,
  params: Params,
): void {
  responsesReasoningRejectors.add(reasoningKey(model, params));
}

export function applyPipelineMetadata(params: Params): void {
  const metadata = pipelineMetadata();
  if (Object.keys(metadata).length > 0) {
    params.metadata = {
      ...metadata,
      ...((params.metadata as Params | null | undefined) ?? {}),
    };
  }
}

export async function applyTraceHeaders(params: Params): Promise<void> {
  const headers = await getTraceContextHeaders();
  if (Object.keys(headers).length > 0) {
    params.extra_headers = {
      ...((params.extra_headers as Params | null | undefined) ?? {}),
      ...headers,
    };
  }
}

/** The timeout runs inside the slot, so queueing never counts against it. */
function boundedCall<T>(
  request: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const runSignal = runAbortSignal();
  externalSignal =
    runSignal && externalSignal
      ? AbortSignal.any([runSignal, externalSignal])
      : (runSignal ?? externalSignal);
  return llmSlot(
    async () => {
      externalSignal?.throwIfAborted();
      const controller = new AbortController();
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          controller.abort(externalSignal?.reason);
          reject(
            externalSignal?.reason ??
              Object.assign(new Error("Cancelled"), { name: "AbortError" }),
          );
        };
        externalSignal?.addEventListener("abort", onAbort, { once: true });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new LlmTimeoutError(`LLM call timed out after ${timeoutMs}ms`),
          );
          controller.abort();
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          request(controller.signal),
          timeout,
          aborted,
        ]);
      } finally {
        clearTimeout(timer);
        if (onAbort) externalSignal?.removeEventListener("abort", onAbort);
      }
    },
    { signal: externalSignal },
  );
}

/**
 * Splits params into the JSON body and the SDK request options. The JS SDK has
 * no `extra_body`, so its keys merge into the body and win, as they do in the
 * Python SDK.
 */
function requestParts(params: Params): { body: Params; options: Params } {
  const { extra_body, extra_headers, extra_query, timeout, ...body } = params;
  const options: Params = {};
  if (extra_headers) {
    options.headers = extra_headers;
  }
  if (extra_query) {
    options.query = extra_query;
  }
  if (timeout !== undefined && timeout !== null) {
    options.timeout = timeout;
  }
  return { body: { ...body, ...((extra_body as Params) ?? {}) }, options };
}

function postChat(
  client: OpenAI,
  params: Params,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ChatCompletionLike> {
  const { body, options } = requestParts(params);
  return boundedCall(
    (signal) =>
      wire(client).chat.completions.create(body, { ...options, signal }),
    timeoutMs,
    signal,
  );
}

function postResponse(
  client: OpenAI,
  params: Params,
  timeoutMs: number,
  signal?: AbortSignal,
  onResponseHeaders?: (headers: Headers) => void,
): Promise<unknown> {
  const { body, options } = requestParts(params);
  return boundedCall(
    (signal) => {
      const pending = wire(client).responses.create(body, {
        ...options,
        signal,
      });
      if (onResponseHeaders && typeof pending.withResponse === "function")
        return pending.withResponse().then(({ data, response }) => {
          onResponseHeaders(response.headers);
          return data;
        });
      return pending;
    },
    timeoutMs,
    signal,
  );
}

async function withEffortRetry<T>(
  model: string,
  params: Params,
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!isReasoningEffortRejection(params, error)) {
      throw error;
    }
    reasoningEffortRejectors.add(reasoningKey(model, params));
    console.warn(
      `Model ${model} rejected reasoning_effort; dropping it and retrying once`,
    );
    delete params.reasoning_effort;
    return send();
  }
}

function completionUsage(
  response: { usage?: unknown; model?: unknown },
  model: string,
  client: OpenAI,
): Promise<Usage | null> {
  return priceUsage(extractUsage(response.usage ?? null, 1), model, client, {
    servedModel: (response.model as string | undefined) ?? null,
  });
}

export interface BaseCallOptions {
  client: OpenAI;
  model: string;
  messages: readonly unknown[];
  span: Span | undefined;
  timeoutMs: number;
  temperature?: number | null;
  reasoningEffort?: string | null;
  tools?: readonly unknown[] | null;
  injectTraceHeaders?: boolean;
  extraBody?: Extras;
  extraKwargs?: Extras;
  signal?: AbortSignal;
}

export interface ChatCompletionOptions extends BaseCallOptions {
  retryUnsupportedReasoning?: boolean;
  maxTokens?: number | null;
  maxCompletionTokens?: number | null;
  responseFormat?: Readonly<Record<string, unknown>> | null;
}

function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function nonEmpty(value: Extras | undefined): value is Params {
  return isSet(value) && Object.keys(value).length > 0;
}

async function prepareChat(
  options: BaseCallOptions,
  params: Params,
  allowReasoningFallback = true,
): Promise<void> {
  const {
    model,
    messages,
    span,
    extraKwargs,
    injectTraceHeaders = true,
  } = options;
  if (nonEmpty(extraKwargs)) {
    checkReservedKeys(extraKwargs, RESERVED_COMPLETION_KEYS);
    Object.assign(params, extraKwargs);
  }
  if (allowReasoningFallback) stripKnownRejectedReasoning(model, params);
  applyPipelineMetadata(params);
  recordLlmInput(span, messages);
  if (injectTraceHeaders) {
    await applyTraceHeaders(params);
  }
}

export async function executeChatCompletion(
  options: ChatCompletionOptions,
): Promise<LlmCallResult<ChatCompletionLike>> {
  const { client, model, messages, span, timeoutMs, tools } = options;
  const params: Params = { model, messages };
  if (isSet(options.temperature)) {
    params.temperature = options.temperature;
  }
  if (isSet(options.maxTokens)) {
    params.max_tokens = options.maxTokens;
  }
  if (isSet(options.maxCompletionTokens)) {
    params.max_completion_tokens = options.maxCompletionTokens;
  }
  if (options.reasoningEffort) {
    params.reasoning_effort = options.reasoningEffort;
  }
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
  }
  if (isSet(options.responseFormat)) {
    params.response_format = options.responseFormat;
  }
  if (nonEmpty(options.extraBody)) {
    params.extra_body = options.extraBody;
  }
  const allowReasoningFallback = options.retryUnsupportedReasoning !== false;
  await prepareChat(options, params, allowReasoningFallback);
  const send = () => postChat(client, params, timeoutMs, options.signal);
  const response = allowReasoningFallback
    ? await withEffortRetry(model, params, send)
    : await send();
  recordLlmResponse(span, response);
  return { response, usage: await completionUsage(response, model, client) };
}

export interface ChatParseOptions extends BaseCallOptions {
  responseModel?: NamedSchema | null;
  toolChoice?: unknown;
  maxCompletionTokens?: number | null;
}

function parseCompletion(
  completion: ChatCompletionLike,
  responseModel: NamedSchema | null | undefined,
): ChatCompletionLike {
  return {
    ...completion,
    choices: (completion.choices ?? []).map((choice) => {
      if (choice.finish_reason === "length") {
        throw new LengthFinishReasonError(completion);
      }
      if (choice.finish_reason === "content_filter") {
        throw new ContentFilterFinishReasonError();
      }
      const { message } = choice;
      const parsed =
        responseModel && message.content && !message.refusal
          ? responseModel.schema.parse(JSON.parse(message.content))
          : null;
      return { ...choice, message: { ...message, parsed } };
    }),
  };
}

/**
 * The counterpart of the Python SDK's `.parse`, sent through `.create` because
 * `openai/helpers/zod` writes a nullable field in a form models ignore (see
 * `toStrictSchema`). Fills `message.parsed` and throws the same finish-reason
 * errors. Tool arguments are left to the caller.
 */
export async function executeChatParse(
  options: ChatParseOptions,
): Promise<LlmCallResult<ChatCompletionLike>> {
  const { client, model, messages, span, timeoutMs, tools, responseModel } =
    options;
  const params: Params = { model, messages };
  if (responseModel) {
    params.response_format = {
      type: "json_schema",
      json_schema: {
        name: responseModel.name,
        strict: true,
        schema: toStrictSchema(responseModel.schema),
      },
    };
  }
  if (tools && tools.length > 0) {
    params.tools = tools;
  }
  if (isSet(options.toolChoice)) {
    params.tool_choice = options.toolChoice;
  }
  if (isSet(options.temperature)) {
    params.temperature = options.temperature;
  }
  if (isSet(options.maxCompletionTokens)) {
    params.max_completion_tokens = options.maxCompletionTokens;
  }
  if (options.reasoningEffort) {
    params.reasoning_effort = options.reasoningEffort;
  }
  if (nonEmpty(options.extraBody)) {
    params.extra_body = options.extraBody;
  }
  await prepareChat(options, params);
  const raw = await withEffortRetry(model, params, () =>
    postChat(client, params, timeoutMs, options.signal),
  );
  const response = parseCompletion(raw, responseModel);
  recordLlmResponse(span, response);
  return { response, usage: await completionUsage(response, model, client) };
}

export interface ResponseOptions extends BaseCallOptions {
  responseModel?: NamedSchema | null;
  responseTextFormat?: NamedSchema | null;
  maxOutputTokens?: number | null;
  instructions?: string | null;
  recordInput?: boolean;
  onResponseHeaders?: (headers: Headers) => void;
  onRequest?: (payload: Readonly<Record<string, unknown>>) => void;
}

function buildResponseParams(options: ResponseOptions): Params {
  const { model, messages, responseModel, responseTextFormat, tools } = options;
  const params: Params = { model, input: messages };
  if (isSet(options.instructions)) {
    params.instructions = options.instructions;
  }
  if (tools && tools.length > 0) {
    params.tools = tools;
  }
  if (isSet(options.temperature)) {
    params.temperature = options.temperature;
  }
  if (isSet(options.maxOutputTokens)) {
    params.max_output_tokens = options.maxOutputTokens;
  }
  if (options.reasoningEffort) {
    params.reasoning = { effort: options.reasoningEffort };
  }
  if (nonEmpty(options.extraBody)) {
    params.extra_body = options.extraBody;
  }
  if (nonEmpty(options.extraKwargs)) {
    checkReservedKeys(options.extraKwargs, RESERVED_RESPONSES_KEYS);
    Object.assign(params, options.extraKwargs);
  }
  if (params.temperature === null || params.temperature === undefined) {
    delete params.temperature;
  }
  if (responseModel && responseTextFormat) {
    throw new Error(
      "responseModel and responseTextFormat are mutually exclusive",
    );
  }
  const format = responseModel ?? responseTextFormat;
  if (format) {
    params.text = responsesTextConfig(format.name, format.schema, {
      scrub: format.scrubWire,
    });
  }
  return params;
}

function parsedResponse(
  response: unknown,
  responseModel: NamedSchema,
): unknown {
  const { outputParsed } = parseResponsesResponse(
    response,
    responseModel.schema,
  );
  return { ...(response as Params), output_parsed: outputParsed };
}

/**
 * One Responses API call. With `responseModel` the reply gains `output_parsed`,
 * and validation can throw. With `responseTextFormat` the same strict schema is
 * sent but the raw reply comes back, for a caller that must read completion
 * metadata before validating.
 */
export async function executeResponse(
  options: ResponseOptions,
): Promise<LlmCallResult<unknown>> {
  const { client, model, messages, span, timeoutMs, responseModel } = options;
  const { injectTraceHeaders = true, recordInput = true } = options;
  const params = buildResponseParams(options);

  stripKnownRejectedResponsesReasoning(model, params);
  applyPipelineMetadata(params);
  if (recordInput) {
    recordLlmInput(span, messages);
  }
  if (injectTraceHeaders) {
    await applyTraceHeaders(params);
  }

  let raw: unknown;
  try {
    options.onRequest?.(params);
    raw = await postResponse(
      client,
      params,
      timeoutMs,
      options.signal,
      options.onResponseHeaders,
    );
  } catch (error) {
    if (!isResponsesReasoningRejection(params, error)) {
      throw error;
    }
    rememberResponsesReasoningRejection(model, params);
    console.warn(
      `Model ${model} rejected the reasoning block; dropping it and retrying once`,
    );
    delete params.reasoning;
    options.onRequest?.(params);
    raw = await postResponse(
      client,
      params,
      timeoutMs,
      options.signal,
      options.onResponseHeaders,
    );
  }
  const response = responseModel ? parsedResponse(raw, responseModel) : raw;
  recordLlmResponse(span, response);
  return {
    response,
    usage: await priceUsage(
      extractUsage(getField(response, "usage") ?? null, 1),
      model,
      client,
      { servedModel: (getField(response, "model") as string) ?? null },
    ),
  };
}

export function classifyRequestBody(
  model: string,
  state: unknown,
  questions: Readonly<Record<string, ClassifyQuestion>>,
): Record<string, unknown> {
  return {
    model,
    state,
    questions: classifierQuestionWirePayloads(questions),
  };
}

export interface ClassifyCallOptions {
  client: OpenAI;
  model: string;
  question?: ClassifyQuestion | null;
  request?: ClassifyRequest | null;
  span: Span | undefined;
  timeoutMs: number;
  injectTraceHeaders?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One Orq router `/decisions` call. Pass exactly one of `question` or `request`.
 * The reply comes back decoded but unvalidated. A reply with no readable usage
 * is returned as one unpriced call and records no usage on the span, because
 * zeros there would read as a free call.
 */
export async function executeClassify(
  options: ClassifyCallOptions,
): Promise<LlmCallResult<unknown>> {
  const { client, model, question, request, span, timeoutMs } = options;
  const { injectTraceHeaders = true } = options;
  if (!question === !request) {
    throw new Error(
      "executeClassify requires exactly one of question or request",
    );
  }
  const questions: Readonly<Record<string, ClassifyQuestion>> = question
    ? { verdict: question }
    : (request as ClassifyRequest).questions;
  const state = question ? question.state : (request as ClassifyRequest).state;
  // No pipeline metadata: the router validates this body strictly and rejects
  // keys beyond model, state and questions.
  const body = classifyRequestBody(model, state, questions);

  const traced: Params = {};
  if (injectTraceHeaders) {
    await applyTraceHeaders(traced);
  }

  const single =
    question ??
    (Object.keys(questions).length === 1 ? questions.verdict : undefined);
  const systemContent = single
    ? { instructions: single.instructions, criteria: single.criteria }
    : { questions: body.questions };
  recordLlmInput(span, [
    { role: "system", content: JSON.stringify(systemContent) },
    { role: "user", content: JSON.stringify(state) },
  ]);

  const headers = traced.extra_headers;
  const payload = await boundedCall(
    (signal) =>
      wire(client).post(DECISIONS_PATH, {
        body,
        signal,
        ...(headers ? { headers } : {}),
      }),
    timeoutMs,
  );
  recordLlmResponse(span, payload, {
    outputContent: JSON.stringify(payload),
    recordUsage: false,
  });

  const usage = extractUsage(
    isRecord(payload) ? (payload.usage ?? null) : null,
    1,
  );
  if (usage === null) {
    console.warn(
      `Classify ${model} reply carried no readable usage block; the call stays unpriced and its span records no usage`,
    );
    return {
      response: payload,
      usage: UsageSchema.parse({ calls: 1, pricedCalls: 0 }),
    };
  }
  recordTokenUsage(span, { usage, calls: 0 });
  const served = isRecord(payload) ? (payload.model as string | null) : null;
  return {
    response: payload,
    usage: await priceUsage(usage, model, client, {
      servedModel: served ?? null,
    }),
  };
}
