import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  buildEvalReplacements,
  ClassifyQuestionSchema,
  classifyVerdict,
  EVALUATOR_RESPONSE_FORMAT,
  JudgeError,
  resetResponsesRejectors,
  runClassifyJudges,
  runJudge,
  stripCodeFences,
  verdictCoerced,
} from "../../../src/lib/common/judge.js";
import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
  resetCatalogueCache,
} from "../../../src/lib/common/model-catalogue.js";
import {
  isConnectionError,
  isRetryableError,
} from "../../../src/lib/common/retry.js";
import { LLMCallConfig } from "../../../src/lib/contracts.js";

interface Scripted {
  status: number;
  body: unknown;
  delayMs?: number;
}

let script: Scripted[] = [];
let requests: { path: string; body: Record<string, unknown> }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") {
      return Response.json([]);
    }
    requests.push({
      path: new URL(request.url).pathname.split("/v3/router").at(-1) ?? "",
      body: (await request.json()) as Record<string, unknown>,
    });
    const next = script.shift() ?? { status: 500, body: { error: {} } };
    if (next.delayMs) {
      await Bun.sleep(next.delayMs);
    }
    return Response.json(next.body, { status: next.status });
  },
});

afterAll(() => server.stop(true));

const client = () =>
  new OpenAI({
    apiKey: "k",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });

const chat = (content: string | null) => ({
  status: 200,
  body: {
    id: "c",
    object: "chat.completion",
    created: 1,
    model: "served",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
});

const responses = (text: string) => ({
  status: 200,
  body: {
    id: "r",
    object: "response",
    created_at: 1,
    model: "served",
    status: "completed",
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    output: [
      {
        type: "message",
        id: "m",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  },
});

const classifyReply = (answers: Record<string, unknown>) => ({
  status: 200,
  body: {
    answers,
    usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
    model: "served",
  },
});

const verdict = '{"explanation":"because","abstain":false,"value":true}';
const cfg = (extra: Record<string, unknown> = {}) =>
  new LLMCallConfig({ retryCount: 0, maxTokens: 100, ...extra });

function judge(extra: Partial<Parameters<typeof runJudge>[0]> = {}) {
  return runJudge({
    client: client(),
    model: "openai/m",
    cfg: cfg(),
    promptTemplate: "Rate {{log.input}}",
    replacements: { log: { input: "hello" } },
    ...extra,
  });
}

const info = (extra: Record<string, unknown>) =>
  new ModelInfo({
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    provider: "openai",
    supportsResponses: true,
    ...extra,
  });

beforeEach(() => {
  script = [];
  requests = [];
  resetCatalogueCache();
  clearModelOverrides();
  resetResponsesRejectors();
  registerModel("openai/m", info({}));
  registerModel(
    "acme/jev",
    info({ supportsClassify: true, supportsResponses: false }),
  );
});

describe("runJudge on chat completions", () => {
  test("sends json_object and renders the template", async () => {
    script = [chat(verdict)];
    const outcome = await judge();
    expect(outcome.payload?.value).toBe(true);
    expect(outcome.endpoint).toBe("chat");
    expect(requests[0]?.path).toBe("/chat/completions");
    expect(requests[0]?.body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(requests[0]?.body.messages)).toContain("Rate hello");
  });

  test("unwraps a fenced verdict", async () => {
    script = [chat(`\`\`\`json\n${verdict}\n\`\`\``)];
    expect((await judge()).payload?.explanation).toBe("because");
  });

  test("malformed JSON keeps the raw body for the report", async () => {
    script = [chat("not json")];
    const outcome = await judge();
    expect(outcome.errorKind).toBe(JudgeError.PARSE);
    expect(outcome.rawContent).toBe("not json");
  });

  test("abstain discards a value and is flagged as coerced", async () => {
    script = [chat('{"explanation":"e","abstain":true,"value":false}')];
    const outcome = await judge();
    expect(outcome.payload?.abstain).toBe(true);
    expect(outcome.payload?.value).toBeNull();
    expect(verdictCoerced(outcome)).toBe(true);
  });

  test("a real SDK 500 is an api_status outcome and is retried", async () => {
    script = [
      { status: 500, body: { error: { message: "boom" } } },
      chat(verdict),
    ];
    const outcome = await judge({ cfg: cfg({ retryCount: 1 }) });
    expect(outcome.payload?.value).toBe(true);
    expect(requests).toHaveLength(2);
  });

  test("a real SDK 401 is reported without a retry", async () => {
    script = [{ status: 401, body: { error: { message: "no" } } }];
    const outcome = await judge({ cfg: cfg({ retryCount: 2 }) });
    expect(outcome.errorKind).toBe(JudgeError.API_STATUS);
    expect(requests).toHaveLength(1);
  });

  test("a closed port is a connection error", async () => {
    const closed = new OpenAI({
      apiKey: "k",
      baseURL: "http://127.0.0.1:1/v3/router",
      maxRetries: 0,
    });
    const caught = await closed.chat.completions
      .create({ model: "m", messages: [] })
      .catch((error: unknown) => error);
    expect(isConnectionError(caught)).toBe(true);
    expect(isRetryableError(caught)).toBe(true);
    const outcome = await judge({ client: closed });
    expect(outcome.errorKind).toBe(JudgeError.API_CONNECTION);
  });

  test("a slow reply is a timeout outcome", async () => {
    script = [{ ...chat(verdict), delayMs: 400 }];
    const outcome = await judge({ cfg: cfg({ timeoutMs: 50 }) });
    expect(outcome.errorKind).toBe(JudgeError.TIMEOUT);
    expect(outcome.timeoutMs).toBe(50);
  });

  test("the strict schema drops null defaults and keeps a flat union", async () => {
    script = [chat(verdict)];
    await judge({ responseModel: EVALUATOR_RESPONSE_FORMAT });
    const format = requests[0]?.body.response_format as {
      json_schema: { schema: { properties: { value: object } } };
    };
    const { value } = format.json_schema.schema.properties;
    expect(value).not.toHaveProperty("default");
    expect(value).toEqual({
      anyOf: [
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "null" },
      ],
    });
  });

  test("a schema 400 falls back to json_object", async () => {
    script = [
      {
        status: 400,
        body: { error: { message: "response_format not allowed" } },
      },
      chat(verdict),
    ];
    const outcome = await judge({ responseModel: EVALUATOR_RESPONSE_FORMAT });
    expect(outcome.payload?.value).toBe(true);
    expect(requests).toHaveLength(2);
  });
});

describe("runJudge on the Responses API", () => {
  const api = () => cfg({ api: "responses" });

  test("uses /responses and keeps the verdict description", async () => {
    script = [responses(verdict)];
    const outcome = await judge({ cfg: api() });
    expect(outcome.endpoint).toBe("responses");
    expect(requests[0]?.path).toBe("/responses");
    const { format } = requests[0]?.body.text as {
      format: { schema: Record<string, unknown> };
    };
    expect(format.schema.description).toContain("judge's verdict");
  });

  test("a 400 naming the endpoint moves the model to chat for later calls", async () => {
    registerModel("openai/m2", info({}));
    script = [
      {
        status: 400,
        body: { error: { message: "text_format is not supported" } },
      },
      chat(verdict),
      chat(verdict),
    ];
    await judge({ cfg: api(), model: "openai/m2" });
    await judge({ cfg: api(), model: "openai/m2" });
    expect(requests.map((request) => request.path)).toEqual([
      "/responses",
      "/chat/completions",
      "/chat/completions",
    ]);
  });
});

describe("classify judges", () => {
  const noul = ClassifyQuestionSchema.parse({
    kind: "noul",
    instructions: "Ok?",
    criteria: { true: "y", false: "n" },
    state: "s",
    noulThreshold: 0.3,
  });
  const score = ClassifyQuestionSchema.parse({
    kind: "score",
    instructions: "Rate",
    criteria: ["bad", "mid", "good"],
    state: "s",
  });

  test("a classify model posts to /decisions and thresholds noul", async () => {
    script = [classifyReply({ verdict: { type: "noul", noul: 0.71 } })];
    const outcome = await judge({ model: "acme/jev", classify: noul });
    expect(requests[0]?.path).toBe("/decisions");
    expect(outcome.payload?.value).toBe(true);
    expect(outcome.endpoint).toBe("classify");
  });

  test("a classify-only model without a question fails before any call", async () => {
    const outcome = await judge({ model: "typesafe/jev-latest" });
    expect(outcome.errorKind).toBe(JudgeError.UNKNOWN);
    expect(outcome.errorMessage).toContain("classify-only");
    expect(requests).toHaveLength(0);
  });

  test("a missing answer fails only that question and keeps usage", async () => {
    script = [classifyReply({ a: { type: "noul", noul: 0.8 } })];
    const outcomes = await runClassifyJudges({
      client: client(),
      model: "acme/jev",
      cfg: cfg(),
      state: "state",
      questions: { a: noul, b: score },
    });
    expect(requests).toHaveLength(1);
    expect(outcomes.a?.payload?.value).toBe(true);
    expect(outcomes.b?.errorKind).toBe(JudgeError.PARSE);
    expect(outcomes.b?.tokenUsage?.totalTokens).toBe(8);
  });

  test("classifyVerdict rejects a type that does not match the question", () => {
    expect(
      classifyVerdict(score, { type: "choice", choice: "a" } as never),
    ).toBeNull();
  });
});

describe("buildEvalReplacements", () => {
  test("plain messages pass through and a prefix namespaces every key", () => {
    const content = [{ type: "text", text: "x" }];
    const reps = buildEvalReplacements({
      inputMessages: [{ role: "user", content, name: "n" }],
      outputMessages: [],
      prefix: "response_a",
    }) as { response_a: { log: { input: unknown; messages: unknown[] } } };
    expect(reps.response_a.log.input).toEqual(content);
    expect(reps.response_a.log.messages[0]).toHaveProperty("name", "n");
    expect(reps).toHaveProperty(["response_a.log.messages"]);
  });

  test("flat keys escape non-ascii like json.dumps", () => {
    const reps = buildEvalReplacements({
      inputMessages: [{ role: "user", content: "hé" }],
      outputMessages: [],
    });
    expect(reps["log.messages"]).toContain("\\u00e9");
  });
});

test("stripCodeFences leaves a backtick run inside the JSON alone", () => {
  expect(stripCodeFences('```json\n{"a":"```"}\n```\n')).toBe('{"a":"```"}');
  expect(stripCodeFences("plain")).toBe("plain");
});
test("legacy classify questions retain their boolean decision threshold", () => {
  const question = ClassifyQuestionSchema.parse({
    kind: "noul",
    instructions: "Judge",
    state: {},
    noul_threshold: 0.8,
  });
  expect(question.noulThreshold).toBe(0.8);
  expect(() =>
    ClassifyQuestionSchema.parse({ ...question, noul_threshold: 0.5 }),
  ).toThrow("Conflicting");
});
