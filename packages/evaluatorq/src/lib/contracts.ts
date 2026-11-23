import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { getField } from "./common/fields.js";
import { UNKNOWN_ARGUMENTS, wireArguments } from "./common/messages.js";
import {
  iterPaired,
  PairedToolCall,
} from "./integrations/openresponses/tool-records.js";

export const JURY_RAW_OUTPUT_KEY = "jury";
export const EVAL_ERROR_RAW_OUTPUT_KEY = "evaluation_error";

export const DEFAULT_FAST_MODEL = "openai/gpt-6-luna";
export const DEFAULT_SMART_MODEL = "openai/gpt-6-sol";
export const DEFAULT_CLASSIFIER_MODEL = "typesafe/jev-latest";
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_PIPELINE_MODEL = DEFAULT_FAST_MODEL;
// Covers hidden reasoning as well as the visible answer on a reasoning model.
export const DEFAULT_TARGET_MAX_TOKENS = 10_000;
export const DEFAULT_TARGET_TIMEOUT_MS = 240_000;

const InputTextContentSchema = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

const InputImageContentSchema = z.object({
  type: z.literal("input_image"),
  image_url: z.string().nullish(),
  file_id: z.string().nullish(),
  detail: z.enum(["auto", "low", "high"]).default("auto"),
});

const InputFileContentSchema = z.object({
  type: z.literal("input_file"),
  file_id: z.string().nullish(),
  file_data: z.string().nullish(),
  file_url: z.string().nullish(),
  filename: z.string().nullish(),
  mime_type: z.string().nullish(),
});

// The Orq Responses API rejects an explicit null on an optional content field.
export const ContentPartSchema = z
  .discriminatedUnion("type", [
    InputTextContentSchema,
    InputImageContentSchema,
    InputFileContentSchema,
  ])
  .transform(
    (part) =>
      Object.fromEntries(
        Object.entries(part).filter(
          ([, value]) => value !== null && value !== undefined,
        ),
      ) as typeof part,
  );

export type ContentPart = z.infer<typeof ContentPartSchema>;
export type MessageContent = string | ContentPart[] | null | undefined;

function contentPartToChatBlock(part: ContentPart): Record<string, unknown> {
  if (part.type === "input_text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "input_image") {
    if (part.image_url === null || part.image_url === undefined) {
      throw new Error(
        "file_id-backed images are Responses-API only; use OrqResponsesTarget.",
      );
    }
    return {
      type: "image_url",
      image_url: { url: part.image_url, detail: part.detail },
    };
  }
  const { file_id, file_data, filename } = part;
  if (
    (file_id === null || file_id === undefined) &&
    (file_data === null || file_data === undefined)
  ) {
    throw new Error(
      "file_url-backed files are Responses-API only; use OrqResponsesTarget.",
    );
  }
  return {
    type: "file",
    file: {
      ...(file_id == null ? {} : { file_id }),
      ...(file_data == null ? {} : { file_data }),
      ...(filename == null ? {} : { filename }),
    },
  };
}

function renderChatContent(
  content: MessageContent,
): string | Record<string, unknown>[] {
  return Array.isArray(content)
    ? content.map(contentPartToChatBlock)
    : content || "";
}

export function contentToText(content: MessageContent): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type !== "input_text") {
        throw new Error(
          `This target accepts only text content; got a '${part.type}' part. Use a Responses-API target (OrqResponsesTarget) for image/file content.`,
        );
      }
      return part.text;
    })
    .join("");
}

export type ConversationHistoryMode = "caller" | "target";

export const RESERVED_COMPLETION_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "response_format",
  "extra_body",
]);
export const RESERVED_RESPONSES_KEYS: ReadonlySet<string> = new Set([
  "model",
  "input",
  "text",
  "extra_body",
]);

export function checkReservedKeys(
  extraKwargs: Readonly<Record<string, unknown>>,
  reserved: ReadonlySet<string>,
): void {
  const clash = Object.keys(extraKwargs)
    .filter((key) => reserved.has(key))
    .sort();
  if (clash.length > 0) {
    throw new Error(
      `extra_kwargs cannot override structural request field(s) ${JSON.stringify(clash)}; these are owned by the call site.`,
    );
  }
}

export type LlmApi = "chat_completions" | "responses";

export const LLMCallConfigSchema = z.object({
  model: z.string().default(DEFAULT_PIPELINE_MODEL),
  api: z.enum(["chat_completions", "responses"]).default("chat_completions"),
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxTokens: z.number().int().positive().default(DEFAULT_TARGET_MAX_TOKENS),
  timeoutMs: z.number().int().positive().default(90_000),
  extraKwargs: z.record(z.unknown()).default(() => ({})),
  extraBody: z.record(z.unknown()).default(() => ({})),
  reasoningEffort: z.string().nullable().default(null),
  client: z.unknown().optional(),
  retryCount: z.number().int().nonnegative().default(1),
});

export type LLMCallConfigInput = z.input<typeof LLMCallConfigSchema>;
type LLMCallConfigField = keyof LLMCallConfigInput;

export class LLMCallConfig {
  readonly model: string;
  readonly api: LlmApi;
  readonly temperature: number | null;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly extraKwargs: Record<string, unknown>;
  readonly extraBody: Record<string, unknown>;
  readonly reasoningEffort: string | null;
  readonly client: unknown;
  readonly retryCount: number;
  readonly fieldsSet: ReadonlySet<string>;

  constructor(input: LLMCallConfigInput = {}) {
    const parsed = LLMCallConfigSchema.parse(input);
    this.model = parsed.model;
    this.api = parsed.api;
    this.temperature = parsed.temperature;
    this.maxTokens = parsed.maxTokens;
    this.timeoutMs = parsed.timeoutMs;
    this.extraKwargs = parsed.extraKwargs;
    this.extraBody = parsed.extraBody;
    this.reasoningEffort = parsed.reasoningEffort;
    this.client = parsed.client;
    this.retryCount = parsed.retryCount;
    this.fieldsSet = new Set(
      Object.entries(input).flatMap(([key, value]) =>
        value === undefined ? [] : [key],
      ),
    );
  }

  setValues<K extends LLMCallConfigField>(
    ...names: K[]
  ): Partial<Pick<LLMCallConfig, K & keyof LLMCallConfig>> {
    return Object.fromEntries(
      names.flatMap((name) =>
        this.fieldsSet.has(name)
          ? [[name, this[name as keyof LLMCallConfig]]]
          : [],
      ),
    ) as Partial<Pick<LLMCallConfig, K & keyof LLMCallConfig>>;
  }

  resolveTimeoutMs(defaultMs: number): number {
    return this.fieldsSet.has("timeoutMs") ? this.timeoutMs : defaultMs;
  }

  requestParams(
    params: Record<string, unknown> = {},
    api?: LlmApi,
  ): Record<string, unknown> {
    const endpoint = api ?? this.api;
    if (api !== undefined && api !== this.api && this.fieldsSet.has("api")) {
      console.warn(
        `LLMCallConfig(api='${this.api}') is set but this call site only speaks '${api}'; rendering '${api}' request parameters. The api field governs the call sites that can choose, the judge and the target, not single-endpoint helpers.`,
      );
    }
    const isResponses = endpoint === "responses";
    checkReservedKeys(
      this.extraKwargs,
      isResponses ? RESERVED_RESPONSES_KEYS : RESERVED_COMPLETION_KEYS,
    );
    const base: Record<string, unknown> = isResponses
      ? { max_output_tokens: this.maxTokens }
      : { max_completion_tokens: this.maxTokens };
    if (this.temperature !== null) {
      base.temperature = this.temperature;
    }
    if (this.reasoningEffort) {
      if (isResponses) {
        base.reasoning = { effort: this.reasoningEffort };
      } else {
        base.reasoning_effort = this.reasoningEffort;
      }
    }
    const merged = { ...base, ...params, ...this.extraKwargs };
    if (merged.temperature === null || merged.temperature === undefined) {
      // The provider rejects an explicit null, and reasoning models reject the
      // parameter at all.
      delete merged.temperature;
    }
    if (Object.keys(this.extraBody).length > 0) {
      merged.extra_body = {
        ...((params.extra_body as Record<string, unknown>) ?? {}),
        ...this.extraBody,
      };
    }
    return merged;
  }
}

function hexId(): string {
  return randomUUID().replaceAll("-", "");
}

function serializeArguments(value: unknown): unknown {
  if (typeof value === "string" || value === undefined) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn(
      `ToolCallOutputItem: arguments not JSON-serializable, falling back to String() (${error})`,
    );
    return String(value);
  }
}

export const TextOutputItemSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.unknown()).default(() => []),
  logprobs: z.array(z.unknown()).default(() => []),
});
export type TextOutputItem = z.infer<typeof TextOutputItemSchema>;

export const ToolCallOutputItemSchema = z.object({
  type: z.literal("function_call"),
  id: z.string().default(() => `fc_${hexId()}`),
  call_id: z.string().default(() => `call_${hexId()}`),
  name: z.string(),
  arguments: z.preprocess(serializeArguments, z.string()),
  status: z
    .enum(["in_progress", "completed", "incomplete"])
    .default("completed"),
  result: z.string().nullable().default(null),
});
export type ToolCallOutputItem = z.infer<typeof ToolCallOutputItemSchema>;

export const ReasoningOutputItemSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  id: z.string().nullable().default(null),
});
export type ReasoningOutputItem = z.infer<typeof ReasoningOutputItemSchema>;

export const OutputMessageSchema = z.discriminatedUnion("type", [
  TextOutputItemSchema,
  ToolCallOutputItemSchema,
  ReasoningOutputItemSchema,
]);
export type OutputMessage = z.infer<typeof OutputMessageSchema>;

export function textOutputItem(text: string): TextOutputItem {
  return TextOutputItemSchema.parse({ type: "output_text", text });
}

export function toolCallOutputItem(
  input: Omit<z.input<typeof ToolCallOutputItemSchema>, "type">,
): ToolCallOutputItem {
  return ToolCallOutputItemSchema.parse({ type: "function_call", ...input });
}

export function reasoningOutputItem(
  text: string,
  id: string | null = null,
): ReasoningOutputItem {
  return ReasoningOutputItemSchema.parse({ type: "reasoning", text, id });
}

/** Malformed or non-object arguments read as `{}`, since a tool call can be adversary-controlled. */
export function toolCallArgumentsDict(
  item: Pick<ToolCallOutputItem, "arguments">,
): Record<string, unknown> {
  const raw = item.arguments.slice(0, 200);
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.arguments);
  } catch (error) {
    console.warn(
      `toolCallArgumentsDict: arguments not valid JSON (${error}, raw=${JSON.stringify(raw)})`,
    );
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(
      `toolCallArgumentsDict: parsed JSON is not an object (raw=${JSON.stringify(raw)})`,
    );
    return {};
  }
  return parsed as Record<string, unknown>;
}

export const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const StrategyToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: FunctionCallSchema,
  item_id: z.string().nullable().default(null),
  incomplete: z.boolean().default(false),
});

export type StrategyToolCall = z.infer<typeof StrategyToolCallSchema>;

// Field names stay in the OpenAI wire spelling: a Message is that format, and
// recorded transcripts and loose provider dicts are read by the same helpers.
export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool", "system", "developer"]),
  content: z
    .union([z.string(), z.array(ContentPartSchema)])
    .nullable()
    .default(null),
  tool_calls: z.array(StrategyToolCallSchema).nullable().default(null),
  tool_call_id: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
});

export type Message = z.infer<typeof MessageSchema>;
export type MessageInput = z.input<typeof MessageSchema>;

export function toChatCompletion(message: Message): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id || "",
      content: message.content || "",
      ...(message.name ? { name: message.name } : {}),
    };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: wireArguments(tc.function.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: renderChatContent(message.content) };
}

export function renderToolCall(
  item: Pick<ToolCallOutputItem, "call_id" | "name" | "arguments"> & {
    id?: string | null;
    result?: string | null;
  },
): {
  toolCall: StrategyToolCall;
  toolMessage: Message | null;
} {
  const hasResult = item.result !== null && item.result !== undefined;
  const toolCall = StrategyToolCallSchema.parse({
    id: item.call_id,
    item_id: item.id || null,
    function: { name: item.name, arguments: item.arguments },
    incomplete: !hasResult,
  });
  if (!hasResult) {
    console.error(
      `Tool call '${item.call_id}' ('${item.name}') has no result (None); kept without a tool message.`,
    );
    return { toolCall, toolMessage: null };
  }
  return {
    toolCall,
    toolMessage: MessageSchema.parse({
      role: "tool",
      tool_call_id: item.call_id,
      name: item.name,
      content: item.result,
    }),
  };
}

export { UNKNOWN_ARGUMENTS };

const count = z.number().int().nonnegative();
const cost = z.number().nonnegative().nullable();

export const UsageSchema = z.object({
  inputTokens: count.default(0),
  outputTokens: count.default(0),
  totalTokens: count.default(0),
  cachedTokens: count.default(0),
  cacheCreationTokens: count.default(0),
  cacheCreation1hTokens: count.default(0),
  cacheCreation5mTokens: count.default(0),
  reasoningTokens: count.default(0),
  inputCost: cost.default(null),
  outputCost: cost.default(null),
  totalCost: cost.default(null),
  calls: count.default(0),
  pricedCalls: count.default(0),
});

export type Usage = z.infer<typeof UsageSchema>;
export type UsageInput = z.input<typeof UsageSchema>;

export function parseUsage(raw: unknown): Usage {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("Usage must be an object");
  const source = raw as Record<string, unknown>,
    value: Record<string, unknown> = {};
  const legacy: Record<string, string[]> = {
    inputTokens: ["prompt_tokens", "promptTokens"],
    outputTokens: ["completion_tokens", "completionTokens"],
    inputCost: ["prompt_cost"],
    outputCost: ["completion_cost"],
    totalCost: ["cost_usd", "cost"],
  };
  for (const key of Object.keys(UsageSchema.shape)) {
    const snake = key
      .replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
      .replace(/([a-z])(\d)/g, "$1_$2");
    if (
      key !== snake &&
      Object.hasOwn(source, key) &&
      Object.hasOwn(source, snake) &&
      !isDeepStrictEqual(source[key], source[snake])
    )
      throw new Error(`Conflicting '${key}' and '${snake}' values`);
    for (const alias of [key, snake, ...(legacy[key] ?? [])])
      if (Object.hasOwn(source, alias)) {
        value[key] = source[alias];
        break;
      }
  }
  return UsageSchema.parse(value);
}

const USAGE_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedTokens",
  "cacheCreationTokens",
  "cacheCreation1hTokens",
  "cacheCreation5mTokens",
  "reasoningTokens",
  "calls",
  "pricedCalls",
] as const;

const USAGE_COSTS = ["inputCost", "outputCost", "totalCost"] as const;

function combineCost(
  a: number | null,
  b: number | null,
  sign: 1 | -1,
): number | null {
  if (a === null && b === null) {
    return null;
  }
  return Math.max((a ?? 0) + sign * (b ?? 0), 0);
}

function combineUsage(a: Usage, b: Usage, sign: 1 | -1): Usage {
  const combined = { ...a };
  for (const key of USAGE_COUNTERS) {
    combined[key] = Math.max(a[key] + sign * b[key], 0);
  }
  for (const key of USAGE_COSTS) {
    combined[key] = combineCost(a[key], b[key], sign);
  }
  return combined;
}

export function addUsage(a: Usage, b?: Usage | null): Usage {
  return b ? combineUsage(a, b, 1) : { ...a };
}

export function subtractUsage(a: Usage, b?: Usage | null): Usage {
  return b ? combineUsage(a, b, -1) : { ...a };
}

export function costIsPartial(usage: Usage): boolean {
  return (
    usage.totalCost !== null &&
    usage.pricedCalls > 0 &&
    usage.pricedCalls < usage.calls
  );
}

export function usageWithCalls(usage: Usage, calls: number): Usage {
  return {
    ...usage,
    calls,
    pricedCalls: usage.totalCost !== null ? calls : 0,
  };
}

function usageGet(usage: unknown, key: string): unknown {
  if (usage === null || typeof usage !== "object") return undefined;
  const data = usage as Record<string, unknown>;
  if (Object.hasOwn(data, key)) return data[key];
  return data[
    key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
  ];
}

function firstInt(usage: unknown, keys: readonly string[]): number {
  for (const key of keys) {
    const value = usageGet(usage, key);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}

function detailInt(
  usage: unknown,
  containers: readonly string[],
  keys: readonly string[],
): number {
  for (const container of containers) {
    const detail = usageGet(usage, container);
    if (detail === null || detail === undefined) {
      continue;
    }
    const value = firstInt(detail, keys);
    if (value) {
      return value;
    }
  }
  return 0;
}

function clampedCost(usage: unknown, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = usageGet(usage, key);
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(value, 0);
    }
  }
  return null;
}

const INPUT_DETAILS = [
  "input_tokens_details",
  "prompt_tokens_details",
  "input_token_details",
];
const OUTPUT_DETAILS = [
  "output_tokens_details",
  "completion_tokens_details",
  "output_token_details",
];

/**
 * Maps any provider usage shape into a Usage. Returns null for a present but
 * empty payload, which must not be recorded as a confident "0 tokens, 1 call".
 */
export function extractUsage(usage: unknown, calls = 1): Usage | null {
  if (usage === null || usage === undefined) {
    return null;
  }
  const inputTokens = firstInt(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "prompt",
  ]);
  const outputTokens = firstInt(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "completion",
  ]);
  const reportedTotal = firstInt(usage, [
    "total_tokens",
    "totalTokens",
    "total",
  ]);
  const totalTokens =
    reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;
  const cachedTokens =
    detailInt(usage, INPUT_DETAILS, ["cached_tokens", "cache_read"]) ||
    firstInt(usage, ["cache_read_input_tokens", "cached_input_tokens"]);
  const tierContainers = [...INPUT_DETAILS, "cache_creation"];
  const cacheCreation1hTokens =
    detailInt(usage, tierContainers, [
      "cache_creation_1h_tokens",
      "ephemeral_1h_input_tokens",
    ]) || firstInt(usage, ["cache_creation_1h_tokens"]);
  const cacheCreation5mTokens =
    detailInt(usage, tierContainers, [
      "cache_creation_5m_tokens",
      "ephemeral_5m_input_tokens",
    ]) || firstInt(usage, ["cache_creation_5m_tokens"]);
  const cacheCreationTokens =
    detailInt(usage, INPUT_DETAILS, [
      "cache_creation_tokens",
      "cache_creation_input_tokens",
    ]) ||
    firstInt(usage, [
      "cache_creation_input_tokens",
      "cache_write_input_tokens",
    ]) ||
    cacheCreation1hTokens + cacheCreation5mTokens;
  const reasoningTokens =
    detailInt(usage, OUTPUT_DETAILS, ["reasoning_tokens", "reasoning"]) ||
    firstInt(usage, ["reasoning_output_tokens"]);
  const inputCost = clampedCost(usage, ["input_cost", "prompt_cost"]);
  const outputCost = clampedCost(usage, ["output_cost", "completion_cost"]);
  let totalCost = clampedCost(usage, ["total_cost", "cost_usd", "cost"]);
  if (totalCost === null && (inputCost !== null || outputCost !== null)) {
    totalCost = (inputCost ?? 0) + (outputCost ?? 0);
  }
  if (totalTokens <= 0 && cachedTokens <= 0 && totalCost === null) {
    return null;
  }
  const rawCalls = usageGet(usage, "calls");
  const resolvedCalls =
    typeof rawCalls === "number" ? Math.trunc(rawCalls) : calls;
  const rawPriced =
    usageGet(usage, "priced_calls") ?? usageGet(usage, "pricedCalls");
  const resolvedPriced =
    typeof rawPriced === "number"
      ? Math.trunc(rawPriced)
      : totalCost !== null
        ? resolvedCalls
        : 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens,
    cacheCreationTokens,
    cacheCreation1hTokens,
    cacheCreation5mTokens,
    reasoningTokens,
    inputCost,
    outputCost,
    totalCost,
    calls: resolvedCalls,
    pricedCalls: Math.min(resolvedPriced, resolvedCalls),
  };
}

const verdictValue = z.union([z.boolean(), z.number(), z.string()]);

export const JuryRepetitionSchema = z.object({
  value: verdictValue.nullable().default(null),
  explanation: z.string().nullable().default(null),
  rawOutput: z.record(z.unknown()).nullable().default(null),
});

export type JuryRepetition = z.infer<typeof JuryRepetitionSchema>;

export const JuryVoteSchema = z
  .object({
    model: z.string(),
    replacement: z.boolean().default(false),
    success: z.boolean(),
    abstained: z.boolean().default(false),
    value: verdictValue.nullable().default(null),
    explanation: z.string().default(""),
    error: z.string().nullable().default(null),
    repetitions: z
      .preprocess(
        (raw) =>
          Array.isArray(raw)
            ? raw.map((item) =>
                item !== null &&
                typeof item === "object" &&
                !Array.isArray(item)
                  ? item
                  : { value: item },
              )
            : raw,
        z.array(JuryRepetitionSchema),
      )
      .default(() => []),
    repetitionsFailed: count.default(0),
  })
  .superRefine((vote, ctx) => {
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (vote.success && vote.value === null && !vote.abstained) {
      fail("successful JuryVote must have a non-null value unless abstained");
    }
    if (vote.abstained && vote.value !== null) {
      fail("abstained JuryVote must have a null value");
    }
    if (!vote.success && vote.value !== null) {
      fail("failed JuryVote must have a null value");
    }
    if (!vote.success && vote.abstained) {
      fail("failed JuryVote cannot also be abstained");
    }
  });

export type JuryVote = z.infer<typeof JuryVoteSchema>;
export type JuryVoteInput = z.input<typeof JuryVoteSchema>;

export const JuryStatsSchema = z.object({
  mean: z.number(),
  std: z.number().nonnegative(),
});

export type JuryStats = z.infer<typeof JuryStatsSchema>;

export const JuryResultSchema = z
  .object({
    judgesConfigured: count,
    judgesSucceeded: count,
    judgesFailed: count,
    replacementsUsed: count.default(0),
    tie: z.boolean().default(false),
    inconclusive: z.boolean().default(false),
    votes: z.array(JuryVoteSchema).default(() => []),
    stats: JuryStatsSchema.nullable().default(null),
    rawAgreement: z.number().min(0).max(1).nullable().default(null),
  })
  .superRefine((jury, ctx) => {
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const decisive = jury.votes.filter((v) => v.success && !v.abstained).length;
    if (jury.judgesSucceeded !== decisive) {
      fail(
        `judgesSucceeded (${jury.judgesSucceeded}) does not match decisive successful votes (${decisive})`,
      );
    }
    if (jury.judgesFailed > jury.judgesConfigured) {
      fail(
        `judgesFailed (${jury.judgesFailed}) exceeds judgesConfigured (${jury.judgesConfigured})`,
      );
    }
    const replacements = jury.votes.filter((v) => v.replacement).length;
    if (jury.replacementsUsed !== replacements) {
      fail(
        `replacementsUsed (${jury.replacementsUsed}) does not match replacement votes (${replacements})`,
      );
    }
    if (jury.votes.length !== jury.judgesConfigured + jury.replacementsUsed) {
      fail(
        `vote count (${jury.votes.length}) != judgesConfigured + replacementsUsed (${jury.judgesConfigured} + ${jury.replacementsUsed})`,
      );
    }
    if (jury.tie && jury.inconclusive) {
      fail("jury result cannot be both tie and inconclusive");
    }
    if (
      jury.inconclusive &&
      (jury.stats !== null || jury.rawAgreement !== null)
    ) {
      fail("inconclusive jury result must not include stats/rawAgreement");
    }
  });

export type JuryResult = z.infer<typeof JuryResultSchema>;
export type JuryResultInput = z.input<typeof JuryResultSchema>;

export function parseJuryResult(raw: unknown): JuryResult {
  const aliases = (value: unknown, keys: string[]): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const data = { ...value } as Record<string, unknown>;
    for (const key of keys) {
      const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      if (!(key in data) && snake in data) data[key] = data[snake];
    }
    return data;
  };
  const value = aliases(raw, [
    "judgesConfigured",
    "judgesSucceeded",
    "judgesFailed",
    "replacementsUsed",
    "rawAgreement",
  ]);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return JuryResultSchema.parse(value);
  const data = value as Record<string, unknown>;
  if (Array.isArray(data.votes))
    data.votes = data.votes.map((vote) => {
      const parsed = aliases(vote, ["repetitionsFailed"]);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        return parsed;
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.repetitions))
        record.repetitions = record.repetitions.map((item) =>
          aliases(item, ["rawOutput"]),
        );
      return record;
    });
  return JuryResultSchema.parse(data);
}

export const AgentResponseErrorSchema = z.object({
  message: z.string(),
  errorType: z.string(),
  code: z.string().nullable().default(null),
});
export type AgentResponseError = z.infer<typeof AgentResponseErrorSchema>;

export const ResponseTraceSchema = z.object({
  traceId: z.string().nullable().default(null),
  spanId: z.string().nullable().default(null),
});
export type ResponseTrace = z.infer<typeof ResponseTraceSchema>;

const AgentResponseSchema = z.object({
  output: z.array(OutputMessageSchema).default(() => []),
  usage: UsageSchema.nullable().default(null),
  model: z.string().nullable().default(null),
  responseId: z.string().nullable().default(null),
  traceId: z.string().nullable().default(null),
  spanId: z.string().nullable().default(null),
  finishReason: z.string().nullable().default(null),
  refusal: z.string().nullable().default(null),
  error: AgentResponseErrorSchema.nullable().default(null),
});

export type AgentResponseInput = z.input<typeof AgentResponseSchema> & {
  text?: string | null;
};

export class AgentResponse {
  readonly output: OutputMessage[];
  readonly usage: Usage | null;
  readonly model: string | null;
  readonly responseId: string | null;
  /** Orq trace id from `response.telemetry`; null when not routed through Orq. */
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly finishReason: string | null;
  readonly refusal: string | null;
  readonly error: AgentResponseError | null;

  constructor(input: AgentResponseInput = {}) {
    const { text, ...fields } = input;
    if (
      "text" in input &&
      fields.output !== undefined &&
      fields.output !== null
    ) {
      throw new Error("AgentResponse accepts either output or text, not both");
    }
    const parsed = AgentResponseSchema.parse(
      "text" in input
        ? {
            ...fields,
            output:
              text === undefined || text === null ? [] : [textOutputItem(text)],
          }
        : fields,
    );
    this.output = parsed.output;
    this.usage = parsed.usage;
    this.model = parsed.model;
    this.responseId = parsed.responseId;
    this.traceId = parsed.traceId;
    this.spanId = parsed.spanId;
    this.finishReason = parsed.finishReason;
    this.refusal = parsed.refusal;
    this.error = parsed.error;
    Object.freeze(this);
  }

  static fromJSON(raw: unknown): AgentResponse {
    if (raw instanceof AgentResponse) return raw;
    const decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded)
    )
      throw new TypeError("AgentResponse JSON must be an object");
    const value = { ...decoded } as Record<string, unknown>;
    for (const key of Object.keys(AgentResponseSchema.shape)) {
      const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      if (
        key !== snake &&
        Object.hasOwn(value, key) &&
        Object.hasOwn(value, snake) &&
        !isDeepStrictEqual(value[key], value[snake])
      )
        throw new Error(`Conflicting '${key}' and '${snake}' values`);
      if (!Object.hasOwn(value, key) && Object.hasOwn(value, snake))
        value[key] = value[snake];
    }
    if (value.usage !== undefined && value.usage !== null) {
      if (typeof value.usage !== "object" || Array.isArray(value.usage))
        throw new TypeError("AgentResponse usage must be an object or null");
      value.usage = parseUsage(value.usage);
    }
    if (
      value.error !== null &&
      typeof value.error === "object" &&
      !Array.isArray(value.error)
    ) {
      const error = { ...value.error } as Record<string, unknown>;
      if (
        !Object.hasOwn(error, "errorType") &&
        Object.hasOwn(error, "error_type")
      )
        error.errorType = error.error_type;
      value.error = error;
    }
    return new AgentResponse(value as AgentResponseInput);
  }

  get text(): string {
    return this.output
      .flatMap((item) => (item.type === "output_text" ? [item.text] : []))
      .join("");
  }

  get toolCalls(): ToolCallOutputItem[] {
    return this.output.filter(
      (item): item is ToolCallOutputItem => item.type === "function_call",
    );
  }

  static fromOutputItems(outputItems: Iterable<unknown>): AgentResponse {
    const output: OutputMessage[] = [];
    let refusal: string | null = null;
    for (const item of iterPaired(outputItems)) {
      const itemType = getField(item, "type");
      if (item instanceof PairedToolCall) {
        output.push(
          toolCallOutputItem({
            call_id: item.callId,
            name: item.name,
            arguments: item.arguments_ ?? UNKNOWN_ARGUMENTS,
            result: item.result,
            ...(item.itemId ? { id: item.itemId } : {}),
          }),
        );
      } else if (itemType === "message") {
        for (const part of (getField(item, "content") || []) as unknown[]) {
          const partType = getField(part, "type");
          // A refusal is a real answer (for red teaming, the resistant outcome),
          // and an item holding only a refusal must not parse to empty output.
          const text = getField(
            part,
            partType === "output_text" ? "text" : "refusal",
          );
          if (
            partType === "refusal" &&
            typeof text === "string" &&
            refusal === null
          ) {
            refusal = text;
          }
          if (partType !== "output_text" && partType !== "refusal") {
            console.warn(
              `AgentResponse.fromOpenResponses: skipping unknown message part type=${JSON.stringify(partType)}`,
            );
          } else if (text) {
            output.push(textOutputItem(text as string));
          }
        }
      } else if (itemType === "function_call_output") {
        console.warn(
          `Result for call_id ${JSON.stringify(getField(item, "call_id"))} has no matching call (call input missing); dropped`,
        );
      } else if (itemType !== "reasoning") {
        console.warn(
          `AgentResponse.fromOpenResponses: skipping unknown item type=${JSON.stringify(itemType)}`,
        );
      }
    }
    return new AgentResponse({ output, refusal });
  }

  /** `usage.calls` stays 0: this is a pure parse, and callers count billed calls. */
  static fromOpenResponses(response: unknown): AgentResponse {
    const parsed = AgentResponse.fromOutputItems(
      (getField(response, "output") || []) as Iterable<unknown>,
    );
    const rawUsage = getField(response, "usage") ?? null;
    if (rawUsage === null) {
      console.warn(
        "AgentResponse.fromOpenResponses: response.usage is missing; usage left null so cost reports do not record fake-zero usage for billed calls",
      );
    }
    const stringField = (name: string): string | null => {
      const value = getField(response, name);
      return typeof value === "string" ? value : null;
    };
    return new AgentResponse({
      output: parsed.output,
      usage: rawUsage === null ? null : extractUsage(rawUsage, 0),
      model: stringField("model"),
      finishReason: stringField("status"),
      responseId: stringField("id"),
      refusal: parsed.refusal,
    });
  }
}

export const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  parameters: z.record(z.string(), z.unknown()).nullable().default(null),
  actionType: z.string().nullable().default(null),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

export const MemoryStoreInfoSchema = z.object({
  id: z.string(),
  key: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});
export type MemoryStoreInfo = z.infer<typeof MemoryStoreInfoSchema>;

export const KnowledgeBaseInfoSchema = z.object({
  id: z.string(),
  key: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});
export type KnowledgeBaseInfo = z.infer<typeof KnowledgeBaseInfoSchema>;

function coerceProviderText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return Number.isInteger(value) ? String(value) : null;
}

const AGENT_CONTEXT_OPTIONAL_TEXT = [
  "id",
  "workspaceId",
  "displayName",
  "description",
  "model",
  "version",
];
const AGENT_CONTEXT_REQUIRED_TEXT = ["systemPrompt", "instructions"];
const AGENT_CONTEXT_LITERALS: Record<string, readonly string[]> = {
  targetKind: ["agent", "deployment", "direct", "openai"],
  agentType: ["internal", "a2a"],
  engine: ["text", "jinja", "mustache"],
};

// Context retrieval is enrichment, so a wrong-typed metadata field must not fail
// a whole scan. `key` stays strict because it identifies the agent under attack.
function normalizeAgentContextInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const data: Record<string, unknown> = { ...input };
  for (const name of [
    "workspaceId",
    "targetKind",
    "displayName",
    "systemPrompt",
    "memoryStores",
    "knowledgeBases",
    "agentType",
    "isMultiAgent",
  ]) {
    const snake = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!(name in data) && snake in data) data[name] = data[snake];
  }
  if (Array.isArray(data.tools))
    data.tools = data.tools.map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
      const value = { ...tool } as Record<string, unknown>;
      if (!("actionType" in value) && "action_type" in value)
        value.actionType = value.action_type;
      return value;
    });
  for (const name of AGENT_CONTEXT_OPTIONAL_TEXT) {
    if (name in data) {
      data[name] = coerceProviderText(data[name]);
    }
  }
  for (const name of AGENT_CONTEXT_REQUIRED_TEXT) {
    if (name in data) {
      data[name] = coerceProviderText(data[name]) ?? "";
    }
  }
  for (const [name, allowed] of Object.entries(AGENT_CONTEXT_LITERALS)) {
    if (name in data) {
      const value = data[name];
      data[name] =
        typeof value === "string" && allowed.includes(value) ? value : null;
    }
  }
  if ("skills" in data) {
    const { skills } = data;
    data.skills = Array.isArray(skills)
      ? skills.filter((skill) => typeof skill === "string")
      : [];
  }
  return data;
}

export const AgentContextSchema = z.preprocess(
  normalizeAgentContextInput,
  z.object({
    key: z.string(),
    id: z.string().nullable().default(null),
    workspaceId: z.string().nullable().default(null),
    targetKind: z
      .enum(["agent", "deployment", "direct", "openai"])
      .nullable()
      .default(null),
    displayName: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    /** A deployment's prompt; agents carry `instructions` and leave this empty. */
    systemPrompt: z.string().default(""),
    instructions: z.string().default(""),
    tools: z.array(ToolInfoSchema).default(() => []),
    memoryStores: z.array(MemoryStoreInfoSchema).default(() => []),
    knowledgeBases: z.array(KnowledgeBaseInfoSchema).default(() => []),
    model: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    skills: z.array(z.string()).default(() => []),
    agentType: z.enum(["internal", "a2a"]).nullable().default(null),
    engine: z.enum(["text", "jinja", "mustache"]).nullable().default(null),
    /** Gates multi-agent-only attack categories, so it stays off unless confirmed. */
    isMultiAgent: z.boolean().default(false),
  }),
);
export type AgentContext = z.infer<typeof AgentContextSchema>;

/**
 * A target never retries itself: the shared target-call layer owns the budget,
 * and a retrying `respond` multiplies against it. SDK-backed subclasses build
 * their client with retries off for the same reason.
 */
export abstract class AgentTarget {
  /**
   * True when `respond` bounds its own duration and throws a non-retryable error
   * on expiry. A target that sets this without bounding itself can hang a run.
   */
  readonly managesOwnTimeout: boolean = false;
  readonly historyMode: ConversationHistoryMode = "caller";
  private currentMemoryEntityId: string | null;
  protected memoryEntitySeeded: boolean;

  constructor(memoryEntityId: string | null = null) {
    this.currentMemoryEntityId = memoryEntityId;
    this.memoryEntitySeeded = memoryEntityId !== null;
  }

  get memoryEntityId(): string | null {
    return this.currentMemoryEntityId;
  }
  set memoryEntityId(value: string | null) {
    this.currentMemoryEntityId = value;
    this.memoryEntitySeeded = value !== null;
  }

  /** Installs an auto-minted id, so every clone keeps minting its own entity. */
  mintMemoryEntityId(value: string): void {
    this.memoryEntityId = value;
    this.memoryEntitySeeded = false;
  }

  abstract respond(messages: Message[]): Promise<AgentResponse>;

  /** A fresh independent instance for a new attack. */
  abstract newInstance(): AgentTarget;

  async getAgentContext(): Promise<AgentContext> {
    return AgentContextSchema.parse({
      key: getField(this, "agentKey", "unknown"),
    });
  }

  async cleanupMemory(
    _context: AgentContext,
    _entityIds: string[],
    _options?: { signal?: AbortSignal },
  ): Promise<void> {}

  mapError(_error: unknown): { code: string; message: string } | null {
    return null;
  }
}

export type ReportSectionKind =
  | "summary"
  | "token_usage"
  | "individual_results"
  | "agent_context"
  | "overview"
  | "failures_first"
  | "failure_mode"
  | "persona_scenario_heatmap"
  | "score_distribution"
  | "turn_quality_timeline"
  | "persona_breakdown"
  | "scenario_breakdown"
  | "judge_verdicts"
  | "turn_metrics"
  | "evaluator_scores"
  | "errors"
  | "recommendations"
  | "pipeline_warnings"
  | "focus_areas"
  | "vulnerability_breakdown"
  | "category_breakdown"
  | "technique_breakdown"
  | "delivery_breakdown"
  | "error_analysis"
  | "attack_heatmap"
  | "agent_comparison"
  | "agent_disagreements"
  | "framework_breakdown"
  | "turn_scope_breakdown"
  | "turn_depth_analysis"
  | "source_distribution"
  | "severity_definitions"
  | "methodology"
  | "pairwise_consensus"
  | "pairwise_judges"
  | "pairwise_comparisons";

export interface ReportSection {
  readonly kind: ReportSectionKind;
  readonly title: string;
  readonly data: Record<string, unknown>;
}

export const ManifestSurface = {
  SIM: "sim",
  REDTEAM: "redteam",
  INSIGHTS: "insights",
} as const;
export type ManifestSurface =
  (typeof ManifestSurface)[keyof typeof ManifestSurface];

export const ManifestStatus = {
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
  CANCELLED: "cancelled",
} as const;
export type ManifestStatus =
  (typeof ManifestStatus)[keyof typeof ManifestStatus];

export const RUN_SUMMARY_TOTAL_KEY = "totalResults";

/**
 * Format version of `RunManifest.summary`. Bump it whenever a surface's summary
 * changes shape, so readers re-read an older one from the full report instead of
 * rendering blank columns.
 */
export const RUN_SUMMARY_VERSION = 1;

export const RunSummarySchema = z.object({
  totalResults: z.number().int().optional(),
  pipeline: z.string().optional(),
  totalAttacks: z.number().int().optional(),
  vulnerabilityRate: z.number().nullable().optional(),
  resistanceRate: z.number().nullable().optional(),
  testedAgents: z.array(z.string()).optional(),
  mode: z.string().optional(),
  targetKind: z.string().optional(),
  scorerAverages: z.record(z.string(), z.number()).optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

const manifestStatus = z.nativeEnum(ManifestStatus);
const dateTime = z.preprocess(
  (value) => (typeof value === "string" ? new Date(value) : value),
  z.date(),
);
const optionalDateTime = z.preprocess(
  (value) => (typeof value === "string" ? new Date(value) : value),
  z.date().nullable().default(null),
);

export const StageRecordSchema = z
  .object({
    name: z.string(),
    target: z.string().nullable().default(null),
    status: manifestStatus.default(ManifestStatus.RUNNING),
    startedAt: dateTime,
    endedAt: optionalDateTime,
    completed: z.number().int().nullable().default(null),
    total: z.number().int().nullable().default(null),
  })
  .superRefine((stage, context) => {
    const { completed, total } = stage;
    const issues = [
      completed !== null && completed < 0 && "completed must be non-negative",
      total !== null && total < 0 && "total must be non-negative",
      completed !== null &&
        total !== null &&
        completed > total &&
        "completed must not exceed total",
    ];
    for (const message of issues) {
      if (message) {
        context.addIssue({ code: "custom", message });
      }
    }
  });
export type StageRecord = z.infer<typeof StageRecordSchema>;

export const RunManifestSchema = z.object({
  runId: z.string(),
  surface: z.nativeEnum(ManifestSurface),
  runName: z.string(),
  status: manifestStatus.default(ManifestStatus.RUNNING),
  stage: z.string().nullable().default(null),
  stages: z.array(StageRecordSchema).default(() => []),
  plannedStages: z.array(z.string()).default(() => []),
  stageLabels: z.record(z.string(), z.string()).default(() => ({})),
  startedAt: dateTime,
  updatedAt: dateTime,
  endedAt: optionalDateTime,
  error: z.string().nullable().default(null),
  reportPath: z.string().nullable().default(null),
  parallelism: z.number().int().nullable().default(null),
  summary: RunSummarySchema.nullable().default(null),
  summaryVersion: z.number().int().nullable().default(null),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

/** Null while the stage or run is still going. */
export function durationSeconds(record: {
  startedAt: Date;
  endedAt: Date | null;
}): number | null {
  return record.endedAt === null
    ? null
    : (record.endedAt.getTime() - record.startedAt.getTime()) / 1000;
}
