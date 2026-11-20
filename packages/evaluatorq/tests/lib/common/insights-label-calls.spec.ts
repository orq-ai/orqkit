import { afterAll, beforeEach, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import { LLMCallConfig } from "../../../src/lib/contracts.js";
import {
  askLabels,
  prepareClassifierState,
} from "../../../src/lib/insights/labeling.js";
import { LabelSpec } from "../../../src/lib/insights/models.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const model = "test/insights-label";
let requests: Record<string, unknown>[] = [],
  fail = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    if (fail-- > 0)
      return Response.json(
        { error: { message: "temporary" } },
        { status: 503 },
      );
    return Response.json({
      answers: {
        sentiment: {
          type: "choice",
          choice: "yes",
          confidence: 0.9,
          probabilities: { yes: 0.9, no: 0.1 },
        },
      },
      model,
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests = [];
  fail = 0;
  clearModelOverrides();
  registerModel(
    model,
    new ModelInfo({
      provider: "test",
      supportsClassify: true,
      supportsResponses: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    }),
  );
});
const client = () =>
  new OpenAI({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });
const spec = new LabelSpec({
  name: "sentiment",
  kind: "choice",
  instructions: "Which?",
  criteria: { yes: "yes", no: "no" },
});
const trace = new TraceRecord({
  schemaVersion: 1,
  traceId: "t",
  spanId: "s",
  timestamp: "2026-11-10T00:00:00Z",
  project: "p",
  model: "m",
  provider: "p",
  status: "ok",
  product: "agents",
  traceType: "agent",
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "answer" },
  ],
});

test("Insights sends one bounded classifier request and counts its usage", async () => {
  const usage = new UsageLedger(),
    state = prepareClassifierState(trace, { model, charCap: 4096 });
  const [answers, error] = await askLabels(state, [spec], {
    client: client(),
    model,
    cfg: new LLMCallConfig({ model, retryCount: 0 }),
    charCap: 4096,
    usage,
  });
  expect(error).toBeNull();
  expect(answers.sentiment?.value).toBe("yes");
  expect(usage.totals().label?.calls).toBe(1);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain("hello");
  expect(JSON.stringify(requests[0])).toContain("answer");
});

test("Insights records each retry including an unpriced failed attempt", async () => {
  fail = 1;
  const usage = new UsageLedger(),
    [answers, error] = await askLabels("hello", [spec], {
      client: client(),
      model,
      cfg: new LLMCallConfig({ model, retryCount: 1 }),
      charCap: 4096,
      usage,
    });
  expect(error).toBeNull();
  expect(answers.sentiment?.value).toBe("yes");
  expect(requests).toHaveLength(2);
  expect(usage.totals().label?.calls).toBe(2);
});
