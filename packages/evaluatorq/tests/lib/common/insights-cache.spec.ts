import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InsightsCache,
  packVector,
  promptHash,
  unpackVector,
} from "../../../src/lib/insights/cache.js";
import { TraceSummarySchema } from "../../../src/lib/insights/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-cache-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: { input: number[]; hex: string; decoded: number[] }[];
  hashes: [string, string][];
};
for (const [i, c] of gold.vectors.entries())
  test(`Python vector wire format ${i}`, () => {
    expect(packVector(c.input).toString("hex")).toBe(c.hex);
    expect(unpackVector(Buffer.from(c.hex, "hex"))).toEqual(c.decoded);
  });
for (const [text, hash] of gold.hashes)
  test(`summary hash ${text}`, () => {
    expect(promptHash(text)).toBe(hash);
  });
test("corrupt or nonfinite vectors cannot be read or cached", () => {
  expect(() => packVector([])).toThrow();
  expect(() => packVector([Infinity])).toThrow();
  expect(() => packVector([1e100])).toThrow();
  const blob = packVector([1, 2]);
  blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
  expect(() => unpackVector(blob)).toThrow("checksum");
});
test("cache keys, persistence and disabled mode", async () => {
  const path = join(tmpdir(), `insights-cache-${crypto.randomUUID()}.sqlite`),
    summary = TraceSummarySchema.parse({
      summary: "test",
      request: null,
      task: null,
      topic: null,
      sentimentExplanation: null,
    });
  const cache = await InsightsCache.open({ path });
  try {
    cache.putSummary("t", "s", "m", "hash", summary);
    cache.putVectors("m", { hello: [1, 2], world: [3, 4] });
    expect(cache.getSummary("t", "s", "m", "hash")).toEqual(summary);
    expect(cache.getSummary("t", "s", "m", "other")).toBeNull();
    expect(cache.getVectors("m", ["hello", "missing"])).toEqual({
      hello: [1, 2],
    });
    expect(cache.getVectors("other", ["hello"])).toEqual({});
  } finally {
    cache.close();
  }
  const reopened = await InsightsCache.open({ path });
  try {
    expect(reopened.getSummary("t", "s", "m", "hash")).toEqual(summary);
    expect(reopened.getVectors("m", ["world"])).toEqual({ world: [3, 4] });
    reopened.deleteVectors("m");
    expect(reopened.getVectors("m", ["hello"])).toEqual({});
  } finally {
    reopened.close();
    rmSync(path, { force: true });
  }
  const disabled = await InsightsCache.open({ enabled: false });
  disabled.putSummary("t", "s", "m", "h", summary);
  expect(disabled.getSummary("t", "s", "m", "h")).toBeNull();
  disabled.close();
});

test("cache creates private transcript files and preserves unrelated parent permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "insights-private-"));
  const path = join(root, "private", "insights.sqlite");
  const parentMode = statSync(root).mode & 0o777;
  const cache = await InsightsCache.open({ path });
  try {
    if (process.platform !== "win32") {
      expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(root).mode & 0o777).toBe(parentMode);
    }
  } finally {
    cache.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite memory caches do not create a literal file", async () => {
  expect(existsSync(":memory:")).toBe(false);
  const cache = await InsightsCache.open({ path: ":memory:" });
  try {
    cache.putVectors("m", { test: [1, 2] });
    expect(cache.getVectors("m", ["test"])).toEqual({ test: [1, 2] });
    expect(existsSync(":memory:")).toBe(false);
  } finally {
    cache.close();
  }
});
