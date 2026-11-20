#!/usr/bin/env node

import { Command } from "commander";

import { evaluate } from "../commands/evaluate.js";
import { find } from "../commands/find.js";

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

program.parse(process.argv);
