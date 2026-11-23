import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { BadParameter } from "../../common/cli-config.js";
import { DEFAULT_ORQ_BASE_URL } from "../../common/env-config.js";
import { resolveLlmClient } from "../../common/llm-client.js";
import { roleModel } from "../../common/model-roles.js";
import {
  echoNext,
  type SimIO,
  TARGET_HINT,
  TARGET_PLACEHOLDER,
} from "./cli.js";
import { toOrqDatasetRows } from "./cli-generate.js";
import { loadDatapointRecords } from "./cli-run.js";
import { DatapointSchema } from "./contract-schemas.js";
import { toOpenResponses } from "./convert.js";
import { exportSimulationHtml } from "./reports/export-html.js";
import { exportSimulationMarkdown } from "./reports/export-md.js";
import { generateSimulationRecommendations } from "./reports/recommendations.js";
import {
  parseSimulationResult,
  type SimulationRecommendation,
  SimulationRun,
  type StoredSimulationResult,
} from "./run-store.js";
import type { Datapoint, SimulationResult } from "./types.js";

export interface SimExportIO extends SimIO {
  generateRecommendations?: (
    results: readonly StoredSimulationResult[],
    model: string,
  ) => Promise<SimulationRecommendation[] | null>;
}

function tryRun(content: string): SimulationRun | null {
  try {
    return new SimulationRun(JSON.parse(content));
  } catch {
    return null;
  }
}

export function loadResultsForExport(
  inputPath: string,
): [StoredSimulationResult[], SimulationRecommendation[]] {
  const content = readFileSync(inputPath, "utf8");
  if (content.trimStart().startsWith("{")) {
    const run = tryRun(content);
    if (run) return [run.results, run.recommendations ?? []];
  }
  const results: StoredSimulationResult[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error(`Malformed JSON on line ${index + 1}`);
    }
    results.push(parseSimulationResult(data));
  }
  return [results, []];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultGenerateRecommendations(
  results: readonly StoredSimulationResult[],
  model: string,
  io: SimIO,
): Promise<SimulationRecommendation[] | null> {
  let resolved: Awaited<ReturnType<typeof resolveLlmClient>>;
  try {
    resolved = await resolveLlmClient(null, { maxRetries: 0 });
  } catch (error) {
    io.printError(
      `Warning: remediation suggestion generation failed (${errorText(error)}); continuing without.`,
    );
    return null;
  }
  let recs: SimulationRecommendation[];
  try {
    recs = await generateSimulationRecommendations(
      results,
      resolved.client,
      model,
    );
  } catch (error) {
    io.printError(
      `Warning: remediation suggestion generation failed (${errorText(error)}); continuing without.`,
    );
    return null;
  }
  io.printError(
    `Generated remediation suggestions for ${recs.length} conversation(s).`,
  );
  return recs.length ? recs : null;
}

export interface SimExportArgs {
  input: string;
  output: string;
  format?: string;
  recommendations?: boolean;
  sim_model?: string;
  target_label?: string;
}

export async function executeSimExport(
  args: SimExportArgs,
  io: SimExportIO,
): Promise<void> {
  const fmt = args.format ?? "openresponses";
  const target = args.target_label ?? "agent";
  if (!existsSync(args.input))
    throw new BadParameter(`Input file not found: ${args.input}`);
  if (!["openresponses", "md", "html"].includes(fmt))
    throw new BadParameter(
      `Unknown --format '${fmt}'; use openresponses, md, or html.`,
    );
  let results: StoredSimulationResult[];
  let storedRecs: SimulationRecommendation[];
  try {
    [results, storedRecs] = loadResultsForExport(args.input);
  } catch (error) {
    throw new BadParameter(`Failed to read ${args.input}: ${errorText(error)}`);
  }

  if (fmt === "openresponses") {
    const payloads = results.map((result) =>
      toOpenResponses(result as unknown as SimulationResult),
    );
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, JSON.stringify(payloads, null, 2), "utf8");
    io.print(`Exported ${payloads.length} result(s) to ${args.output}`);
    return;
  }

  let recs: SimulationRecommendation[] | null = storedRecs.length
    ? storedRecs
    : null;
  if (args.recommendations && !recs) {
    const model =
      args.sim_model || roleModel("fast", { task: "sim.generator" });
    recs = io.generateRecommendations
      ? await io.generateRecommendations(results, model)
      : await defaultGenerateRecommendations(results, model, io);
  } else if (recs)
    io.printError(
      `Using ${recs.length} stored remediation suggestion(s) from the input run.`,
    );

  let rendered: string;
  if (fmt === "md")
    rendered = await exportSimulationMarkdown(results, {
      target,
      recommendations: recs,
    } as never);
  else {
    const savedRun = tryRun(readFileSync(args.input, "utf8"));
    if (savedRun) {
      savedRun.recommendations = recs;
      if (args.target_label !== undefined) savedRun.target = target;
      rendered = await exportSimulationHtml(savedRun);
    } else
      rendered = await exportSimulationHtml(results, {
        target,
        recommendations: recs,
      });
  }
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, rendered, "utf8");
  io.print(`Exported ${results.length} result(s) to ${args.output}`);
}

export interface SimDatasetsApi {
  create(request: {
    displayName: string;
    path?: string;
  }): Promise<{ id: string }>;
  createDatapoint(request: {
    datasetId: string;
    requestBody: Record<string, unknown>[];
  }): Promise<unknown>;
}

export interface SimUploadIO extends SimIO {
  env?: Record<string, string | undefined>;
  datasets?: (apiKey: string) => Promise<SimDatasetsApi>;
}

export interface SimUploadArgs {
  input: string;
  name?: string;
  path?: string;
  dataset_id?: string;
}

async function defaultDatasets(apiKey: string): Promise<SimDatasetsApi> {
  const { Orq } = await import("@orq-ai/node");
  const { resolveOrqHost } = await import("./defaults.js");
  return new Orq({ apiKey, serverURL: resolveOrqHost() })
    .datasets as unknown as SimDatasetsApi;
}

export async function executeSimUploadDataset(
  args: SimUploadArgs,
  io: SimUploadIO,
): Promise<void> {
  const env = io.env ?? process.env;
  if (!existsSync(args.input))
    throw new BadParameter(`File not found: ${args.input}`);
  if (args.dataset_id === undefined && !args.name)
    throw new BadParameter(
      "Provide --name to create a dataset, or --dataset-id to extend one.",
    );
  if (!env.ORQ_API_KEY)
    throw new BadParameter(
      "upload-dataset requires ORQ_API_KEY to be set in the environment.",
    );
  let datapoints: Datapoint[];
  try {
    datapoints = loadDatapointRecords(args.input).map(
      (record) => DatapointSchema.parse(record) as Datapoint,
    );
  } catch (error) {
    if (errorText(error).startsWith("No datapoints loaded"))
      throw new BadParameter(`No datapoints found in ${args.input}`);
    throw new BadParameter(`Failed to read ${args.input}: ${errorText(error)}`);
  }
  if (!datapoints.length)
    throw new BadParameter(`No datapoints found in ${args.input}`);

  const rows = toOrqDatasetRows(datapoints).map(
    ({ expected_output, ...rest }) => ({
      ...rest,
      expectedOutput: expected_output,
    }),
  );
  const datasets = await (io.datasets ?? defaultDatasets)(env.ORQ_API_KEY);
  let datasetId = args.dataset_id;
  if (datasetId === undefined) {
    const created = await datasets.create({
      displayName: args.name ?? "",
      path: args.path ?? "Default",
    });
    datasetId = created.id;
    io.printError(`Created dataset ${datasetId} ("${args.name}")`);
  }
  await datasets.createDatapoint({ datasetId, requestBody: rows });
  const base = (env.ORQ_BASE_URL || DEFAULT_ORQ_BASE_URL).replace(/\/+$/, "");
  io.print(
    `Uploaded ${rows.length} datapoint(s) -> dataset ${datasetId} (${base})`,
  );
  echoNext(
    `eq sim simulate --dataset-id ${datasetId} --target ${TARGET_PLACEHOLDER}`,
    "run the simulation on the uploaded dataset",
    TARGET_HINT,
    io,
  );
}
