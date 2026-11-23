import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import chalk from "chalk";

export interface PlanConsole {
  log(text: string): void;
}

type PlanRows = readonly (readonly [string, string])[];

const width = (text: string): number => Array.from(text).length;
const pad = (text: string, size: number): string =>
  text + " ".repeat(Math.max(0, size - width(text)));

export function renderPlanTable(options: {
  title: string;
  rows: PlanRows;
  parameterWidth?: number;
  output?: PlanConsole;
}): void {
  const { title, rows, parameterWidth = 18, output = console } = options;
  const left = Math.max(
    parameterWidth,
    width("Parameter"),
    ...rows.map(([name]) => width(name)),
  );
  const right = Math.max(width("Value"), ...rows.map(([, v]) => width(v)));
  const rule = (a: string, b: string, c: string) =>
    `${a}${"─".repeat(left + 2)}${b}${"─".repeat(right + 2)}${c}`;
  const total = left + right + 7;
  const indent = " ".repeat(
    Math.max(0, Math.floor((total - width(title)) / 2)),
  );
  output.log(`${indent}${title}`);
  output.log(rule("╭", "┬", "╮"));
  output.log(
    `│ ${chalk.bold(pad("Parameter", left))} │ ${chalk.bold(pad("Value", right))} │`,
  );
  output.log(rule("├", "┼", "┤"));
  for (const [name, value] of rows) {
    output.log(`│ ${pad(name, left)} │ ${chalk.cyan(pad(value, right))} │`);
  }
  output.log(rule("╰", "┴", "╯"));
}

/** Enter accepts. End of input or Ctrl-C rejects with an error named `Abort`. */
export function askConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let settled = false;
    const finish = (answer: boolean) => {
      settled = true;
      rl.close();
      resolve(answer);
    };
    rl.once("close", () => {
      if (!settled) {
        reject(Object.assign(new Error("Aborted"), { name: "Abort" }));
      }
    });
    const ask = () => {
      rl.question(`${prompt} [Y/n]: `, (raw) => {
        const value = raw.trim().toLowerCase();
        if (value === "" || value === "y" || value === "yes") {
          finish(true);
        } else if (value === "n" || value === "no") {
          finish(false);
        } else {
          process.stderr.write("Error: invalid input\n");
          ask();
        }
      });
    };
    ask();
  });
}

export async function confirmRunPlan(options: {
  title: string;
  rows: PlanRows;
  prompt: string;
  skipConfirm: boolean;
  output?: PlanConsole;
}): Promise<boolean> {
  const { title, rows, prompt, skipConfirm, output } = options;
  renderPlanTable({ title, rows, output });
  return skipConfirm ? true : askConfirm(prompt);
}

export function writeTextReport(
  directory: string,
  options: { stem: string; fmt: string; content: string },
): string {
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new Error(
      `cannot create report directory ${directory}: ${String(error)}`,
      { cause: error },
    );
  }
  const path = join(directory, `${options.stem}.${options.fmt}`);
  writeFileSync(path, options.content, "utf8");
  console.error(`Report written to ${path}`);
  return path;
}
