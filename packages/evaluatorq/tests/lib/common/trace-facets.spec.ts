import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  closeFacetCatalogueCache,
  type FacetClient,
  facetCatalogueCacheHit,
  invalidateFacetCatalogueCache,
  loadFacetCatalogue,
  loadFacetCatalogueCached,
  projectLabels,
} from "../../../src/lib/trace-finder/facets.js";
import { FacetCatalogueSchema } from "../../../src/lib/trace-finder/models.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-facets-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    facets: Record<string, unknown>;
    projects: Record<string, unknown>[];
    ok: boolean;
    expected: Record<string, unknown> | null;
  }[];
  labels: { input: Record<string, string>; expected: Record<string, string> }[];
};
const options = { start: "2026-11-09T00:00:00Z", end: "2026-11-10T00:00:00Z" };
function fake(row = goldens.cases[0] as (typeof goldens.cases)[number]) {
  let calls = 0;
  const client = {
    _baseURL: new URL("https://facet.test"),
    _options: { apiKey: "synthetic-key" },
    traces: {
      listFacetValues: async ({ field }: { field: string }) => {
        calls++;
        return row.facets[field];
      },
    },
    projects: {
      list: async (args: { startingAfter?: string }) =>
        row.projects[
          Math.min(args.startingAfter ? 1 : 0, row.projects.length - 1)
        ],
    },
  } as unknown as FacetClient;
  return { client, calls: () => calls };
}
function serialized(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(serialized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialized(item)]),
    );
  return value;
}
function expected(value: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      item,
    ]),
  );
}
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(async () => {
  await invalidateFacetCatalogueCache();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  warn.mockRestore();
  await closeFacetCatalogueCache();
});
for (const [i, row] of goldens.cases.entries())
  test(`Python facet catalogue ${i}`, async () => {
    const fixture = fake(row);
    let result: unknown,
      ok = false;
    try {
      result = await loadFacetCatalogue(fixture.client, options);
      ok = true;
    } catch {}
    expect(ok).toBe(row.ok);
    expect(fixture.calls()).toBe(8);
    if (ok && row.expected)
      expect<unknown>(serialized(result)).toEqual(expected(row.expected));
  });
for (const [i, row] of goldens.labels.entries())
  test(`Python project labels ${i}`, () =>
    expect(projectLabels(row.input)).toEqual(row.expected));
test("facet cache shares concurrent loads and returns detached nested values", async () => {
  const fixture = fake();
  const [a, b] = await Promise.all([
    loadFacetCatalogueCached(fixture.client, options),
    loadFacetCatalogueCached(fixture.client, options),
  ]);
  expect(fixture.calls()).toBe(8);
  expect(a).not.toBe(b);
  expect(a.valueCounts).not.toBe(b.valueCounts);
  expect(await facetCatalogueCacheHit(fixture.client, options)).toBe(true);
  (a.valueCounts.model as Record<string, number>).a = 999;
  expect(
    (await loadFacetCatalogueCached(fixture.client, options)).valueCounts.model
      ?.a,
  ).toBe(3);
  expect(fixture.calls()).toBe(8);
});
test("cache expires after five minutes and is scoped by client, credentials and request headers", async () => {
  let now = 0;
  const time = spyOn(performance, "now").mockImplementation(() => now);
  const fixture = fake();
  try {
    await loadFacetCatalogueCached(fixture.client, options);
    now = 299999;
    expect(await facetCatalogueCacheHit(fixture.client, options)).toBe(true);
    now = 300000;
    expect(await facetCatalogueCacheHit(fixture.client, options)).toBe(false);
    await loadFacetCatalogueCached(fixture.client, options);
    expect(fixture.calls()).toBe(16);
    await loadFacetCatalogueCached(fixture.client, {
      ...options,
      headers: { "X-Orq-Workspace-Id": "other" },
    });
    expect(fixture.calls()).toBe(24);
    fixture.client._options.apiKey = "rotated-synthetic-key";
    expect(await facetCatalogueCacheHit(fixture.client, options)).toBe(false);
    await loadFacetCatalogueCached(fixture.client, options);
    expect(fixture.calls()).toBe(32);
    expect(await facetCatalogueCacheHit(fake().client, options)).toBe(false);
  } finally {
    time.mockRestore();
  }
});
test("rolling windows reuse a catalogue while explicit windows retain their bounds", async () => {
  const fixture = fake();
  await loadFacetCatalogueCached(fixture.client, {
    ...options,
    defaultWindow: true,
  });
  const shifted = {
    start: "2026-11-09T00:01:00Z",
    end: "2026-11-10T00:01:00Z",
  };
  expect(
    await facetCatalogueCacheHit(fixture.client, {
      ...shifted,
      defaultWindow: true,
    }),
  ).toBe(true);
  expect(await facetCatalogueCacheHit(fixture.client, shifted)).toBe(false);
});
test("cache is bounded and injected loaders bypass it", async () => {
  const fixture = fake();
  for (let i = 0; i < 33; i++)
    await loadFacetCatalogueCached(fixture.client, {
      ...options,
      headers: { "X-Orq-Project-Id": String(i) },
    });
  expect(
    await facetCatalogueCacheHit(fixture.client, {
      ...options,
      headers: { "X-Orq-Project-Id": "0" },
    }),
  ).toBe(false);
  expect(
    await facetCatalogueCacheHit(fixture.client, {
      ...options,
      headers: { "X-Orq-Project-Id": "1" },
    }),
  ).toBe(true);
  const catalogue = FacetCatalogueSchema.parse({ model: ["injected"] });
  let count = 0;
  const loader = async () => {
    count++;
    return catalogue;
  };
  expect(
    await loadFacetCatalogueCached(fixture.client, { ...options, loader }),
  ).toBe(catalogue);
  expect(
    await loadFacetCatalogueCached(fixture.client, { ...options, loader }),
  ).toBe(catalogue);
  expect(count).toBe(2);
});
function gated() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    aborted = 0;
  const client = {
    _baseURL: new URL("https://facet.test"),
    _options: { apiKey: "synthetic" },
    traces: {
      listFacetValues: async (
        { field }: { field: string },
        { signal }: { signal: AbortSignal },
      ) => {
        calls++;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            aborted++;
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          void gate.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
        });
        return {
          values: field === "project_id" ? [] : [{ value: "a", count: 1 }],
        };
      },
    },
    projects: { list: async () => ({ data: [], hasMore: false }) },
  } as unknown as FacetClient;
  return { client, release, calls: () => calls, aborted: () => aborted };
}
test("one cancelled caller leaves a shared load alive", async () => {
  const fixture = gated(),
    controller = new AbortController(),
    first = loadFacetCatalogueCached(fixture.client, {
      ...options,
      signal: controller.signal,
    }),
    second = loadFacetCatalogueCached(fixture.client, options);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(first).rejects.toThrow();
  expect(fixture.aborted()).toBe(0);
  fixture.release();
  expect((await second).model).toEqual(["a"]);
  expect(fixture.calls()).toBe(8);
  expect(await facetCatalogueCacheHit(fixture.client, options)).toBe(true);
});
test("invalidation cancels in-flight calls and failures do not become cache hits", async () => {
  const fixture = gated(),
    pending = loadFacetCatalogueCached(fixture.client, options);
  const rejected = pending.then(
    () => {
      throw new Error("Expected cancellation");
    },
    (error) => error,
  );
  await Promise.resolve();
  await Promise.resolve();
  await invalidateFacetCatalogueCache();
  const reason = await rejected;
  expect((reason as Error).name).toBe("AbortError");
  expect(fixture.aborted()).toBe(8);
  expect(await facetCatalogueCacheHit(fixture.client, options)).toBe(false);
  const broken = fake({
    ...(goldens.cases[0] as (typeof goldens.cases)[number]),
    projects: [{ data: [], has_more: false }],
  });
  await expect(
    loadFacetCatalogueCached(broken.client, options),
  ).rejects.toThrow("cannot resolve");
  expect(await facetCatalogueCacheHit(broken.client, options)).toBe(false);
});
