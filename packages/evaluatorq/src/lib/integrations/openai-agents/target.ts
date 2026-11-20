import { isDeepStrictEqual } from "node:util";

import { getField } from "../../common/fields.js";
import { resolveLlmClient } from "../../common/llm-client.js";
import {
  contentPartText,
  toolResultToText,
  UNKNOWN_ARGUMENTS,
} from "../../common/messages.js";
import { responsesStopReason } from "../../common/responses.js";
import {
  recordLlmOutput,
  recordTokenUsage,
  withLlmSpan,
} from "../../common/tracing.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  extractUsage,
  type Message,
  type MessageInput,
  MessageSchema,
  textOutputItem,
  type Usage,
} from "../../contracts.js";
import { messagesToResponsesInput } from "../openresponses/input-items.js";

export interface OpenAIAgentTargetOptions {
  runner?: object;
  runOptions?: Record<string, unknown>;
}

function sdkContent(part: unknown): unknown {
  const type = getField(part, "type");
  if (type === "input_image") {
    const id = getField(part, "file_id");
    const url = getField(part, "image_url");
    const image = typeof id === "string" && id ? { id } : url;
    if (
      typeof image !== "string" &&
      !(typeof image === "object" && image !== null)
    )
      throw new Error(
        "OpenAIAgentTarget: image content has no image URL or file id",
      );
    return { type, image, detail: getField(part, "detail") };
  }
  if (type === "input_file") {
    const id = getField(part, "file_id");
    const data = getField(part, "file_data");
    const url = getField(part, "file_url");
    const file =
      typeof id === "string" && id
        ? { id }
        : typeof data === "string" && data
          ? data
          : typeof url === "string" && url
            ? { url }
            : null;
    if (file === null)
      throw new Error(
        "OpenAIAgentTarget: file content has no file id, data or URL",
      );
    return { type, file, filename: getField(part, "filename") };
  }
  return part;
}

function sdkInput(messages: readonly Message[]): Record<string, unknown>[] {
  const items = messagesToResponsesInput(messages);
  const names = new Map(
    items
      .filter((item) => item.type === "function_call")
      .map((item) => [item.call_id, item.name]),
  );
  return items.map((item) => {
    const { call_id, ...rest } = item;
    if (item.type === "function_call")
      return { ...rest, callId: call_id, status: "completed" };
    if (item.type === "function_call_output") {
      const name = names.get(call_id);
      if (!name)
        throw new Error(
          `OpenAIAgentTarget: tool output ${String(call_id)} has no matching function call`,
        );
      return {
        ...rest,
        type: "function_call_result",
        callId: call_id,
        name,
        output: Array.isArray(item.output)
          ? item.output.map(sdkContent)
          : item.output,
        status: "completed",
      };
    }
    return {
      ...rest,
      type: "message",
      content: Array.isArray(item.content)
        ? item.content.map(sdkContent)
        : item.content,
      ...(item.role === "assistant" ? { status: "completed" } : {}),
    };
  });
}

function sdkUsage(raw: unknown): Usage | null {
  const requests = getField(raw, "requests");
  const usage = extractUsage(
    raw,
    typeof requests === "number" && Number.isInteger(requests) && requests >= 0
      ? requests
      : 1,
  );
  if (!usage) return null;
  for (const [source, key, destination] of [
    ["inputTokensDetails", "cached_tokens", "cachedTokens"],
    ["outputTokensDetails", "reasoning_tokens", "reasoningTokens"],
  ] as const) {
    const details = getField(raw, source);
    if (Array.isArray(details))
      usage[destination] = details.reduce((total, detail) => {
        const value = getField(detail, key);
        return (
          total +
          (typeof value === "number" && Number.isFinite(value) && value >= 0
            ? Math.trunc(value)
            : 0)
        );
      }, 0);
  }
  return usage;
}

function checkProviderResults(result: unknown): void {
  const responses = getField(result, "rawResponses");
  if (!Array.isArray(responses)) return;
  for (const response of responses) {
    const provider = getField(response, "providerData");
    const status = getField(provider, "status");
    const stopReason = responsesStopReason(provider);
    const choices = getField(provider, "choices");
    if (
      ["incomplete", "failed", "cancelled", "queued", "in_progress"].includes(
        String(status),
      ) ||
      getField(provider, "incomplete_details") != null ||
      stopReason === "length" ||
      (Array.isArray(choices) &&
        choices.some(
          (choice) => getField(choice, "finish_reason") === "length",
        ))
    )
      throw new Error(
        `OpenAIAgentTarget: provider response is ${String(status ?? stopReason ?? "truncated")}`,
      );
  }
}

function rejectRunContext(context: unknown): void {
  if (
    getField(context, "usage") !== undefined &&
    getField(context, "context") !== undefined &&
    [
      "getRejectionMessage",
      "isToolApproved",
      "approveTool",
      "rejectTool",
    ].every((method) => typeof getField(context, method) === "function")
  )
    throw new Error(
      "OpenAIAgentTarget: runOptions.context must contain application data, not a shared SDK RunContext",
    );
}

const BUILTIN_CALLS: Record<string, string> = {
  computer_call: "computer",
  shell_call: "shell",
  apply_patch_call: "apply_patch",
  tool_search_call: "tool_search",
  program: "program",
};
const BUILTIN_RESULTS = new Set([
  "computer_call_result",
  "shell_call_output",
  "apply_patch_call_output",
  "tool_search_output",
  "program_output",
]);

function sdkOutputItems(items: readonly unknown[]): Record<string, unknown>[] {
  const pendingSearch: string[] = [];
  return items.map((item) => {
    if (item === null || typeof item !== "object")
      throw new TypeError("OpenAIAgentTarget: output items must be objects");
    const fields = item as Record<string, unknown>;
    const type = String(fields.type);
    const provider = fields.providerData;
    let callId = type.startsWith("tool_search_")
      ? (getField(provider, "call_id") ??
        getField(provider, "callId") ??
        fields.call_id ??
        fields.callId)
      : (fields.callId ?? fields.call_id);
    if (type === "tool_search_call") {
      callId ??= fields.id;
      if (typeof callId === "string" && callId) pendingSearch.push(callId);
    } else if (type === "tool_search_output") {
      if (callId === undefined || callId === null) {
        const match =
          typeof fields.id === "string" ? pendingSearch.indexOf(fields.id) : -1;
        if (match >= 0) callId = pendingSearch[match];
        else if (pendingSearch.length === 1 || fields.execution === "client")
          callId = pendingSearch[0];
      }
      const match =
        typeof callId === "string" ? pendingSearch.indexOf(callId) : -1;
      if (match >= 0) pendingSearch.splice(match, 1);
    }
    if (Object.hasOwn(BUILTIN_CALLS, type) || BUILTIN_RESULTS.has(type)) {
      if (typeof callId !== "string" || !callId)
        throw new Error(
          `OpenAIAgentTarget: cannot correlate ${type} without a call id`,
        );
      if (BUILTIN_RESULTS.has(type)) {
        const {
          type: _type,
          callId: _callId,
          call_id: _call_id,
          ...result
        } = fields;
        return {
          type: "function_call_output",
          call_id: callId,
          output: toolResultToText(result),
        };
      }
      const argumentsValue =
        type === "program"
          ? { code: fields.code, fingerprint: fields.fingerprint }
          : type === "computer_call" && fields.actions !== undefined
            ? { action: fields.action, actions: fields.actions }
            : (fields.action ?? fields.operation ?? fields.arguments);
      return {
        ...fields,
        type: "function_call",
        call_id: callId,
        name: BUILTIN_CALLS[type],
        arguments:
          argumentsValue === undefined
            ? UNKNOWN_ARGUMENTS
            : typeof argumentsValue === "string"
              ? argumentsValue
              : toolResultToText(argumentsValue),
      };
    }
    if (type === "hosted_tool_call")
      return {
        ...fields,
        type: "function_call",
        call_id: fields.id,
        arguments: fields.arguments ?? "",
        result: fields.output ?? null,
      };
    if (
      ![
        "message",
        "function_call",
        "function_call_result",
        "reasoning",
      ].includes(type)
    )
      throw new Error(
        `OpenAIAgentTarget: unsupported output item type ${type}`,
      );
    return {
      ...fields,
      ...(callId === undefined ? {} : { call_id: callId }),
      ...(type === "function_call_result"
        ? {
            type: "function_call_output",
            output:
              contentPartText(fields.output) ?? toolResultToText(fields.output),
          }
        : {}),
    };
  });
}

function responseFromResult(
  result: unknown,
  model: string | null,
): AgentResponse {
  checkProviderResults(result);
  const finalOutput = getField(result, "finalOutput");
  if (finalOutput === undefined || finalOutput === null)
    throw new Error(
      "OpenAIAgentTarget: run returned no finalOutput; interrupted runs are not completed answers",
    );
  const items = getField(result, "output");
  if (!Array.isArray(items))
    throw new Error("OpenAIAgentTarget: run result has no output array");
  const wire = sdkOutputItems(items);
  const parsed = AgentResponse.fromOutputItems(wire);
  const finalText = toolResultToText(finalOutput);
  const lastText = parsed.output
    .filter((item) => item.type === "output_text")
    .at(-1);
  const output = [...parsed.output];
  let alreadyRendered =
    lastText?.type === "output_text" && lastText.text === finalText;
  if (
    !alreadyRendered &&
    typeof finalOutput !== "string" &&
    lastText?.type === "output_text"
  ) {
    try {
      const rawOutput = JSON.parse(lastText.text);
      if (!isDeepStrictEqual(rawOutput, finalOutput))
        output[output.lastIndexOf(lastText)] = textOutputItem(finalText);
      alreadyRendered = true;
    } catch {}
  }
  if (!alreadyRendered) output.push(textOutputItem(finalText));
  const rawResponses = getField(result, "rawResponses");
  const telemetry = getField(
    getField(
      Array.isArray(rawResponses) ? rawResponses.at(-1) : null,
      "providerData",
    ),
    "telemetry",
  );
  const traceId = getField(telemetry, "trace_id");
  const spanId = getField(telemetry, "span_id");
  return new AgentResponse({
    output,
    traceId: typeof traceId === "string" ? traceId : null,
    spanId: typeof spanId === "string" ? spanId : null,
    usage: sdkUsage(getField(getField(result, "runContext"), "usage")),
    model,
    responseId:
      typeof getField(result, "lastResponseId") === "string"
        ? (getField(result, "lastResponseId") as string)
        : null,
    refusal: parsed.refusal,
  });
}

export class OpenAIAgentTarget extends AgentTarget {
  private runner?: Promise<object>;
  private provider?: object;
  readonly options: OpenAIAgentTargetOptions;

  constructor(
    readonly agent: object,
    options: OpenAIAgentTargetOptions = {},
  ) {
    super();
    const runOptions = { ...options.runOptions };
    rejectRunContext(runOptions.context);
    for (const key of ["session", "conversationId", "previousResponseId"])
      if (runOptions[key] !== undefined)
        throw new Error(
          `OpenAIAgentTarget uses caller-owned history; runOptions.${key} cannot be shared between conversations`,
        );
    if (runOptions.stream)
      throw new Error("OpenAIAgentTarget requires a non-streaming run");
    if (options.runner && typeof getField(options.runner, "run") !== "function")
      throw new TypeError("OpenAIAgentTarget runner must expose run()");
    this.options = { ...options, runOptions };
  }

  private async getRunner(): Promise<object> {
    if (this.options.runner) return this.options.runner;
    this.runner ??= (async () => {
      const sdkName = "@openai/agents";
      let sdk: Record<string, unknown>;
      try {
        sdk = await import(sdkName);
      } catch (cause) {
        throw new Error(
          "OpenAIAgentTarget requires @openai/agents; install it or supply a runner",
          { cause },
        );
      }
      if (
        typeof sdk.Runner !== "function" ||
        typeof sdk.OpenAIProvider !== "function"
      )
        throw new Error("@openai/agents must export Runner and OpenAIProvider");
      const resolved =
        process.env.ORQ_API_KEY || process.env.OPENAI_API_KEY
          ? await resolveLlmClient(null, { maxRetries: 0 })
          : null;
      const provider = Reflect.construct(sdk.OpenAIProvider, [
        resolved ? { openAIClient: resolved.client } : {},
      ]);
      this.provider = provider;
      return Reflect.construct(sdk.Runner, [
        {
          modelProvider: provider,
          modelSettings: { retry: { maxRetries: 0 } },
          ...(resolved?.routesThroughOrq ? { tracingDisabled: true } : {}),
        },
      ]);
    })();
    return this.runner;
  }

  override async respond(
    messages: MessageInput[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    options.signal?.throwIfAborted();
    const normalized = messages.map((message) => MessageSchema.parse(message));
    const input = sdkInput(normalized);
    const context = await this.getAgentContext();
    return withLlmSpan(
      {
        model: context.model ?? context.key,
        provider: "openai-agents",
        operation: "agent",
        inputMessages: normalized,
        attributes: { "orq.llm.purpose": "target" },
      },
      async (span) => {
        const runner = await this.getRunner();
        const run = getField(runner, "run");
        if (typeof run !== "function")
          throw new TypeError("OpenAIAgentTarget runner must expose run()");
        const runOptions: Record<string, unknown> = {
          ...this.options.runOptions,
          stream: false,
        };
        rejectRunContext(runOptions.context);
        const configuredSignal = getField(runOptions, "signal");
        const signals = [options.signal, configuredSignal].filter(
          (signal): signal is AbortSignal => signal instanceof AbortSignal,
        );
        if (signals.length) runOptions.signal = AbortSignal.any(signals);
        let completedUsage: Usage | null = null;
        try {
          const result = await run.call(runner, this.agent, input, runOptions);
          completedUsage = sdkUsage(
            getField(getField(result, "runContext"), "usage"),
          );
          options.signal?.throwIfAborted();
          const response = responseFromResult(result, context.model);
          if (response.traceId)
            span?.setAttribute("orq.trace_id", response.traceId);
          if (response.spanId)
            span?.setAttribute("orq.span_id", response.spanId);
          if (response.usage) recordTokenUsage(span, { usage: response.usage });
          recordLlmOutput(span, response.text);
          return response;
        } catch (error) {
          const state = getField(error, "state");
          const usage =
            sdkUsage(getField(getField(state, "_context"), "usage")) ??
            completedUsage;
          if (usage) recordTokenUsage(span, { usage });
          if (
            usage &&
            error !== null &&
            typeof error === "object" &&
            Object.isExtensible(error)
          )
            Object.assign(error, { usage });
          throw error;
        }
      },
    );
  }

  async close(): Promise<void> {
    if (this.options.runner || !this.runner) return;
    await this.runner;
    const close = getField(this.provider, "close");
    if (typeof close === "function") await close.call(this.provider);
    this.provider = undefined;
    this.runner = undefined;
  }

  override newInstance(): OpenAIAgentTarget {
    return new OpenAIAgentTarget(this.agent, {
      ...this.options,
      runOptions: { ...this.options.runOptions },
    });
  }

  override async getAgentContext(): Promise<AgentContext> {
    const name = getField(this.agent, "name");
    const instructions = getField(this.agent, "instructions");
    const model = getField(this.agent, "model");
    const tools = getField(this.agent, "tools");
    return AgentContextSchema.parse({
      key: typeof name === "string" && name ? name : "openai_agent",
      displayName: typeof name === "string" ? name : null,
      description: "OpenAI Agents SDK target",
      systemPrompt: typeof instructions === "string" ? instructions : "",
      model:
        typeof model === "string"
          ? model
          : typeof getField(model, "model") === "string"
            ? getField(model, "model")
            : null,
      isMultiAgent:
        Array.isArray(getField(this.agent, "handoffs")) &&
        (getField(this.agent, "handoffs") as unknown[]).length > 0,
      tools: Array.isArray(tools)
        ? tools.map((tool) => ({
            name: getField(tool, "name"),
            description: getField(tool, "description"),
            parameters: getField(tool, "parameters"),
          }))
        : [],
    });
  }
}
