import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BadParameter } from "../../src/lib/common/cli-config.js";
import { reportId } from "../../src/lib/common/dashboard/library.js";
import {
  executeSimRuns,
  executeSimSchema,
  executeSimValidate,
  executeSimValidateDataset,
  fmtSimDate,
  formatScorerAverages,
  simulateCommand,
} from "../../src/lib/integrations/simulation/cli.js";
import {
  GENERATE_AND_SIMULATE_CONFIG_MODEL,
  GenerateAndSimulateCliConfigSchema,
  SIMULATE_CONFIG_MODEL,
  SimulateCliConfigSchema,
} from "../../src/lib/integrations/simulation/run-config.js";

const golden = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures", "sim-cli-python-goldens.json"),
    "utf8",
  ),
);
type Case = { exit_code: number; stdout: string; stderr: string };
const cases = golden.cases as Record<string, Case>;
const PY = "/python-work";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line),
    },
    text: (lines: string[]) => (lines.length ? `${lines.join("\n")}\n` : ""),
  };
}

async function workDir(): Promise<string> {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-sim-cli-")));
  for (const name of ["good.jsonl", "bad.jsonl"])
    await writeFile(join(dir, name), golden.files[name]);
  return dir;
}

describe("eq sim schema matches pinned Python", () => {
  for (const [name, args] of [
    ["schema_simulate", {}],
    ["schema_run", { command: "run" }],
    ["schema_output", { output: true }],
  ] as const) {
    test(name, () => {
      const c = capture();
      expect(executeSimSchema(args, c.io)).toBe(0);
      expect(JSON.parse(c.out.join("\n"))).toEqual(
        JSON.parse(cases[name]?.stdout as string),
      );
    });
  }

  for (const [name, live] of [
    ["schema_simulate", SimulateCliConfigSchema],
    ["schema_run", GenerateAndSimulateCliConfigSchema],
  ] as const) {
    test(`${name} stays aligned with live TypeScript config fields and defaults`, () => {
      const schema = JSON.parse(cases[name]?.stdout as string) as {
        properties: Record<string, { default?: unknown }>;
      };
      expect(Object.keys(live.shape).sort()).toEqual(
        Object.keys(schema.properties).sort(),
      );
      for (const [key, field] of Object.entries(live.shape)) {
        const property = schema.properties[key];
        if (property && Object.hasOwn(property, "default")) {
          const parsed = field.safeParse(undefined);
          expect(parsed.success).toBe(true);
          if (parsed.success)
            expect<unknown>(parsed.data).toEqual(property.default);
        }
      }
    });

    test(`${name} retains documented numeric constraints`, () => {
      const schema = JSON.parse(cases[name]?.stdout as string) as {
        properties: Record<
          string,
          {
            minimum?: number;
            exclusiveMinimum?: number;
            anyOf?: { minimum?: number; exclusiveMinimum?: number }[];
          }
        >;
      };
      for (const key of [
        "max_turns",
        "target_agent_timeout_ms",
        "max_target_retries",
        "max_tool_result_chars",
      ] as const) {
        const property = schema.properties[key];
        if (!property) throw new Error(`Missing schema field: ${key}`);
        const bounds =
          property.anyOf?.find(
            (branch) =>
              branch.minimum !== undefined ||
              branch.exclusiveMinimum !== undefined,
          ) ?? property;
        const minimum =
          bounds.minimum ??
          (bounds.exclusiveMinimum === undefined
            ? undefined
            : bounds.exclusiveMinimum + 1);
        if (minimum === undefined)
          throw new Error(`Missing numeric bound: ${key}`);
        expect(live.shape[key].safeParse(minimum).success).toBe(true);
        expect(live.shape[key].safeParse(minimum - 1).success).toBe(false);
        expect(live.shape[key].safeParse("1").success).toBe(false);
      }
    });
  }

  test("default evaluation_name preserves whether the legacy alias was supplied", () => {
    for (const model of [
      SIMULATE_CONFIG_MODEL,
      GENERATE_AND_SIMULATE_CONFIG_MODEL,
    ]) {
      expect(model.build({}).evaluation_name).toBe("");
      expect(model.build({}).run_name).toBeNull();
      expect(model.build({ evaluation_name: "" }).run_name).toBe("");
      expect(model.build({ evaluation_name: "legacy" }).run_name).toBe(
        "legacy",
      );
      expect(model.build({ run_name: "current" }).run_name).toBe("current");
      expect(() =>
        model.build({ run_name: "current", evaluation_name: "legacy" }),
      ).toThrow("run_name and evaluation_name must match");
    }
  });

  test("unknown --command is a usage error", () => {
    expect(() =>
      executeSimSchema({ command: "nope" as "run" }, capture().io),
    ).toThrow(BadParameter);
  });
});

describe("eq sim validate matches Python", () => {
  test("valid file", async () => {
    const dir = await workDir();
    for (const [name, run] of [
      [
        "validate_good",
        (io: never) =>
          executeSimValidate({ input: join(dir, "good.jsonl") }, io),
      ],
      [
        "validate_dataset",
        (io: never) =>
          executeSimValidateDataset({ path: join(dir, "good.jsonl") }, io),
      ],
    ] as const) {
      const c = capture();
      expect(run(c.io as never)).toBe(cases[name]?.exit_code as number);
      const py = cases[name] as Case;
      expect(c.text(c.out)).toBe(py.stdout.replaceAll(PY, dir));
      expect(c.text(c.err)).toBe(py.stderr.replaceAll(PY, dir));
    }
  });

  test("invalid lines", async () => {
    const dir = await workDir();
    const c = capture();
    const py = cases.validate_bad as Case;
    expect(executeSimValidate({ path: join(dir, "bad.jsonl") }, c.io)).toBe(
      py.exit_code,
    );
    const pyLines = py.stderr.trimEnd().split("\n");
    expect(c.err.at(-1)).toBe((pyLines.at(-1) as string).replaceAll(PY, dir));
    expect(c.err.map((line) => line.split(":")[0]).slice(0, -1)).toEqual(
      pyLines
        .filter((line) => line.startsWith("Line "))
        .map((line) => line.split(":")[0]),
    );
    expect(c.out).toEqual([]);
  });

  test("usage errors", async () => {
    const dir = await workDir();
    const good = join(dir, "good.jsonl");
    const flat = (text: string) =>
      text.replace(/[─-╿]/g, "").replace(/\s+/g, " ");
    for (const [name, args] of [
      ["validate_both", { input: good, path: good }],
      ["validate_missing", { input: join(dir, "nope.jsonl") }],
    ] as const) {
      let error: unknown;
      try {
        executeSimValidate(args, capture().io);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BadParameter);
      expect(cases[name]?.exit_code).toBe(2);
      expect(flat(cases[name]?.stderr.replaceAll(PY, dir) as string)).toContain(
        flat((error as BadParameter).render().replace(/^Error: /, "")),
      );
    }
  });
});

describe("eq sim runs matches Python", () => {
  test("--json rows", async () => {
    const dir = resolve(await mkdtemp(join(tmpdir(), "eq-sim-runs-")));
    const pyRuns = `${PY}/runs`;
    await mkdir(join(dir, ".manifests"));
    for (const [name, text] of [
      ["legacy-run.json", golden.files["legacy-run.json"]],
      ["broken.json", "{not json"],
      ["managed-run.json", "{}"],
    ] as const) {
      await writeFile(join(dir, name), text);
      await utimes(join(dir, name), new Date(0), new Date(0));
    }
    for (const [name, manifest] of Object.entries(
      golden.manifests as Record<string, Record<string, unknown>>,
    )) {
      const copy = { ...manifest };
      if (typeof copy.report_path === "string")
        copy.report_path = copy.report_path.replace(pyRuns, dir);
      await writeFile(join(dir, ".manifests", name), JSON.stringify(copy));
    }
    const c = capture();
    expect(await executeSimRuns({ directory: dir, json: true }, c.io)).toBe(0);
    const python = JSON.parse(cases.runs_json?.stdout as string) as Record<
      string,
      unknown
    >[];
    const ts = JSON.parse(c.out.join("\n")) as Record<string, unknown>[];
    const toMillis = (value: unknown) =>
      typeof value === "string"
        ? value.replace(/(\.\d{3})\d{3}\+/, "$1000+")
        : value;
    expect(ts).toEqual(
      python.map((row) => ({
        ...row,
        created_at: toMillis(row.created_at),
        report_id: row.file
          ? reportId(join(dir, row.file as string))
          : (ts.find((t) => t.run_name === row.run_name)?.report_id ?? null),
      })),
    );
    expect(c.text(c.err)).toBe(cases.runs_json?.stderr as string);
    c.out.length = 0;
    await executeSimRuns({ directory: dir, json: true, limit: 1 }, c.io);
    expect(JSON.parse(c.out.join("\n"))).toHaveLength(
      JSON.parse(cases.runs_limit1?.stdout as string).length,
    );
  });

  test("missing directory", async () => {
    const dir = await workDir();
    for (const [name, json] of [
      ["runs_missing", false],
      ["runs_missing_json", true],
    ] as const) {
      const c = capture();
      expect(
        await executeSimRuns({ directory: join(dir, "none"), json }, c.io),
      ).toBe(0);
      expect(c.text(c.out)).toBe(
        (cases[name] as Case).stdout.replaceAll(PY, dir),
      );
    }
  });
});

test("helpers match Python", () => {
  for (const [value, expected] of golden.helpers.fmt_date)
    expect(fmtSimDate(value)).toBe(expected);
  for (const [value, expected] of golden.helpers.scores)
    expect(formatScorerAverages(value)).toBe(expected);
  expect(simulateCommand("my dir/dp.jsonl", null)).toBe(
    golden.helpers.simulate_command,
  );
});
