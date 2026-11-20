import { afterAll, beforeEach, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import { LLMCallConfig } from "../../../src/lib/contracts.js";
import { InsightsCache } from "../../../src/lib/insights/cache.js";
import {
  embedTexts,
  vectorCacheModel,
} from "../../../src/lib/insights/embed.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";

const model = "test/embedding";
let requests: { input: string[]; model: string }[] = [],
  fail = 0,
  invalid = false,
  mixed = false,
  base64 = false;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { input: string[]; model: string };
    requests.push(body);
    if (fail-- > 0)
      return Response.json(
        { error: { message: "temporary" } },
        { status: 503 },
      );
    return Response.json({
      object: "list",
      model,
      data: body.input.slice(0, invalid ? 0 : undefined).map((text, index) => ({
        object: "embedding",
        index,
        embedding: (() => {
          const vector = mixed && text === "b" ? [1] : [text.length, 2];
          if (!base64) return vector;
          const bytes = Buffer.alloc(vector.length * 4);
          vector.forEach((value, offset) => {
            bytes.writeFloatLE(value, offset * 4);
          });
          return bytes.toString("base64");
        })(),
      })),
      usage: {
        prompt_tokens: body.input.length,
        total_tokens: body.input.length,
      },
    });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests = [];
  fail = 0;
  invalid = false;
  mixed = false;
  base64 = false;
  clearModelOverrides();
  registerModel(
    model,
    new ModelInfo({
      provider: "test",
      supportsResponses: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      modelType: "embedding",
    }),
  );
});
const client = () =>
  new OpenAI({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });

test("embedding batches deduplicate inputs, preserve order and reuse the cache", async () => {
  const cache = await InsightsCache.open({ path: ":memory:" }),
    usage = new UsageLedger();
  try {
    const c = client(),
      result = await embedTexts(["a", "bb", "a", "ccc"], {
        client: c,
        model,
        cache,
        usage,
        batchSize: 2,
        cfg: new LLMCallConfig({ model, retryCount: 0 }),
      });
    expect(result).toEqual({ a: [1, 2], bb: [2, 2], ccc: [3, 2] });
    expect(requests.map((r) => r.input)).toEqual([["a", "bb"], ["ccc"]]);
    expect(usage.totals().embed?.calls).toBe(2);
    expect(
      await embedTexts(["ccc", "a"], { client: c, model, cache, usage }),
    ).toEqual({ ccc: [3, 2], a: [1, 2] });
    expect(requests).toHaveLength(2);
    expect(usage.totals().embed?.calls).toBe(2);
  } finally {
    cache.close();
  }
});

test("embedding retries account for unknown usage", async () => {
  const cache = await InsightsCache.open({ enabled: false }),
    usage = new UsageLedger();
  try {
    fail = 1;
    expect(
      await embedTexts(["a"], {
        client: client(),
        model,
        cache,
        usage,
        cfg: new LLMCallConfig({ model, retryCount: 1 }),
      }),
    ).toEqual({ a: [1, 2] });
    expect(requests).toHaveLength(2);
    expect(usage.totals().embed?.calls).toBe(2);
  } finally {
    cache.close();
  }
});

test("bad or inconsistent vectors fail the whole stage and clear the cache namespace", async () => {
  const cache = await InsightsCache.open({ path: ":memory:" }),
    c = client();
  try {
    const namespace = vectorCacheModel(c, model);
    cache.putVectors(namespace, { a: [1, 2] });
    mixed = true;
    await expect(
      embedTexts(["a", "b"], {
        client: c,
        model,
        cache,
        cfg: new LLMCallConfig({ model, retryCount: 0 }),
      }),
    ).rejects.toThrow("inconsistent dimensions");
    expect(cache.getVectors(namespace, ["a"])).toEqual({});
    mixed = false;
    invalid = true;
    await expect(
      embedTexts(["a"], {
        client: c,
        model,
        cache,
        cfg: new LLMCallConfig({ model, retryCount: 0 }),
      }),
    ).rejects.toThrow("embedding response length does not match batch");
  } finally {
    cache.close();
  }
});

test("empty input and invalid batch size behave explicitly", async () => {
  const cache = await InsightsCache.open({ enabled: false });
  try {
    expect(await embedTexts([], { client: client(), model, cache })).toEqual(
      {},
    );
    await expect(
      embedTexts([], { client: client(), model, cache, batchSize: 0 }),
    ).rejects.toThrow("batch_size must be positive");
    expect(requests).toHaveLength(0);
  } finally {
    cache.close();
  }
});

test("base64 embedding vectors are decoded without losing data", async () => {
  const cache = await InsightsCache.open({ enabled: false });
  try {
    base64 = true;
    expect(
      await embedTexts(["hello"], { client: client(), model, cache }),
    ).toEqual({ hello: [5, 2] });
  } finally {
    cache.close();
  }
});

test("cache namespace matches Python endpoint hashing", () => {
  expect(
    vectorCacheModel({ baseURL: "https://example.invalid/v3/router///" }, "m"),
  ).toBe("m@26b2becb1fea087cf4f3c224a87729c5ff99abaa45693b56b773c9e832125f74");
  expect(vectorCacheModel({}, "m")).toBe("m");
});

test("embedding requests can be cancelled", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fakeFetch: NonNullable<
    NonNullable<ConstructorParameters<typeof OpenAI>[0]>["fetch"]
  > = async (_url, init) =>
    new Promise((_resolve, reject) => {
      entered();
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      if (signal.aborted) reject(signal.reason);
      else
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    });
  const c = new OpenAI({
      apiKey: "synthetic",
      baseURL: "http://localhost/v3/router",
      maxRetries: 0,
      fetch: fakeFetch,
    }),
    cache = await InsightsCache.open({ enabled: false }),
    controller = new AbortController();
  try {
    const pending = embedTexts(["hello"], {
      client: c,
      model,
      cache,
      signal: controller.signal,
    }).then(
      () => false,
      () => true,
    );
    await started;
    controller.abort();
    expect(await pending).toBe(true);
  } finally {
    cache.close();
  }
});
