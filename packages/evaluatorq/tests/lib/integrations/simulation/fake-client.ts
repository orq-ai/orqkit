import OpenAI from "openai";

type Request = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** The judge goes through the Responses API. */
export interface JudgeRequest {
  model: string;
  input: { role: string; content: string }[];
  temperature?: number;
  max_output_tokens?: number;
  tool_choice?: string;
  tools?: {
    type: string;
    name: string;
    strict?: boolean;
    parameters?: { properties?: Record<string, unknown> };
  }[];
}

export interface JudgeTurn {
  tool: "continue_conversation" | "finish_conversation";
  args: Record<string, unknown>;
}

export interface FakeScript {
  /** Reply for the nth judge call. Throw to fail the call, null for no tool call. */
  judge?: (call: number, request: JudgeRequest) => JudgeTurn | null;
  /** Rewrite the Responses API reply built from the judge's turn. */
  judgeResponse?: (
    reply: Record<string, unknown> & { output: unknown[] },
  ) => Record<string, unknown>;
  userSimulator?: (
    request: Request,
  ) => string | { content: string; finishReason?: string };
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
    judge: [],
    userSimulator: [],
    firstMessage: [],
    generator: [],
  };

  const createResponse = async (request: JudgeRequest) => {
    const call = requests.judge.length;
    requests.judge.push(request);
    const turn = script.judge
      ? script.judge(call, request)
      : finishTurn([], {});
    const reply = {
      id: "fake",
      created_at: 0,
      model: request.model,
      status: "completed",
      output_text: turn ? "" : "no decision",
      output: turn
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

  const create = async (request: Request, options?: { timeout?: number }) => {
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
    const reply = script.userSimulator?.(request) ?? "Please continue.";
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
