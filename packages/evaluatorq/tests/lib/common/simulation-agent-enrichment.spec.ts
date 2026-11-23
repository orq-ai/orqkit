import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  clearSimulationAgentInfoCache,
  resolveSimulationAgentInfo,
  simulationAgentCardFragment,
  simulationReportTabs,
} from "../../../src/lib/dashboard/simulation-report-tabs.js";
import * as snapshots from "../../../src/lib/integrations/simulation/agent-snapshot.js";
import { SimulationRun } from "../../../src/lib/integrations/simulation/run-store.js";
import fixture from "../fixtures/simulation-run-python-goldens.json" with {
  type: "json",
};

let fetch: ReturnType<typeof spyOn<typeof snapshots, "fetchAgentInfo">>;
const info = (key: string, values: Record<string, unknown> = {}) =>
  snapshots.agentInfoFromResponse(
    {
      _id: `id-${key}`,
      model: { id: "live-model" },
      description: "Live description",
      ...values,
    },
    key,
    { baseUrl: "https://synthetic.example", workspaceKey: "synthetic" },
  );
const run = (options: Record<string, unknown> = {}) =>
  new SimulationRun({
    ...new SimulationRun(fixture.run).toJSON(),
    targetKind: "orq_agent",
    target: "agent:key",
    experimentUrl: "https://synthetic.example/synthetic/experiments/e",
    ...options,
  });
beforeEach(() => {
  clearSimulationAgentInfoCache();
  fetch = spyOn(snapshots, "fetchAgentInfo").mockResolvedValue(null);
});
afterEach(() => {
  fetch.mockRestore();
  clearSimulationAgentInfoCache();
});
test("complete captured identity and non-Orq runs render without fetching", async () => {
  const captured = info("key");
  expect(
    (await resolveSimulationAgentInfo(run({ agentInfo: captured })))[2],
  ).toBe("captured");
  expect(
    (
      await resolveSimulationAgentInfo(
        run({ targetKind: "callback", agentInfo: null }),
      )
    )[2],
  ).toBe("none");
  await simulationReportTabs("r", run({ agentInfo: captured }), {
    standalone: true,
  });
  expect(fetch).not.toHaveBeenCalled();
});
test("successful enrichment fills gaps while retaining captured scalar and list values", async () => {
  const live = {
    ...info("key"),
    tools: ["live-tool"],
    knowledgeBases: ["live-kb"],
  };
  fetch.mockResolvedValue(live);
  const saved = run({
      agentInfo: {
        key: "key",
        model: "as-run-model",
        description: "",
        tools: ["as-run-tool"],
        knowledgeBases: [],
      },
    }),
    [display, original, source] = await resolveSimulationAgentInfo(saved);
  expect(source).toBe("augmented");
  expect(original).toBe(saved.agentInfo);
  expect(display?.model).toBe("as-run-model");
  expect(display?.tools).toEqual(["as-run-tool"]);
  expect(display?.description).toBe("Live description");
  expect(display?.knowledgeBases).toEqual(["live-kb"]);
  await resolveSimulationAgentInfo(saved);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("missing captures use fetched data, cache successful keys, and show provenance", async () => {
  fetch.mockResolvedValue(info("key"));
  const saved = run({ agentInfo: null });
  const [display, original, source] = await resolveSimulationAgentInfo(saved);
  expect(source).toBe("fetched");
  expect(original).toBeNull();
  expect(display?.key).toBe("key");
  expect(await simulationAgentCardFragment(saved)).toContain(
    "Loaded live from Orq - no agent config was captured in this run.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  await resolveSimulationAgentInfo(
    run({ target: "agent:other", agentInfo: null }),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("failed fetches stay uncached and retain stored target identity", async () => {
  const saved = run({ agentInfo: null, targetModel: "saved-model" });
  for (let i = 0; i < 2; i++) {
    const [display, original, source] = await resolveSimulationAgentInfo(saved);
    expect(source).toBe("stored");
    expect(original).toBeNull();
    expect(display).toEqual({ key: "key", model: "saved-model" });
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  const captured = run({ agentInfo: { key: "key", model: "saved" } });
  expect((await resolveSimulationAgentInfo(captured))[2]).toBe("captured");
});
