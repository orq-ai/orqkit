import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { resetResponsesRejectors } from "../../src/lib/common/judge.js";
import { resetReasoningRejectors } from "../../src/lib/common/llm-call.js";
import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
  resetCatalogueCache,
} from "../../src/lib/common/model-catalogue.js";
import { llmJury, llmJuryPairwise } from "../../src/lib/llm-jury.js";
import type { DataPoint } from "../../src/lib/types.js";

interface Reply {
  status: number;
  body: unknown;
}

type Script = Record<string, Reply[] | { AB: Reply[]; BA: Reply[] }>;

let script: Script = {};
let requests: { path: string; body: Record<string, unknown> }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") {
      return Response.json([]);
    }
    const text = await request.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    requests.push({
      path: new URL(request.url).pathname.split("/v3/router").at(-1) ?? "",
      body,
    });
    const entry = script[body.model as string] ?? [];
    const first = text.indexOf("A text");
    const second = text.indexOf("B text");
    const queue = Array.isArray(entry)
      ? entry
      : entry[second === -1 || first < second ? "AB" : "BA"];
    const next = queue.shift() ?? { status: 500, body: { error: {} } };
    return Response.json(next.body, { status: next.status });
  },
});

afterAll(() => server.stop(true));

const client = () =>
  new OpenAI({
    apiKey: "k",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });

const verdict = (value: unknown, explanation = "because"): Reply => ({
  status: 200,
  body: {
    id: "r",
    object: "response",
    created_at: 1,
    model: "served",
    status: "completed",
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    output: [
      {
        type: "message",
        id: "m",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({ explanation, value }),
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  },
});

const failure: Reply = { status: 400, body: { error: { message: "boom" } } };

const classifyReply = (answers: Record<string, unknown>): Reply => ({
  status: 200,
  body: {
    answers,
    usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
    model: "served",
  },
});

const MODELS = ["openai/a", "anthropic/b", "google/c"];
const data: DataPoint = {
  inputs: { input: "What is 2+2?" },
  expectedOutput: "4",
};

function votes(...values: unknown[]): Script {
  return Object.fromEntries(
    values.map((value, index) => [MODELS[index], [verdict(value)]]),
  );
}

interface JuryResult {
  value: unknown;
  explanation: string;
  pass?: boolean | null;
  tokenUsage?: { totalTokens: number; calls: number } | null;
  rawOutput?: {
    jury: {
      judgesFailed: number;
      replacementsUsed: number;
      tie: boolean;
      inconclusive: boolean;
    };
  } | null;
}

async function score(
  options: Omit<Parameters<typeof llmJury>[0], "name" | "client">,
  row?: number,
): Promise<JuryResult> {
  const evaluator = llmJury({ name: "n", client: client(), ...options });
  return (await evaluator.scorer({
    data,
    output: "4",
    ...(row === undefined ? {} : { row }),
  })) as unknown as JuryResult;
}

beforeEach(() => {
  script = {};
  requests = [];
  resetCatalogueCache();
  clearModelOverrides();
  resetResponsesRejectors();
  resetReasoningRejectors();
  for (const model of MODELS) {
    registerModel(
      model,
      new ModelInfo({
        inputCostPer1k: 0.001,
        outputCostPer1k: 0.002,
        provider: model.split("/")[0],
        supportsResponses: true,
      }),
    );
  }
});

describe("llmJury", () => {
  test("a single boolean judge reports its verdict, usage and audit", async () => {
    script = votes(true);
    const result = await score({ criteria: "correct?", model: MODELS[0] });
    expect(result.value).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.explanation).toContain("[jury: 1/1 judges");
    expect(result.tokenUsage?.totalTokens).toBe(15);
    expect(result.rawOutput?.jury.judgesFailed).toBe(0);
    expect(requests[0]?.path).toBe("/responses");
    expect(requests[0]?.body.max_output_tokens).toBe(8000);
  });

  test("the panel majority decides and usage is summed", async () => {
    script = votes(true, false, true);
    const result = await score({ criteria: "c", judges: MODELS });
    expect(result.value).toBe(true);
    expect(result.tokenUsage?.calls).toBe(3);
  });

  test("an even boolean split is inconclusive and has no pass value", async () => {
    script = votes(true, false);
    const result = await score({ criteria: "c", judges: MODELS.slice(0, 2) });
    expect(result.pass).toBeNull();
    expect(result.rawOutput?.jury.inconclusive).toBe(true);
  });

  test("categorical labels pass only for passing labels", async () => {
    script = votes("good", "good", "bad");
    const result = await score({
      criteria: "c",
      judges: MODELS,
      labels: ["good", "bad"],
      passingLabels: ["good"],
    });
    expect(result.value).toBe("good");
    expect(result.pass).toBe(true);
  });

  test("numeric mean keeps Python's summation so thresholds do not flip", async () => {
    script = votes(0.1, 0.2, 0.3);
    const result = await score({
      criteria: "c",
      judges: MODELS,
      verdictKind: "numeric",
      threshold: 0.1,
    });
    expect(result.value).toBe(0.6 / 3);
    expect(result.pass).toBe(true);
  });

  test("one failed judge is tolerated and recorded", async () => {
    script = votes(true, true);
    script[MODELS[2] as string] = [failure];
    const result = await score({ criteria: "c", judges: MODELS });
    expect(result.value).toBe(true);
    expect(result.rawOutput?.jury.judgesFailed).toBe(1);
  });

  test("a replacement judge takes over a failed seat", async () => {
    script = votes(true);
    script[MODELS[0] as string] = [failure];
    script[MODELS[1] as string] = [verdict(true)];
    const result = await score({
      criteria: "c",
      judges: MODELS.slice(0, 1),
      replacementJudges: MODELS.slice(1, 2),
    });
    expect(result.value).toBe(true);
    expect(result.rawOutput?.jury.replacementsUsed).toBe(1);
  });

  test("every repetition of a judge is called", async () => {
    script = {
      [MODELS[0] as string]: [verdict(true), verdict(false), verdict(true)],
    };
    const result = await score({
      criteria: "c",
      model: MODELS[0],
      repetitions: 3,
    });
    expect(requests).toHaveLength(3);
    expect(result.value).toBe(true);
  });

  test("cyclic assignment picks the seat from the row", async () => {
    script = votes(true, true, true);
    await score({ criteria: "c", judges: MODELS, assignment: "cyclic" }, 4);
    expect(requests.map((request) => request.body.model)).toEqual([MODELS[1]]);
  });

  test("classify judges use the classify route with the configured threshold", async () => {
    registerModel(
      "acme/jev",
      new ModelInfo({
        inputCostPer1k: 0.001,
        outputCostPer1k: 0.002,
        provider: "acme",
        supportsClassify: true,
        supportsResponses: false,
      }),
    );
    script = {
      "acme/jev": [
        classifyReply({ verdict: { type: "noul", noul: 0.8 } }),
        classifyReply({ verdict: { type: "noul", noul: 0.2 } }),
      ],
    };
    const options = { criteria: "c", model: "acme/jev", threshold: 0.5 };
    expect((await score(options)).pass).toBe(true);
    expect((await score(options)).pass).toBe(false);
    expect(requests[0]?.path).toBe("/decisions");
  });

  test("invalid configuration is rejected at construction", () => {
    expect(() =>
      llmJury({ name: "n", criteria: "c", repetitions: 0 }),
    ).toThrow();
    expect(() =>
      llmJury({
        name: "n",
        criteria: "c",
        judges: MODELS,
        model: MODELS[0],
      }),
    ).toThrow();
  });
});

describe("llmJuryPairwise", () => {
  const compare = () =>
    llmJuryPairwise({ model: MODELS[0], client: client() }).compare({
      question: "Which?",
      responseA: "A text",
      responseB: "B text",
    });

  test("a judge that sticks to one response across orderings wins it", async () => {
    script = {
      [MODELS[0] as string]: { AB: [verdict("A")], BA: [verdict("B")] },
    };
    const result = await compare();
    expect(result.winner).toBe("A");
    expect(result.votes[0]?.flipped).toBe(false);
    expect(result.tokenUsage?.calls).toBe(2);
  });

  test("a judge that follows position is flipped and inconclusive", async () => {
    script = {
      [MODELS[0] as string]: { AB: [verdict("A")], BA: [verdict("A")] },
    };
    const result = await compare();
    expect(result.winner).toBe("inconclusive");
    expect(result.votes[0]?.flipped).toBe(true);
    expect(result.votes[0]?.vote).toBeNull();
  });
});
