import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  appendJurySummary,
  attachJuryRawOutput,
  duplicateJudgesMessage,
  evenPanelTieOutcome,
  type JudgeFn,
  type Prediction,
  panelCompositionMessages,
  providerFamily,
  resolvePanel,
  runJury,
  TIE_LOSES_VERDICT,
  unswap,
  validateAggregator,
} from "../../src/lib/common/jury.js";
import {
  addUsage,
  extractUsage,
  JURY_RAW_OUTPUT_KEY,
  JuryResultSchema,
  JuryVoteSchema,
  subtractUsage,
  UsageSchema,
} from "../../src/lib/contracts.js";

const byModel =
  (table: Record<string, Prediction | Error>): JudgeFn =>
  async (model) => {
    const entry = table[model];
    if (entry instanceof Error) {
      throw entry;
    }
    return entry ?? { error: "missing" };
  };

let silenced: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  silenced = [
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const spy of silenced) {
    spy.mockRestore();
  }
});

describe("runJury", () => {
  test("plurality verdict with agreement and summed usage", async () => {
    const usage = UsageSchema.parse({ inputTokens: 5, calls: 1 });
    const result = await runJury({
      panel: ["a", "b", "c"],
      judgeFn: byModel({
        a: { value: "yes", explanation: "A", tokenUsage: usage },
        b: { value: "yes", explanation: "B", tokenUsage: usage },
        c: { value: "no", explanation: "C" },
      }),
    });
    expect(result.verdict).toBe("yes");
    expect(result.explanation).toBe("A");
    expect(result.jury.rawAgreement).toBeCloseTo(2 / 3);
    expect(result.tokenUsage?.inputTokens).toBe(10);
    expect(result.tokenUsage?.calls).toBe(2);
  });

  test("a tie without tie-break is inconclusive", async () => {
    const result = await runJury({
      panel: ["a", "b"],
      judgeFn: byModel({ a: { value: "x" }, b: { value: "y" } }),
    });
    expect(result.verdict).toBeNull();
    expect(result.jury.inconclusive).toBe(true);
    expect(result.jury.tie).toBe(false);
    expect(result.jury.stats).toBeNull();
  });

  test("a tie-break sets the flag and labels the explanation", async () => {
    const result = await runJury({
      panel: ["a", "b"],
      judgeFn: byModel({
        a: { value: "x", explanation: "why" },
        b: { value: "y" },
      }),
      tieBreak: () => "x",
      tieBreakLabel: "fail closed",
    });
    expect(result.verdict).toBe("x");
    expect(result.jury.tie).toBe(true);
    expect(result.explanation).toBe("[TIE: fail closed] why");
  });

  test.each([
    ["mean_std", 2],
    ["median", 1],
    ["min", 1],
    ["max", 4],
  ] as const)("numeric %s", async (aggregator, want) => {
    const result = await runJury({
      panel: ["a", "b", "c"],
      verdictKind: "numeric",
      aggregator,
      judgeFn: byModel({
        a: { value: 1 },
        b: { value: 1 },
        c: { value: 4 },
      }),
    });
    expect(result.verdict).toBe(want);
    expect(result.jury.rawAgreement).toBeNull();
    expect(result.jury.stats?.mean).toBe(2);
  });

  test("majority needs more than half", async () => {
    const result = await runJury({
      panel: ["a", "b", "c"],
      aggregator: "majority",
      judgeFn: byModel({
        a: { value: "x" },
        b: { value: "y" },
        c: { value: "z" },
      }),
    });
    expect(result.verdict).toBeNull();
    expect(result.jury.inconclusive).toBe(true);
  });

  test("Boolean and equal numeric categorical votes share Python's tally", async () => {
    for (const [first, equivalent] of [
      [true, 1],
      [1, true],
      [false, 0],
      [0, false],
    ] as const) {
      const result = await runJury({
        panel: ["a", "b", "c"],
        verdictKind: "categorical",
        judgeFn: byModel({
          a: { value: first },
          b: { value: equivalent },
          c: { value: equivalent },
        }),
      });
      expect(result.verdict).toBe(first);
      expect(result.jury.rawAgreement).toBe(1);
    }
  });

  test("custom aggregator sees failed votes", async () => {
    let seen = 0;
    const result = await runJury({
      panel: ["a", "b"],
      judgeFn: byModel({ a: { value: "x" }, b: new Error("down") }),
      aggregator: (votes) => {
        seen = votes.length;
        return "custom";
      },
    });
    expect(seen).toBe(2);
    expect(result.verdict).toBe("custom");
  });

  test("replacement stands in only for failures, deduplicated", async () => {
    const calls: string[] = [];
    const result = await runJury({
      panel: ["a", "b"],
      replacementJudges: ["a", "r", "r", "s"],
      judgeFn: async (model) => {
        calls.push(model);
        if (model === "b") {
          throw new Error("down");
        }
        return { value: true };
      },
    });
    expect(calls.sort()).toEqual(["a", "b", "r"]);
    expect(result.jury.replacementsUsed).toBe(1);
    expect(result.jury.judgesFailed).toBe(1);
    expect(result.jury.judgesConfigured).toBe(2);
    expect(result.verdict).toBe(true);
    expect(result.jury.stats).toEqual({ mean: 1, std: 0 });
  });

  test("propagateErrors aborts", async () => {
    await expect(
      runJury({
        panel: ["a"],
        propagateErrors: true,
        judgeFn: byModel({ a: new Error("outage") }),
      }),
    ).rejects.toThrow("outage");
  });

  test("minSuccessfulJudges makes a thin panel inconclusive", async () => {
    const result = await runJury({
      panel: ["a", "b"],
      minSuccessfulJudges: 2,
      judgeFn: byModel({ a: { value: "x" }, b: { abstained: true } }),
    });
    expect(result.jury.inconclusive).toBe(true);
    expect(result.explanation).toContain("only 1 of 2");
  });

  test("repetitions count failures but not clean abstentions", async () => {
    const queue: Prediction[] = [
      { value: "x" },
      { abstained: true },
      { error: "bad" },
      {},
    ];
    const result = await runJury({
      panel: ["a"],
      repetitions: 4,
      judgeFn: async () => queue.shift() as Prediction,
    });
    const vote = result.jury.votes[0];
    expect(vote?.repetitionsFailed).toBe(2);
    expect(vote?.value).toBe("x");
    expect(vote?.repetitions.map((r) => r.value)).toEqual([
      "x",
      null,
      null,
      null,
    ]);
  });

  test("all abstaining is a successful non-verdict", async () => {
    const result = await runJury({
      panel: ["a"],
      judgeFn: byModel({ a: { abstained: true, explanation: "unsure" } }),
    });
    expect(result.jury.votes[0]?.abstained).toBe(true);
    expect(result.jury.votes[0]?.success).toBe(true);
    expect(result.explanation).toContain("abstained");
  });

  test("the last error reaches the explanation when all fail", async () => {
    const result = await runJury({
      panel: ["a", "b"],
      judgeFn: byModel({ a: new Error("one"), b: new Error("two") }),
    });
    expect(result.explanation).toContain("last error: two");
  });

  test("rejects an empty panel", async () => {
    await expect(
      runJury({ panel: ["", ""], judgeFn: byModel({}) }),
    ).rejects.toThrow("at least one");
  });
});

describe("contracts", () => {
  test("saved votes accept Python bare repetition values", () => {
    const vote = JuryVoteSchema.parse({
      model: "m",
      success: true,
      value: "yes",
      repetitions: [
        "yes",
        null,
        true,
        1,
        { value: "no", explanation: "checked" },
      ],
    });
    expect(vote.repetitions.map((item) => item.value)).toEqual([
      "yes",
      null,
      true,
      1,
      "no",
    ]);
    expect(vote.repetitions[4]?.explanation).toBe("checked");
    expect(() =>
      JuryVoteSchema.parse({ model: "m", success: false, repetitions: [[]] }),
    ).toThrow();
  });
  test("votes reject contradictions", () => {
    expect(() => JuryVoteSchema.parse({ model: "m", success: true })).toThrow();
    expect(() =>
      JuryVoteSchema.parse({
        model: "m",
        success: true,
        abstained: true,
        value: "x",
      }),
    ).toThrow();
    expect(() =>
      JuryVoteSchema.parse({ model: "m", success: false, value: "x" }),
    ).toThrow();
    expect(() =>
      JuryVoteSchema.parse({ model: "m", success: false, abstained: true }),
    ).toThrow();
  });

  test("a result must reconcile with its votes", () => {
    const vote = { model: "m", success: true, value: "x" };
    expect(() =>
      JuryResultSchema.parse({
        judgesConfigured: 1,
        judgesSucceeded: 0,
        judgesFailed: 0,
        votes: [vote],
      }),
    ).toThrow("judgesSucceeded");
    expect(() =>
      JuryResultSchema.parse({
        judgesConfigured: 2,
        judgesSucceeded: 1,
        judgesFailed: 0,
        votes: [vote],
      }),
    ).toThrow("vote count");
  });

  test("usage cost stays unknown only when both sides are", () => {
    const known = UsageSchema.parse({ totalCost: 1, calls: 1, pricedCalls: 1 });
    const unknown = UsageSchema.parse({ calls: 1 });
    expect(addUsage(known, unknown).totalCost).toBe(1);
    expect(addUsage(unknown, unknown).totalCost).toBeNull();
    expect(subtractUsage(unknown, known).calls).toBe(0);
  });

  test("extractUsage reads provider shapes and refuses empty ones", () => {
    expect(extractUsage({})).toBeNull();
    expect(extractUsage({ input_tokens: -1, prompt_tokens: 10 })).toMatchObject(
      {
        inputTokens: 10,
        totalTokens: 10,
        calls: 1,
      },
    );
    expect(
      extractUsage({
        prompt_tokens: 4,
        completion_tokens: 6,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3 },
        input_cost: 0.1,
        output_cost: 0.2,
      }),
    ).toMatchObject({
      totalTokens: 10,
      cachedTokens: 2,
      reasoningTokens: 3,
      pricedCalls: 1,
    });
    expect(
      extractUsage({
        input_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 3 },
      })?.cacheCreationTokens,
    ).toBe(3);
  });
});

describe("helpers", () => {
  test("unswap flips only slot labels", () => {
    expect(unswap("A")).toBe("B");
    expect(unswap("B")).toBe("A");
    expect(unswap("tie")).toBe("tie");
    expect(unswap(true)).toBe(true);
    expect(unswap(null)).toBeNull();
  });

  test("validateAggregator enforces the verdict kind", () => {
    expect(() => validateAggregator("mode", "numeric")).toThrow("categorical");
    expect(() => validateAggregator("median", "categorical")).toThrow(
      "numeric",
    );
    expect(() => validateAggregator("nope" as "mode", "categorical")).toThrow(
      "Unknown",
    );
    expect(() => validateAggregator(() => null, "numeric")).not.toThrow();
    expect(() => validateAggregator(undefined, "numeric")).not.toThrow();
  });

  test("appendJurySummary reports only what exists", () => {
    const jury = JuryResultSchema.parse({
      judgesConfigured: 1,
      judgesSucceeded: 1,
      judgesFailed: 0,
      votes: [{ model: "m", success: true, value: "x" }],
      rawAgreement: 1,
    });
    expect(appendJurySummary("base", jury)).toBe(
      "base [jury: 1/1 judges, raw agreement 100%]",
    );
    expect(appendJurySummary("base", null)).toBe("base");
  });

  test("attachJuryRawOutput keeps null when there is no jury", () => {
    expect(attachJuryRawOutput(null, null)).toBeNull();
    const jury = JuryResultSchema.parse({
      judgesConfigured: 0,
      judgesSucceeded: 0,
      judgesFailed: 0,
    });
    expect(attachJuryRawOutput({ a: 1 }, jury)).toEqual({
      a: 1,
      [JURY_RAW_OUTPUT_KEY]: jury,
    });
  });

  test.each([
    ["openai/gpt-4.1", "openai"],
    ["gpt4", "openai"],
    ["aws/eu.anthropic.claude-haiku-4-5", "anthropic"],
    ["deepseek/deepseek-r1-distill-llama-70b", "deepseek"],
    ["google/zai-org/glm-5-maas", "zhipu"],
    ["google/eu.claude-sonnet-5", "anthropic"],
    ["palmyra-x", "unknown"],
    ["openai/some-new-thing", "openai"],
    ["", "unknown"],
  ])("providerFamily(%s) is %s", (id, want) => {
    expect(providerFamily(id)).toBe(want);
  });

  test("evenPanelTieOutcome", () => {
    expect(evenPanelTieOutcome(null, "numeric")).toBeNull();
    expect(evenPanelTieOutcome("majority", "categorical")).toBe(
      TIE_LOSES_VERDICT,
    );
    expect(evenPanelTieOutcome(null, "categorical")).toBe(TIE_LOSES_VERDICT);
    expect(evenPanelTieOutcome(null, "categorical", () => "x", "fail")).toBe(
      "fail",
    );
  });

  test("composition messages", () => {
    const dup = panelCompositionMessages(["openai/gpt-x", "openai/gpt-x"], []);
    expect(dup.join()).toContain("more than once");
    const even = panelCompositionMessages(["claude-3", "gemini-2"], []);
    expect(even.join()).toContain("even number");
    const single = panelCompositionMessages(["gpt-1", "gpt-2", "gpt-3"], []);
    expect(single.join()).toContain("single provider family");
    const lone = panelCompositionMessages(["gpt-1"], ["gpt-2"]);
    expect(lone).toEqual([]);
    const strict = panelCompositionMessages(["gpt-1"], ["gpt-2"], {
      strict: true,
    });
    expect(strict.join()).toContain("target provider family");
  });

  test("duplicates and panel order", () => {
    expect(duplicateJudgesMessage(["a", "b"])).toBeNull();
    expect(resolvePanel(["b", "a", "b", ""])).toEqual(["b", "a"]);
  });
});
