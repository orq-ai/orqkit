import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";

import {
  type DatasetClient,
  type ExperimentClient,
  experimentRowToDataPoint,
  fetchDatasetBatches,
  fetchExperimentDataPoints,
  MAX_EXPERIMENT_EXPORT_BYTES,
  rowsFromExperimentExport,
} from "../../../../src/lib/common/fetch-data.js";
import { LLMCallConfig } from "../../../../src/lib/contracts.js";
import { extractSingleDatapoint } from "../../../../src/lib/integrations/simulation/datapoint-io.js";
import {
  datapointsFromDataset,
  datapointsFromExperiment,
  extendFromDataset,
  extendFromExperiment,
  simulate,
} from "../../../../src/lib/integrations/simulation/index.js";
import {
  describeAgent,
  seedContext,
} from "../../../../src/lib/integrations/simulation/seed-extension.js";
import type { Datapoint } from "../../../../src/lib/integrations/simulation/types.js";
import fixtures from "../../fixtures/simulation-source-python-goldens.json" with {
  type: "json",
};
import { makeFakeClient } from "./fake-client.js";

const P = {
  name: "P",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual" as const,
  background: "Customer context",
};
const S = {
  name: "S",
  goal: "Get mango",
  criteria: [
    { description: "Agent replies mango", type: "must_happen" as const },
  ],
};
const DP: Datapoint = {
  id: "dp-one",
  persona: P,
  scenario: S,
  user_system_prompt: "cached",
  first_message: "Reply mango",
};
const clean = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(clean)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => [k, clean(v)]),
        )
      : value;

it.each(fixtures.rows)(
  "matches pinned Python simulation row extraction: %j",
  (entry) => {
    if (entry.error)
      expect(() =>
        extractSingleDatapoint({ inputs: entry.inputs }, "row"),
      ).toThrow();
    else
      expect(
        clean(extractSingleDatapoint({ inputs: entry.inputs }, "row")),
      ).toEqual(entry.expected);
  },
);
it.each(fixtures.exports)(
  "matches pinned Python experiment response normalization: %j",
  (entry) => {
    const expected = entry.expected as {
      inputs: Record<string, unknown>;
      expected_output?: import("../../../../src/lib/types.js").Output;
    };
    expect(experimentRowToDataPoint(entry.row)).toEqual({
      inputs: expected.inputs,
      expectedOutput: expected.expected_output,
    });
  },
);
it("matches Python deduplicated seed context and derived agent description", () => {
  const seeds = fixtures.seeds as Datapoint[];
  expect(seedContext(seeds)).toBe(fixtures.seedContext);
  expect(describeAgent(seeds)).toBe(fixtures.description);
  expect(seedContext(seeds).match(/"name":"P"/g)).toHaveLength(2);
});
it("caps distinct seed goals without dropping seed variants from the context", () => {
  const seeds = Array.from({ length: 12 }, (_, i) => ({
    ...DP,
    scenario: { ...S, goal: `goal-${i}` },
  }));
  const text = describeAgent(seeds);
  expect(text).toContain("goal-9");
  expect(text).not.toContain("goal-10");
  expect(seedContext(seeds)).toContain("goal-11");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(describeAgent([{ ...DP, scenario: { ...S, goal: "" } }])).toContain(
      "general-purpose assistant",
    );
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

function dataset(
  rows: Record<string, unknown>[][] = [
    [{ datapoint: DP }],
    [{ persona: P, scenario: S, first_message: "Second opener" }],
  ],
): DatasetClient {
  return {
    datasets: {
      listDatapoints: async ({ startingAfter }) => {
        const page = startingAfter === undefined ? 0 : Number(startingAfter);
        return {
          data: (rows[page] ?? []).map((inputs, index) => ({
            inputs,
            id: String(page + 1 + index),
          })),
          hasMore: page < rows.length - 1,
        };
      },
    },
  };
}
function experiment(
  text = JSON.stringify({ inputs: { datapoint: DP }, task_output: "mango" }),
): ExperimentClient {
  return {
    experiments: {
      listRuns: async () => ({
        data: [
          { runId: "latest", createdAt: new Date("2026-01-01T00:00:00Z") },
        ],
        hasMore: false,
      }),
      exportRun: async () =>
        new Blob([text.slice(0, 7), text.slice(7)]).stream(),
    },
  };
}

it("loads all dataset pages in order and keeps row IDs from their serialized datapoints", async () => {
  const rows = await datapointsFromDataset("d", {
    apiKey: "k",
    orqClient: dataset(),
  });
  expect(rows.map((row) => row.id)).toEqual(["dp-one", "P-S"]);
  expect(rows.map((row) => row.first_message)).toEqual([
    "Reply mango",
    "Second opener",
  ]);
});
it("names the dataset and global row index on a malformed later page", async () => {
  await expect(
    datapointsFromDataset("d", {
      apiKey: "k",
      orqClient: dataset([[{ datapoint: DP }], [{ datapoints: [DP, DP] }]]),
    }),
  ).rejects.toThrow("dataset 'd' row 1: row must encode exactly one datapoint");
});
it.each(["missing", "repeat", "empty"] as const)(
  "rejects %s dataset pagination instead of returning a partial load",
  async (mode) => {
    let calls = 0;
    const client: DatasetClient = {
      datasets: {
        listDatapoints: async () => {
          calls++;
          return {
            data:
              mode === "empty" && calls > 1
                ? []
                : [
                    {
                      id: mode === "missing" ? undefined : "same",
                      inputs: { datapoint: DP },
                    },
                  ],
            hasMore: true,
          };
        },
      },
    };
    await expect(
      datapointsFromDataset("d", { apiKey: "k", orqClient: client }),
    ).rejects.toThrow("refusing a partial import");
    expect(calls).toBeLessThanOrEqual(2);
  },
);
it("preserves includeMessages behavior in the shared dataset runner fetcher", async () => {
  const client: DatasetClient = {
    datasets: {
      listDatapoints: async () => ({
        data: [
          {
            inputs: { x: 1 },
            messages: [{ role: "user", content: "hello" }],
            expectedOutput: "expected",
          },
        ],
        hasMore: false,
      }),
    },
  };
  const batches = [];
  for await (const batch of fetchDatasetBatches(client, "d", {
    includeMessages: true,
  }))
    batches.push(batch);
  expect(batches[0]?.datapoints[0]).toEqual({
    inputs: { x: 1, messages: [{ role: "user", content: "hello" }] },
    expectedOutput: "expected",
  });
  const clash: DatasetClient = {
    datasets: {
      listDatapoints: async () => ({
        data: [{ inputs: { messages: [] } }],
        hasMore: false,
      }),
    },
  };
  await expect(
    (async () => {
      for await (const _batch of fetchDatasetBatches(clash, "d", {
        includeMessages: true,
      })) {
      }
    })(),
  ).rejects.toThrow("inputs already contain");
});
it("uses the newest v3 run metadata and supports an explicit run without listing", async () => {
  const client = experiment();
  const list = spyOn(client.experiments, "listRuns");
  const exp = spyOn(client.experiments, "exportRun");
  expect(
    await datapointsFromExperiment("e", { apiKey: "k", orqClient: client }),
  ).toHaveLength(1);
  expect(list).toHaveBeenCalledWith({ experimentId: "e", limit: 50 });
  expect(exp.mock.calls[0]?.[0]).toEqual({
    experimentId: "e",
    runId: "latest",
    format: "jsonl",
  });
  await datapointsFromExperiment("e", {
    apiKey: "k",
    runId: "chosen",
    orqClient: client,
  });
  expect(list).toHaveBeenCalledTimes(1);
  expect(exp.mock.calls[1]?.[0].runId).toBe("chosen");
});
it.each(["no-runs", "no-date", "no-id"] as const)(
  "rejects %s latest-run metadata",
  async (mode) => {
    const client = experiment();
    client.experiments.listRuns = async () => ({
      data:
        mode === "no-runs"
          ? []
          : [
              {
                runId: mode === "no-id" ? undefined : "r",
                createdAt: mode === "no-date" ? undefined : new Date(),
              },
            ],
    });
    await expect(
      datapointsFromExperiment("e", { apiKey: "k", orqClient: client }),
    ).rejects.toThrow();
  },
);
it("keeps recorded responses and existing messages in the common experiment fetcher", async () => {
  const rows = await fetchExperimentDataPoints("k", "e", "r", {
    orqClient: experiment(
      JSON.stringify({
        inputs: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
        task_output: "recorded",
        expected_output: "expected",
      }),
    ),
  });
  expect(rows[0]).toEqual({
    inputs: {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "recorded" },
      ],
    },
    expectedOutput: "expected",
  });
});
it("names the experiment row when an export is not simulation-compatible", async () => {
  await expect(
    datapointsFromExperiment("e", {
      apiKey: "k",
      runId: "r",
      orqClient: experiment(JSON.stringify({ inputs: { x: 1 } })),
    }),
  ).rejects.toThrow("experiment 'e' row 0");
});
it("reads complete exports and rejects malformed, empty or non-object rows", async () => {
  const text =
    JSON.stringify({ inputs: { datapoint: DP } }) +
    "\r\n\r\n" +
    JSON.stringify({ inputs: { datapoint: { ...DP, id: "last" } } });
  const rows = await datapointsFromExperiment("e", {
    apiKey: "k",
    runId: "r",
    orqClient: experiment(text),
  });
  expect(rows.map((row) => row.id)).toEqual(["dp-one", "last"]);
  expect(() => rowsFromExperimentExport("\n", "e", "r")).toThrow("no rows");
  expect(() => rowsFromExperimentExport("{}\n{", "e", "r")).toThrow("line 2");
  expect(() => rowsFromExperimentExport("[]", "e", "r")).toThrow(
    "not an object",
  );
  expect(rowsFromExperimentExport("{}\u0085{}", "e", "r")).toHaveLength(2);
  const broken = experiment();
  broken.experiments.exportRun = async () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}\n"));
        controller.error(new Error("broken stream"));
      },
    });
  await expect(
    datapointsFromExperiment("e", {
      apiKey: "k",
      runId: "r",
      orqClient: broken,
    }),
  ).rejects.toThrow("broken stream");
});
it("requires an Orq key even with a custom generation client", async () => {
  const previous = process.env.ORQ_API_KEY;
  delete process.env.ORQ_API_KEY;
  try {
    await expect(
      datapointsFromDataset("d", { orqClient: dataset() }),
    ).rejects.toThrow("load Orq datasets");
    await expect(
      datapointsFromExperiment("e", { orqClient: experiment() }),
    ).rejects.toThrow("load Orq experiments");
  } finally {
    if (previous === undefined) delete process.env.ORQ_API_KEY;
    else process.env.ORQ_API_KEY = previous;
  }
});
it.each(["dataset", "experiment"] as const)(
  "extends %s seeds through the supplied model client and returns only new rows",
  async (kind) => {
    const { client, requests } = makeFakeClient({
      generator: (request) => {
        const format = request.response_format;
        return {
          content: JSON.stringify(
            format?.type === "json_schema" &&
              format.json_schema.name === "personas"
              ? { personas: [{ ...P, name: "New P" }] }
              : { scenarios: [{ ...S, name: "New S" }] },
          ),
        };
      },
      firstMessage: () => "Fresh opening",
    });
    const options = {
      apiKey: "fetch-key",
      llmConfig: new LLMCallConfig({ client }),
      numPersonas: 1,
      numScenarios: 1,
    };
    const rows =
      kind === "dataset"
        ? await extendFromDataset("d", {
            ...options,
            orqClient: dataset([[{ datapoint: DP }]]),
          })
        : await extendFromExperiment("e", {
            ...options,
            runId: "r",
            orqClient: experiment(),
          });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(DP.id);
    expect(rows[0]?.persona.name).toBe("New P");
    const prompt = JSON.stringify(
      requests.generator.map((request) => request.messages),
    );
    expect(prompt).toContain("EXTEND this coverage");
    expect(prompt).toContain("Get mango");
    expect(prompt).toContain("Customer context");
    expect(requests.firstMessage).toHaveLength(1);
  },
);

let server: ReturnType<typeof Bun.serve>;
let requests: { path: string; authorization: string | null }[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname + url.search,
        authorization: request.headers.get("authorization"),
      });
      if (url.pathname === "/v2/datasets/d/datapoints")
        return Response.json({
          object: "list",
          data: [
            {
              _id: "one",
              dataset_id: "d",
              created_by_id: "tester",
              updated_by_id: "tester",
              inputs: { datapoint: DP },
              expected_output: "mango",
            },
          ],
          has_more: false,
        });
      if (url.pathname === "/v3/experiments/e/runs")
        return Response.json({
          data: [{ run_id: "r", created_at: "2026-01-01T00:00:00Z" }],
          has_more: false,
        });
      if (url.pathname === "/v3/experiments/e/runs/r/export")
        return new Response(
          JSON.stringify({
            inputs: { datapoint: DP },
            task_output: "mango",
            expected_output: "mango",
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      return new Response("missing", { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
});
afterEach(() => {
  requests = [];
});
it("uses the actual SDK dataset and v3 streaming experiment wire formats", async () => {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const ds = await datapointsFromDataset("d", { apiKey: "wire-key", baseUrl });
  const exp = await datapointsFromExperiment("e", {
    apiKey: "wire-key",
    baseUrl,
  });
  expect(ds[0]?.id).toBe(DP.id);
  expect(exp[0]?.id).toBe(DP.id);
  expect(requests.map((request) => request.path)).toEqual([
    "/v2/datasets/d/datapoints?limit=50",
    "/v3/experiments/e/runs?limit=50",
    "/v3/experiments/e/runs/r/export?format=jsonl",
  ]);
  expect(
    requests.every((request) => request.authorization === "Bearer wire-key"),
  ).toBe(true);
});
it.each(["dataset", "experiment"] as const)(
  "runs simulate from its %s source via the actual SDK",
  async (kind) => {
    const previous = {
      key: process.env.ORQ_API_KEY,
      host: process.env.ORQ_BASE_URL,
      tracing: process.env.ORQ_DISABLE_TRACING,
    };
    process.env.ORQ_DISABLE_TRACING = "1";
    process.env.ORQ_API_KEY = "wire-key";
    process.env.ORQ_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { client } = makeFakeClient();
      let targets = 0;
      const results = await simulate({
        ...(kind === "dataset"
          ? { datasetId: "d" }
          : { experimentId: "e", experimentRunId: "r" }),
        client,
        target: () => {
          targets++;
          return "mango";
        },
        maxTurns: 1,
        uploadResults: false,
      });
      expect(results).toHaveLength(1);
      expect(targets).toBe(1);
    } finally {
      if (previous.key === undefined) delete process.env.ORQ_API_KEY;
      else process.env.ORQ_API_KEY = previous.key;
      if (previous.host === undefined) delete process.env.ORQ_BASE_URL;
      else process.env.ORQ_BASE_URL = previous.host;
      if (previous.tracing === undefined)
        delete process.env.ORQ_DISABLE_TRACING;
      else process.env.ORQ_DISABLE_TRACING = previous.tracing;
    }
  },
);
it("rejects conflicting simulation sources before a fetch or model call", async () => {
  const { client, requests: llmRequests } = makeFakeClient();
  for (const source of [
    { datasetId: "d", experimentId: "e" },
    { datasetId: "d", datapoints: [DP] },
    { experimentId: "e", personas: [P], scenarios: [S] },
    { experimentRunId: "r" },
  ]) {
    await expect(
      simulate({
        ...source,
        client,
        target: () => "mango",
        uploadResults: false,
      }),
    ).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
  expect(llmRequests.judge).toHaveLength(0);
});

it("selects the newest run across unordered pages", async () => {
  const client = experiment();
  const cursors: (string | undefined)[] = [];
  client.experiments.listRuns = async ({ startingAfter }) => {
    cursors.push(startingAfter);
    return startingAfter === undefined
      ? {
          data: [{ runId: "old", createdAt: new Date("2020-01-01") }],
          hasMore: true,
        }
      : {
          data: [
            { runId: "newest", createdAt: new Date("2026-01-01") },
            { runId: "middle", createdAt: new Date("2022-01-01") },
          ],
          hasMore: false,
        };
  };
  const exportRun = spyOn(client.experiments, "exportRun");
  await fetchExperimentDataPoints("k", "e", undefined, { orqClient: client });
  expect(cursors).toEqual([undefined, "old"]);
  expect(exportRun.mock.calls[0]?.[0].runId).toBe("newest");
});
it("refuses repeated pagination cursors instead of evaluating an incomplete run list", async () => {
  const client = experiment();
  client.experiments.listRuns = async () => ({
    data: [{ runId: "same", createdAt: new Date() }],
    hasMore: true,
  });
  await expect(
    fetchExperimentDataPoints("k", "e", undefined, { orqClient: client }),
  ).rejects.toThrow("pagination repeated");
});
it.each(["sdk", "fetch"] as const)(
  "caps and cancels oversized %s export streams",
  async (kind) => {
    let cancelled = false;
    let emitted = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = experiment();
    client.experiments.exportRun = async () => stream;
    const options =
      kind === "sdk"
        ? { orqClient: client }
        : { fetchFn: async () => new Response(stream) };
    await expect(
      fetchExperimentDataPoints("k", "e", "r", options),
    ).rejects.toThrow("100 MB size limit");
    expect(cancelled).toBe(true);
    expect(emitted * chunk.byteLength).toBeGreaterThan(
      MAX_EXPERIMENT_EXPORT_BYTES,
    );
  },
);
it.each(["sdk", "fetch"] as const)(
  "times out and cancels a stalled %s export body",
  async (kind) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const client = experiment();
    client.experiments.exportRun = async () => stream;
    const options =
      kind === "sdk"
        ? { orqClient: client, timeoutMs: 10 }
        : { fetchFn: async () => new Response(stream), timeoutMs: 10 };
    await expect(
      fetchExperimentDataPoints("k", "e", "r", options),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
  },
);
