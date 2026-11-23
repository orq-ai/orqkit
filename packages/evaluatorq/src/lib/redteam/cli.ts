import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  BadParameter,
  type ConfigModel,
  echoJson,
  type Flag,
  flag,
  jsonFlag,
  resolveConfig,
  shellPath,
} from "../common/cli-config.js";
import {
  type CliConfirmationIO,
  confirmCliRun,
} from "../common/cli-confirm.js";
import { manifestCardId, reportId } from "../common/dashboard/library.js";
import { envRaw } from "../common/env-config.js";
import { PYTHON_CLI_SCHEMAS } from "../common/python-cli-schemas.js";
import { pythonJsonDumps } from "../common/python-json.js";
import { ReplayError } from "../common/replay.js";
import { pct } from "../common/reports/html-helpers.js";
import { pyPercent } from "../common/reports/number-format.js";
import { listRunRecords } from "../common/run-manifest.js";
import type { RunManifest } from "../contracts.js";
import { knownStrategyNames } from "./adaptive/strategy-registry.js";
import { LLMConfig } from "./config.js";
import { Vulnerability } from "./contracts.js";
import {
  deliveryMethodStr,
  isKnownDeliveryMethod,
  listAvailableDeliveryMethods,
  resolveDeliveryMethods,
} from "./delivery-method-registry.js";
import { CancelledError, RedTeamError } from "./exceptions.js";
import {
  DEFAULT_HF_FILENAME,
  DEFAULT_HF_REPO,
  parseHfSource,
} from "./frameworks/owasp/evaluatorq-bridge.js";
import { DefaultHooks } from "./hooks.js";
import { RedTeamSampleSchema } from "./input.js";
import type { RedTeamReport } from "./reports/models.js";
import { RedTeamCliConfig } from "./run-config.js";
import { getRedteamRunsDir, pythonReport } from "./run-store.js";
import type { redTeam } from "./runner.js";
import { CATEGORY_TO_VULNERABILITY } from "./vulnerability-registry.js";

export interface RedteamIO extends CliConfirmationIO {
  print: (line: string) => void;
  printError: (line: string) => void;
  redTeam?: typeof redTeam;
  readStdin?: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const REPLAY_FIELDS = [
  "mode",
  "dataset",
  "categories",
  "vulnerabilities",
  "strategies",
  "datapoints",
  "attack_techniques",
  "delivery_methods",
  "max_per_category",
  "max_dynamic_datapoints",
  "max_static_datapoints",
] as const;

export const REDTEAM_CONFIG_MODEL: ConfigModel<RedTeamCliConfig> = {
  name: "RedTeamCliConfig",
  build: (data) => new RedTeamCliConfig(data as never),
};

const LLM_CONFIG_MODEL: ConfigModel<LLMConfig> = {
  name: "LLMConfig",
  build: (data) => new LLMConfig(data as never),
};

export const REDTEAM_RUN_FLAGS: readonly Flag[] = [
  flag("target"),
  flag("name"),
  flag("mode"),
  flag("categories"),
  flag("vulnerabilities"),
  flag("strategies"),
  flag("delivery_methods"),
  flag("max_turns"),
  flag("max_per_category"),
  flag("attacker_instructions"),
  flag("datapoint_parallelism", { replaces: ["parallelism"] }),
  flag("llm_parallelism"),
  flag("generate_strategies"),
  flag("generated_strategy_count"),
  flag("max_dynamic_datapoints"),
  flag("max_static_datapoints"),
  flag("cleanup_memory"),
  flag("dataset", { replaces: ["datapoints", "previous_run"] }),
  flag("from_run", { path: "previous_run", replaces: REPLAY_FIELDS }),
  flag("artifacts_dir"),
  flag("save"),
  flag("executive_summary", { path: "generate_executive_summary" }),
  flag("recommendations"),
  flag("system_prompt", { path: "target_config.system_prompt" }),
  jsonFlag("llm_config_json", "llm_config", LLM_CONFIG_MODEL, {
    flag: "--llm-config",
  }),
  flag("attack_model", { path: "llm_config.attacker.model" }),
  flag("evaluator_model", { path: "llm_config.evaluator.model" }),
  flag("min_evaluation_coverage", {
    path: "llm_config.evaluator.min_evaluation_coverage",
  }),
  flag("target_timeout_ms", { path: "llm_config.target_agent_timeout_ms" }),
  flag("max_target_retries", { path: "llm_config.max_target_retries" }),
  flag("max_backtracks", { path: "llm_config.max_backtracks" }),
  flag("retry_count", { path: "llm_config.retry_count" }),
  flag("max_tool_continuations", {
    path: "llm_config.max_tool_continuations",
  }),
  flag("target_reasoning_effort", {
    path: "llm_config.target_reasoning_effort",
  }),
  flag("verbose", {
    path: "verbosity",
    toValue: ((count: number) => count + 1) as never,
  }),
  flag("quiet", { path: "verbosity", toValue: (() => 0) as never }),
];

export interface RedteamRunArguments {
  target?: string[];
  name?: string;
  mode?: string;
  categories?: string[];
  vulnerabilities?: string[];
  strategies?: string[];
  delivery_methods?: string[];
  max_turns?: number;
  max_per_category?: number;
  attack_model?: string;
  attacker_instructions?: string;
  evaluator_model?: string;
  min_evaluation_coverage?: number;
  target_timeout_ms?: number;
  max_target_retries?: number;
  max_backtracks?: number;
  retry_count?: number;
  max_tool_continuations?: number;
  target_reasoning_effort?: string;
  datapoint_parallelism?: number;
  llm_parallelism?: number;
  generated_strategy_count?: number;
  generate_strategies?: boolean;
  max_dynamic_datapoints?: number;
  max_static_datapoints?: number;
  cleanup_memory?: boolean;
  dataset?: string;
  from_run?: string;
  artifacts_dir?: string;
  save?: string;
  yes?: boolean;
  verbose?: number;
  quiet?: boolean;
  report?: string;
  report_md?: string;
  report_html?: string;
  executive_summary?: boolean;
  recommendations?: boolean;
  system_prompt?: string;
  config?: string;
  llm_config_json?: string;
  json?: boolean;
}

const pyStr = (value: string): string =>
  value.includes("'") && !value.includes('"')
    ? `"${value}"`
    : `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const pyList = (values: readonly string[]): string =>
  `[${values.map(pyStr).join(", ")}]`;
const pySorted = (values: Iterable<string>): string[] =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function splitCsv(values: readonly string[] | null | undefined) {
  if (values == null) return null;
  const tokens = values.flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return tokens.length ? tokens : null;
}

function safeTarget(target: string): string {
  return target
    .replace(/[/:|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function generateReportFilename(
  target: string,
  timestamp: string,
  ext: string,
): string {
  return `redteam-report-${safeTarget(target)}-${timestamp}${ext}`;
}

export function generateMdFilename(target: string, timestamp: string): string {
  return generateReportFilename(target, timestamp, ".md");
}

export function reportTimestamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}`;
}

async function writeReportFile(
  report: RedTeamReport,
  outputDir: string,
  target: string,
  ext: ".md" | ".html",
  now: Date,
  label: string,
): Promise<string> {
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    throw new CliExit(
      1,
      `Error: failed to create report directory ${outputDir}: ${String(error)}`,
    );
  }
  const path = join(
    outputDir,
    generateReportFilename(target, reportTimestamp(now), ext),
  );
  const content =
    ext === ".md"
      ? await (await import("./reports/export-md.js")).exportRedteamMarkdown(
          report,
        )
      : await (await import("./reports/export-html.js")).exportRedteamHtml(
          report,
        );
  try {
    writeFileSync(path, content, "utf8");
  } catch (error) {
    throw new CliExit(
      1,
      `Error: failed to write ${label} report to ${path}: ${String(error)}`,
    );
  }
  return path;
}

export function writeMarkdownReport(
  report: RedTeamReport,
  outputDir: string,
  target: string,
  now: Date = new Date(),
): Promise<string> {
  return writeReportFile(report, outputDir, target, ".md", now, "Markdown");
}

export function writeHtmlReport(
  report: RedTeamReport,
  outputDir: string,
  target: string,
  now: Date = new Date(),
): Promise<string> {
  return writeReportFile(report, outputDir, target, ".html", now, "HTML");
}

class CliExit extends Error {
  constructor(
    readonly code: number,
    readonly errorLine: string | null = null,
  ) {
    super(errorLine ?? `exit ${code}`);
  }
}

export const GENERIC_EVAL_HINT =
  "Check evaluator model configuration, credentials, and any gateway guardrails that may be " +
  "rejecting judge or target calls.";

export function evaluationErrorHint(report: RedTeamReport): string {
  const causes: [string, string][] = [];
  for (const result of report.results) {
    const evaluation = result.evaluationError as {
      code?: string | null;
      errorType?: string | null;
      message?: string | null;
    } | null;
    if (evaluation != null)
      causes.push([
        `evaluation/${evaluation.code || evaluation.errorType || "unknown"}`,
        evaluation.message || "",
      ]);
    else if (result.vulnerable == null && result.error)
      causes.push([
        `execution/${result.errorCode || result.errorType || "unknown"}`,
        result.error,
      ]);
  }
  if (!causes.length) return GENERIC_EVAL_HINT;
  const counts = new Map<string, number>();
  for (const [code] of causes) counts.set(code, (counts.get(code) ?? 0) + 1);
  let topCode = "",
    topN = 0;
  for (const [code, n] of counts)
    if (n > topN) {
      topCode = code;
      topN = n;
    }
  const sample = causes.find(([code]) => code === topCode)?.[1] ?? "";
  const detail = sample ? `: ${[...sample].slice(0, 200).join("")}` : "";
  return `Dominant failure: ${topCode} (${topN}/${causes.length} unscored attacks)${detail}. ${GENERIC_EVAL_HINT}`;
}

export function normaliseRunConfig(
  cfg: RedTeamCliConfig,
  printError: (line: string) => void,
): RedTeamCliConfig {
  if (!cfg.target || (Array.isArray(cfg.target) && !cfg.target.length))
    throw new BadParameter(
      'provide --target, or set "target" in --config.',
      "'--target'",
    );
  const target =
    Array.isArray(cfg.target) && cfg.target.length === 1
      ? (cfg.target[0] as string)
      : cfg.target;
  const strategies = splitCsv(cfg.strategies);
  const deliveryTokens = splitCsv(
    cfg.deliveryMethods?.length
      ? cfg.deliveryMethods.map(deliveryMethodStr)
      : null,
  );
  const categories = splitCsv(cfg.categories);
  const vulnerabilities = splitCsv(cfg.vulnerabilities);
  if (vulnerabilities) {
    const valid = new Set<string>([
      ...Object.values(Vulnerability),
      ...Object.keys(CATEGORY_TO_VULNERABILITY),
    ]);
    for (const value of vulnerabilities)
      if (!valid.has(value))
        throw new BadParameter(
          `Unknown vulnerability ID: ${pyStr(value)}. Valid IDs: ${pyList(pySorted(Object.values(Vulnerability)))}`,
        );
  }
  if (strategies) {
    const known = knownStrategyNames();
    const unknown = strategies.filter(
      (name) => !known.has(name) && !name.startsWith("generated_"),
    );
    if (unknown.length)
      throw new BadParameter(
        `Unknown strategy name(s): ${pyList(unknown)}. Valid names: ${pyList(pySorted(known))} (or a 'generated_*' name from a prior run).`,
      );
  }
  let deliveryMethods: string[] | null = null;
  if (deliveryTokens) {
    const unknown = deliveryTokens.filter(
      (value) => !isKnownDeliveryMethod(value),
    );
    if (unknown.length)
      printError(
        `Warning: delivery method(s) ${pyList(unknown)} are not known delivery methods ${pyList(pySorted(listAvailableDeliveryMethods().map(deliveryMethodStr)))}; ` +
          "filtering by them literally (they will only match a dataset row spelled exactly the same).",
      );
    deliveryMethods =
      resolveDeliveryMethods(deliveryTokens).map(deliveryMethodStr);
  }
  Object.assign(cfg, {
    target,
    strategies,
    deliveryMethods,
    categories,
    vulnerabilities,
  });
  return cfg;
}

function runOptions(cfg: RedTeamCliConfig) {
  const { target: _target, fieldsSet: _fields, ...rest } = cfg;
  return rest;
}

function cliArgs(args: RedteamRunArguments): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...args };
  if (args.verbose === 0) raw.verbose = undefined;
  if (args.quiet === false) raw.quiet = undefined;
  return raw;
}

export async function executeRedteamRun(
  args: RedteamRunArguments,
  io: RedteamIO,
): Promise<number> {
  const out = args.json ? io.printError : io.print;
  try {
    let cfg = resolveConfig(
      REDTEAM_CONFIG_MODEL,
      REDTEAM_RUN_FLAGS,
      cliArgs(args),
      {
        configSource: args.config,
        readStdin: io.readStdin,
      },
    );
    cfg = normaliseRunConfig(cfg, io.printError);
    const targets = Array.isArray(cfg.target)
      ? cfg.target.join(", ")
      : (cfg.target as string);
    const run = io.redTeam ?? (await import("./runner.js")).redTeam;
    let report: RedTeamReport;
    try {
      report = await run(
        cfg.target as string | string[],
        {
          ...runOptions(cfg),
          hooks: new DefaultHooks(args.quiet ? () => {} : out, () =>
            confirmCliRun(args.yes, io),
          ),
        } as never,
      );
    } catch (error) {
      if (error instanceof CancelledError) {
        out("Run cancelled.");
        return 0;
      }
      if (process.env.EQ_DEBUG) throw error;
      if (
        error instanceof RedTeamError ||
        error instanceof ReplayError ||
        error instanceof RangeError ||
        error instanceof TypeError ||
        (error instanceof Error && error.name === "ZodError")
      ) {
        io.printError(`Error: ${error.message}`);
        return 1;
      }
      throw error;
    }
    const now = (io.now ?? (() => new Date()))();
    if (args.report) {
      mkdirSync(dirname(args.report), { recursive: true });
      writeFileSync(args.report, pythonJsonDumps(pythonReport(report)), "utf8");
      out(`Report saved to ${args.report}`);
    }
    if (args.report_md) {
      const path = await writeMarkdownReport(
        report,
        args.report_md,
        targets,
        now,
      );
      out(`Markdown report written to ${path}`);
    }
    if (args.report_html) {
      const path = await writeHtmlReport(
        report,
        args.report_html,
        targets,
        now,
      );
      out(`HTML report written to ${path}`);
    }
    if (args.json) io.print(JSON.stringify(pythonReport(report), null, 2));
    const summary = report.summary;
    if (summary.noVerdict) {
      io.printError(
        `Error: 0/${summary.totalAttacks} attacks could be evaluated \u2014 the target was ` +
          `not tested. ${evaluationErrorHint(report)}`,
      );
      return 1;
    }
    if (summary.coverageBelowMinimum) {
      io.printError(
        `Error: only ${summary.evaluatedAttacks}/${summary.totalAttacks} attacks could be ` +
          `evaluated (${pct(summary.evaluationCoverage)}), below the configured minimum of ` +
          `${pct(summary.minEvaluationCoverage)}. The reported rates cover that subset only. ` +
          evaluationErrorHint(report),
      );
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof CliExit) {
      if (error.errorLine) io.printError(error.errorLine);
      return error.code;
    }
    if (error instanceof BadParameter) {
      io.printError(error.render());
      return 2;
    }
    throw error;
  }
}

export function executeRedteamSchema(
  args: { output?: boolean },
  io: Pick<RedteamIO, "print">,
): number {
  echoJson(
    PYTHON_CLI_SCHEMAS[args.output ? "RedTeamReport" : "RedTeamCliConfig"],
    io.print,
  );
  return 0;
}

const HF_INSTALL_HINT =
  "Check your network connection, that the repository exists, and your " +
  "access (set HF_TOKEN for gated/private datasets).";

async function downloadHfDataset(
  repo: string,
  filename: string,
  io: RedteamIO,
): Promise<unknown> {
  io.print(`Downloading from HuggingFace: ${repo}/${filename}`);
  const url = `https://huggingface.co/datasets/${repo.split("/").map(encodeURIComponent).join("/")}/resolve/main/${filename.split("/").map(encodeURIComponent).join("/")}`;
  const token = envRaw("HF_TOKEN");
  let text: string;
  try {
    const response = await (io.fetch ?? globalThis.fetch)(url, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    throw new CliExit(
      1,
      `Failed to download dataset from HuggingFace (${repo}/${filename}): ${error instanceof Error ? error.message : String(error)}. ${HF_INSTALL_HINT}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliExit(
      1,
      `Failed to read dataset file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadRawDataset(
  dataset: string | undefined,
  io: RedteamIO,
): Promise<unknown> {
  if (dataset === undefined)
    return downloadHfDataset(DEFAULT_HF_REPO, DEFAULT_HF_FILENAME, io);
  if (dataset.startsWith("hf:")) {
    let source: ReturnType<typeof parseHfSource>;
    try {
      source = parseHfSource(dataset.slice(3));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new BadParameter(error.message);
    }
    const [repo, filename] = source;
    return downloadHfDataset(repo, filename, io);
  }
  io.print(`Validating local file: ${dataset}`);
  return JSON.parse(readFileSync(dataset, "utf8"));
}

export function collectSampleErrors(samples: readonly unknown[]): string[] {
  const errors: string[] = [];
  samples.forEach((sample, index) => {
    const parsed = RedTeamSampleSchema.safeParse(sample);
    if (parsed.success) return;
    for (const issue of parsed.error.issues)
      errors.push(
        `  sample[${index}].${issue.path.map(String).join(" -> ")}: ${issue.message}`,
      );
  });
  return errors;
}

export async function executeRedteamValidateDataset(
  args: { dataset?: string },
  io: RedteamIO,
): Promise<number> {
  try {
    const raw = await loadRawDataset(args.dataset, io);
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !("samples" in raw) ||
      !Array.isArray(raw.samples)
    ) {
      io.printError("FAIL: Expected top-level object with 'samples' key.");
      return 1;
    }
    const samples = (raw as { samples: unknown[] }).samples;
    io.print(`Found ${samples.length} samples.`);
    const errors = collectSampleErrors(samples);
    if (errors.length) {
      io.printError(`\nFAIL: ${errors.length} validation error(s):`);
      for (const line of errors.slice(0, 20)) io.printError(line);
      if (errors.length > 20)
        io.printError(`  ... and ${errors.length - 20} more`);
      return 1;
    }
    io.print(`OK: All ${samples.length} samples are valid.`);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) {
      if (error.errorLine) io.printError(error.errorLine);
      return error.code;
    }
    throw error;
  }
}

export function pythonIsoformat(date: Date): string {
  const iso = date.toISOString();
  const millis = date.getUTCMilliseconds();
  return `${iso.slice(0, 19)}${millis ? `.${String(millis * 1000).padStart(6, "0")}` : ""}+00:00`;
}

export function pythonPathStr(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export interface RedteamRunRow {
  report_id: string;
  run_name: unknown;
  created_at: unknown;
  status: unknown;
  pipeline: unknown;
  tested_agents: unknown;
  total_attacks: unknown;
  vulnerability_rate: unknown;
  file: string | null;
  summary_version: number | null;
}

export function runRow(
  manifest: RunManifest | null,
  reportPath: string | null,
): RedteamRunRow | null {
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
      pipeline: summary.pipeline ?? null,
      tested_agents: summary.testedAgents ?? [],
      total_attacks: summary.totalAttacks ?? summary.totalResults ?? null,
      vulnerability_rate: summary.vulnerabilityRate ?? null,
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
  const summary = record.summary ?? {};
  if (summary === null || typeof summary !== "object" || Array.isArray(summary))
    return null;
  const stats = summary as Record<string, unknown>;
  const stem = basename(reportPath).replace(/\.[^.]*$/, "");
  return {
    report_id: reportId(reportPath),
    run_name: "run_name" in record ? record.run_name : stem,
    created_at: record.created_at ?? null,
    status: "completed",
    pipeline: record.pipeline ?? null,
    tested_agents: record.tested_agents ?? [],
    total_attacks:
      "total_attacks" in stats
        ? stats.total_attacks
        : (record.total_results ?? null),
    vulnerability_rate: stats.vulnerability_rate ?? null,
    file: basename(reportPath),
    summary_version: null,
  };
}

export function fmtCreated(created: unknown): string {
  return typeof created === "string" && created.length >= 16
    ? created.slice(0, 16).replace("T", " ")
    : created == null || created === ""
      ? ""
      : String(created);
}

export function fmtAsr(asr: unknown): string {
  return typeof asr === "number" ? pyPercent(asr) : "\u2014";
}

const DASH = "\u2014";

export async function executeRedteamRuns(
  args: { path?: string; limit?: number; json?: boolean },
  io: RedteamIO,
): Promise<number> {
  const runsDir =
    args.path !== undefined ? pythonPathStr(args.path) : getRedteamRunsDir();
  const limit = args.limit ?? 20;
  if (!existsSync(runsDir)) {
    if (args.json) echoJson([], io.print);
    else io.print(`No runs found (directory ${runsDir} does not exist).`);
    return 0;
  }
  const records = (await listRunRecords(runsDir)).slice(0, Math.max(limit, 0));
  if (!records.length) {
    if (args.json) echoJson([], io.print);
    else io.print(`No runs found in ${runsDir}.`);
    return 0;
  }
  const rows: RedteamRunRow[] = [];
  let skipped = 0;
  for (const { manifest, reportPath } of records) {
    const row = runRow(manifest, reportPath);
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  const warning = `Warning: ${skipped} file(s) could not be parsed and were skipped.`;
  if (args.json) {
    echoJson(rows, io.print);
    if (skipped) io.printError(warning);
    return 0;
  }
  io.print(
    `${"Name".padEnd(20)} ${"Date".padEnd(17)} ${"Status".padEnd(10)} ${"Mode".padEnd(8)} ${"Attacks".padStart(7)} ${"ASR".padStart(5)}  File`,
  );
  io.print("-".repeat(88));
  for (const row of rows) {
    const total = row.total_attacks;
    io.print(
      `${String(row.run_name).slice(0, 20).padEnd(20)} ${fmtCreated(row.created_at).padEnd(17)} ` +
        `${String(row.status || DASH).padEnd(10)} ${String(row.pipeline || DASH).padEnd(8)} ` +
        `${(total != null ? String(total) : DASH).padStart(7)} ${fmtAsr(row.vulnerability_rate).padStart(5)}  ` +
        `${row.file || DASH}`,
    );
  }
  if (skipped) io.printError(warning);
  if (rows.length) io.print(`open: eq dashboard ${shellPath(runsDir)}`);
  return 0;
}

export const REDTEAM_RUN_EXAMPLES = [
  "# dynamic run against an orq agent",
  "eq redteam run -t agent:my-agent",
  "# static + generated attacks from an OWASP dataset",
  "eq redteam run -t agent:my-agent --mode hybrid",
  "# scope to one OWASP category, machine-readable later via `eq redteam runs --json`",
  "eq redteam run -t agent:my-agent -c ASI01",
  "# replay the last run against a new agent version (same attacks, new target)",
  "eq redteam run -t agent:my-agent-v2 --from-run latest",
  "# every red_team() keyword argument from a JSON file, the report as JSON on stdout",
  "eq redteam run --config run.json --json > report.json",
];
