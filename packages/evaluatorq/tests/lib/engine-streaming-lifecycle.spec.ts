import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import * as fetchData from "../../src/lib/common/fetch-data.js";
import {
  evaluatorq,
  evaluatorqEffect,
  StreamingEvaluationError,
} from "../../src/lib/evaluatorq.js";
import * as tracing from "../../src/lib/tracing/index.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const data = (size: number, offset = 0) =>
  Array.from({ length: size }, (_, index) => ({
    inputs: { index: index + offset },
  }));
const base = {
  data: { datasetId: "synthetic" },
  print: false,
  sendResults: false,
  exitOnFailure: false,
  manageTracing: false,
  datapointParallelism: 2,
};
let previousKey: string | undefined,
  spies: ReturnType<typeof spyOn>[] = [],
  batches: () => AsyncGenerator<fetchData.DataPointBatch>;
beforeEach(() => {
  previousKey = process.env.ORQ_API_KEY;
  process.env.ORQ_API_KEY = "synthetic";
  batches = async function* () {
    yield { datapoints: data(3), hasMore: true, batchNumber: 1 };
    yield { datapoints: data(3, 3), hasMore: false, batchNumber: 2 };
  };
  spies = [
    spyOn(tracing, "initTracingIfNeeded").mockResolvedValue(false),
    spyOn(fetchData, "setupOrqClient").mockResolvedValue(
      {} as NonNullable<Awaited<ReturnType<typeof fetchData.setupOrqClient>>>,
    ),
    spyOn(fetchData, "fetchDatasetBatches").mockImplementation(() => batches()),
    spyOn(fetchData, "fetchDatasetAsDataPoints").mockResolvedValue(
      data(4).map((point) => Promise.resolve(point)),
    ),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  if (previousKey === undefined) delete process.env.ORQ_API_KEY;
  else process.env.ORQ_API_KEY = previousKey;
});
test("streaming completion callbacks hold their datapoint slots and results remain ordered", async () => {
  let active = 0,
    peak = 0;
  const seen: number[] = [];
  const results = await evaluatorq("stream", {
    ...base,
    jobs: [
      async (point) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(2);
        return { name: "job", output: point.inputs.index as number };
      },
    ],
    onDatapointComplete: async (result) => {
      seen.push(result.dataPoint.inputs.index as number);
      await sleep(5);
      active--;
    },
  });
  expect(active).toBe(0);
  expect(peak).toBe(2);
  expect(seen).toHaveLength(6);
  expect(results.map((result) => result.dataPoint.inputs.index)).toEqual([
    0, 1, 2, 3, 4, 5,
  ]);
});
test("streaming collects callback errors after settling every started row", async () => {
  let active = 0,
    done = 0;
  const seen: number[] = [];
  const error = await evaluatorq("stream", {
    ...base,
    jobs: [
      async (point) => {
        active++;
        await sleep(2);
        active--;
        done++;
        return { name: "job", output: point.inputs.index as number };
      },
    ],
    onDatapointComplete: (result) => {
      const index = result.dataPoint.inputs.index as number;
      seen.push(index);
      if (index < 2) throw new Error(`callback-${index}`);
    },
  }).then(
    () => null,
    (error) => error,
  );
  expect(error).toBeInstanceOf(StreamingEvaluationError);
  expect((error as AggregateError).errors).toHaveLength(2);
  expect(active).toBe(0);
  expect(done).toBe(6);
  expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5]);
});
test("streaming fetch failure settles workers and prevents later scorers or callbacks", async () => {
  let active = 0,
    scored = 0,
    notified = 0,
    notify: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      notify = resolve;
    }),
    failure = new Error("fetch failed");
  batches = async function* () {
    yield { datapoints: data(2), hasMore: true, batchNumber: 1 };
    await ready;
    throw failure;
  };
  const error = await evaluatorq("stream", {
    ...base,
    jobs: [
      async () => {
        active++;
        if (active === 2) notify();
        try {
          await sleep(20);
          return { name: "job", output: "ok" };
        } finally {
          active--;
        }
      },
    ],
    evaluators: [
      {
        name: "scorer",
        scorer: async () => {
          scored++;
          return { value: true };
        },
      },
    ],
    onDatapointComplete: () => {
      notified++;
    },
  }).then(
    () => null,
    (error) => error,
  );
  expect(error).toBe(failure);
  expect(active).toBe(0);
  expect(scored).toBe(0);
  expect(notified).toBe(0);
});
test("Effect dataset loading forwards terminal callbacks exactly once", async () => {
  const seen: number[] = [];
  const results = await Effect.runPromise(
    evaluatorqEffect("dataset", {
      ...base,
      jobs: [
        async (point) => ({
          name: "job",
          output: point.inputs.index as number,
        }),
      ],
      onDatapointComplete: async (result) => {
        await sleep(1);
        seen.push(result.dataPoint.inputs.index as number);
      },
    }),
  );
  expect(results).toHaveLength(4);
  expect(seen.sort()).toEqual([0, 1, 2, 3]);
});
test("streaming progress polling stops after callback and fetch failures", async () => {
  const started = spyOn(globalThis, "setInterval"),
    cleared = spyOn(globalThis, "clearInterval");
  try {
    await evaluatorq("stream", {
      ...base,
      jobs: [async () => ({ name: "job", output: "ok" })],
      onDatapointComplete: () => {
        throw new Error("callback failed");
      },
    }).catch(() => {});
    batches = async function* () {
      yield* [];
      throw new Error("fetch failed");
    };
    await evaluatorq("stream", {
      ...base,
      jobs: [async () => ({ name: "job", output: "ok" })],
    }).catch(() => {});
    const timers = started.mock.results
      .filter((result) => result.type === "return")
      .map((result) => result.value);
    expect(timers).toHaveLength(2);
    for (const timer of timers)
      expect(cleared.mock.calls.some(([value]) => value === timer)).toBe(true);
  } finally {
    started.mockRestore();
    cleared.mockRestore();
  }
});
