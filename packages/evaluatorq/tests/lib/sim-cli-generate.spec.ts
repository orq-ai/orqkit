import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BadParameter } from "../../src/lib/common/cli-config.js";
import {
  executeSimFromTraces,
  executeSimGenerate,
  type SimTracesApi,
} from "../../src/lib/integrations/simulation/cli-generate.js";
import type { Datapoint } from "../../src/lib/integrations/simulation/types.js";

const golden = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures", "sim-cli-generate-python-goldens.json"),
    "utf8",
  ),
);
type Case = { exit_code: number; stdout: string; stderr: string };
const cases = golden.cases as Record<string, Case>;
const PY = "/python-work";
const datapoints = golden.datapoints as Datapoint[];

test("generation and trace ranges reject before any external work", async () => {
  let calls = 0;
  const io = {
    print: () => {},
    printError: () => {},
    generate: async () => {
      calls++;
      return [];
    },
    resolveAgentDescription: async () => {
      calls++;
      return "fixture";
    },
  };
  for (const key of ["num_personas", "num_scenarios"] as const)
    for (const value of [0, -1, 1.5, NaN, Infinity])
      await expect(
        executeSimGenerate(
          { datapoints_path: "/unused", target: "agent:fixture", [key]: value },
          io,
        ),
      ).rejects.toBeInstanceOf(BadParameter);
  for (const [key, values] of [
    ["limit", [0, -1, 1.5, NaN, Infinity]],
    ["max_summaries", [0, -1, 1.5, NaN, Infinity]],
    ["extend", [-1, 1.5, NaN, Infinity]],
    ["lookback_hours", [-1, NaN, Infinity]],
  ] as const)
    for (const value of values)
      await expect(
        executeSimFromTraces({ output: "/unused", [key]: value }, io),
      ).rejects.toBeInstanceOf(BadParameter);
  expect(calls).toBe(0);
});

async function setup() {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-sim-gen-")));
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  const norm = (lines: string[]) =>
    (lines.length ? `${lines.join("\n")}\n` : "").replaceAll(dir, PY);
  return {
    dir,
    calls,
    io: {
      print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line),
      env: {},
    },
    out: () => norm(out),
    err: () => norm(err),
    file: (name: string) => readFile(join(dir, name), "utf8"),
  };
}

describe("eq sim generate matches Python", () => {
  test("forwards seeded generation instructions", async () => {
    const s = await setup();
    let forwarded: unknown;
    const code = await executeSimGenerate(
      {
        datapoints_path: join(s.dir, "seeded.jsonl"),
        agent_description: "bot",
        persona_seed: ["angry"],
        scenario_seed: ["refund"],
        generation_instructions: "In Dutch",
        quiet: true,
      },
      {
        ...s.io,
        generate: async (params) => {
          forwarded = params;
          return structuredClone(datapoints);
        },
      },
    );
    expect(code).toBe(0);
    expect(forwarded).toMatchObject({
      personaSeeds: ["angry"],
      scenarioSeeds: ["refund"],
      generationInstructions: "In Dutch",
    });
  });

  for (const [name, file, extra] of [
    ["generate_quiet", "gen/dp.jsonl", {}],
    [
      "generate_dataset_format",
      "ds.jsonl",
      { dataset_format: true, num_personas: 2 },
    ],
  ] as const) {
    test(name, async () => {
      const s = await setup();
      const code = await executeSimGenerate(
        {
          datapoints_path: join(s.dir, file),
          agent_description: "desc",
          quiet: true,
          ...extra,
        },
        {
          ...s.io,
          generate: async (params) => {
            s.calls.push(params);
            return structuredClone(datapoints);
          },
        },
      );
      const py = cases[name] as Case;
      expect(code).toBe(py.exit_code);
      expect(s.err()).toBe(py.stderr);
      expect(s.out()).toBe(py.stdout);
      expect(await s.file(file)).toBe(golden.files[file]);
      expect(s.calls[0]).toMatchObject({
        agentDescription: "desc",
        numPersonas: "num_personas" in extra ? 2 : 5,
        numScenarios: 5,
      });
    });
  }

  test("generate_loud ends with the same result and next step", async () => {
    const s = await setup();
    const code = await executeSimGenerate(
      {
        datapoints_path: join(s.dir, "loud.jsonl"),
        agent_description: "desc",
        target: "agent:bot",
      },
      { ...s.io, generate: async () => structuredClone(datapoints) },
    );
    expect(code).toBe(0);
    const tail = (text: string) => text.split("\n").slice(-6).join("\n");
    expect(tail(s.err())).toBe(tail(cases.generate_loud?.stderr as string));
    expect(await s.file("loud.jsonl")).toBe(golden.files["loud.jsonl"]);
  });

  test("generate_no_description", async () => {
    const s = await setup();
    const code = await executeSimGenerate(
      { datapoints_path: join(s.dir, "x.jsonl"), quiet: true },
      s.io,
    );
    expect(code).toBe(1);
    expect(s.err()).toBe(cases.generate_no_description?.stderr as string);
  });
});

function fakeTraces(
  calls: unknown[],
  conversations: unknown[],
  direct: Datapoint[],
): SimTracesApi {
  return {
    fetchTraceConversations: async (options) => {
      const { startDateMs, ...rest } = options;
      calls.push({ fetch: rest, has_start: startDateMs !== undefined });
      return conversations as never;
    },
    summarizeConversations: async (_c, options) => {
      const c = options.config;
      calls.push({
        summarize: {
          max_tokens: c.maxTokens,
          summary_max_tokens: c.summaryMaxTokens,
          summary_target_tokens: c.summaryTargetTokens,
          max_reduce_summaries: c.maxReduceSummaries,
          generate_first_message: c.generateFirstMessage,
          redact_pii: c.redactPii,
        },
      });
      return {};
    },
    datapointsFromTraces: async () => structuredClone(direct),
    extendFromTraces: async (_c, options) => {
      calls.push({
        extend: options.numDatapoints,
        agent_description: options.agentDescription ?? null,
      });
      return Array.from({ length: options.numDatapoints }, () =>
        structuredClone(datapoints[1] as Datapoint),
      );
    },
  };
}

describe("eq sim from-traces matches Python", () => {
  const all: unknown[] = [];
  for (const [name, file, args, conversations, direct] of [
    ["traces_basic", "tr.jsonl", {}, ["c1", "c2"], datapoints.slice(0, 1)],
    [
      "traces_extend",
      "tr2.jsonl",
      {
        extend: 2,
        agent_description: "bot",
        limit: 5,
        search: "refund",
        lookback_hours: 2,
        replay_first_message: true,
        redact_pii: false,
        max_summaries: 7,
      },
      ["c1", "c2"],
      datapoints.slice(0, 1),
    ],
    ["traces_none", "tr3.jsonl", {}, [], []],
    ["traces_empty", "tr4.jsonl", {}, ["c1"], []],
  ] as const) {
    test(name, async () => {
      const s = await setup();
      const code = await executeSimFromTraces(
        { output: join(s.dir, file), quiet: true, ...args },
        {
          ...s.io,
          traces: fakeTraces(all, [...conversations], [...direct]),
        },
      );
      const py = cases[name] as Case;
      expect(code).toBe(py.exit_code);
      expect(s.err()).toBe(py.stderr);
      if (golden.files[file] !== undefined)
        expect(await s.file(file)).toBe(golden.files[file]);
    });
  }
  test("trace API calls match", () => {
    expect(all).toEqual(golden.trace_calls);
  });
});
