#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { DASHBOARD_HELP } from "@orq-ai/evaluatorq/dashboard";

import { runDashboard } from "../commands/dashboard.js";
import { evaluate } from "../commands/evaluate.js";
import { find } from "../commands/find.js";
import { runInsights } from "../commands/insights.js";
import {
  applyRootModelFlags,
  runRedteam,
  runRedteamRuns,
  runRedteamSchema,
  runRedteamValidateDataset,
} from "../commands/redteam.js";
import { runSessions } from "../commands/sessions.js";
import {
  runSimExport,
  runSimFromTraces,
  runSimGenerate,
  runSimRun,
  runSimRuns,
  runSimSchema,
  runSimSimulate,
  runSimUploadDataset,
  runSimValidate,
  runSimValidateDataset,
} from "../commands/sim.js";

// Python keeps debug logs hidden by default; Bun prints console.debug always.
console.debug = process.env.ORQ_DEBUG
  ? (...args) => console.error(...args)
  : () => {};

const program = new Command();

// Click exits 2 on usage errors; Commander's default is 1.
program.exitOverride((err) => {
  process.exit(err.exitCode === 1 ? 2 : err.exitCode);
});

program
  .name("orq")
  .description("CLI for running evaluatorq evaluation files")
  .version("0.0.1")
  .enablePositionalOptions()
  .option("--fast-model <model>", "Model for cheap, high-volume steps")
  .option("--smart-model <model>", "Model for attacks, judges and summaries")
  .option("--classifier-model <model>", "Model for trace classification")
  .option("--embedding-model <model>", "Model for embeddings")
  .option(
    "--model-override <task=model>",
    "Pin one task to a model; repeatable",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .hook("preAction", (command, action) => {
    applyRootModelFlags(command.opts());
    const options = action.opts();
    if (options.quiet) console.debug = () => {};
    else if (options.verbose)
      console.debug = (...args) => console.error(...args);
  });

program
  .command("evaluate <pattern>")
  .description("Run evaluation files matching the glob pattern")
  // .option("-w, --watch", "Watch for file changes", false)
  .action(evaluate);

const integer = (value: string): number => {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError(`Invalid integer: ${value}`);
  return parsed;
};
const positiveInteger = (value: string): number => {
  const parsed = integer(value);
  if (parsed < 1) throw new InvalidArgumentError("Must be at least 1");
  return parsed;
};
const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];
program
  .command("find <query>")
  .description("Find recent traces matching a natural-language question")
  .option("--debug", "Show progress and model requests and responses")
  .option("-y, --yes", "Skip plan confirmation")
  .option("--profile <name>", "Orq CLI profile")
  .option("--window-days <days>", "Number of recent days to search", integer)
  .option("--filter-selection <mode>", "Metadata filter mode: llm or llm+jev")
  .option("--limit <count>", "Maximum traces to classify", integer)
  .option("--parallelism <count>", "Concurrent classify calls", integer)
  .option("--compiler-model <model>", "Compiler model")
  .option("--classifier-model <model>", "Classifier model")
  .option("--json <path>", "Write the completed run export to a file")
  .option("--positive-only", "Export only matched traces")
  .option("--project <value>", "Project facet; repeatable", collect)
  .option("--model <value>", "Model facet; repeatable", collect)
  .option("--provider <value>", "Provider facet; repeatable", collect)
  .option("--status <value>", "Status facet; repeatable", collect)
  .option("--product <value>", "Product facet; repeatable", collect)
  .option("--trace-type <value>", "Trace type facet; repeatable", collect)
  .option("--agent <value>", "Agent facet; repeatable", collect)
  .option("--tool <value>", "Tool facet; repeatable", collect)
  .option("--tokens-min <value>", "Minimum total tokens", integer)
  .option("--tokens-max <value>", "Maximum total tokens", integer)
  .option(
    "--duration-ms-min <value>",
    "Minimum duration in milliseconds",
    integer,
  )
  .option(
    "--duration-ms-max <value>",
    "Maximum duration in milliseconds",
    integer,
  )
  .action(find);

program
  .command("insights")
  .description("Analyze and cluster trace conversations")
  .option("--sessions", "Use local coding-agent sessions")
  .option("--source <name>", "Session source; repeatable", collect)
  .option("--from <date>", "First local day, YYYY-MM-DD")
  .option("--to <date>", "Last local day, YYYY-MM-DD")
  .option("--project-dir <path>", "Limit sessions to a project")
  .option("--text <text>", "Find text in session messages")
  .option("--query <text>", "Natural-language trace selection")
  .option("--from-finder <path>", "Use a Finder export")
  .option("--from-snapshot <path>", "Use a local trace snapshot")
  .option(
    "--preview-input",
    "Preview snapshot input coverage without running models",
  )
  .option(
    "--label <name-or-path>",
    "Label preset or JSON specification; repeatable",
    collect,
  )
  .option("--dimension <name>", "Dimension to cluster; repeatable", collect)
  .option("--priority-dimension <name>", "Priority matrix dimension")
  .option("--max-clusters <count>", "Maximum top-level clusters", integer)
  .option(
    "--max-subclusters <count>",
    "Maximum base clusters per group",
    integer,
  )
  .option("--outlier-zscore <value>", "Outlier z-score", Number)
  .option("--summary-model <model>", "Summary model")
  .option("--classifier-model <model>", "Classifier model")
  .option("--compiler-model <model>", "Query compiler model")
  .option("--embedding-model <model>", "Embedding model")
  .option("--no-cache", "Disable Insights cache")
  .option("--coding", "Enable coding analysis")
  .option("--json <path>", "Write run JSON to a file")
  .option("--profile <name>", "Orq CLI profile")
  .option("--window-days <days>", "Recent days to scan", integer)
  .option("--limit <count>", "Maximum traces to scan", integer)
  .option("--parallelism <count>", "Concurrent model calls", integer)
  .option("--filter-selection <mode>", "Metadata filter mode: llm or llm+jev")
  .option("--project <value>", "Project facet; repeatable", collect)
  .option("--model <value>", "Model facet; repeatable", collect)
  .option("--provider <value>", "Provider facet; repeatable", collect)
  .option("--status <value>", "Status facet; repeatable", collect)
  .option("--product <value>", "Product facet; repeatable", collect)
  .option("--trace-type <value>", "Trace type facet; repeatable", collect)
  .option("--agent <value>", "Agent facet; repeatable", collect)
  .option("--tool <value>", "Tool facet; repeatable", collect)
  .option("--tokens-min <value>", "Minimum total tokens", integer)
  .option("--tokens-max <value>", "Maximum total tokens", integer)
  .option(
    "--duration-ms-min <value>",
    "Minimum duration in milliseconds",
    integer,
  )
  .option(
    "--duration-ms-max <value>",
    "Maximum duration in milliseconds",
    integer,
  )
  .action(runInsights);

program
  .command("agent-sessions")
  .description("Search local coding-agent sessions")
  .option("--source <name>", "Session source; repeatable", collect)
  .option("--from <date>", "First local day, YYYY-MM-DD")
  .option("--to <date>", "Last local day, YYYY-MM-DD")
  .option("--project-dir <path>", "Limit sessions to a project")
  .option("--text <text>", "Find text in session messages")
  .option("--limit <count>", "Maximum sessions to list", integer)
  .option("--json", "Output sessions as JSON")
  .option("--export <path>", "Write an Insights snapshot")
  .action(runSessions);

program
  .command("dashboard [paths...]")
  .description(DASHBOARD_HELP)
  .option("--host <host>", "Host to bind the dashboard server to")
  .option("-p, --port <port>", "Port for the dashboard server", integer)
  .option("--no-browser", "Start the dashboard without opening a browser")
  .option("--compiler-model <model>", "Finder compiler model")
  .option("--classifier-model <model>", "Classifier model role")
  .option("--window-days <days>", "Finder search window in days", integer)
  .option("--limit <count>", "Finder trace limit", integer)
  .option("--parallelism <count>", "Finder classifier concurrency", integer)
  .action(runDashboard);

const signedInteger = (value: string): number => {
  const parsed = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError(`Invalid integer: ${value}`);
  return parsed;
};
const number = (value: string): number => {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed))
    throw new InvalidArgumentError(`Invalid number: ${value}`);
  return parsed;
};
const nonnegativeNumber = (value: string): number => {
  const parsed = number(value);
  if (parsed < 0) throw new InvalidArgumentError("Must be at least 0");
  return parsed;
};
const count = (_value: string, previous = 0): number => previous + 1;

const redteam = program
  .command("redteam")
  .description("Red teaming CLI for evaluatorq.");

redteam
  .command("run")
  .description("Run red teaming against one or more targets.")
  .option("-t, --target <target>", "Target identifier; repeatable", collect)
  .option("-n, --name <name>", "Experiment name (defaults to 'red-team')")
  .option("--mode <mode>", "Execution mode: dynamic, static or hybrid")
  .option("-c, --category <category>", "OWASP categories; repeatable", collect)
  .option("-V, --vulnerability <id>", "Vulnerability IDs; repeatable", collect)
  .option("-s, --strategy <name>", "Attack strategies; repeatable", collect)
  .option(
    "-d, --delivery-method <method>",
    "Delivery methods; repeatable",
    collect,
  )
  .option("--max-turns <count>", "Maximum conversation turns", integer)
  .option("--max-per-category <count>", "Cap strategies per category", integer)
  .option("--attack-model <model>", "Model for adversarial prompt generation")
  .option("--attacker-instructions <text>", "Domain context to steer attacks")
  .option("--evaluator-model <model>", "Model for OWASP evaluation scoring")
  .option(
    "--min-evaluation-coverage <fraction>",
    "Required verdict coverage",
    number,
  )
  .option("--target-timeout-ms <ms>", "Per-call target timeout", integer)
  .option("--max-target-retries <count>", "Target transport retries", integer)
  .option(
    "--max-backtracks <count>",
    "Crescendo backtracks per attack",
    integer,
  )
  .option("--retry-count <count>", "Retries for pipeline LLM calls", integer)
  .option(
    "--max-tool-continuations <count>",
    "Tool continuation rounds",
    integer,
  )
  .option("--target-reasoning-effort <effort>", "Target reasoning effort")
  .option("--datapoint-parallelism <count>", "Concurrent datapoints", integer)
  .option(
    "--parallelism <count>",
    "Deprecated alias of --datapoint-parallelism",
    integer,
  )
  .option(
    "--llm-parallelism <count>",
    "In-flight LLM request ceiling, -1 for none",
    signedInteger,
  )
  .option(
    "--generated-strategy-count <count>",
    "Strategies to generate per category",
    integer,
  )
  .option("--generate-strategies", "Enable LLM strategy generation")
  .option("--no-generate-strategies", "Disable LLM strategy generation")
  .option("--max-dynamic-datapoints <count>", "Cap dynamic datapoints", integer)
  .option("--max-static-datapoints <count>", "Cap static datapoints", integer)
  .option("--cleanup-memory", "Clean up memory entities after dynamic runs")
  .option("--no-cleanup-memory", "Keep memory entities after dynamic runs")
  .option(
    "--dataset <source>",
    'Local path, "hf:org/repo" or "hf:org/repo/file.json"',
  )
  .option(
    "--from-run <run>",
    'Replay a previous run: file name, run id, path or "latest"',
  )
  .option("--artifacts-dir <path>", "Directory for saved JSON files")
  .option("--save <mode>", "What to persist: none, final or detail")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("-v, --verbose", "Increase verbosity; repeatable", count)
  .option("-q, --quiet", "Suppress progress and non-error output")
  .option("--report <path>", "Path to write the report JSON")
  .option("--report-md <dir>", "Directory for a Markdown report")
  .option("--report-html <dir>", "Directory for an HTML report")
  .option("--executive-summary", "Generate an executive summary")
  .option("--no-executive-summary", "Skip the executive summary")
  .option("--recommendations", "Generate remediation recommendations")
  .option("--no-recommendations", "Skip remediation recommendations")
  .option("--system-prompt <prompt>", "System prompt for the target")
  .option("--config <source>", "Inline JSON, a JSON file path, or - for stdin")
  .option("--llm-config <json>", "LLMConfig as a JSON object")
  .option("--json", "Print the report as JSON on stdout")
  .action(runRedteam);

redteam
  .command("schema")
  .description(
    "Print the JSON schema of `redteam run`'s config or of its JSON report.",
  )
  .option("--input", "The shape --config accepts (default)")
  .option("--output", "The report --json prints")
  .action(runRedteamSchema);

redteam
  .command("validate-dataset [dataset]")
  .description("Validate the shape of a red team dataset.")
  .action(runRedteamValidateDataset);

redteam
  .command("runs [path]")
  .description("List previous red team runs saved locally.")
  .option("-n, --limit <count>", "Maximum number of runs to show", integer)
  .option("--json", "Emit runs as a JSON array on stdout")
  .action(runRedteamRuns);

const sim = program.command("sim").description("Agent simulation pipeline.");

sim
  .command("schema")
  .description(
    "Print the JSON schema of `sim simulate` / `sim run`'s config or of their JSON result.",
  )
  .option("--input", "The shape --config accepts (default)")
  .option("--output", "The SimulationRun that --json prints")
  .option("--command <command>", "simulate or run", "simulate")
  .action(runSimSchema);

sim
  .command("validate [path]")
  .description("Validate a simulation datapoints JSONL file before running it.")
  .option("-i, --input <path>", "Path to datapoints JSONL file to validate")
  .action(runSimValidate);

sim
  .command("validate-dataset <path>")
  .description("Deprecated alias for `validate`.")
  .action(runSimValidateDataset);

sim
  .command("runs [directory]")
  .description("List recent simulation runs.")
  .option("-n, --limit <count>", "Maximum number of runs to show", integer)
  .option("--json", "Emit runs as a JSON array on stdout")
  .option("-f, --full", "Render the full table without truncating columns")
  .action(runSimRuns);

function simSharedOptions(command: Command): Command {
  return command
    .option(
      "--target <target>",
      "agent:<key> (default for a bare key) or deployment:<key>",
    )
    .option("--memory-entity <id>", "Memory entity id for an agent target")
    .option("--vercel-url <url>", "Vercel AI SDK endpoint URL")
    .option("--openai-model <model>", "OpenAI-compatible model as the target")
    .option("-r, --results <path>", "Path to write results JSONL")
    .option("--report <path>", "Write the JSON report to a file or directory")
    .option(
      "--report-md <path>",
      "Write a Markdown report to a file or directory",
    )
    .option(
      "--report-html <path>",
      "Write an HTML report to a file or directory",
    )
    .option("-n, --name <name>", "Run name")
    .option("--sim-model <model>", "Model for simulation-side LLM calls")
    .option("--max-turns <count>", "Maximum conversation turns", integer)
    .option(
      "--datapoint-parallelism <count>",
      "Concurrent simulations",
      integer,
    )
    .option(
      "--parallelism <count>",
      "Alias for --datapoint-parallelism",
      integer,
    )
    .option(
      "--llm-parallelism <count>",
      "Ceiling on in-flight LLM requests, -1 for no limit",
      signedInteger,
    )
    .option(
      "--target-reasoning-effort <effort>",
      "Reasoning effort for the target",
    )
    .option("--evaluator <name>", "Evaluator name; repeatable", collect)
    .option("--save", "Write the run to .evaluatorq/sim-runs/")
    .option("--no-save", "Skip writing the run")
    .option("--recommendations", "Generate remediation suggestions")
    .option("--no-recommendations", "Skip remediation suggestions")
    .option("--executive-summary", "Generate an executive summary")
    .option("--no-executive-summary", "Skip the executive summary")
    .option(
      "--config <source>",
      "Config as inline JSON, a path, or - for stdin",
    )
    .option("--llm-config <json>", "LLMCallConfig as JSON")
    .option("--json", "Emit the SimulationRun as JSON on stdout")
    .option("-q, --quiet", "Suppress non-error output")
    .option("-v, --verbose", "Increase verbosity; repeatable", count)
    .option("-y, --yes", "Skip interactive confirmation prompt");
}

simSharedOptions(
  sim
    .command("simulate")
    .description(
      "Run simulations from a datapoints file, an Orq dataset, experiment, or previous run.",
    )
    .option("-i, --input <path>", "Datapoints JSONL file")
    .option("--dataset-id <id>", "Orq dataset id")
    .option("--experiment-id <id>", "Orq experiment id")
    .option("--experiment-run-id <id>", "Run of --experiment-id")
    .option("--from-run <ref>", "Replay a saved run"),
).action(runSimSimulate);

simSharedOptions(
  sim
    .command("run")
    .description("Generate personas and scenarios, then run simulations.")
    .option("--agent-description <text>", "Description of the agent under test")
    .option("--num-personas <count>", "Personas to generate", positiveInteger)
    .option("--num-scenarios <count>", "Scenarios to generate", positiveInteger)
    .option("--persona-seed <seed>", "Persona seed; repeatable", collect)
    .option("--scenario-seed <seed>", "Scenario seed; repeatable", collect)
    .option("--generation-instructions <text>", "Extra generation instructions")
    .option("-d, --datapoints <path>", "Save the generated datapoints"),
).action(runSimRun);

sim
  .command("generate")
  .description("Generate simulation datapoints from an agent description.")
  .requiredOption(
    "-d, --datapoints <path>",
    "Path to write the generated datapoints JSONL",
  )
  .option("--agent-description <text>", "Description of the agent under test")
  .option("--target <target>", "Agent target used to fetch the description")
  .option("--sim-model <model>", "Model for generation")
  .option("--num-personas <count>", "Personas to generate", positiveInteger)
  .option("--num-scenarios <count>", "Scenarios to generate", positiveInteger)
  .option("--persona-seed <seed>", "Persona seed; repeatable", collect)
  .option("--scenario-seed <seed>", "Scenario seed; repeatable", collect)
  .option("--generation-instructions <text>", "Extra generation instructions")
  .option("--dataset-format", "Write the Orq dataset-row envelope")
  .option("-q, --quiet", "Suppress non-error output")
  .option("-v, --verbose", "Increase verbosity; repeatable", count)
  .action(runSimGenerate);

sim
  .command("from-traces")
  .description("Build simulation datapoints from Orq production traces.")
  .requiredOption(
    "-o, --output <path>",
    "Path to write the generated datapoints JSONL",
  )
  .option(
    "--limit <count>",
    "Maximum number of traces to fetch",
    positiveInteger,
  )
  .option(
    "--lookback-hours <hours>",
    "Only traces from the last N hours",
    nonnegativeNumber,
  )
  .option("--search <text>", "Free-text search applied to the trace list")
  .option("--extend <count>", "Extra distribution-matched datapoints", integer)
  .option("--agent-description <text>", "Description used by --extend")
  .option("--sim-model <model>", "Model for summaries and generation")
  .option("--replay-first-message", "Reuse the recorded first message")
  .option("--generate-first-message", "Write a new first message (default)")
  .option("--redact-pii", "Redact PII before summarizing (default)")
  .option("--no-redact-pii", "Keep PII in summaries")
  .option(
    "--max-summaries <count>",
    "Summaries in the traffic profile",
    positiveInteger,
  )
  .option(
    "--llm-parallelism <count>",
    "Ceiling on in-flight LLM requests, -1 for no limit",
    signedInteger,
  )
  .option("-q, --quiet", "Suppress non-error output")
  .option("-v, --verbose", "Increase verbosity; repeatable", count)
  .action((options) =>
    runSimFromTraces({
      ...options,
      replayFirstMessage: options.generateFirstMessage
        ? false
        : options.replayFirstMessage,
    }),
  );

sim
  .command("export")
  .description(
    "Export simulation results: OpenResponses payload JSON, or an HTML/Markdown report.",
  )
  .requiredOption(
    "-i, --input <path>",
    "Results JSONL file or a SimulationRun report JSON",
  )
  .requiredOption("-o, --output <path>", "Path to write the exported file")
  .option("--format <format>", "openresponses, md or html", "openresponses")
  .option(
    "--recommendations",
    "For md/html: generate remediation suggestions when none are stored",
  )
  .option("--sim-model <model>", "Model for --recommendations generation")
  .option("--target-label <label>", "Target name shown in md/html headers")
  .action((options) => runSimExport(options));

sim
  .command("upload-dataset")
  .description(
    "Convert a simulation datapoints JSONL into an Orq dataset and upload it.",
  )
  .requiredOption("-i, --input <path>", "Datapoints JSONL to upload")
  .option("-n, --name <name>", "Display name for a new dataset")
  .option("--path <path>", "Orq folder path for a new dataset", "Default")
  .option("--dataset-id <id>", "Append to this existing dataset")
  .action((options) => runSimUploadDataset(options));

program.parse(process.argv);
