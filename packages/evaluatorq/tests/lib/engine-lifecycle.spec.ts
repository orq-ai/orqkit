import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import {
  activeLlmParallelism,
  llmConcurrencyLimit,
  llmSlot,
} from "../../src/lib/common/llm-limit.js";
import { evaluatorq, evaluatorqEffect } from "../../src/lib/evaluatorq.js";
import * as tracing from "../../src/lib/tracing/index.js";
import type { EvaluatorParams } from "../../src/lib/types.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const data = (size: number) =>
  Array.from({ length: size }, (_, index) => ({ inputs: { index } }));
const base = {
  print: false,
  sendResults: false,
  exitOnFailure: false,
  manageTracing: false,
};
let tracingSpy: ReturnType<typeof spyOn>, warning: ReturnType<typeof spyOn>;
beforeEach(() => {
  tracingSpy = spyOn(tracing, "initTracingIfNeeded").mockResolvedValue(false);
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  tracingSpy.mockRestore();
  warning.mockRestore();
});
const runners = {
  async: (params: EvaluatorParams) =>
    evaluatorq("lifecycle", { ...base, ...params }),
  effect: (params: EvaluatorParams) =>
    Effect.runPromise(evaluatorqEffect("lifecycle", { ...base, ...params })),
};
for (const [kind, run] of Object.entries(runners)) {
  test(`${kind} datapoint concurrency includes awaited callbacks and preserves input result order`, async () => {
    let active = 0,
      peak = 0;
    const completed: number[] = [];
    const results = await run({
      data: data(8),
      datapointParallelism: 3,
      jobs: [
        async (point) => {
          active++;
          peak = Math.max(peak, active);
          await sleep(Number(point.inputs.index) === 0 ? 30 : 3);
          return { name: "job", output: point.inputs.index as number };
        },
      ],
      onDatapointComplete: async (result) => {
        completed.push(result.dataPoint.inputs.index as number);
        await sleep(8);
        active--;
      },
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(completed).toHaveLength(8);
    expect(completed[0]).not.toBe(0);
    expect([...completed].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(results.map((result) => result.dataPoint.inputs.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });
  test(`${kind} default concurrency is ten and the new parameter wins the deprecated alias`, async () => {
    let active = 0,
      peak = 0;
    const jobs: EvaluatorParams["jobs"] = [
      async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(10);
        active--;
        return { name: "job", output: "ok" };
      },
    ];
    await run({ data: data(13), jobs });
    expect(peak).toBe(10);
    peak = 0;
    await run({ data: data(5), jobs, parallelism: 1, datapointParallelism: 3 });
    expect(peak).toBe(3);
    expect(warning).toHaveBeenCalledTimes(2);
  });
  test(`${kind} callback failures propagate after active jobs settle and prevent later scorers`, async () => {
    let active = 0,
      laterScorers = 0;
    const callbackError = new Error("callback failed"),
      completed: number[] = [];
    const pending = run({
      data: data(8),
      datapointParallelism: 3,
      jobs: [
        async (point) => {
          active++;
          try {
            if (point.inputs.index !== 0) await sleep(25);
            return { name: "job", output: "ok" };
          } finally {
            active--;
          }
        },
      ],
      evaluators: [
        {
          name: "scorer",
          scorer: async ({ data: point }) => {
            if (point.inputs.index !== 0) laterScorers++;
            return { value: true };
          },
        },
      ],
      onDatapointComplete: (result) => {
        completed.push(result.dataPoint.inputs.index as number);
        throw callbackError;
      },
    });
    await expect(pending).rejects.toThrow("callback failed");
    expect(active).toBe(0);
    expect(laterScorers).toBe(0);
    expect(completed).toEqual([0]);
  });
  test(`${kind} reports terminal datapoint and job failures exactly once`, async () => {
    const seen: unknown[] = [];
    const rows = await run({
      data: [
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("data failed")), 1),
        ),
      ],
      onDatapointComplete: (result) => {
        seen.push(result);
      },
      jobs: [async () => ({ name: "unused", output: "x" })],
    });
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(rows[0]?.error?.message).toBe("data failed");
    seen.length = 0;
    await run({
      data: data(1),
      jobs: [
        async () => {
          throw new Error("job failed");
        },
      ],
      onDatapointComplete: (result) => {
        seen.push(result);
        expect(result.jobResults?.[0]?.error?.message).toBe("job failed");
      },
    });
    expect(seen).toHaveLength(1);
  });
  test(`${kind} one shared LLM ceiling bounds requests across all datapoints`, async () => {
    let active = 0,
      peak = 0;
    const observed: (number | undefined)[] = [];
    await run({
      data: data(6),
      datapointParallelism: 6,
      llmParallelism: 2,
      jobs: [
        async () => {
          observed.push(activeLlmParallelism());
          await llmSlot(async () => {
            active++;
            peak = Math.max(peak, active);
            await sleep(5);
            active--;
          });
          return { name: "llm", output: "ok" };
        },
      ],
    });
    expect(peak).toBe(2);
    expect(observed).toEqual(Array(6).fill(2));
  });
  test(`${kind} explicit and unbounded inner ceilings preserve the enclosing limit`, async () => {
    for (const limit of [4, -1, undefined]) {
      const observed: (number | undefined)[] = [];
      await llmConcurrencyLimit(1, () =>
        run({
          data: data(2),
          datapointParallelism: 2,
          llmParallelism: limit,
          jobs: [
            async () => {
              observed.push(activeLlmParallelism());
              return { name: "nested", output: "ok" };
            },
          ],
        }),
      );
      expect(observed).toEqual([1, 1]);
    }
  });
  test(`${kind} rejects invalid concurrency before calling jobs`, async () => {
    let called = false;
    for (const value of [0, -1, 1.5, NaN, Infinity])
      await expect(
        run({
          data: data(1),
          datapointParallelism: value,
          jobs: [
            async () => {
              called = true;
              return { name: "job", output: "ok" };
            },
          ],
        }),
      ).rejects.toThrow("datapointParallelism");
    for (const value of [0, -2, 1.5, NaN, Infinity])
      await expect(
        run({
          data: data(1),
          llmParallelism: value,
          jobs: [
            async () => {
              called = true;
              return { name: "job", output: "ok" };
            },
          ],
        }),
      ).rejects.toThrow("llmParallelism");
    expect(called).toBe(false);
  });
}
test("Effect construction does not capture a limit before the run executes", async () => {
  const seen: (number | undefined)[] = [],
    program = llmConcurrencyLimit(4, () =>
      evaluatorqEffect("lazy", {
        ...base,
        data: data(2),
        llmParallelism: 3,
        jobs: [
          async () => {
            seen.push(activeLlmParallelism());
            return { name: "job", output: "ok" };
          },
        ],
      }),
    );
  await llmConcurrencyLimit(1, () => Effect.runPromise(program));
  expect(seen).toEqual([1, 1]);
  seen.length = 0;
  await Effect.runPromise(program);
  expect(seen).toEqual([3, 3]);
});
test("Effect interruption waits for started user work to settle", async () => {
  let active = 0,
    notify: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      notify = resolve;
    }),
    controller = new AbortController();
  const program = evaluatorqEffect("cancel", {
    ...base,
    data: data(4),
    datapointParallelism: 2,
    jobs: [
      async () => {
        active++;
        if (active === 2) notify();
        try {
          await sleep(30);
          return { name: "job", output: "ok" };
        } finally {
          active--;
        }
      },
    ],
  });
  const result = Effect.runPromise(program, { signal: controller.signal }).then(
    () => null,
    (error) => error,
  );
  await ready;
  controller.abort();
  expect(await result).toBeTruthy();
  expect(active).toBe(0);
});
for (const [kind, run] of Object.entries(runners))
  test(`${kind} callback failure aborts a pending provider request`, async () => {
    const { default: OpenAI } = await import("openai"),
      { executeChatCompletion } = await import(
        "../../src/lib/common/llm-call.js"
      );
    let active = 0,
      notify: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
        notify = resolve;
      }),
      callbackError = new Error("stop pending provider");
    const client = new OpenAI({
      apiKey: "synthetic",
      baseURL: "http://synthetic.invalid/v1",
      maxRetries: 0,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing provider abort signal");
        active++;
        notify();
        return new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              active--;
              reject(new Error("provider aborted"));
            },
            { once: true },
          );
        });
      },
    });
    const pending = run({
      data: data(2),
      datapointParallelism: 2,
      jobs: [async () => ({ name: "job", output: "ok" })],
      evaluators: [
        {
          name: "provider",
          scorer: async ({ data: point }) => {
            if (point.inputs.index === 1)
              await executeChatCompletion({
                client,
                span: undefined,
                model: "synthetic",
                messages: [{ role: "user", content: "hi" }],
                timeoutMs: 60000,
              });
            return { value: true };
          },
        },
      ],
      onDatapointComplete: async (result) => {
        if (result.dataPoint.inputs.index === 0) {
          await ready;
          throw callbackError;
        }
      },
    });
    const error = await pending.then(
      () => null,
      (error) => error,
    );
    expect(error).toBeTruthy();
    expect(active).toBe(0);
    if (kind === "async") expect(error).toBe(callbackError);
  });
for (const [kind, run] of Object.entries(runners))
  test(`${kind} cancellation removes LLM slot waiters without waiting for an unrelated holder`, async () => {
    const { default: OpenAI } = await import("openai"),
      { executeChatCompletion } = await import(
        "../../src/lib/common/llm-call.js"
      );
    let release: () => void = () => {},
      notify: () => void = () => {},
      called = false;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        notify = resolve;
      }),
      client = new OpenAI({
        apiKey: "synthetic",
        baseURL: "http://synthetic.invalid/v1",
        maxRetries: 0,
        fetch: async () => {
          called = true;
          throw new Error("unexpected queued provider request");
        },
      });
    await llmConcurrencyLimit(1, async () => {
      const holder = llmSlot(() => blocked);
      await sleep(1);
      let finished = false;
      const pending = run({
        data: data(2),
        datapointParallelism: 2,
        jobs: [async () => ({ name: "job", output: "ok" })],
        evaluators: [
          {
            name: "provider",
            scorer: async ({ data: point }) => {
              if (point.inputs.index === 1) {
                notify();
                await executeChatCompletion({
                  client,
                  span: undefined,
                  model: "synthetic",
                  messages: [],
                  timeoutMs: 60000,
                });
              }
              return { value: true };
            },
          },
        ],
        onDatapointComplete: async (result) => {
          if (result.dataPoint.inputs.index === 0) {
            await ready;
            throw new Error("cancel queued provider");
          }
        },
      }).then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      let finishedBeforeRelease = false;
      try {
        await ready;
        await sleep(25);
        finishedBeforeRelease = finished;
      } finally {
        release();
        await holder;
        await pending;
      }
      expect(finishedBeforeRelease).toBe(true);
      expect(called).toBe(false);
    });
  });
