import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  applyModelFlags,
  BadParameter,
} from "../../src/lib/common/cli-config.js";
import { reportId } from "../../src/lib/common/dashboard/library.js";
import { fromPythonKeys } from "../../src/lib/common/python-json.js";
import {
  executeRedteamRun,
  executeRedteamRuns,
  executeRedteamSchema,
  executeRedteamValidateDataset,
  fmtAsr,
  fmtCreated,
  generateMdFilename,
  generateReportFilename,
  type RedteamIO,
  type RedteamRunArguments,
  splitCsv,
} from "../../src/lib/redteam/cli.js";
import { CancelledError } from "../../src/lib/redteam/exceptions.js";
import {
  ManifestStageHooks,
  type PipelineHooks,
} from "../../src/lib/redteam/hooks.js";
import { RedTeamReport } from "../../src/lib/redteam/reports/models.js";
import type { RedTeamCliConfig } from "../../src/lib/redteam/run-config.js";
import { keyDiff } from "./python-interop.js";

const golden = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures", "redteam-cli-python-goldens.json"),
    "utf8",
  ),
);
type Case = {
  name: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  stdin: string | null;
  kwargs: Record<string, unknown> | null;
  report: Record<string, unknown>;
};
const cases = new Map<string, Case>(
  golden.cases.map((row: Case) => [row.name, row]),
);
const goldenCase = (name: string): Case => cases.get(name) as Case;

const TS_ARGS: Record<string, RedteamRunArguments> = {
  json: { target: ["agent:x"], json: true },
  no_verdict: { target: ["agent:x"] },
  below: { target: ["agent:x"] },
  flags: {
    target: ["agent:a", "agent:b"],
    strategies: ["direct_override,roleplay_escape"],
    delivery_methods: ["role-play,custom-dm"],
    categories: ["ASI01"],
    vulnerabilities: ["goal_hijacking"],
    max_turns: 3,
    attack_model: "m/a",
    evaluator_model: "m/e",
    min_evaluation_coverage: 0.5,
    datapoint_parallelism: 4,
    verbose: 2,
    generate_strategies: false,
    save: "none",
    llm_config_json:
      '{"attacker": {"temperature": 0.9, "model": "m/ignored"}, "retry_count": 4}',
    system_prompt: "be nice",
    config:
      '{"name": "cfg", "max_turns": 8, "parallelism": 9, "description": "d"}',
  },
  from_run: { config: "-", from_run: "latest", quiet: true },
  unknown_key: {
    config:
      '{"bogus": 1, "llm_config": {"attacker": {"modl": "x"}}, "datapoints": [{"inputs": {}, "extra": 1}]}',
  },
  llm_unknown: { target: ["agent:x"], llm_config_json: '{"attackr": {}}' },
  no_target: { name: "n" },
  bad_vuln: { target: ["agent:x"], vulnerabilities: ["nope"] },
  bad_strategy: { target: ["agent:x"], strategies: ["nope,generated_ok"] },
};

function boxText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(Usage:|Try ')/.test(line))
    .join(" ")
    .replace(/[│╭╮╯╰─]/g, " ")
    .replace(/\bError\b(?=\s+Invalid)/, "")
    .replace(/^\s*Error:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function run(name: string) {
  const row = goldenCase(name);
  const out: string[] = [],
    err: string[] = [];
  const holder: {
    received: { target: unknown; options: RedTeamCliConfig } | null;
  } = { received: null };
  const io: RedteamIO = {
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    readStdin: () => row.stdin ?? "",
    redTeam: (async (target: unknown, options: RedTeamCliConfig) => {
      holder.received = { target, options };
      return new RedTeamReport(fromPythonKeys(row.report, "RedTeamReport"));
    }) as never,
  };
  const code = await executeRedteamRun(TS_ARGS[name] as never, io);
  return { row, code, out, err, received: holder.received };
}

const saved = process.env.EVALUATORQ_MODEL_OVERRIDES;
afterEach(() => {
  if (saved === undefined) delete process.env.EVALUATORQ_MODEL_OVERRIDES;
  else process.env.EVALUATORQ_MODEL_OVERRIDES = saved;
});

describe("eq redteam run matches Python", () => {
  test("JSON stdout stays clean during model diagnostics and result uploads", async () => {
    const source = resolve(import.meta.dir, "../../src/lib");
    const script = `
      import { executeRedteamRun } from ${JSON.stringify(join(source, "redteam/cli.ts"))};
      import { RedTeamReport } from ${JSON.stringify(join(source, "redteam/reports/models.ts"))};
      import { fromPythonKeys } from ${JSON.stringify(join(source, "common/python-json.ts"))};
      import { executeChatCompletion, resetReasoningRejectors } from ${JSON.stringify(join(source, "common/llm-call.ts"))};
      import { logStructuredUsage } from ${JSON.stringify(join(source, "common/structured-output.ts"))};
      import { sendResultsToOrq } from ${JSON.stringify(join(source, "send-results.ts"))};
      const fixture = await Bun.file(${JSON.stringify(join(import.meta.dir, "fixtures/redteam-cli-python-goldens.json"))}).json();
      const report = new RedTeamReport(fromPythonKeys(fixture.cases.find(row => row.name === "json").report, "RedTeamReport"));
      let calls = 0;
      const client = { chat: { completions: { create: async () => {
        if (calls++ === 0) throw Object.assign(new Error("reasoning_effort is not supported"), { status: 400 });
        return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
      } } } };
      resetReasoningRejectors();
      const code = await executeRedteamRun({ target: ["agent:x"], json: true, yes: true }, {
        print: line => console.log(line),
        printError: line => console.error(line),
        redTeam: async () => {
          logStructuredUsage(null, { phase: "Red-team recommendations" });
          for (let index = 0; index < 3; index++) await executeChatCompletion({
            client, model: "test-model", messages: [{ role: "user", content: "q" }], reasoningEffort: "low",
          });
          let uploaded = 0;
          const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
            if (request.method !== "POST" || new URL(request.url).pathname !== "/v2/spreadsheets/evaluations/receive") return new Response("unexpected request", { status: 400 });
            const payload = await request.json();
            if (payload.results.length !== 1 || payload.results[0].jobResults[0].output !== "ok") return new Response("unexpected payload", { status: 400 });
            uploaded++;
            return Response.json({ sheet_id: "sheet", manifest_id: "manifest", experiment_name: "JSON transport smoke", rows_created: 1, experiment_url: "https://example.test/experiments/smoke" });
          } });
          try {
            await sendResultsToOrq({
              apiKey: "local-fixture-key", baseUrl: String(server.url), evaluationName: "JSON transport smoke",
              startTime: new Date("2026-01-01T00:00:00Z"), endTime: new Date("2026-01-01T00:00:01Z"), raiseOnError: true,
              results: [{ dataPoint: { inputs: { prompt: "q" } }, jobResults: [{ jobName: "smoke", output: "ok" }] }],
            });
            if (uploaded !== 1) throw new Error("Expected exactly one local upload");
          } finally {
            server.stop(true);
          }
          return report;
        },
      });
      process.exitCode = code;
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).summary).toEqual(
      JSON.parse(goldenCase("json").stdout).summary,
    );
    expect(stderr).toContain("Red-team recommendations: no usage reported");
    expect(stderr).toContain("stripped again");
    expect(stderr).toContain(
      "Results sent to Orq: JSON transport smoke (1 rows created)",
    );
    expect(stderr).toContain(
      "View your evaluation at: https://example.test/experiments/smoke",
    );
  });

  test("--json prints the report Python prints", async () => {
    const { row, code, out, err } = await run("json");
    expect(code).toBe(row.exit_code);
    expect(err).toEqual([]);
    const python = JSON.parse(row.stdout),
      ts = JSON.parse(out.join("\n"));
    expect(keyDiff(python, ts)).toEqual({ onlyPython: [], onlyTs: [] });
    expect(ts.results).toEqual(python.results);
    expect(ts.summary).toEqual(python.summary);
  });

  for (const name of ["no_verdict", "below"])
    test(`coverage gate: ${name}`, async () => {
      const { row, code, err, out } = await run(name);
      expect(code).toBe(row.exit_code);
      expect(out).toEqual([]);
      expect(`${err.join("\n")}\n`).toBe(row.stderr);
    });

  for (const name of [
    "unknown_key",
    "llm_unknown",
    "no_target",
    "bad_vuln",
    "bad_strategy",
  ])
    test(`usage error: ${name}`, async () => {
      const { row, code, err, received } = await run(name);
      expect(received).toBeNull();
      expect(code).toBe(row.exit_code);
      expect(boxText(err.join("\n"))).toBe(boxText(row.stderr));
    });

  for (const name of ["flags", "from_run"])
    test(`config resolution: ${name}`, async () => {
      const { row, code, err, received } = await run(name);
      expect(code).toBe(row.exit_code);
      expect(`${err.join("\n")}${err.length ? "\n" : ""}`).toBe(row.stderr);
      const py = row.kwargs as Record<string, unknown>;
      const ts = received?.options as RedTeamCliConfig;
      const pyLlm = py.llm_config as Record<string, Record<string, unknown>>;
      expect(received?.target).toEqual(py.target);
      expect({
        name: ts.name,
        description: ts.description,
        mode: ts.mode,
        dataset: ts.dataset,
        categories: ts.categories,
        vulnerabilities: ts.vulnerabilities,
        strategies: ts.strategies,
        delivery_methods: ts.deliveryMethods,
        max_turns: ts.maxTurns,
        datapoint_parallelism: ts.datapointParallelism,
        parallelism: ts.parallelism,
        verbosity: ts.verbosity,
        generate_strategies: ts.generateStrategies,
        save: ts.save,
        previous_run: ts.previousRun,
        system_prompt: ts.targetConfig?.systemPrompt ?? null,
      } as Record<string, unknown>).toEqual({
        name: py.name,
        description: py.description,
        mode: py.mode,
        dataset: py.dataset,
        categories: py.categories,
        vulnerabilities: py.vulnerabilities,
        strategies: py.strategies,
        delivery_methods: py.delivery_methods,
        max_turns: py.max_turns,
        datapoint_parallelism: py.datapoint_parallelism,
        parallelism: py.parallelism,
        verbosity: py.verbosity,
        generate_strategies: py.generate_strategies,
        save: py.save,
        previous_run: py.previous_run,
        system_prompt:
          (py.target_config as Record<string, unknown> | null)?.system_prompt ??
          null,
      });
      if (pyLlm) {
        const llm = ts.llmConfig;
        expect({
          attacker: llm?.attacker.model,
          temperature: llm?.attacker.temperature,
          evaluator: llm?.evaluator.judges,
          coverage: llm?.evaluator.minEvaluationCoverage,
          retry: llm?.retryCount,
        } as Record<string, unknown>).toEqual({
          attacker: pyLlm.attacker?.model,
          temperature: pyLlm.attacker?.temperature,
          evaluator: pyLlm.evaluator?.judges,
          coverage: pyLlm.evaluator?.min_evaluation_coverage,
          retry: pyLlm.retry_count as never,
        });
      } else expect(ts.llmConfig).toBeNull();
    });
});

describe("eq redteam helpers match Python", () => {
  test("report filenames", () => {
    for (const [target, md, html] of golden.helpers.filenames) {
      expect(generateMdFilename(target, "20250615_103000")).toBe(md);
      expect(generateReportFilename(target, "20250615_103000", ".html")).toBe(
        html,
      );
    }
  });
  test("split csv", () => {
    for (const [input, output] of golden.helpers.split_csv)
      expect(splitCsv(input)).toEqual(output);
  });
  test("runs table cells", () => {
    for (const [input, output] of golden.helpers.fmt_created)
      expect(fmtCreated(input)).toBe(output);
    for (const [input, output] of golden.helpers.fmt_asr)
      expect(fmtAsr(input)).toBe(output);
  });
});

describe("eq redteam runs matches Python", () => {
  test("--json rows", async () => {
    const dir = resolve(await mkdtemp(join(tmpdir(), "eq-redteam-runs-")));
    const pyDir: string = golden.runs.dir;
    await mkdir(join(dir, ".manifests"));
    for (const [name, text] of Object.entries(golden.runs.files)) {
      await writeFile(join(dir, name), text as string);
      await utimes(join(dir, name), new Date(0), new Date(0));
    }
    for (const [name, manifest] of Object.entries(
      golden.runs.manifests as Record<string, Record<string, unknown>>,
    )) {
      const copy = { ...manifest };
      if (typeof copy.report_path === "string")
        copy.report_path = copy.report_path.replace(pyDir, dir);
      await writeFile(join(dir, ".manifests", name), JSON.stringify(copy));
    }
    const out: string[] = [],
      err: string[] = [];
    const io = {
      print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line),
    };
    expect(await executeRedteamRuns({ path: dir, json: true }, io)).toBe(0);
    const python = JSON.parse(golden.runs.json.stdout) as Record<
      string,
      unknown
    >[];
    const ts = JSON.parse(out.join("\n")) as Record<string, unknown>[];
    const toMillis = (value: unknown) =>
      typeof value === "string"
        ? value.replace(/(\.\d{3})\d{3}\+/, "$1000+")
        : value;
    const withIds = python.map((row) => ({
      ...row,
      created_at: toMillis(row.created_at),
      report_id: row.file
        ? reportId(join(dir, row.file as string))
        : (ts.find((t) => t.run_name === row.run_name)?.report_id ?? null),
    }));
    expect(ts).toEqual(withIds);
    expect(`${err.join("\n")}\n`).toBe(golden.runs.json.stderr);
    out.length = 0;
    await executeRedteamRuns({ path: dir, json: true, limit: 1 }, io);
    expect(JSON.parse(out.join("\n")).length).toBe(
      JSON.parse(golden.runs.limit1.stdout).length,
    );
  });

  test("missing directory", async () => {
    const out: string[] = [];
    const io = { print: (line: string) => out.push(line), printError() {} };
    await executeRedteamRuns({ path: "./none" }, io);
    expect(out).toEqual(["No runs found (directory none does not exist)."]);
    out.length = 0;
    await executeRedteamRuns({ path: "./none", json: true }, io);
    expect(out).toEqual(["[]"]);
  });
});

describe("eq redteam schema and validate-dataset", () => {
  test("schema prints the Python input schema", () => {
    const out: string[] = [];
    executeRedteamSchema({}, { print: (line) => out.push(line) });
    const schema = JSON.parse(out.join("\n"));
    expect(schema.title).toBe("RedTeamCliConfig");
    expect(schema.additionalProperties).toBe(false);
  });

  test("validate-dataset reports sample errors and mocks the HF download", async () => {
    const out: string[] = [],
      err: string[] = [];
    const urls: string[] = [];
    const io: RedteamIO = {
      print: (line) => out.push(line),
      printError: (line) => err.push(line),
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ samples: [{}, {}] }));
      }) as never,
    };
    expect(
      await executeRedteamValidateDataset({ dataset: "hf:org/repo" }, io),
    ).toBe(1);
    expect(urls[0]).toContain("huggingface.co/datasets/org/repo/resolve/main/");
    expect(out[1]).toBe("Found 2 samples.");
    expect(err[0]).toMatch(/^\nFAIL: \d+ validation error\(s\):$/);
    expect(err[1]).toMatch(/^ {2}sample\[0\]\.input: /);
  });
});

describe("root model flags", () => {
  test("replace the recorded models and export them for subprocesses", () => {
    applyModelFlags({ smart: "m/smart" }, { replace: true });
    applyModelFlags(
      { fast: " m/fast ", overrides: ["redteam.attacker=m/att"] },
      {},
    );
    expect(JSON.parse(process.env.EVALUATORQ_MODEL_OVERRIDES ?? "")).toEqual({
      roles: { smart: "m/smart", fast: "m/fast" },
      overrides: { "redteam.attacker": "m/att" },
    });
    applyModelFlags({}, { replace: true });
    expect(process.env.EVALUATORQ_MODEL_OVERRIDES).toBeUndefined();
    expect(() => applyModelFlags({ overrides: ["nope=x"] })).toThrow(
      BadParameter,
    );
  });
});

describe("report artifacts", () => {
  test("--report, --report-md and --report-html write next to the run", async () => {
    const dir = resolve(await mkdtemp(join(tmpdir(), "eq-redteam-report-")));
    const row = goldenCase("json");
    const out: string[] = [];
    const code = await executeRedteamRun(
      {
        target: ["agent:my/target"],
        report: join(dir, "nested", "report.json"),
        report_md: join(dir, "md"),
        report_html: join(dir, "html"),
      },
      {
        print: (line) => out.push(line),
        printError: () => {},
        now: () => new Date("2025-06-15T10:30:00Z"),
        redTeam: (async () =>
          new RedTeamReport(
            fromPythonKeys(row.report, "RedTeamReport"),
          )) as never,
      },
    );
    expect(code).toBe(0);
    expect(out).toEqual([
      `Report saved to ${join(dir, "nested", "report.json")}`,
      `Markdown report written to ${join(dir, "md", "redteam-report-agent-my-target-20250615_103000.md")}`,
      `HTML report written to ${join(dir, "html", "redteam-report-agent-my-target-20250615_103000.html")}`,
    ]);
    const saved = JSON.parse(
      await readFile(join(dir, "nested", "report.json"), "utf8"),
    );
    expect(keyDiff(JSON.parse(row.stdout), saved)).toEqual({
      onlyPython: [],
      onlyTs: [],
    });
  });
});

test("JSON output remains parseable when the real CLI hooks run", async () => {
  const out: string[] = [],
    err: string[] = [];
  const info = spyOn(console, "info");
  const report = new RedTeamReport(
    fromPythonKeys(goldenCase("json").report, "RedTeamReport"),
  );
  try {
    const code = await executeRedteamRun(
      { target: ["agent:x"], json: true, yes: true },
      {
        print: (line) => out.push(line),
        printError: (line) => err.push(line),
        stdinIsTTY: true,
        confirm: () => {
          throw new Error("--yes must not prompt");
        },
        redTeam: async (_target, options) => {
          const hooks = options?.hooks as PipelineHooks;
          await hooks.onStageStart("attack_execution", {});
          expect(await hooks.onConfirm({ numDatapoints: 1 })).toBe(true);
          await hooks.onComplete(report);
          return report;
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n")).summary).toEqual(
      JSON.parse(goldenCase("json").stdout).summary,
    );
    expect(err.some((line) => line.includes("Run plan"))).toBe(true);
    expect(info).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
});

test("declining an interactive redteam plan prevents target execution", async () => {
  let prompts = 0,
    targetCalls = 0;
  const out: string[] = [];
  const code = await executeRedteamRun(
    { target: ["agent:x"] },
    {
      print: (line) => out.push(line),
      printError: () => {},
      stdinIsTTY: true,
      confirm: () => {
        prompts++;
        return false;
      },
      redTeam: async (_target, options) => {
        if (
          !(await (options?.hooks as PipelineHooks).onConfirm({
            numDatapoints: 1,
          }))
        )
          throw new CancelledError("declined");
        targetCalls++;
        throw new Error("target must not run");
      },
    },
  );
  expect(code).toBe(0);
  expect(prompts).toBe(1);
  expect(targetCalls).toBe(0);
  expect(out).toContain("Run cancelled.");
});

test("manifest hooks do not perform CLI confirmation", async () => {
  expect(await new ManifestStageHooks({} as never).onConfirm({})).toBe(true);
});
