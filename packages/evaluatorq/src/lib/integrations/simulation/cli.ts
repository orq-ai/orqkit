import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { BadParameter, echoJson, shellPath } from "../../common/cli-config.js";
import type { CliConfirmationIO } from "../../common/cli-confirm.js";
import { manifestCardId, reportId } from "../../common/dashboard/library.js";
import { PYTHON_CLI_SCHEMAS } from "../../common/python-cli-schemas.js";
import { pyFixed } from "../../common/reports/number-format.js";
import { listRunRecords } from "../../common/run-manifest.js";
import type { RunManifest } from "../../contracts.js";
import { pythonIsoformat, pythonPathStr } from "../../redteam/cli.js";
import { DatapointSchema } from "./contract-schemas.js";
import { getSimulationRunsDir } from "./run-store.js";

export interface SimIO extends CliConfirmationIO {
  print: (line: string) => void;
  printError: (line: string) => void;
}

const DASH = "\u2014";
export const TARGET_PLACEHOLDER = "agent:<your-agent-key>";
export const TARGET_HINT = `Replace ${TARGET_PLACEHOLDER} with your agent key, e.g. agent:support-bot.`;

export function dashboardCommand(directory: string): string {
  return `eq dashboard ${shellPath(directory)}`;
}

export function simulateCommand(
  datapointsPath: string,
  target: string | null,
): string {
  return `eq sim simulate -i ${shellPath(datapointsPath)} --target ${target || TARGET_PLACEHOLDER}`;
}

export function echoNext(
  command: string,
  intent: string,
  hint: string | null,
  io: Pick<SimIO, "printError">,
): void {
  io.printError("");
  io.printError(`▸ Next \u2014 ${intent}:`);
  io.printError("");
  io.printError(`    ${command}`);
  if (hint) io.printError(`  ${hint}`);
}

export function executeSimSchema(
  args: { output?: boolean; command?: "simulate" | "run" },
  io: Pick<SimIO, "print">,
): number {
  const command = args.command ?? "simulate";
  if (command !== "simulate" && command !== "run")
    throw new BadParameter(
      `'${command}' is not one of 'simulate', 'run'.`,
      "'--command'",
    );
  const name = args.output
    ? "SimulationRun"
    : command === "simulate"
      ? "SimulateCliConfig"
      : "GenerateAndSimulateCliConfig";
  echoJson(PYTHON_CLI_SCHEMAS[name], io.print);
  return 0;
}

function validateDatapoints(path: string, io: SimIO): number {
  if (!existsSync(path)) throw new BadParameter(`File not found: ${path}`);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new BadParameter(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  let bad = 0;
  let valid = 0;
  lines.forEach((line, index) => {
    try {
      DatapointSchema.parse(JSON.parse(line));
      valid += 1;
    } catch (error) {
      io.printError(`Line ${index + 1}: ${validationMessage(error)}`);
      bad += 1;
    }
  });
  if (bad) {
    io.printError(`✗ ${bad} invalid line(s) in ${path}`);
    return 1;
  }
  io.print(`✓ ${valid} valid datapoint(s) in ${path}`);
  echoNext(simulateCommand(path, null), "run the simulation", TARGET_HINT, io);
  return 0;
}

function validationMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  )
    return (error.issues as { path: PropertyKey[]; message: string }[])
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
  return error instanceof Error ? error.message : String(error);
}

export function executeSimValidate(
  args: { input?: string; path?: string },
  io: SimIO,
): number {
  if (args.input !== undefined && args.path !== undefined)
    throw new BadParameter(
      "Provide the input path once, either as an argument or with --input.",
    );
  const selected = args.input ?? args.path;
  if (selected === undefined)
    throw new BadParameter("Provide a datapoints file with --input PATH.");
  return validateDatapoints(selected, io);
}

export function executeSimValidateDataset(
  args: { path: string },
  io: SimIO,
): number {
  return validateDatapoints(args.path, io);
}

export interface SimRunRow {
  report_id: string;
  run_name: unknown;
  created_at: unknown;
  status: unknown;
  mode: unknown;
  target_kind: unknown;
  total_results: unknown;
  scorer_averages: unknown;
  file: string | null;
  summary_version: number | null;
}

export function simRunRow(
  manifest: RunManifest | null,
  reportPath: string | null,
): SimRunRow | null {
  if (manifest !== null) {
    const summary = (manifest.summary ?? {}) as Record<string, unknown>;
    return {
      report_id:
        reportPath !== null
          ? reportId(reportPath)
          : manifestCardId(manifest.runId),
      run_name: manifest.runName,
      created_at: pythonIsoformat(manifest.startedAt),
      status: manifest.status,
      mode: summary.mode ?? null,
      target_kind: summary.targetKind ?? summary.target_kind ?? null,
      total_results: summary.totalResults ?? summary.total_results ?? null,
      scorer_averages: summary.scorerAverages ?? summary.scorer_averages ?? {},
      file: reportPath !== null ? basename(reportPath) : null,
      summary_version: manifest.summaryVersion ?? null,
    };
  }
  if (reportPath === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return null;
  const record = data as Record<string, unknown>;
  return {
    report_id: reportId(reportPath),
    run_name: record.run_name ?? null,
    created_at: record.created_at ?? null,
    status: "completed",
    mode: record.mode ?? null,
    target_kind: record.target_kind ?? null,
    total_results: record.total_results ?? null,
    scorer_averages: record.scorer_averages ?? {},
    file: basename(reportPath),
    summary_version: null,
  };
}

export function fmtSimDate(created: unknown): string {
  return typeof created === "string"
    ? created.slice(0, 19).replace("T", " ")
    : String(created || DASH);
}

export function formatScorerAverages(averages: unknown): string {
  const entries = Object.entries((averages ?? {}) as Record<string, number>);
  if (!entries.length) return DASH;
  return entries
    .map(([key, value]) => `${key}=${pyFixed(value, 2)}`)
    .join("  ");
}

export async function executeSimRuns(
  args: { directory?: string; limit?: number; json?: boolean },
  io: SimIO,
): Promise<number> {
  const runsDir =
    args.directory !== undefined
      ? pythonPathStr(args.directory)
      : getSimulationRunsDir();
  if (!existsSync(runsDir)) {
    if (args.json) echoJson([], io.print);
    else io.print(`No sim-runs directory found at ${runsDir}`);
    return 0;
  }
  const records = (await listRunRecords(runsDir)).slice(
    0,
    Math.max(args.limit ?? 20, 0),
  );
  if (!records.length) {
    if (args.json) echoJson([], io.print);
    else io.print(`No runs found in ${runsDir}`);
    return 0;
  }
  const rows: SimRunRow[] = [];
  let malformed = 0;
  for (const { manifest, reportPath } of records) {
    const row = simRunRow(manifest, reportPath);
    if (row === null) malformed += 1;
    else rows.push(row);
  }
  if (args.json) {
    echoJson(rows, io.print);
    if (malformed)
      io.printError(`Warning: ${malformed} malformed file(s) skipped.`);
    return 0;
  }
  const header = `${"Name".padEnd(20)} ${"Date".padEnd(20)} ${"Status".padEnd(10)} ${"Mode".padEnd(10)} ${"Target".padEnd(16)} ${"N".padStart(4)}  ${"Scores".padEnd(30)} File`;
  io.print(header);
  io.print("-".repeat(header.length));
  for (const row of rows) {
    const n = row.total_results != null ? String(row.total_results) : DASH;
    io.print(
      `${String(row.run_name || DASH).padEnd(20)} ${fmtSimDate(row.created_at).padEnd(20)} ` +
        `${String(row.status || DASH).padEnd(10)} ${String(row.mode || DASH).padEnd(10)} ` +
        `${String(row.target_kind || DASH).padEnd(16)} ${n.padStart(4)}  ` +
        `${formatScorerAverages(row.scorer_averages).padEnd(30)} ${row.file || DASH}`,
    );
  }
  if (malformed)
    io.printError(`Warning: ${malformed} malformed run file(s) skipped.`);
  if (rows.length) io.print(`open: ${dashboardCommand(runsDir)}`);
  return 0;
}
