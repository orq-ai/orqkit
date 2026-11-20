import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BadParameter } from "../../src/lib/common/cli-config.js";
import {
  executeSimRun,
  executeSimSimulate,
  loadDatapointRecords,
  type SimRunArgs,
  type SimSimulateArgs,
} from "../../src/lib/integrations/simulation/cli-run.js";
import { SimulationRun } from "../../src/lib/integrations/simulation/run-store.js";

const golden = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures", "sim-cli-run-python-goldens.json"),
    "utf8",
  ),
);
type Case = { exit_code: number; stdout: string; stderr: string };
const cases = golden.cases as Record<string, Case>;
const PY = "/python-work";

function pythonError(stderr: string): string {
  const lines = stderr.split("\n");
  const start = lines.findIndex((line) => line.startsWith("╭─ Error"));
  if (start < 0) return stderr;
  return lines
    .slice(start + 1)
    .filter((line) => line.startsWith("│"))
    .map((line) => line.replace(/^│\s?/, "").replace(/\s*│$/, "").trim())
    .join(" ");
}

async function setup() {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-sim-run-")));
  for (const [name, content] of Object.entries(
    golden.inputs as Record<string, string>,
  ))
    await writeFile(join(dir, name), content);
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const run = await SimulationRun.load(join(dir, "run.json"));
  const fake = async (params: Record<string, unknown>) => {
    calls.push(Object.keys(params).sort());
    (params.onRun as (r: SimulationRun) => void)(run);
    return [];
  };
  const io = {
    print: (line: string) => out.push(line),
    printError: (line: string) => err.push(line),
    env: {},
    simulate: fake as never,
    generateAndSimulate: fake as never,
  };
  const norm = (lines: string[]) =>
    (lines.length ? `${lines.join("\n")}\n` : "").replaceAll(dir, PY);
  return { dir, io, calls, out: () => norm(out), err: () => norm(err) };
}

async function invoke(
  command: "simulate" | "run",
  build: (dir: string) => SimSimulateArgs & SimRunArgs,
) {
  const s = await setup();
  const args = build(s.dir);
  let code: number;
  let bad: BadParameter | null = null;
  try {
    code =
      command === "simulate"
        ? await executeSimSimulate(args, s.io)
        : await executeSimRun(args, s.io);
  } catch (error) {
    if (!(error instanceof BadParameter)) throw error;
    bad = error;
    code = 2;
  }
  return { ...s, code, bad };
}

const T = { target: "agent:x" };
const V = { vercel_url: "http://localhost:1" };
const Q = { quiet: true };
const errorCases: [
  string,
  "simulate" | "run",
  (d: string) => SimSimulateArgs,
][] = [
  ["no_input", "simulate", () => ({ ...T, ...Q })],
  [
    "two_inputs",
    "simulate",
    (d) => ({
      datapoints: join(d, "good.jsonl"),
      from_run: "latest",
      ...T,
      ...Q,
    }),
  ],
  [
    "run_id_without_exp",
    "simulate",
    () => ({ dataset_id: "d", experiment_run_id: "r", ...T, ...Q }),
  ],
  ["dataset_no_key", "simulate", () => ({ dataset_id: "d", ...T, ...Q })],
  [
    "config_inline_and_flag",
    "simulate",
    () => ({
      config: JSON.stringify({
        personas: [JSON.parse(golden.inputs["good.jsonl"]).persona],
        scenarios: [JSON.parse(golden.inputs["good.jsonl"]).scenario],
        dataset_id: "z",
      }),
      ...T,
      ...Q,
    }),
  ],
  [
    "no_target",
    "simulate",
    (d) => ({ datapoints: join(d, "good.jsonl"), ...Q }),
  ],
  [
    "two_targets",
    "simulate",
    (d) => ({ datapoints: join(d, "good.jsonl"), ...T, ...V, ...Q }),
  ],
  [
    "blank_memory",
    "simulate",
    (d) => ({
      datapoints: join(d, "good.jsonl"),
      ...T,
      memory_entity: "  ",
      ...Q,
    }),
  ],
  [
    "memory_no_target",
    "simulate",
    (d) => ({
      datapoints: join(d, "good.jsonl"),
      ...V,
      memory_entity: "m",
      ...Q,
    }),
  ],
  [
    "memory_deployment",
    "simulate",
    (d) => ({
      datapoints: join(d, "good.jsonl"),
      target: "deployment:d",
      memory_entity: "m",
      ...Q,
    }),
  ],
  [
    "deployment_no_key",
    "simulate",
    (d) => ({
      datapoints: join(d, "good.jsonl"),
      target: "deployment:d",
      ...Q,
    }),
  ],
  [
    "openai_no_key",
    "simulate",
    (d) => ({ datapoints: join(d, "good.jsonl"), openai_model: "gpt-x", ...Q }),
  ],
  [
    "unknown_evaluator",
    "simulate",
    (d) => ({
      datapoints: join(d, "good.jsonl"),
      ...V,
      evaluator: ["nope"],
      ...Q,
    }),
  ],
  [
    "missing_input",
    "simulate",
    (d) => ({ datapoints: join(d, "nope.jsonl"), ...T, ...Q }),
  ],
  ["bad_config", "simulate", () => ({ config: '{"bogus": 1}', ...T, ...Q })],
  ["sim_model_line", "simulate", () => ({ ...T, sim_model: "my-model", ...Q })],
];

describe("eq sim simulate errors match Python", () => {
  for (const [name, command, build] of errorCases) {
    test(name, async () => {
      const r = await invoke(command, build);
      const py = cases[name] as Case;
      expect(r.code).toBe(py.exit_code);
      expect(
        r.bad
          ?.render()
          .replace(/^Error: /, "")
          .replaceAll(r.dir, PY),
      ).toBe(pythonError(py.stderr));
      const usingLine = py.stderr.split("\n")[0] as string;
      if (usingLine.startsWith("Using"))
        expect(r.err().split("\n")[0]).toBe(
          name === "sim_model_line"
            ? "Using for generations: unresolved provider · my-model"
            : usingLine,
        );
      else expect(r.err()).toBe("");
    });
  }

  test("alias_conflict carries the alias message", async () => {
    const r = await invoke("simulate", (d) => ({
      config: '{"run_name": "a", "evaluation_name": "b"}',
      datapoints: join(d, "good.jsonl"),
      ...T,
      ...Q,
    }));
    expect(r.code).toBe(cases.alias_conflict?.exit_code as number);
    expect(r.bad?.message).toContain(
      "run_name and evaluation_name must match when both are supplied",
    );
  });

  for (const name of [
    "empty_input",
    "run_no_description",
    "run_deployment_description",
  ]) {
    test(name, async () => {
      const r = await invoke(
        name.startsWith("run") ? "run" : "simulate",
        (d) =>
          name === "empty_input"
            ? { datapoints: join(d, "empty.jsonl"), ...T, ...Q }
            : name === "run_no_description"
              ? { ...V, ...Q }
              : { target: "deployment:d", ...Q },
      );
      const py = cases[name] as Case;
      expect(r.code).toBe(py.exit_code);
      expect(r.err()).toBe(py.stderr);
      expect(r.out()).toBe(py.stdout);
    });
  }
});

describe("eq sim simulate and run outputs match Python", () => {
  test("success writes results and an auto-named report", async () => {
    const r = await invoke("simulate", (d) => ({
      datapoints: join(d, "good.jsonl"),
      ...V,
      save: false,
      report_path: `${join(d, "reports")}/`,
      results_path: join(d, "out", "res.jsonl"),
      ...Q,
    }));
    expect(r.code).toBe(0);
    expect(r.out()).toBe(cases.success?.stdout as string);
    expect(r.err()).toBe(cases.success?.stderr as string);
    expect(
      existsSync(
        join(r.dir, "reports", "sim-report-my_run-20260102-030405.json"),
      ),
    ).toBe(true);
    expect(r.calls[0]).toContain("datapoints");
    expect(r.calls[0]).toContain("onRun");
    expect(r.calls[0]).not.toContain("reportPath");
  });

  test("envelope input with --json prints the run", async () => {
    const r = await invoke("simulate", (d) => ({
      datapoints: join(d, "envelope.jsonl"),
      ...V,
      save: false,
      json: true,
      ...Q,
    }));
    const py = cases.success_envelope_json as Case;
    expect(r.code).toBe(0);
    expect(r.err()).toBe(py.stderr);
    expect(JSON.parse(r.out())).toEqual(JSON.parse(py.stdout));
  });

  test("--report-md writes into a directory", async () => {
    const r = await invoke("simulate", (d) => ({
      datapoints: join(d, "good.jsonl"),
      ...V,
      save: false,
      report_md: join(d, "md"),
      ...Q,
    }));
    expect(r.code).toBe(0);
    expect(r.err()).toBe(cases.success_md?.stderr as string);
  });

  test("run forwards the agent description", async () => {
    const r = await invoke("run", () => ({
      agent_description: "desc",
      ...V,
      save: false,
      ...Q,
    }));
    expect(r.code).toBe(0);
    expect(r.err()).toBe(cases.run_success?.stderr as string);
    expect(r.calls[0]).toEqual(
      expect.arrayContaining([
        "agentDescription",
        "numPersonas",
        "numScenarios",
      ]),
    );
  });

  test("run forwards seeds and saves generated datapoints", async () => {
    const s = await setup();
    let forwarded: Record<string, unknown> = {};
    const path = join(s.dir, "generated.jsonl");
    const dp = {
      id: "saved",
      persona: { name: "seed" },
      scenario: { name: "case" },
      first_message: "hello",
      user_system_prompt: "test",
    };
    const code = await executeSimRun(
      {
        agent_description: "desc",
        ...V,
        persona_seed: ["angry"],
        scenario_seed: ["refund"],
        generation_instructions: "In Dutch",
        datapoints_path: path,
        ...Q,
      },
      {
        ...s.io,
        generateAndSimulate: async (params) => {
          forwarded = params as unknown as Record<string, unknown>;
          await params.emitDatapoints?.([dp as never]);
          params.onRun?.(await SimulationRun.load(join(s.dir, "run.json")));
          return [];
        },
      },
    );
    expect(code).toBe(0);
    expect(forwarded).toMatchObject({
      personaSeeds: ["angry"],
      scenarioSeeds: ["refund"],
      generationInstructions: "In Dutch",
    });
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual(dp);
    expect(s.err()).toContain("Datapoints saved:");
  });
});

test("declining an interactive simulation plan prevents model and target calls", async () => {
  const s = await setup();
  const { simulate } = await import(
    "../../src/lib/integrations/simulation/simulation/index.js"
  );
  const { makeFakeClient } = await import(
    "./integrations/simulation/fake-client.js"
  );
  const { client, requests } = makeFakeClient();
  let prompts = 0,
    targetCalls = 0;
  const code = await executeSimSimulate(
    {
      datapoints: join(s.dir, "good.jsonl"),
      vercel_url: "http://localhost:1",
      save: false,
      recommendations: false,
      executive_summary: false,
    },
    {
      ...s.io,
      stdinIsTTY: true,
      confirm: () => {
        prompts++;
        return false;
      },
      simulate: (params) =>
        simulate({
          ...params,
          target: undefined,
          targetAgent: undefined,
          targetCallback: () => {
            targetCalls++;
            return "must not run";
          },
          client,
        }),
    },
  );
  expect(code).toBe(1);
  expect(prompts).toBe(1);
  expect(targetCalls).toBe(0);
  expect(Object.values(requests).flat()).toHaveLength(0);
  expect(s.err()).toContain("Simulation cancelled before execution");
});

test("datapoint files reject partial JSONL and retain explicit legacy and hybrid records", async () => {
  const fixture = await setup();
  const path = join(fixture.dir, "checked.jsonl");
  const raw = JSON.parse(golden.inputs["good.jsonl"]);
  const invalidRows = [
    "{",
    "[]",
    "null",
    "{}",
    JSON.stringify({ inputs: { persona: "broken", scenario: raw.scenario } }),
  ];
  for (const invalid of invalidRows) {
    await writeFile(path, `${JSON.stringify(raw)}\n${invalid}`);
    expect(() => loadDatapointRecords(path)).toThrow("line 2:");
  }
  const inputs = { persona_name: "P", scenario_name: "S", goal: "g" };
  for (const row of [
    { inputs },
    { inputs: { ...inputs, persona: raw.persona } },
    { inputs: { ...inputs, scenario: JSON.stringify(raw.scenario) } },
  ]) {
    await writeFile(path, JSON.stringify(row));
    const [parsed] = loadDatapointRecords(path);
    expect((parsed?.persona as { name: string }).name).toBe("P");
    expect((parsed?.scenario as { goal: string }).goal).toBe("g");
  }
});
