import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../../../cli/src/bin/cli.ts");

for (const quiet of [false, true])
  test(`ORQ_DEBUG keeps JSON stdout valid with quiet=${quiet}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "eq-cli-debug-json-"));
    const harness = join(directory, "debug.ts");
    const simulation = resolve(
      import.meta.dir,
      "../../src/lib/integrations/simulation/index.ts",
    );
    try {
      writeFileSync(
        harness,
        `
import { mock } from "bun:test";
const simulation = await import(${JSON.stringify(simulation)});
mock.module(${JSON.stringify(simulation)}, () => ({
  ...simulation,
  executeSimSimulate: async (_args, io) => {
    console.debug("fixture generation debug");
    io.print(JSON.stringify({ ok: true }));
    return 0;
  },
}));
process.argv = [process.execPath, ${JSON.stringify(cli)}, "sim", "simulate", "--json", ...${JSON.stringify(quiet ? ["-q"] : [])}];
await import(${JSON.stringify(cli)});
`,
      );
      const result = spawnSync(
        process.execPath,
        ["--conditions=development", harness],
        {
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ORQ_DEBUG: "1" },
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
      expect(result.stderr.includes("fixture generation debug")).toBe(!quiet);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

for (const flags of [
  ["redteam", "run", "--max-turns", "abc"],
  ["sim", "runs", "-n", "-1"],
  ["redteam", "runs", "-n", "abc"],
  ["sim", "generate", "-d", "/unused", "--num-personas", "0"],
  ["sim", "from-traces", "-o", "/unused", "--limit", "0"],
  ["sim", "from-traces", "-o", "/unused", "--lookback-hours", "-1"],
  ["sim", "from-traces", "-o", "/unused", "--lookback-hours", "Infinity"],
])
  test(`Commander rejects ${flags.join(" ")} as usage before execution`, () => {
    const result = spawnSync(
      process.execPath,
      ["--conditions=development", cli, ...flags],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, EQ_DEBUG: "1" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  }, 20000);

for (const command of ["simulate", "run", "generate", "from-traces"])
  test(`sim ${command} exposes the pinned verbosity flag`, () => {
    const result = spawnSync(
      process.execPath,
      ["--conditions=development", cli, "sim", command, "--help"],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("-v, --verbose");
  }, 20000);

test("sim runs accepts --full and keeps output filenames intact", () => {
  const directory = mkdtempSync(join(tmpdir(), "eq-cli-full-"));
  const filename = `sim-${"long-name-".repeat(12)}.json`;
  try {
    writeFileSync(
      join(directory, filename),
      JSON.stringify({ run_name: "fixture", mode: "simulate" }),
    );
    const result = spawnSync(
      process.execPath,
      ["--conditions=development", cli, "sim", "runs", directory, "--full"],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(filename);
    expect(result.stderr).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

for (const [flags, progress] of [
  [[], false],
  [["-v"], true],
  [["-vv", "-q"], false],
] as const)
  test(`real generate progress follows ${flags.join(" ") || "default"} verbosity`, () => {
    const directory = mkdtempSync(join(tmpdir(), "eq-cli-quiet-"));
    const output = join(directory, "datapoints.jsonl");
    const harness = join(directory, "generate.ts");
    try {
      writeFileSync(
        harness,
        `
import { DatapointGenerator } from ${JSON.stringify(resolve(import.meta.dir, "../../src/lib/integrations/simulation/generators/datapoint-generator.ts"))};
import { FirstMessageGenerator } from ${JSON.stringify(resolve(import.meta.dir, "../../src/lib/integrations/simulation/generators/first-message-generator.ts"))};
import { makeFakeClient } from ${JSON.stringify(join(import.meta.dir, "integrations/simulation/fake-client.ts"))};
const persona = { name: "Fixture", patience: 0.5, assertiveness: 0.5, politeness: 0.5, technical_level: 0.5, communication_style: "casual", background: "fixture" };
const scenario = { name: "Fixture", goal: "Say hello", criteria: [] };
DatapointGenerator.prototype.generateFromDescription = async () => {
  const { client } = makeFakeClient({ firstMessage: () => "Hello" });
  const message = await new FirstMessageGenerator({ client }).generate(persona, scenario);
  return [{ id: "fixture", persona, scenario, user_system_prompt: "fixture", first_message: message }];
};
process.argv = [process.execPath, ${JSON.stringify(cli)}, "sim", "generate", "--agent-description", "fixture", "-d", ${JSON.stringify(output)}, ...${JSON.stringify(flags)}];
await import(${JSON.stringify(cli)});
`,
      );
      const result = spawnSync(
        process.execPath,
        ["--conditions=development", harness],
        {
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            ORQ_API_KEY: undefined,
            OPENAI_API_KEY: "fixture-key",
            ORQ_DEBUG: undefined,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.includes("Generated first message: Hello")).toBe(
        progress,
      );
      expect(result.stderr).toContain("Generated 1 datapoint(s)");
      expect(JSON.parse(readFileSync(output, "utf8")).first_message).toBe(
        "Hello",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
