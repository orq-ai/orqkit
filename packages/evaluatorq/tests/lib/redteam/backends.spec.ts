import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import OpenAI, { AzureOpenAI } from "openai";

import { OrqError } from "@orq-ai/node/models/errors/orqerror.js";

import { executeChatCompletion } from "../../../src/lib/common/llm-call.js";
import { withoutClientRetries } from "../../../src/lib/common/retry.js";
import {
  callTargetWithRetry,
  extractStatusCode,
} from "../../../src/lib/common/target-call.js";
import {
  conversationThread,
  evaluatorqPipeline,
  evaluatorqRunId,
} from "../../../src/lib/common/thread-context.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  MessageSchema,
} from "../../../src/lib/contracts.js";
import {
  Backend,
  BareTargetBackend,
  CredentialError,
  extractProviderErrorCode,
  HybridAgentBackend,
  mapProviderError,
  OpenAIBackend,
  OpenAIModelTarget,
  OpenResponsesBackend,
  validateAgentTarget,
} from "../../../src/lib/redteam/index.js";

let env: Record<string, string | undefined>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  env = {};
  for (const key of [
    "ORQ_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "ORQ_DISABLE_TRACING",
  ]) {
    env[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ORQ_DISABLE_TRACING = "1";
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  warn.mockRestore();
});
const reply = () => ({
  id: "reply",
  object: "chat.completion",
  created: 0,
  model: "echo",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "mango" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
    input_cost: 0.01,
    output_cost: 0.02,
    total_cost: 0.03,
  },
});
const messages = () => [MessageSchema.parse({ role: "user", content: "Hi" })];
function sdk(status = 200, baseURL = "https://native.test/v1") {
  const requests: Request[] = [];
  const bodies: Record<string, unknown>[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    baseURL,
    maxRetries: 2,
    fetch: (async (input: string | Request | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      requests.push(request);
      bodies.push((await request.clone().json()) as Record<string, unknown>);
      return status === 200
        ? Response.json(reply())
        : Response.json(
            { error: { message: "Failed", type: "temporary", code: "failed" } },
            { status },
          );
    }) as unknown as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >["fetch"],
  });
  return { client, requests, bodies };
}
it("disables real OpenAI SDK v4 retries without changing the caller's client or transport", async () => {
  const fake = sdk(500);
  const clone = withoutClientRetries(fake.client);
  expect(clone).not.toBe(fake.client);
  expect(clone.maxRetries).toBe(0);
  expect(fake.client.maxRetries).toBe(2);
  await expect(
    (async () =>
      await clone.chat.completions.create({
        model: "echo",
        messages: [{ role: "user", content: "Hi" }],
      }))(),
  ).rejects.toThrow();
  expect(fake.requests).toHaveLength(1);
});
it("preserves Azure API version, deployment and token-provider authentication when disabling v4 retries", async () => {
  const requests: Request[] = [];
  const client = new AzureOpenAI({
    apiVersion: "2024-10-21",
    endpoint: "https://azure.test",
    deployment: "echo-deployment",
    azureADTokenProvider: async () => "synthetic-token",
    maxRetries: 2,
    fetch: (async (input: string | Request | URL, init?: RequestInit) => {
      requests.push(
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init),
      );
      return Response.json(reply());
    }) as unknown as NonNullable<
      ConstructorParameters<typeof AzureOpenAI>[0]
    >["fetch"],
  });
  const clone = withoutClientRetries(client);
  expect(clone.maxRetries).toBe(0);
  expect(client.maxRetries).toBe(2);
  await clone.chat.completions.create({
    model: "echo",
    messages: [{ role: "user", content: "Hi" }],
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toContain(
    "/deployments/echo-deployment/chat/completions",
  );
  expect(requests[0]?.url).toContain("api-version=2024-10-21");
  expect(requests[0]?.headers.get("authorization")).toBe(
    "Bearer synthetic-token",
  );
});
it("replays tool history, replaces system prompts, forwards attribution and keeps response usage", async () => {
  const fake = sdk(200, "https://router.test/v3/router");
  const target = new OpenAIModelTarget("echo", {
    client: fake.client,
    systemPrompt: "Configured",
    maxTokens: 4000,
    reasoningEffort: "low",
  });
  const result = await evaluatorqPipeline("redteam", () =>
    evaluatorqRunId("run", () =>
      conversationThread("thread", () =>
        target.respond([
          MessageSchema.parse({ role: "system", content: "Discard" }),
          ...messages(),
          MessageSchema.parse({
            role: "assistant",
            tool_calls: [
              {
                id: "old",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          }),
          MessageSchema.parse({
            role: "tool",
            tool_call_id: "old",
            content: "found",
          }),
          MessageSchema.parse({ role: "system", content: "Discard too" }),
        ]),
      ),
    ),
  );
  expect(result.text).toBe("mango");
  expect(result.usage).toMatchObject({
    totalTokens: 5,
    totalCost: 0.03,
    calls: 1,
    pricedCalls: 1,
  });
  expect(result.responseId).toBe("reply");
  expect(result.finishReason).toBe("stop");
  expect(fake.bodies[0]).toMatchObject({
    max_completion_tokens: 4000,
    reasoning_effort: "low",
    metadata: { evaluatorq_pipeline: "redteam", evaluatorq_run_id: "run" },
    thread: { id: "thread" },
  });
  expect(fake.bodies[0]).not.toHaveProperty("max_tokens");
  const sent = fake.bodies[0]?.messages as {
    role: string;
    content?: unknown;
    tool_call_id?: string;
  }[];
  expect(sent.filter((message) => message.role === "system")).toEqual([
    { role: "system", content: "Configured" },
  ]);
  expect(sent.find((message) => message.role === "tool")).toMatchObject({
    tool_call_id: "old",
    content: "found",
  });
  expect((await target.getAgentContext()).model).toBe("echo");
  expect(target.newInstance()).not.toBe(target);
  expect(target.memoryEntityId).toBeNull();
});
it("uses the classic budget field without reasoning and omits router thread data for a direct client", async () => {
  const fake = sdk();
  const target = new OpenAIModelTarget("echo", {
    client: fake.client,
    maxTokens: 123,
  });
  await conversationThread("thread", () => target.respond(messages()));
  expect(fake.bodies[0]).toHaveProperty("max_tokens", 123);
  expect(fake.bodies[0]).not.toHaveProperty("max_completion_tokens");
  expect(fake.bodies[0]).not.toHaveProperty("thread");
});
it("keeps target retries at the shared boundary with the actual SDK", async () => {
  const fake = sdk(500);
  const target = new OpenAIModelTarget("echo", { client: fake.client });
  const result = await callTargetWithRetry(target, messages(), {
    maxTargetRetries: 1,
    targetAgentTimeoutMs: 5000,
  });
  expect(result.attempts).toBe(2);
  expect(fake.requests).toHaveLength(2);
  expect(fake.client.maxRetries).toBe(2);
});
it("does not strip or self-retry rejected reasoning, even when a common caller memoized it", async () => {
  const seen: Record<string, unknown>[] = [];
  let fail = true;
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          seen.push(structuredClone(body));
          if (fail && body.reasoning_effort) {
            fail = false;
            throw Object.assign(
              new Error("Unsupported parameter: reasoning_effort"),
              { status: 400 },
            );
          }
          return reply();
        },
      },
    },
  } as unknown as OpenAI;
  await executeChatCompletion({
    client,
    model: "native-no-fallback",
    messages: [],
    span: undefined,
    timeoutMs: 1000,
    reasoningEffort: "low",
  });
  expect(seen).toHaveLength(2);
  seen.length = 0;
  fail = true;
  await expect(
    new OpenAIModelTarget("native-no-fallback", {
      client,
      reasoningEffort: "low",
    }).respond(messages()),
  ).rejects.toThrow("reasoning_effort");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toHaveProperty("reasoning_effort", "low");
});
it("retains provider tool-call ids separately from Responses item ids and keeps refusal metadata", async () => {
  const data = reply();
  const client = {
    chat: {
      completions: {
        create: async () => ({
          ...data,
          choices: [
            {
              message: {
                content: null,
                refusal: "Policy refusal",
                tool_calls: [
                  {
                    id: "provider-call",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"hello"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      },
    },
  } as unknown as OpenAI;
  const result = await new OpenAIModelTarget("echo", { client }).respond(
    messages(),
  );
  expect(result.toolCalls[0]?.call_id).toBe("provider-call");
  expect(result.toolCalls[0]?.id).toStartWith("fc_");
  expect(result.refusal).toBe("Policy refusal");
  expect(result.finishReason).toBe("tool_calls");
});
it("does not silently accept missing client credentials", async () => {
  const target = new OpenAIModelTarget("echo");
  await expect(target.respond(messages())).rejects.toBeInstanceOf(
    CredentialError,
  );
});
class ProbeTarget extends AgentTarget {
  constructor(readonly context: () => Promise<AgentContext>) {
    super();
  }
  override async respond() {
    return new AgentResponse({ text: "ok" });
  }
  override newInstance() {
    return new ProbeTarget(this.context);
  }
  override getAgentContext() {
    return this.context();
  }
}
class ProbeBackend extends Backend {
  created: string[] = [];
  cleaned: string[][] = [];
  constructor(readonly factory: () => Promise<AgentContext>) {
    super("probe");
  }
  override createTarget(key: string) {
    this.created.push(key);
    return new ProbeTarget(this.factory);
  }
  override async cleanupMemory(_context: AgentContext, ids: string[]) {
    this.cleaned.push(ids);
  }
}
it("caches modeled contexts and degrades only validation failures", async () => {
  const backend = new ProbeBackend(async () =>
    AgentContextSchema.parse({ key: "k" }),
  );
  const one = await backend.resolveContext("k");
  expect(await backend.resolveContext("k")).toBe(one);
  expect(backend.created).toEqual(["k"]);
  const invalid = new ProbeBackend(async () =>
    AgentContextSchema.parse({ key: 4 }),
  );
  expect((await invalid.resolveContext("k")).key).toBe("k");
  const forbidden = new ProbeBackend(async () => {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  });
  await expect(forbidden.resolveContext("k")).rejects.toThrow("Forbidden");
});
it("uses lazy context/cleanup for hybrid execution and mints independent memory scopes", async () => {
  let constructed = 0;
  const context = new ProbeBackend(async () =>
    AgentContextSchema.parse({ key: "k" }),
  );
  const backend = new HybridAgentBackend({
    execBackend: new OpenResponsesBackend(),
    contextBackendFactory: () => {
      constructed++;
      return context;
    },
  });
  const target = backend.createTarget("agent/key");
  expect(constructed).toBe(0);
  expect(target.memoryEntityId).toMatch(/^red-team-[a-f0-9]{12}$/);
  expect(
    (target as unknown as { config: { model: string } }).config.model,
  ).toBe("agent/key");
  expect(target.newInstance().memoryEntityId).not.toBe(target.memoryEntityId);
  await backend.resolveContext("key");
  await backend.cleanupMemory(AgentContextSchema.parse({ key: "k" }), ["id"]);
  expect(constructed).toBe(1);
  expect(context.cleaned).toEqual([["id"]]);
  expect(
    () => new HybridAgentBackend({ execBackend: new OpenResponsesBackend() }),
  ).toThrow("exactly one");
});
it("clones bare targets and warns when created memory is not cleaned up", async () => {
  const target = new ProbeTarget(async () =>
    AgentContextSchema.parse({ key: "k" }),
  );
  const backend = new BareTargetBackend(target);
  expect(backend.createTarget("ignored")).not.toBe(target);
  await backend.cleanupMemory(AgentContextSchema.parse({ key: "k" }), ["id"]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(backend.mapError(new Error("bad")).code).toBe("target_error");
  expect(() => validateAgentTarget({ clone() {} })).toThrow("newInstance");
  expect(() => validateAgentTarget(target)).not.toThrow();
});
it("creates independent native/Responses targets with backend config and cached local context", async () => {
  const fake = sdk();
  const backend = new OpenAIBackend({
    client: fake.client,
    systemPrompt: "Prompt",
  });
  expect(backend.createTarget("echo")).not.toBe(backend.createTarget("echo"));
  const responses = new OpenResponsesBackend({
    instructions: "Prompt",
    timeoutMs: 1234,
    reasoningEffort: "low",
  });
  const target = responses.createTarget("agent/key");
  expect(target.config).toMatchObject({
    model: "agent/key",
    timeoutMs: 1234,
    reasoningEffort: "low",
  });
  expect(target.options.requireOrq).toBe(true);
  const context = await responses.resolveContext("agent/key");
  expect(context.systemPrompt).toBe("Prompt");
  expect(await responses.resolveContext("agent/key")).toBe(context);
});
it("classifies actual Node SDK camelCase HTTP status codes before provider labels", async () => {
  const error = new OrqError("Forbidden", {
    response: new Response("denied", { status: 403 }),
    request: new Request("https://native.test"),
    body: "denied",
  });
  expect(extractStatusCode(error)).toBe(403);
  expect(mapProviderError("orq", error).code).toBe("orq.http.403");
  const target = {
    respond: async () => {
      throw error;
    },
  };
  const result = await callTargetWithRetry(target, [], {
    maxTargetRetries: 2,
    targetAgentTimeoutMs: 1000,
  });
  expect(result.attempts).toBe(1);
});
it("extracts provider symbolic codes from attrs/body/text and maps named errors", () => {
  expect(
    extractProviderErrorCode(
      Object.assign(new Error("bad"), { code: "  INVALID_INPUT  " }),
    ),
  ).toBe("invalid_input");
  expect(
    extractProviderErrorCode({ body: { error: { type: "RATE_LIMIT" } } }),
  ).toBe("rate_limit");
  expect(extractProviderErrorCode(new Error("code=Invalid_Request"))).toBe(
    "invalid_request",
  );
  expect(
    mapProviderError(
      "openai",
      Object.assign(new Error("bad"), { status: 429, code: "other" }),
    ).code,
  ).toBe("openai.http.429");
  class AuthenticationError extends Error {}
  expect(
    mapProviderError("openresponses", new AuthenticationError("bad")).code,
  ).toBe("openresponses.auth");
});
