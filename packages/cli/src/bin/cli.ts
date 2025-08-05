#!/usr/bin/env node

import { Command } from "commander";

import { evaluate } from "../commands/evaluate.js";

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

program.parse(process.argv);
