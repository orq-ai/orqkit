import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { SimulationRunner } from "../../../../src/lib/integrations/simulation/runner/simulation.js";
import { simulate } from "../../../../src/lib/integrations/simulation/simulation/index.js";
import type { TargetCallback } from "../../../../src/lib/integrations/simulation/types.js";
import { finishTurn, makeFakeClient } from "./fake-client.js";

const persona = {
  name: "User",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual" as const,
  background: "bg",
};

const scenario = {
  name: "Refund",
  goal: "Get a refund",
  criteria: [{ description: "offers a refund", type: "must_happen" as const }],
};

const noCriteria = { name: "Chat", goal: "Say hi", criteria: [] };

function datapoint(firstMessage: string) {
  return {
    id: firstMessage,
    persona,
    scenario,
    user_system_prompt: "You are a simulated user.",
    first_message: firstMessage,
  };
}

const audited = (occurred: boolean) => [
  { criterion_id: "criteria_0", occurred, evidence: occurred ? "quote" : "" },
];

describe("simulate", () => {
  const originalKey = process.env.ORQ_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.ORQ_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ORQ_API_KEY;
    } else {
      process.env.ORQ_API_KEY = originalKey;
    }
    globalThis.fetch = originalFetch;
  });

  test("a bad maxTurns rejects with its own message before any row runs", async () => {
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });
    let targetCalls = 0;

    await expect(
      simulate({
        evaluationName: "bad-config",
        client,
        maxTurns: 0,
        datapoints: [datapoint("a")],
        uploadResults: false,
        targetCallback: () => {
          targetCalls++;
          return "reply";
        },
      }),
    ).rejects.toThrow("maxTurns must be >= 1");
    expect(targetCalls).toBe(0);
  });

  test("closes its runner after the run", async () => {
    const close = spyOn(SimulationRunner.prototype, "close");
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });

    try {
      await simulate({
        evaluationName: "closes",
        client,
        datapoints: [datapoint("a")],
        uploadResults: false,
        targetCallback: () => "reply",
      });

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  test("a blank agentKey rejects with its own message", async () => {
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });

    await expect(
      simulate({
        evaluationName: "bad-agent",
        client,
        agentKey: "  ",
        datapoints: [datapoint("a")],
        uploadResults: false,
      }),
    ).rejects.toThrow("agentKey must be a non-empty string");
  });

  test("a persona no prompt can be built from fails only its own row", async () => {
    const { client } = makeFakeClient({
      judge: () => finishTurn([]),
    });
    const { background: _dropped, ...withoutBackground } = persona;

    const results = await simulate({
      evaluationName: "bad-persona",
      client,
      personas: [withoutBackground as typeof persona, persona],
      scenarios: [noCriteria],
      uploadResults: false,
      targetCallback: () => "reply",
    });

    expect(results.map((r) => r.terminated_by)).toEqual(["error", "judge"]);
    expect(results[0]?.reason).toContain("First message failed");
  });

  test("returns results in input order whatever order they finish in", async () => {
    const { client } = makeFakeClient({
      judge: () => finishTurn(audited(true)),
    });
    const delays: Record<string, number> = { a: 30, b: 1, c: 10 };

    const results = await simulate({
      evaluationName: "order",
      client,
      parallelism: 3,
      datapoints: [datapoint("a"), datapoint("b"), datapoint("c")],
      targetCallback: async (messages) => {
        const first = messages[0]?.content ?? "";
        await new Promise((resolve) => setTimeout(resolve, delays[first]));
        return "reply";
      },
    });

    expect(results.map((r) => r.messages[0]?.content)).toEqual(["a", "b", "c"]);
  });

  test("works on inline data without an API key or the orq SDK", async () => {
    const { client } = makeFakeClient({
      judge: () => finishTurn(audited(true)),
    });

    const [result] = await simulate({
      evaluationName: "no-key",
      client,
      datapoints: [datapoint("a")],
      targetCallback: async () => "reply",
    });

    expect(result?.terminated_by).toBe("judge");
  });

  test("stamps evaluator scores from the audited result", async () => {
    const { client } = makeFakeClient({
      judge: (_call, request) => {
        const first = request.input.find((m) => m.role === "user")?.content;
        return finishTurn(audited(first === "met"));
      },
    });

    const results = await simulate({
      evaluationName: "scores",
      client,
      datapoints: [datapoint("met"), datapoint("unmet")],
      targetCallback: async () => "reply",
    });

    expect(results[0]?.metadata.evaluator_scores).toEqual({
      goal_achieved: 1,
      criteria_met: 1,
    });
    expect(results[1]?.metadata.evaluator_scores).toEqual({
      goal_achieved: 1,
      criteria_met: 0,
    });
  });

  test("runs persona x scenario pairs", async () => {
    const { client, requests } = makeFakeClient({
      judge: () => finishTurn([]),
    });

    const results = await simulate({
      evaluationName: "pairs",
      client,
      personas: [persona, { ...persona, name: "Other" }],
      scenarios: [noCriteria, { ...noCriteria, name: "Second" }],
      targetCallback: async () => "reply",
    });

    expect(results).toHaveLength(4);
    expect(requests.firstMessage).toHaveLength(4);
  });

  test("a failed first message fails its row and keeps the others", async () => {
    let calls = 0;
    const { client } = makeFakeClient({
      judge: () => finishTurn([]),
      firstMessage: () => {
        calls++;
        if (calls === 1) {
          throw new Error("generator down");
        }
        return "opener";
      },
    });

    const results = await simulate({
      evaluationName: "first-message",
      client,
      parallelism: 1,
      personas: [persona, { ...persona, name: "Other" }],
      scenarios: [noCriteria],
      targetCallback: async () => "reply",
    });

    expect(results[0]?.terminated_by).toBe("error");
    expect(results[0]?.reason).toContain("generator down");
    expect(results[1]?.terminated_by).toBe("judge");
  });

  test("a low score does not end the process", async () => {
    const exit = process.exit;
    const exitSpy = mock(() => undefined as never);
    process.exit = exitSpy;
    try {
      const { client } = makeFakeClient({
        judge: () => finishTurn(audited(false), { goal_achieved: false }),
      });

      await simulate({
        evaluationName: "low-score",
        client,
        datapoints: [datapoint("a")],
        targetCallback: async () => "reply",
      });

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = exit;
    }
  });

  test("uploads when a key is set", async () => {
    process.env.ORQ_API_KEY = "test-key";
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { client } = makeFakeClient({
      judge: () => finishTurn(audited(true)),
    });

    await simulate({
      evaluationName: "upload",
      client,
      datapoints: [datapoint("a")],
      targetCallback: async () => "reply",
    });

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = String(init.body);
    expect(body).toContain("upload");
    expect(body).toContain("goal_achieved");
    expect(body).toContain("criteria_met");
  });

  test("uploads why an unverified score cannot be trusted", async () => {
    process.env.ORQ_API_KEY = "test-key";
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { client } = makeFakeClient({ judge: () => null });

    await simulate({
      evaluationName: "unverified",
      client,
      datapoints: [datapoint("a")],
      targetCallback: async () => "reply",
    });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("criteria_verified=false");
  });

  test("uploads to the host of a ROUTER_BASE_URL set on its own", async () => {
    const originalBase = process.env.ORQ_BASE_URL;
    delete process.env.ORQ_BASE_URL;
    process.env.ROUTER_BASE_URL = "https://staging.example/v3/router";
    process.env.ORQ_API_KEY = "test-key";
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { client } = makeFakeClient({
      judge: () => finishTurn(audited(true)),
    });

    try {
      await simulate({
        evaluationName: "router-only",
        client,
        datapoints: [datapoint("a")],
        targetCallback: async () => "reply",
      });
    } finally {
      delete process.env.ROUTER_BASE_URL;
      if (originalBase !== undefined) {
        process.env.ORQ_BASE_URL = originalBase;
      }
    }

    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      "https://staging.example/v2/spreadsheets/evaluations/receive",
    );
  });

  test("scores an unverified row once, so it warns once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });

    try {
      await simulate({
        evaluationName: "one-score",
        client,
        datapoints: [datapoint("a")],
        uploadResults: false,
        targetCallback: async () => "reply",
      });

      const warnings = warn.mock.calls.filter((call) =>
        String(call[0]).startsWith("criteria_met:"),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("honours timeoutPerSimulation", async () => {
    const { client } = makeFakeClient();

    const [result] = await simulate({
      evaluationName: "timeout",
      client,
      uploadResults: false,
      timeoutPerSimulation: 5,
      datapoints: [datapoint("a")],
      targetCallback: () => new Promise<string>(() => {}),
    });

    expect(result?.terminated_by).toBe("timeout");
  });

  test("a generated first message stops at the row's limit", async () => {
    const { client } = makeFakeClient({
      userSimulator: (_request, options) =>
        new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    });

    const [result] = await simulate({
      evaluationName: "first-message-limit",
      client,
      uploadResults: false,
      timeoutPerSimulation: 20,
      datapoints: [datapoint("")],
      targetCallback: () => "reply",
    });

    expect(result?.terminated_by).toBe("timeout");
  }, 2_000);

  test("calls a target with the messages and nothing else", async () => {
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });
    const argumentCounts: number[] = [];

    await simulate({
      evaluationName: "target-arguments",
      client,
      uploadResults: false,
      datapoints: [datapoint("a")],
      targetCallback: (...args: unknown[]) => {
        argumentCounts.push(args.length);
        return "reply";
      },
    });

    expect(argumentCounts).toEqual([1]);
  });

  test("a target callback can be called with messages alone", async () => {
    const target: TargetCallback = async () => "reply";

    expect(await target([])).toBe("reply");
  });

  test("uploadResults: false skips the upload", async () => {
    process.env.ORQ_API_KEY = "test-key";
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { client } = makeFakeClient({
      judge: () => finishTurn(audited(true)),
    });

    await simulate({
      evaluationName: "no-upload",
      client,
      uploadResults: false,
      datapoints: [datapoint("a")],
      targetCallback: async () => "reply",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects unknown evaluators before running anything", async () => {
    const { client, requests } = makeFakeClient();

    await expect(
      simulate({
        evaluationName: "bad-evaluator",
        client,
        evaluators: ["nonexistent"],
        datapoints: [datapoint("a")],
        targetCallback: async () => "reply",
      }),
    ).rejects.toThrow("Unknown evaluator");
    expect(requests.judge).toHaveLength(0);
  });

  test("the personas path still needs a key or a client", async () => {
    await expect(
      simulate({
        evaluationName: "no-client",
        personas: [persona],
        scenarios: [noCriteria],
        targetCallback: async () => "reply",
      }),
    ).rejects.toThrow("ORQ_API_KEY");
  });
});
