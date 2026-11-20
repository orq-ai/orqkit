import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import OpenAI from "openai";

import * as llmClient from "../../../src/lib/common/llm-client.js";
import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
  resetCatalogueCache,
} from "../../../src/lib/common/model-catalogue.js";
import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { classifyToolRoles } from "../../../src/lib/signals/classify.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import { classifyToolDoors } from "../../../src/lib/signals/doors.js";

const goldens = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signals-classifiers-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  kind: "roles" | "doors";
  inputs: unknown[];
  config: unknown;
  missing: boolean;
  requests: Record<string, unknown>[];
  expected: unknown;
}[];
let requests: Record<string, unknown>[] = [],
  failures: number[] = [],
  requestIndex = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json([]);
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    requestIndex++;
    if (failures.length)
      return Response.json(
        { error: { message: "synthetic failure" } },
        { status: failures.shift() },
      );
    const state = body.state as Record<string, string>,
      name = state.tool_name ?? "";
    if (name.includes("RAISE"))
      return Response.json(
        { error: { message: "synthetic transport failure" } },
        { status: 400 },
      );
    let value: string | null;
    if (name.includes("ABSTAIN")) value = null;
    else if (name.includes("INVALID")) value = "invalid";
    else if (state.command !== undefined || state.arguments !== undefined) {
      const text = state.command ?? state.arguments ?? "";
      value = text.includes("DELETE")
        ? "one_way"
        : text.includes("EDIT")
          ? "two_way"
          : "benign";
    } else
      value =
        (
          {
            ShellNew: "bash",
            BrowseNew: "webview",
            SkillNew: "skill",
            AgentNew: "subagent",
          } as Record<string, string>
        )[name] ?? "other";
    return Response.json({
      answers: { verdict: { type: "choice", choice: value } },
      usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
      model: "acme/jev-signals",
    });
  },
});
afterAll(() => server.stop(true));
const client = () =>
  new OpenAI({
    apiKey: "synthetic-local-test",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });
let warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  error: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  requests = [];
  failures = [];
  requestIndex = 0;
  resetCatalogueCache();
  clearModelOverrides();
  registerModel(
    "acme/jev-signals",
    new ModelInfo({
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      provider: "acme",
      supportsClassify: true,
      supportsResponses: false,
    }),
  );
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  clearModelOverrides();
});
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        key === "value" ? item : native(item),
      ]),
    );
  return value;
}
const orderQuestions = (items: Record<string, unknown>[]) =>
  [...items].sort((a, b) =>
    JSON.stringify(a.state).localeCompare(JSON.stringify(b.state)),
  );
for (const [i, row] of goldens.entries())
  test(`Python signal classifiers ${i} ${row.kind}`, async () => {
    const trajectories = row.inputs.map((input) => new AtifTrajectory(input)),
      config = new SignalsConfig(row.config);
    const reject = row.missing
      ? spyOn(llmClient, "resolveLlmClient").mockRejectedValue(
          new Error("synthetic missing credentials"),
        )
      : null;
    try {
      if (row.kind === "doors")
        expect<unknown>(
          await classifyToolDoors(trajectories[0] as AtifTrajectory, {
            config,
            client: row.missing ? null : client(),
          }),
        ).toEqual(
          Object.fromEntries(
            Object.entries(row.expected as Record<string, unknown>).map(
              ([name, result]) => [name, native(result)],
            ),
          ),
        );
      else {
        const result = await classifyToolRoles(trajectories, {
          config,
          client: row.missing ? null : client(),
        });
        const expected = native(row.expected) as Record<string, unknown>;
        const actual = result.toJSON();
        expect<unknown>(result.toolRoles).toEqual(
          (row.expected as Record<string, unknown>).tool_roles,
        );
        expect<unknown>(actual.classifier).toEqual(expected.classifier);
        expect(result.classifier.model).toBe(config.classifier.model);
        if (!row.requests.length && !row.missing) expect(result).toBe(config);
      }
    } finally {
      reject?.mockRestore();
    }
    expect(
      requests.every((request) => request.model === "acme/jev-signals"),
    ).toBe(true);
    const actualQuestions = requests.map((request) => {
      const questions = request.questions as Record<
        string,
        Record<string, unknown>
      >;
      return { ...questions.verdict, state: request.state };
    });
    const expectedQuestions = row.requests.map((q) => {
      const { noul_threshold: _threshold, kind, ...question } = q;
      return { ...question, type: kind };
    });
    expect<unknown>(orderQuestions(actualQuestions)).toEqual(
      orderQuestions(expectedQuestions),
    );
    expect(JSON.stringify(requests)).not.toContain("SECRET_ARGUMENT");
    expect(JSON.stringify(requests)).not.toContain("syntheticsecret");
  });
test("door transport failures use the judge retry budget and remain unknown after exhaustion", async () => {
  const trajectory = new AtifTrajectory({
    agent: { name: "test", version: "1" },
    steps: [
      {
        stepId: 1,
        source: "agent",
        message: "",
        toolCalls: [{ toolCallId: "c", functionName: "Custom", arguments: {} }],
      },
    ],
  });
  failures = [429, 503, 503, 503];
  const result = await classifyToolDoors(trajectory, {
    config: new SignalsConfig({ classifier: { model: "acme/jev-signals" } }),
    client: client(),
  });
  expect(requestIndex).toBe(4);
  expect(result.unknown_call_count?.value).toBe(1);
  expect(result.one_way_call_count?.value).toBe(0);
}, 20000);
test("a failed transport attempt can recover without an SDK retry layer", async () => {
  const trajectory = new AtifTrajectory({
    agent: { name: "test", version: "1" },
    steps: [
      {
        stepId: 1,
        source: "agent",
        message: "",
        toolCalls: [
          {
            toolCallId: "c",
            functionName: "Custom",
            arguments: { action: "DELETE" },
          },
        ],
      },
    ],
  });
  failures = [429];
  const result = await classifyToolDoors(trajectory, {
    config: new SignalsConfig({ classifier: { model: "acme/jev-signals" } }),
    client: client(),
  });
  expect(requestIndex).toBe(2);
  expect(result.one_way_call_count?.value).toBe(1);
});
