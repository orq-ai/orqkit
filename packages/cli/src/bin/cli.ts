#!/usr/bin/env node

import { Command } from "commander";

import { evaluate } from "../commands/evaluate.js";
import { find } from "../commands/find.js";
import { runInsights } from "../commands/insights.js";
import { runSessions } from "../commands/sessions.js";

const program = new Command();

program
  .name("orq")
  .description("CLI for running evaluatorq evaluation files")
  .version("0.0.1");

program
  .command("evaluate <pattern>")
  .description("Run evaluation files matching the glob pattern")
  // .option("-w, --watch", "Watch for file changes", false)
  .action(evaluate);

const integer = (value: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid integer: ${value}`);
  return Number(value);
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

program.parse(process.argv);
