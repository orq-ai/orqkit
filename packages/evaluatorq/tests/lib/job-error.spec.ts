import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { evaluatorq } from "../../src/lib/evaluatorq.js";

describe("Job error", () => {
  const originalKey = process.env.ORQ_API_KEY;

  beforeEach(() => {
    delete process.env.ORQ_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ORQ_API_KEY = originalKey;
    }
  });

  test("keeps the output, records the error and still runs evaluators", async () => {
    let scored = 0;

    const results = await evaluatorq("job-error", {
      data: [{ inputs: {} }],
      jobs: [
        async () => ({ name: "job", output: "partial", error: "run failed" }),
      ],
      evaluators: [
        {
          name: "seen",
          scorer: async () => {
            scored++;
            return { value: 1 };
          },
        },
      ],
      print: false,
    });

    const jobResult = results[0]?.jobResults?.[0];
    expect(jobResult?.output).toBe("partial");
    expect(jobResult?.error?.message).toBe("run failed");
    expect(jobResult?.evaluatorScores?.[0]?.score.value).toBe(1);
    expect(scored).toBe(1);
  });

  test("a job without an error has none recorded", async () => {
    const results = await evaluatorq("job-ok", {
      data: [{ inputs: {} }],
      jobs: [async () => ({ name: "job", output: "ok" })],
      print: false,
    });

    expect(results[0]?.jobResults?.[0]?.error).toBeUndefined();
  });
});
