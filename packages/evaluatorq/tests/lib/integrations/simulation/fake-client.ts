import { expect } from "bun:test";

import OpenAI from "openai";

/**
 * What strict mode demands of a schema: closed objects, every property required,
 * and null spelled as a type. The `nullable` keyword looks valid, but models
 * ignore it and invent a value instead of answering null.
 */
export function expectStrictSchema(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) expectStrictSchema(item);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;

  const node = schema as Record<string, unknown>;
  expect(node).not.toHaveProperty("nullable");
  expect(node).not.toHaveProperty("$schema");
  if (node.type === "object") {
    const keys = Object.keys(node.properties as object).sort();
    expect([...(node.required as string[])].sort()).toEqual(keys);
    expect(node.additionalProperties).toBe(false);
    for (const value of Object.values(node.properties as object)) {
      expectStrictSchema(value);
    }
  }
  expectStrictSchema(node.items);
  expectStrictSchema(node.anyOf);
}

type Request = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** The judge goes through the Responses API. */
export interface JudgeRequest {
  instructions?: string;
  text?: { format?: { name?: string; strict?: boolean; schema?: unknown } };
  model: string;
  input: { role: string; content: string }[];
  temperature?: number;
  max_output_tokens?: number;
  tool_choice?: string;
  tools?: {
    type: string;
    name: string;
    strict?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
  }[];
}

export interface JudgeTurn {
  tool: "continue_conversation" | "finish_conversation";
  args: Record<string, unknown>;
}

export interface FakeScript {
  analysis?: (
    request: Request,
    options?: { timeout?: number },
  ) => string | { content: string; finishReason?: string };
  /** Reply for the nth judge call. Throw to fail the call, null for no tool call. */
  judge?: (call: number, request: JudgeRequest) => JudgeTurn | null;
  /** Rewrite the Responses API reply built from the judge's turn. */
  judgeResponse?: (
    reply: Record<string, unknown> & { output: unknown[] },
  ) => Record<string, unknown>;
  userSimulator?: (
    request: Request,
    options?: { signal?: AbortSignal },
  ) => string | { content: string; finishReason?: string } | Promise<string>;
  firstMessage?: (
    request: Request,
    options?: { timeout?: number },
  ) => string | { content: string; finishReason?: string };
  /** Reply for generator calls, which are the ones sending response_format. */
  generator?: (
    request: Request,
    options?: { timeout?: number },
  ) => { content: string; finishReason?: string };
}

export interface FakeRequests {
  analysis: Request[];
  judge: JudgeRequest[];
  userSimulator: Request[];
  firstMessage: Request[];
  generator: Request[];
}

export function continueTurn(
  verdicts: unknown,
  extra: Record<string, unknown> = {},
): JudgeTurn {
  return {
    tool: "continue_conversation",
    args: { reason: "keep going", criteria_verdicts: verdicts, ...extra },
  };
}

export function finishTurn(
  verdicts: unknown,
  extra: Record<string, unknown> = {},
): JudgeTurn {
  return {
    tool: "finish_conversation",
    args: {
      reason: "done",
      goal_achieved: true,
      goal_completion_score: 1,
      criteria_verdicts: verdicts,
      ...extra,
    },
  };
}

function completion(
  message: Record<string, unknown>,
  finishReason = "stop",
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "fake",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          ...message,
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

/**
 * A scripted OpenAI client that tells the simulation's LLM calls apart by what
 * they send, so a whole run can execute against the real runner.
 */
export function makeFakeClient(script: FakeScript = {}): {
  client: OpenAI;
  requests: FakeRequests;
} {
  const requests: FakeRequests = {
    analysis: [],
    judge: [],
    userSimulator: [],
    firstMessage: [],
    generator: [],
  };

  const createResponse = async (
    request: JudgeRequest & {
      instructions?: string;
      text?: { format?: Record<string, unknown> };
    },
    options?: { timeout?: number; signal?: AbortSignal },
  ) => {
    const decision = request.text?.format?.name === "JudgeDecision";
    if (!request.tools?.length && !decision) {
      const format = request.text?.format;
      const messages = (request.input ?? []).map((item) => ({
        ...item,
        content: Array.isArray(item.content)
          ? (item.content as { text?: string }[])
              .map((part) => part.text ?? "")
              .join("")
          : item.content,
      }));
      if (request.instructions)
        messages.unshift({ role: "system", content: request.instructions });
      const chatRequest = {
        model: request.model,
        messages,
        max_tokens: request.max_output_tokens,
        temperature: request.temperature,
        ...(format
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: format.name,
                  strict: format.strict,
                  schema: format.schema,
                },
              },
            }
          : {}),
      } as Request;
      const response = await create(chatRequest, options);
      const choice = response.choices[0];
      return {
        id: "fake",
        created_at: 0,
        model: request.model,
        status: choice?.finish_reason === "length" ? "incomplete" : "completed",
        incomplete_details:
          choice?.finish_reason === "length"
            ? { reason: "max_output_tokens" }
            : null,
        output_text: choice?.message.content ?? "",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: choice?.message.content ?? "" },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    }
    const call = requests.judge.length;
    requests.judge.push(request);
    const turn = script.judge
      ? script.judge(call, request)
      : finishTurn([], {});
    const content = turn
      ? JSON.stringify({
          ...turn.args,
          should_terminate: turn.tool === "finish_conversation",
        })
      : "no decision";
    const reply = {
      id: "fake",
      created_at: 0,
      model: request.model,
      status: "completed",
      output_text: decision ? content : turn ? "" : "no decision",
      output: decision
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: content }],
            },
          ]
        : turn
          ? [
              {
                type: "function_call",
                call_id: `call_${call}`,
                name: turn.tool,
                arguments: JSON.stringify(turn.args),
              },
            ]
          : [],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    return script.judgeResponse ? script.judgeResponse(reply) : reply;
  };

  const create = async (
    request: Request,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => {
    const analysisSchema =
      request.response_format?.type === "json_schema" &&
      request.response_format.json_schema.name === "SimulationSuggestions";
    const summary = request.messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("summarizing an agent simulation report"),
    );
    if (analysisSchema || summary) {
      requests.analysis.push(request);
      const reply =
        script.analysis?.(request, options) ??
        (analysisSchema
          ? JSON.stringify({ suggestions: [] })
          : "One simulation completed.");
      return typeof reply === "string"
        ? completion({ content: reply })
        : completion({ content: reply.content }, reply.finishReason);
    }
    // What the router answers for the default model.
    if (request.tools) {
      throw new OpenAI.APIError(
        400,
        { message: "does not support function tools while reasoning" },
        "does not support function tools while reasoning on chat completions",
        {},
      );
    }

    if (request.response_format) {
      requests.generator.push(request);
      const reply = script.generator?.(request, options) ?? { content: "[]" };
      return completion({ content: reply.content }, reply.finishReason);
    }

    const system = request.messages[0]?.content;
    if (
      typeof system === "string" &&
      system.includes("authentic first message")
    ) {
      requests.firstMessage.push(request);
      const reply =
        script.firstMessage?.(request, options) ?? "Hi, I need help.";
      return typeof reply === "string"
        ? completion({ content: reply })
        : completion({ content: reply.content }, reply.finishReason);
    }

    requests.userSimulator.push(request);
    const reply =
      (await script.userSimulator?.(request, options)) ?? "Please continue.";
    return typeof reply === "string"
      ? completion({ content: reply })
      : completion({ content: reply.content }, reply.finishReason);
  };

  return {
    client: {
      chat: { completions: { create } },
      responses: { create: createResponse },
    } as unknown as OpenAI,
    requests,
  };
}
