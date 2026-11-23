import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BadParameter } from "../../src/lib/common/cli-config.js";
import {
  executeSimExport,
  executeSimUploadDataset,
  type SimDatasetsApi,
} from "../../src/lib/integrations/simulation/cli-export.js";

const golden = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures", "sim-cli-export-python-goldens.json"),
    "utf8",
  ),
);
type Case = { exit_code: number; stdout: string; stderr: string };
const cases = golden.cases as Record<string, Case>;
const PY = "/python-work";

function pythonError(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("│"))
    .map((line) => line.replace(/^│\s?/, "").replace(/\s*│$/, "").trim())
    .join(" ");
}

async function setup() {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-sim-export-")));
  for (const [name, content] of Object.entries(
    golden.files.inputs as Record<string, string>,
  ))
    await writeFile(join(dir, name), content, "utf8");
  const out: string[] = [];
  const err: string[] = [];
  const norm = (lines: string[]) =>
    (lines.length ? `${lines.join("\n")}\n` : "").replaceAll(dir, PY);
  return {
    dir,
    io: {
      print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line),
    },
    out: () => norm(out),
    err: () => norm(err),
    read: (name: string) => readFile(join(dir, name), "utf8"),
  };
}

async function badParameter(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
  } catch (error) {
    if (error instanceof BadParameter) return error.render();
    throw error;
  }
  throw new Error("expected BadParameter");
}

function mockDatasets() {
  const calls: unknown[] = [];
  const api: SimDatasetsApi = {
    create: async (request) => {
      calls.push({ create: request });
      return { id: "ds_new" };
    },
    createDatapoint: async (request) => {
      calls.push({ create_datapoint: request });
      return [];
    },
  };
  return { calls, datasets: async () => api };
}

describe("eq sim export matches Python", () => {
  test("rejects a truncated JSONL line before writing an export", async () => {
    const s = await setup();
    const input = join(s.dir, "truncated.jsonl");
    await writeFile(input, '{"broken":');
    const result = await badParameter(() =>
      executeSimExport({ input, output: join(s.dir, "out.json") }, s.io),
    );
    expect(result).toContain("Malformed JSON on line 1");
  });
  for (const [name, input, format] of [
    ["export_missing", "nope.jsonl", undefined],
    ["export_bad_format", "results.jsonl", "pdf"],
  ] as const) {
    test(name, async () => {
      const s = await setup();
      const rendered = await badParameter(() =>
        executeSimExport(
          { input: join(s.dir, input), output: join(s.dir, "o.json"), format },
          s.io,
        ),
      );
      expect(rendered.replace(/^Error: /, "").replaceAll(s.dir, PY)).toBe(
        pythonError((cases[name] as Case).stderr),
      );
    });
  }

  test("export_bad_line", async () => {
    const s = await setup();
    const rendered = await badParameter(() =>
      executeSimExport(
        {
          input: join(s.dir, "bad.jsonl"),
          output: join(s.dir, "o.json"),
        },
        s.io,
      ),
    );
    expect(rendered.replaceAll(s.dir, PY)).toContain(
      "Invalid value: Failed to read /python-work/bad.jsonl: ",
    );
  });

  for (const [name, input, output] of [
    ["export_openresponses", "results.jsonl", "out/or.json"],
    ["export_run_openresponses", "run.json", "out/run-or.json"],
  ] as const) {
    test(name, async () => {
      const s = await setup();
      await executeSimExport(
        { input: join(s.dir, input), output: join(s.dir, output) },
        s.io,
      );
      const py = cases[name] as Case;
      expect(s.out()).toBe(py.stdout);
      expect(s.err()).toBe(py.stderr);
      const payload = JSON.parse(await s.read(output));
      expect(payload).toHaveLength(golden.files.or_count);
      expect(Object.keys(payload[0]).sort()).toEqual(golden.files.or_keys);
    });
  }

  for (const [name, input, output, format, targetLabel, flag] of [
    [
      "export_md_plain",
      "results.jsonl",
      "out/r.md",
      "md",
      undefined,
      "md_plain_has_rec",
    ],
    ["export_md_stored", "run.json", "out/run.md", "md", "bot", "md_has_rec"],
    [
      "export_html_run",
      "run.json",
      "out/run.html",
      "html",
      undefined,
      "html_has_rec",
    ],
  ] as const) {
    test(name, async () => {
      const s = await setup();
      await executeSimExport(
        {
          input: join(s.dir, input),
          output: join(s.dir, output),
          format,
          target_label: targetLabel,
        },
        s.io,
      );
      const py = cases[name] as Case;
      expect(s.out()).toBe(py.stdout);
      expect(s.err()).toBe(py.stderr);
      expect((await s.read(output)).includes("fix it")).toBe(
        golden.files[flag],
      );
    });
  }

  test("--recommendations generates when none are stored", async () => {
    const s = await setup();
    const models: string[] = [];
    await executeSimExport(
      {
        input: join(s.dir, "results.jsonl"),
        output: join(s.dir, "gen.md"),
        format: "md",
        recommendations: true,
        sim_model: "m-1",
      },
      {
        ...s.io,
        generateRecommendations: async (_results, model) => {
          models.push(model);
          return [
            {
              resultIndex: 1,
              datapointId: null,
              persona: "Q",
              scenario: "S",
              triggers: ["rule_broken: leaked"],
              suggestions: ["generated fix"],
            },
          ];
        },
      },
    );
    expect(models).toEqual(["m-1"]);
    expect(await s.read("gen.md")).toContain("generated fix");
  });
});

describe("eq sim upload-dataset matches Python", () => {
  for (const [name, args, env] of [
    [
      "upload_missing",
      { input: "nope.jsonl", name: "x" },
      { ORQ_API_KEY: "k" },
    ],
    ["upload_no_name", { input: "dp.jsonl" }, { ORQ_API_KEY: "k" }],
    ["upload_no_key", { input: "dp.jsonl", name: "x" }, {}],
    ["upload_empty", { input: "empty.jsonl", name: "x" }, { ORQ_API_KEY: "k" }],
  ] as const) {
    test(name, async () => {
      const s = await setup();
      const mock = mockDatasets();
      const rendered = await badParameter(() =>
        executeSimUploadDataset(
          { ...args, input: join(s.dir, args.input) },
          { ...s.io, env, datasets: mock.datasets },
        ),
      );
      expect(rendered.replace(/^Error: /, "").replaceAll(s.dir, PY)).toBe(
        pythonError((cases[name] as Case).stderr),
      );
      expect(mock.calls).toEqual([]);
    });
  }

  test("upload_create and upload_extend", async () => {
    const s = await setup();
    const mock = mockDatasets();
    await executeSimUploadDataset(
      { input: join(s.dir, "dp.jsonl"), name: "my set", path: "proj/sims" },
      { ...s.io, env: { ORQ_API_KEY: "k" }, datasets: mock.datasets },
    );
    const create = cases.upload_create as Case;
    expect(s.out()).toBe(create.stdout);
    expect(s.err()).toBe(create.stderr);

    const t = await setup();
    await executeSimUploadDataset(
      { input: join(t.dir, "dp.jsonl"), dataset_id: "ds_old" },
      {
        ...t.io,
        env: { ORQ_API_KEY: "k", ORQ_BASE_URL: "https://staging.orq.ai/" },
        datasets: mock.datasets,
      },
    );
    const extend = cases.upload_extend as Case;
    expect(t.out()).toBe(extend.stdout);
    expect(t.err()).toBe(extend.stderr);

    type PyCall = {
      create: { display_name: string; path: string };
      create_datapoint: {
        dataset_id: string;
        rows: Record<string, unknown>[];
      };
    };
    const py = golden.calls as PyCall[];
    expect(mock.calls).toEqual([
      {
        create: {
          displayName: py[0]?.create.display_name,
          path: py[0]?.create.path,
        },
      },
      ...py.slice(1).map((call) => ({
        create_datapoint: {
          datasetId: call.create_datapoint.dataset_id,
          requestBody: call.create_datapoint.rows.map(
            ({ expected_output, ...rest }: Record<string, unknown>) => ({
              ...rest,
              expectedOutput: expected_output,
            }),
          ),
        },
      })),
    ]);
  });
});
