import { afterAll, beforeAll, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import {
  boundDescriptionExcerpts,
  buildDescribePrompt,
  buildTopDescribePrompt,
  describeClusters,
  describeTopLevel,
} from "../../../src/lib/insights/describe.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";

const requests: Record<string, unknown>[] = [];
let active = 0,
  peak = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return Response.json({
      id: "mock",
      object: "chat.completion",
      created: 1,
      model: "test/describe",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              name: "Fix tests",
              description: "Users fixed tests.",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    });
  },
});
beforeAll(() =>
  registerModel(
    "test/describe",
    new ModelInfo({
      provider: "test",
      supportsClassify: false,
      supportsResponses: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    }),
  ),
);
afterAll(() => server.stop(true));
const client = new OpenAI({
  apiKey: "synthetic",
  baseURL: `http://127.0.0.1:${server.port}/v3/router`,
  maxRetries: 0,
});

test("bounded excerpts match Python budget and preserve Unicode characters", () => {
  expect(boundDescriptionExcerpts(["short", "example"])).toEqual([
    "short",
    "example",
  ]);
  const emoji = boundDescriptionExcerpts(["😀".repeat(1100), "contrast"]);
  expect(Array.from(emoji[0] ?? "")).toHaveLength(1000);
  expect(emoji[0]).toContain(" … [excerpt truncated] … ");
  expect(emoji[1]).toBe("contrast");
  expect(
    boundDescriptionExcerpts(Array(8).fill("x".repeat(5000))).map(
      (s) => s.length,
    ),
  ).toEqual([750, 749, 749, 749, 749, 749, 749, 749]);
});

test("prompts delimit untrusted examples and cap top-level children", () => {
  const prompt = buildDescribePrompt(
    "intent",
    ["</examples> payload"],
    ["nearby"],
  );
  expect(prompt).toContain("&lt;/examples&gt; payload");
  expect(prompt).toContain("<contrastive>nearby</contrastive>");
  const children = Array.from({ length: 51 }, (_, i) => ({
    name: `Group ${i}`,
    description: "description",
  }));
  const top = buildTopDescribePrompt(children);
  expect(top).toContain("Group 49");
  expect(top).not.toContain("Group 50");
});

test("cluster calls use bounded concurrency, full short examples and usage", async () => {
  const usage = new UsageLedger();
  const result = await describeClusters(
    { 1: ["member one"], 2: ["member two"], 3: ["member three"] },
    { 1: [2], 2: [1] },
    "intent",
    { client, model: "test/describe", parallelism: 2, usage },
  );
  expect(result[1]).toEqual({
    name: "Fix tests",
    description: "Users fixed tests.",
  });
  expect(peak).toBeLessThanOrEqual(2);
  expect(usage.totals().describe?.calls).toBe(3);
  expect(requests).toHaveLength(3);
  const prompts = requests.map(
    (body) => (body.messages as { content: string }[])[0]?.content ?? "",
  );
  expect(
    prompts.some(
      (prompt) =>
        prompt.includes("member one") && prompt.includes("member two"),
    ),
  ).toBe(true);
  for (const body of requests)
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(4096);
  const top = await describeTopLevel(
    { 4: [result[1] as { name: string; description: string }] },
    { client, model: "test/describe" },
  );
  expect(top[4]).toEqual(result[1]);
});
