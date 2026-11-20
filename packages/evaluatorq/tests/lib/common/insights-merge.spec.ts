import { afterAll, beforeEach, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import {
  candidatePairs,
  mergeSimilar,
} from "../../../src/lib/insights/merge.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";

const model = "test/merge";
let requests: Record<string, unknown>[] = [],
  invalid = false;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    return Response.json({
      answers: invalid ? {} : { same: { type: "noul", noul: 0.85 } },
      model,
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests = [];
  invalid = false;
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
const client = new OpenAI({
  apiKey: "synthetic",
  baseURL: `http://127.0.0.1:${server.port}/v3/router`,
  maxRetries: 0,
});
const names = {
  1: { name: "first", description: "first description" },
  2: { name: "second", description: "second description" },
  3: { name: "third", description: "third description" },
  4: { name: "isolated", description: "alone" },
};
const neighbours = { 1: [2, 1, 99], 2: [1, 3], 3: [2] };

test("candidate pairs are ordered, deduplicated and skip unknown clusters", () => {
  expect(candidatePairs(names, neighbours)).toEqual([
    [1, 2],
    [2, 3],
  ]);
});
test("matching pairs merge transitively and record merge usage", async () => {
  const usage = new UsageLedger();
  const result = await mergeSimilar(
    names,
    { 1: ["one", "two", "three", "omitted"], 2: ["other"] },
    neighbours,
    { client, model, usage },
  );
  expect(result).toEqual({
    representatives: { 1: 1, 2: 1, 3: 1, 4: 4 },
    nPairs: 2,
    nFailed: 0,
  });
  expect(usage.totals().merge?.calls).toBe(2);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests)).toContain("first description");
  expect(JSON.stringify(requests)).toContain("three");
  expect(JSON.stringify(requests)).not.toContain("omitted");
});
test("unreadable pairs fail independently and do not merge", async () => {
  invalid = true;
  const result = await mergeSimilar(names, {}, neighbours, { client, model });
  expect(result).toEqual({
    representatives: { 1: 1, 2: 2, 3: 3, 4: 4 },
    nPairs: 2,
    nFailed: 2,
  });
  await expect(
    mergeSimilar(names, {}, neighbours, { client, model, threshold: NaN }),
  ).rejects.toThrow();
});
