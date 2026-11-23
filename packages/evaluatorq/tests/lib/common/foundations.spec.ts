import { describe, expect, spyOn, test } from "bun:test";

import {
  coerceStr,
  coerceStrList,
  extractJsonFromResponse,
} from "../../../src/lib/common/extract-json.js";
import {
  activeLlmParallelism,
  DEFAULT_LLM_PARALLELISM,
  llmConcurrencyLimit,
  llmSlot,
  UNBOUNDED,
} from "../../../src/lib/common/llm-limit.js";
import {
  isRetryableError,
  withoutClientRetries,
  withRetry,
} from "../../../src/lib/common/retry.js";

async function peakConcurrency(tasks: number): Promise<number> {
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: tasks }, () =>
      llmSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
      }),
    ),
  );
  return peak;
}

describe("llm concurrency limit", () => {
  test("defaults to the shared ceiling", async () => {
    expect(activeLlmParallelism()).toBe(DEFAULT_LLM_PARALLELISM);
    expect(await peakConcurrency(30)).toBe(DEFAULT_LLM_PARALLELISM);
  });

  test("bounds requests inside the block", async () => {
    expect(await llmConcurrencyLimit(3, () => peakConcurrency(12))).toBe(3);
  });

  test("an inner limit cannot raise an outer one", async () => {
    const peak = await llmConcurrencyLimit(2, () =>
      llmConcurrencyLimit(8, () => peakConcurrency(12)),
    );
    expect(peak).toBe(2);
  });

  test("unbounded disables the default at top level", async () => {
    await llmConcurrencyLimit(UNBOUNDED, async () => {
      expect(activeLlmParallelism()).toBeUndefined();
      expect(await peakConcurrency(25)).toBe(25);
    });
  });

  test("a failing request gives its slot back", async () => {
    await llmConcurrencyLimit(1, async () => {
      await expect(
        llmSlot(() => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      expect(await llmSlot(() => Promise.resolve("ok"))).toBe("ok");
    });
  });

  test.each([0, -2, 1.5])("rejects %d", (value) => {
    expect(() => llmConcurrencyLimit(value, () => 1)).toThrow(RangeError);
  });
});

describe("retry", () => {
  const status = (code: number) =>
    Object.assign(new Error("http"), { status: code });

  test.each([
    [429, true],
    [500, true],
    [400, false],
    [401, false],
  ])("status %d retryable is %s", (code, want) => {
    expect(isRetryableError(status(code))).toBe(want);
  });

  test("extra statuses are honoured", () => {
    expect(isRetryableError(status(408), new Set([408]))).toBe(true);
  });

  test("transport failures retry, aborts do not", () => {
    const connection = Object.assign(new Error("x"), {
      name: "APIConnectionError",
    });
    const fetchFailed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    const abort = Object.assign(new Error("x"), { name: "AbortError" });
    expect(isRetryableError(connection)).toBe(true);
    expect(isRetryableError(fetchFailed)).toBe(true);
    expect(isRetryableError(abort)).toBe(false);
  });

  test("retries until success", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw status(503);
        }
        return "done";
      },
      { minWaitMs: 0 },
    );
    warn.mockRestore();
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  test("raises the last error after the final attempt", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw status(503);
        },
        { maxAttempts: 2, minWaitMs: 0 },
      ),
    ).rejects.toThrow("http");
    warn.mockRestore();
    expect(calls).toBe(2);
  });

  test("does not retry a client error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw status(400);
      }),
    ).rejects.toThrow("http");
    expect(calls).toBe(1);
  });

  test("rejects zero attempts", async () => {
    await expect(
      withRetry(() => Promise.resolve(1), { maxAttempts: 0 }),
    ).rejects.toThrow(RangeError);
  });

  test("withoutClientRetries clones only clients with a retry budget", () => {
    const clone = { maxRetries: 0 };
    const client = {
      maxRetries: 2,
      withOptions: (options: { maxRetries: number }) => ({
        ...clone,
        ...options,
      }),
    };
    const bare = { maxRetries: 0 };
    expect(withoutClientRetries(client) as unknown).toEqual(clone);
    expect(client.maxRetries).toBe(2);
    expect(withoutClientRetries(bare)).toBe(bare);
  });
});

describe("extractJsonFromResponse", () => {
  test.each([
    ["", ""],
    ['```json\n{"a":1}\n```', '{"a":1}'],
    ["```\n[1,2]\n```", "[1,2]"],
    ['```python\n{"x"}\n```\n```json\n{"a":1}\n```', '{"a":1}'],
    ['```python\n[1]\n```\n```json\n{"a":1}\n```', '{"a":1}'],
    ['here: {"r":[1,2]} done', '{"r":[1,2]}'],
    ["list [1,2] then", "[1,2]"],
    ['{"s":"} not end"}', '{"s":"} not end"}'],
    ['{bad} {"a":1}', '{"a":1}'],
    ["  no json  ", "no json"],
  ])("%s", (input, want) => {
    expect(extractJsonFromResponse(input)).toBe(want);
  });
});

describe("coercers", () => {
  test("coerceStrList stringifies and drops empty items", () => {
    expect(coerceStrList(["a", 1, null, "", 0, [], {}])).toEqual(["a", "1"]);
    expect(coerceStrList("x")).toBe("x");
  });

  test("coerceStr handles scalars", () => {
    expect(coerceStr(null)).toBe("");
    expect(coerceStr(5)).toBe("5");
    expect(coerceStr("x")).toBe("x");
    expect(coerceStr([1])).toEqual([1]);
  });
});
