import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  callTargetWithRetry,
  NonRetryableTargetError,
} from "../../../src/lib/common/target-call.js";
import { MessageSchema } from "../../../src/lib/contracts.js";
import {
  type AISdkMessageFormat,
  messageToAISdkMessage,
  parseAISdkDataStream,
  parseAISdkHttpResponse,
  parseAISdkJsonResponse,
  VercelAISdkTarget,
} from "../../../src/lib/integrations/ai-sdk/http-target.js";
import { simulate } from "../../../src/lib/integrations/simulation/index.js";
import {
  canonicalUsage,
  parseSavedDatapoint,
} from "../../../src/lib/integrations/simulation/run-store.js";
import fixtures from "../fixtures/ai-sdk-http-python-goldens.json" with {
  type: "json",
};
import runFixture from "../fixtures/simulation-run-python-goldens.json" with {
  type: "json",
};
import { makeFakeClient } from "./simulation/fake-client.js";

for (const [index, entry] of fixtures.responses.entries())
  it(`matches Python HTTP ${entry.parser} parser case ${index}`, () => {
    const response =
      entry.parser === "stream"
        ? parseAISdkDataStream(entry.raw)
        : parseAISdkJsonResponse(entry.raw);
    expect(response.text).toBe(entry.text);
    expect(response.usage).toEqual(
      entry.usage ? canonicalUsage(entry.usage) : null,
    );
  });
for (const [index, entry] of fixtures.messages.entries())
  it(`matches Python AI SDK ${entry.version} message case ${index}`, () => {
    expect(
      messageToAISdkMessage(
        MessageSchema.parse(entry.message),
        entry.version as AISdkMessageFormat,
      ) as unknown,
    ).toEqual(entry.expected);
  });
let server: ReturnType<typeof Bun.serve>;
const requests: { path: string; body: unknown; header: string | null }[] = [];
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        body: await request.json(),
        header: request.headers.get("x-test"),
      });
      if (path === "/unauthorized")
        return new Response("denied", { status: 401 });
      if (path === "/slow")
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (path === "/plain")
        return new Response("  plain reply  ", {
          headers: { "content-type": "text/plain" },
        });
      if (path === "/stream")
        return new Response(
          '0:"mango"\ne:{"usage":{"promptTokens":3,"completionTokens":2}}\n',
          { headers: { "content-type": "text/plain" } },
        );
      return Response.json({
        text: "mango",
        usage: { promptTokens: 3, completionTokens: 2 },
      });
    },
  });
});
afterAll(() => server.stop(true));
const endpoint = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const messages = () => [
  MessageSchema.parse({ role: "user", content: "Reply mango" }),
];
it("posts full history with caller headers and extra body, and returns provider usage", async () => {
  const target = new VercelAISdkTarget(endpoint("/json"), {
    headers: { "x-test": "value" },
    extraBody: { model: "echo" },
  });
  const response = await target.respond(messages());
  expect(response.text).toBe("mango");
  expect(response.usage).toMatchObject({
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    calls: 1,
  });
  expect(requests.at(-1)).toMatchObject({
    path: "/json",
    header: "value",
    body: {
      messages: [{ role: "user", content: "Reply mango" }],
      model: "echo",
    },
  });
});
it("keeps plain text responses instead of silently dropping them", async () => {
  expect(
    (await new VercelAISdkTarget(endpoint("/plain")).respond(messages())).text,
  ).toBe("plain reply");
  expect(parseAISdkHttpResponse("plain reply", "text/plain")).toEqual({
    text: "plain reply",
    usage: null,
  });
});
it("parses legacy data streams through an actual HTTP request", async () => {
  const response = await new VercelAISdkTarget(endpoint("/stream")).respond(
    messages(),
  );
  expect(response.text).toBe("mango");
  expect(response.usage?.totalTokens).toBe(5);
});
it("clones configuration without sharing mutable headers and redacts context credentials", async () => {
  const target = new VercelAISdkTarget(
    "https://user:password@example.com/api/chat?token=secret#fragment",
    {
      headers: { "x-test": "old" },
      extraBody: { model: "echo" },
      messageFormat: "v4",
    },
  );
  expect((await target.getAgentContext()).key).toBe(
    "https://example.com/api/chat",
  );
  const clone = target.newInstance();
  if (clone.options.headers) clone.options.headers["x-test"] = "new";
  expect(target.options.headers?.["x-test"]).toBe("old");
  expect(clone.options.messageFormat).toBe("v4");
  expect(clone.options.extraBody).not.toBe(target.options.extraBody);
});
it("surfaces HTTP status for retry classification without retrying authorization failures", async () => {
  const before = requests.length;
  const result = await callTargetWithRetry(
    new VercelAISdkTarget(endpoint("/unauthorized")),
    messages(),
    { maxTargetRetries: 2, targetAgentTimeoutMs: 1000 },
  );
  expect(result.succeeded).toBe(false);
  expect(result.attempts).toBe(1);
  expect(requests.length - before).toBe(1);
});
it("bounds HTTP duration and exposes a non-retryable timeout", async () => {
  const target = new VercelAISdkTarget(endpoint("/slow"), { timeoutMs: 10 });
  await expect(target.respond(messages())).rejects.toBeInstanceOf(
    NonRetryableTargetError,
  );
});
it("cancels the HTTP request when the caller aborts", async () => {
  const controller = new AbortController();
  const target = new VercelAISdkTarget(endpoint("/slow"));
  const pending = target.respond(messages(), { signal: controller.signal });
  controller.abort();
  try {
    await pending;
    throw new Error("expected abort");
  } catch (error) {
    expect((error as Error).name).toBe("AbortError");
  }
});
it("retains target HTTP usage through simulate", async () => {
  const fake = makeFakeClient();
  const result = await simulate({
    target: new VercelAISdkTarget(endpoint("/json")),
    client: fake.client,
    datapoints: [parseSavedDatapoint(runFixture.run.datapoints?.[0])],
    maxTurns: 1,
    uploadResults: false,
    recommendations: false,
    executiveSummary: false,
  });
  expect(result[0]?.usage?.totalTokens).toBe(10);
  expect(result[0]?.token_usage_known).toBe(true);
});

it("recognizes modern SDK inputTokens/outputTokens usage aliases", () => {
  for (const raw of [
    '0:"ok"\nd:{"usage":{"inputTokens":2,"outputTokens":3}}',
    '{"text":"ok","usage":{"inputTokens":2,"outputTokens":3}}',
  ]) {
    const parsed = raw.startsWith("0:")
      ? parseAISdkDataStream(raw)
      : parseAISdkJsonResponse(raw);
    expect(parsed.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    });
  }
});
