import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import * as fetching from "../../../src/lib/common/fetch-data.js";
import {
  replayRecordedResponse,
  resolveEvaluationData,
  resolveEvaluationMode,
} from "../../../src/lib/common/runner-input.js";
import * as traces from "../../../src/lib/common/trace-input.js";
import { MessageSchema } from "../../../src/lib/contracts.js";
import { evaluatorq, evaluatorqEffect } from "../../../src/lib/evaluatorq.js";
import { ExperimentInput } from "../../../src/lib/experiment.js";
import { Trace, TraceInput } from "../../../src/lib/trace.js";
import * as tracing from "../../../src/lib/tracing/index.js";
import type { DataPoint, Job } from "../../../src/lib/types.js";
import goldens from "../fixtures/core-replay-python-goldens.json" with {
  type: "json",
};

let original: NodeJS.ProcessEnv, restorers: (() => void)[];
beforeEach(() => {
  original = { ...process.env };
  delete process.env.ORQ_API_KEY;
  process.env.ORQ_DISABLE_TRACING = "true";
  restorers = [];
  const info = spyOn(console, "info").mockImplementation(() => {});
  restorers.push(() => info.mockRestore());
  const trace = spyOn(tracing, "initTracingIfNeeded").mockResolvedValue(false);
  restorers.push(() => trace.mockRestore());
});
afterEach(() => {
  for (const restore of restorers.reverse()) restore();
  process.env = original;
});
const job: Job = async () => ({ name: "generated", output: "must not run" });
const native = (raw: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key === "recorded_output"
        ? "recordedOutput"
        : key === "trace_import_error"
          ? "traceImportError"
          : key,
      value,
    ]),
  );
for (const row of goldens.cases)
  for (const spelling of ["python", "native"])
    test(`Python recorded response ${row.index} ${spelling}`, async () => {
      const inputs = spelling === "python" ? row.inputs : native(row.inputs);
      if (row.error !== null)
        await expect(replayRecordedResponse({ inputs }, 0)).rejects.toThrow(
          row.error,
        );
      else
        expect<unknown>(await replayRecordedResponse({ inputs }, 0)).toEqual(
          row.expected,
        );
    });
for (const [index, row] of goldens.modes.entries())
  test(`Python inference mode ${index}`, () => {
    const data =
        row.source === "array"
          ? []
          : row.source === "trace"
            ? new TraceInput({ traceId: "trace" })
            : new ExperimentInput({ experimentId: "experiment" }),
      jobs = row.jobs === null ? undefined : row.jobs ? [job] : [];
    if (row.error)
      expect(() => resolveEvaluationMode(data, jobs, row.inference)).toThrow();
    else {
      const mode = resolveEvaluationMode(data, jobs, row.inference);
      expect(mode.inference).toBe(row.expected as boolean);
      expect(mode.jobs.length).toBe(1);
      expect(mode.jobs[0]).toBe(row.expected ? job : replayRecordedResponse);
    }
  });
test("inference=false skips provided jobs and scores the unchanged recorded message output in both APIs", async () => {
  let generated = 0;
  const ignored: Job = async () => {
      generated++;
      return { name: "ignored", output: "wrong" };
    },
    output = [{ role: "assistant", content: "kept" }],
    rows: DataPoint[] = [{ inputs: { recordedOutput: output } }];
  for (const effect of [false, true]) {
    const params = {
        data: rows,
        jobs: [ignored],
        inference: false,
        print: false,
        sendResults: false,
        manageTracing: false,
        exitOnFailure: false,
        evaluators: [
          {
            name: "recorded",
            scorer: async ({ output: actual }: { output: unknown }) => {
              expect(actual).toEqual(output);
              return { value: 1, pass: true };
            },
          },
        ],
      },
      result = effect
        ? await Effect.runPromise(evaluatorqEffect("recorded", params))
        : await evaluatorq("recorded", params);
    expect(result[0]?.jobResults?.[0]?.jobName).toBe("recorded");
    expect<unknown>(result[0]?.jobResults?.[0]?.output).toEqual(output);
  }
  expect(generated).toBe(0);
});
test("trace input defaults to replay, preserves failed imports and never evaluates failed rows", async () => {
  const good = new Trace({
      traceId: "good",
      outputMessages: [
        MessageSchema.parse({ role: "assistant", content: "recorded" }),
      ],
    }),
    bad = new Trace({ traceId: "bad", importError: "not importable" }),
    load = spyOn(traces, "loadTraces").mockResolvedValue({
      traces: [good, bad],
      usable: [good],
      failed: [bad],
    });
  restorers.push(() => load.mockRestore());
  let scored = 0;
  const result = await evaluatorq("traces", {
    data: new TraceInput({ traceId: "requested" }),
    print: false,
    sendResults: false,
    manageTracing: false,
    exitOnFailure: false,
    evaluators: [
      {
        name: "count",
        scorer: async () => {
          scored++;
          return { value: 1 };
        },
      },
    ],
  });
  expect(result.length).toBe(2);
  expect<unknown>(result[0]?.jobResults?.[0]?.output).toEqual([
    { role: "assistant", content: "recorded" },
  ]);
  expect(result[1]?.dataPoint.inputs.sourceTraceId).toBe("bad");
  expect(result[1]?.jobResults?.[0]?.error?.message).toContain(
    "not importable",
  );
  expect(scored).toBe(1);
});
test("trace source with no matches and explicit inference reject before generating", async () => {
  const source = new TraceInput({ traceId: "trace" }),
    load = spyOn(traces, "loadTraces").mockResolvedValue({
      traces: [],
      usable: [],
      failed: [],
    });
  restorers.push(() => load.mockRestore());
  await expect(
    evaluatorq("empty", { data: source, print: false }),
  ).rejects.toThrow("selected no traces");
  await expect(
    evaluatorq("invalid", {
      data: source,
      inference: true,
      jobs: [job],
      print: false,
    }),
  ).rejects.toThrow("only valid with inference=false");
  expect(load).toHaveBeenCalledTimes(1);
});
test("experiment input forwards run and host selection and requires its credential", async () => {
  const source = new ExperimentInput({
    experimentId: "experiment",
    runId: "run",
  });
  await expect(resolveEvaluationData(source)).rejects.toThrow("ORQ_API_KEY");
  const fetch = spyOn(fetching, "fetchExperimentDataPoints").mockResolvedValue([
    { inputs: { messages: [{ role: "assistant", content: "saved" }] } },
  ]);
  restorers.push(() => fetch.mockRestore());
  const rows = await resolveEvaluationData(source, {
    apiKey: "synthetic",
    baseUrl: "https://synthetic.example",
  });
  expect(fetch).toHaveBeenCalledWith("synthetic", "experiment", "run", {
    baseUrl: "https://synthetic.example",
  });
  expect(Array.isArray(rows)).toBe(true);
  process.env.ORQ_API_KEY = "synthetic";
  const result = await Effect.runPromise(
    evaluatorqEffect("experiment", {
      data: source,
      print: false,
      sendResults: false,
    }),
  );
  expect(result[0]?.jobResults?.[0]?.output).toBe("saved");
});
test("dataset replay forces message loading in streaming and Effect APIs", async () => {
  process.env.ORQ_API_KEY = "synthetic";
  const setup = spyOn(fetching, "setupOrqClient").mockResolvedValue(
    {} as never,
  );
  restorers.push(() => setup.mockRestore());
  const rows = [
      {
        inputs: { messages: [{ role: "assistant", content: "from dataset" }] },
      },
    ],
    stream = spyOn(fetching, "fetchDatasetBatches").mockImplementation(
      async function* (_client, _id, options) {
        expect(options?.includeMessages).toBe(true);
        yield { datapoints: rows, hasMore: false, batchNumber: 0 };
      },
    );
  restorers.push(() => stream.mockRestore());
  const batch = spyOn(fetching, "fetchDatasetAsDataPoints").mockImplementation(
    async (_client, _id, options) => {
      expect(options?.includeMessages).toBe(true);
      return rows.map((row) => Promise.resolve(row));
    },
  );
  restorers.push(() => batch.mockRestore());
  const params = {
    data: { datasetId: "dataset", includeMessages: false },
    inference: false,
    print: false,
    sendResults: false,
    manageTracing: false,
    exitOnFailure: false,
  };
  expect(
    (await evaluatorq("dataset", params))[0]?.jobResults?.[0]?.output,
  ).toBe("from dataset");
  expect(
    (await Effect.runPromise(evaluatorqEffect("dataset", params)))[0]
      ?.jobResults?.[0]?.output,
  ).toBe("from dataset");
});
