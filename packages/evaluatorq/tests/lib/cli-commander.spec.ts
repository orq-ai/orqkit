import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function redteamArguments(flags: string[]): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), "eq-commander-"));
  const harness = join(directory, "parse.ts");
  const cli = resolve(import.meta.dir, "../../../cli/src/bin/cli.ts");
  const redteam = resolve(import.meta.dir, "../../src/lib/redteam/index.ts");
  const commander = fileURLToPath(import.meta.resolve("commander"));
  try {
    writeFileSync(
      harness,
      `
import { mock } from "bun:test";
const commander = await import(${JSON.stringify(commander)});
const redteam = await import(${JSON.stringify(redteam)});
let parsing;
let captured;
class ParsedCommand extends commander.Command {
  parse(argv, options) {
    parsing = this.parseAsync(argv, options);
    return this;
  }
}
mock.module(${JSON.stringify(commander)}, () => ({ ...commander, Command: ParsedCommand }));
mock.module(${JSON.stringify(redteam)}, () => ({
  ...redteam,
  executeRedteamRun: async (args) => { captured = args; return 0; },
}));
process.argv = [process.execPath, ${JSON.stringify(cli)}, "redteam", "run", ...${JSON.stringify(flags)}];
await import(${JSON.stringify(cli)});
await parsing;
process.stdout.write(JSON.stringify(captured));
`,
    );
    return JSON.parse(
      execFileSync(process.execPath, ["--conditions=development", harness], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, EQ_DEBUG: "1" },
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Commander maps redteam options to evaluator arguments", () => {
  const args = redteamArguments([
    "--target",
    "agent:first",
    "--target",
    "agent:second",
    "--name",
    "fixture",
    "--mode",
    "static",
    "--category",
    "LLM01",
    "--category",
    "LLM02",
    "--vulnerability",
    "privacy",
    "--strategy",
    "direct",
    "--delivery-method",
    "chat",
    "--max-turns",
    "3",
    "--max-per-category",
    "4",
    "--attack-model",
    "attack-model",
    "--attacker-instructions",
    "fixture instructions",
    "--evaluator-model",
    "judge-model",
    "--min-evaluation-coverage",
    "0.75",
    "--target-timeout-ms",
    "5000",
    "--max-target-retries",
    "2",
    "--max-backtracks",
    "3",
    "--retry-count",
    "4",
    "--max-tool-continuations",
    "5",
    "--target-reasoning-effort",
    "high",
    "--datapoint-parallelism",
    "6",
    "--llm-parallelism",
    "-1",
    "--generated-strategy-count",
    "7",
    "--no-generate-strategies",
    "--max-dynamic-datapoints",
    "8",
    "--max-static-datapoints",
    "9",
    "--no-cleanup-memory",
    "--dataset",
    "fixture.jsonl",
    "--from-run",
    "latest",
    "--artifacts-dir",
    "artifacts",
    "--save",
    "detail",
    "--yes",
    "--verbose",
    "--verbose",
    "--quiet",
    "--report",
    "report.json",
    "--report-md",
    "markdown",
    "--report-html",
    "html",
    "--no-executive-summary",
    "--no-recommendations",
    "--system-prompt",
    "fixture prompt",
    "--config",
    "{}",
    "--llm-config",
    "{}",
    "--json",
  ]);
  expect(args).toEqual({
    target: ["agent:first", "agent:second"],
    name: "fixture",
    mode: "static",
    categories: ["LLM01", "LLM02"],
    vulnerabilities: ["privacy"],
    strategies: ["direct"],
    delivery_methods: ["chat"],
    max_turns: 3,
    max_per_category: 4,
    attack_model: "attack-model",
    attacker_instructions: "fixture instructions",
    evaluator_model: "judge-model",
    min_evaluation_coverage: 0.75,
    target_timeout_ms: 5000,
    max_target_retries: 2,
    max_backtracks: 3,
    retry_count: 4,
    max_tool_continuations: 5,
    target_reasoning_effort: "high",
    datapoint_parallelism: 6,
    llm_parallelism: -1,
    generated_strategy_count: 7,
    generate_strategies: false,
    max_dynamic_datapoints: 8,
    max_static_datapoints: 9,
    cleanup_memory: false,
    dataset: "fixture.jsonl",
    from_run: "latest",
    artifacts_dir: "artifacts",
    save: "detail",
    yes: true,
    verbose: 2,
    quiet: true,
    report: "report.json",
    report_md: "markdown",
    report_html: "html",
    executive_summary: false,
    recommendations: false,
    system_prompt: "fixture prompt",
    config: "{}",
    llm_config_json: "{}",
    json: true,
  });
}, 20000);

for (const flags of [
  ["--datapoint-parallelism", "4", "--parallelism", "2"],
  ["--parallelism", "2", "--datapoint-parallelism", "4"],
  ["--parallelism", "2", "--datapoint-parallelism", "4", "--parallelism", "3"],
])
  test(`canonical parallelism wins for ${flags.join(" ")}`, () => {
    expect(redteamArguments(flags).datapoint_parallelism).toBe(4);
  }, 20000);

test("Commander preserves the parallelism alias and explicit positive booleans", () => {
  expect(
    redteamArguments([
      "--parallelism",
      "3",
      "--generate-strategies",
      "--cleanup-memory",
      "--executive-summary",
      "--recommendations",
    ]),
  ).toMatchObject({
    datapoint_parallelism: 3,
    generate_strategies: true,
    cleanup_memory: true,
    executive_summary: true,
    recommendations: true,
  });
}, 20000);
