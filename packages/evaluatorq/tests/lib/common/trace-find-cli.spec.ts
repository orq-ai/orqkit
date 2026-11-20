import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  findFiltersText,
  findPlanRows,
  findRequest,
  runFind,
} from "../../../src/lib/trace-finder/cli.js";
import {
  CompiledQuerySchema,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  RunRequestSchema,
  RunSnapshot,
} from "../../../src/lib/trace-finder/models.js";
import type { RunStore } from "../../../src/lib/trace-finder/run-store.js";
import { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-find-python-goldens.json", import.meta.url),
    "utf8",
  ),
);
const dimension = CompiledQuerySchema.parse({
  task: { kind: "noul", instructions: "Is this a help request?", state: {} },
  selection: { kind: "values", values: [true] },
});
const request = RunRequestSchema.parse({
  query: "Find help requests",
  mode: "review",
  population: new PopulationRequest(),
  parallelism: 2,
});

test("find filters and review rows match Python", () => {
  expect(findFiltersText(new FacetSelection(), new NumericFilters())).toBe(
    gold.filters[0],
  );
  expect(
    findFiltersText(
      new FacetSelection({
        project: ["z", "a"],
        projectId: "p",
        toolName: ["search"],
        status: ["ok"],
      }),
      new NumericFilters({ tokensMin: 0, durationMsMax: 1234 }),
    ),
  ).toBe(gold.filters[1]);
  const snapshot = new RunSnapshot({
    request,
    total: 3,
    dimensions: [dimension],
    generatedFilters: new FacetSelection({ provider: ["openai"] }),
    generatedNumeric: new NumericFilters({ tokensMin: 100, durationMsMin: 20 }),
  });
  expect(findPlanRows(snapshot)).toEqual(gold.rows);
});

test("find request honors defaults, explicit window and facet scope", () => {
  const settings = new DashboardSettings({
    windowDays: 7,
    limit: 20,
    parallelism: 3,
    orqProjectId: "saved",
  });
  const req = findRequest(
    {
      query: "find",
      windowDaysExplicit: true,
      project: [" alpha ", "", "alpha"],
      tokensMin: 0,
    },
    settings,
    "2026-11-10T10:00:00Z",
  );
  expect(req.population.start).toBe("2026-11-03T10:00:00Z");
  expect(req.population.end).toBe("2026-11-10T10:00:00Z");
  expect(req.population.timeOrigin).toBe("explicit");
  expect([...req.population.facets.project]).toEqual(["alpha"]);
  expect(req.population.facets.projectId).toBeNull();
  expect(req.population.numeric.tokensMin).toBe(0);
  expect(req.parallelism).toBe(3);
  expect(
    findRequest({ query: "x" }, settings, "2026-11-10T10:00:00Z").population
      .facets.projectId,
  ).toBe("saved");
});

test("find review declines without starting and accepts a filter-only plan automatically", async () => {
  let starts = 0,
    confirms = 0;
  const review = new RunSnapshot({
    state: "awaiting_review",
    request,
    dimensions: [dimension],
    total: 1,
  });
  let current = review;
  const fake = {
    compile: async () => current,
    start: async () => {
      starts++;
      current = new RunSnapshot({ state: "completed", total: 1 });
      return current;
    },
    snapshot: async () => current,
    snapshotForRender: async () => current,
    cancel: async () => review,
  } as unknown as RunStore;
  expect(
    await runFind(fake, request, {
      confirm: () => {
        confirms++;
        return false;
      },
      pollMs: 1,
    }),
  ).toBeNull();
  expect([starts, confirms]).toEqual([0, 1]);
  current = new RunSnapshot({ ...review, dimensions: [] });
  expect(
    (
      await runFind(fake, request, {
        confirm: () => {
          throw new Error("unexpected confirmation");
        },
        pollMs: 1,
      })
    )?.state,
  ).toBe("completed");
  expect(starts).toBe(1);
});

test("find timeout cancels an active run", async () => {
  let cancellations = 0;
  const compiling = new RunSnapshot({ state: "compiling", request });
  const fake = {
    compile: async () => compiling,
    snapshot: async () => compiling,
    snapshotForRender: async () => compiling,
    cancel: async () => {
      cancellations++;
      return new RunSnapshot({ state: "cancelled" });
    },
  } as unknown as RunStore;
  await expect(
    runFind(fake, request, { confirm: () => true, timeoutMs: 3, pollMs: 1 }),
  ).rejects.toThrow("Find run exceeded");
  expect(cancellations).toBe(1);
});
