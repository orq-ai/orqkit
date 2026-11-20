import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { writePrivateAtomic } from "../common/private-files.js";
import {
  camelToSnake,
  isPlain,
  pythonJsonDumps,
  toPythonKeys,
} from "../common/python-json.js";
import { REPLAY_VERSION, REPLAY_VERSION_KEY } from "../common/replay.js";
import { getStoreDir } from "../common/run-store-dir.js";
import type { SaveMode } from "./contracts.js";
import { DATAPOINTS_KEY, RUN_CONFIG_KEY } from "./replay.js";
import type { RedTeamReport } from "./reports/models.js";

export const getRedteamRunsDir = (): string => getStoreDir("runs");
export function pythonDatapointInputs(inputs: unknown): unknown {
  if (!isPlain(inputs)) return inputs;
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [
      camelToSnake(key),
      key === "strategy" && isPlain(value)
        ? toPythonKeys(value, "AttackStrategy")
        : value,
    ]),
  );
}
function pythonStageData(filename: string, data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  if (filename.startsWith("01_")) return data.map(pythonDatapointInputs);
  return (toPythonKeys(data, "DataPointResult") as unknown[]).map((row) =>
    isPlain(row) && isPlain(row.dataPoint)
      ? {
          ...row,
          dataPoint: {
            ...row.dataPoint,
            inputs: pythonDatapointInputs(row.dataPoint.inputs),
          },
        }
      : row,
  );
}
/** datetime.now(timezone.utc).isoformat(): microseconds and "+00:00". */
const pythonUtcNow = (): string =>
  new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
export const pythonReport = (report: RedTeamReport): Record<string, unknown> =>
  toPythonKeys(report.toJSON(), "RedTeamReport") as Record<string, unknown>;
export async function saveRedteamStage(
  outputDir: string | null,
  filename: string,
  data: unknown,
): Promise<void> {
  if (outputDir == null) return;
  await writePrivateAtomic(
    join(outputDir, filename),
    pythonJsonDumps({
      saved_at: pythonUtcNow(),
      data: pythonStageData(filename, data),
    }),
    { privateDirectory: false },
  );
}
export async function saveRedteamReport(
  outputDir: string | null,
  filename: string,
  report: RedTeamReport,
): Promise<void> {
  if (outputDir == null) return;
  await writePrivateAtomic(
    join(outputDir, filename),
    pythonJsonDumps({ ...pythonReport(report), saved_at: pythonUtcNow() }),
    { privateDirectory: false },
  );
}
export interface ReplayRunConfig {
  maxTurns: number;
  attackerInstructions: string | null;
  maxBacktracks: number;
}
export async function autoSaveRedteamRun(
  report: RedTeamReport,
  options: {
    name?: string | null;
    datapoints?: Record<string, unknown>[] | null;
    runConfig?: ReplayRunConfig | null;
    runsDir?: string;
  } = {},
): Promise<string | null> {
  try {
    const directory = options.runsDir ?? getRedteamRunsDir();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name =
      (options.name || "red-team")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/^-+|-+$/g, "") || "red-team";
    const timestamp = report.createdAt
      .slice(0, 19)
      .replaceAll("-", "")
      .replaceAll(":", "")
      .replace("T", "_");
    const payload: Record<string, unknown> = {
      ...pythonReport(report),
      run_name: name,
      saved_at: pythonUtcNow(),
    };
    if (options.datapoints?.length) {
      payload[DATAPOINTS_KEY] = options.datapoints.map(pythonDatapointInputs);
      payload[RUN_CONFIG_KEY] = Object.fromEntries(
        Object.entries(options.runConfig ?? {}).map(([key, value]) => [
          camelToSnake(key),
          value,
        ]),
      );
      payload[REPLAY_VERSION_KEY] = REPLAY_VERSION;
    }
    const text = pythonJsonDumps(payload);
    for (let index = 0; index < 1000; index++) {
      const path = join(
        directory,
        `${name}_${timestamp}${index ? `_${String(index).padStart(3, "0")}` : ""}.json`,
      );
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(path, "wx", 0o600);
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") continue;
        throw error;
      }
      try {
        await file.writeFile(text, "utf8");
        await file.close();
        return path;
      } catch (error) {
        await file.close().catch(() => {});
        await rm(path, { force: true }).catch(() => {});
        throw error;
      }
    }
    throw new Error(
      `Could not find a free run-store filename for '${name}' after 1000 attempts`,
    );
  } catch (error) {
    console.warn("Failed to auto-save run report", error);
    return null;
  }
}
export async function persistAndIndexRedteamRun(options: {
  report: RedTeamReport;
  save: SaveMode;
  userOutputDir: string | null;
  pipelineOutputDir: string | null;
  name?: string | null;
  datapointInputs: Record<string, unknown>[];
  runConfig: ReplayRunConfig;
  runsDir?: string;
}): Promise<{ autoSavePath: string | null; runPath: string | null }> {
  const { report, save } = options;
  let autoSavePath: string | null = null,
    runPath: string | null = null;
  if (save !== "none") {
    const directory =
      save === "detail" ? options.pipelineOutputDir : options.userOutputDir;
    if (directory != null) {
      await saveRedteamReport(directory, "03_summary_report.json", report);
      autoSavePath = join(directory, "03_summary_report.json");
    }
    runPath = await autoSaveRedteamRun(report, {
      name: options.name,
      datapoints: options.datapointInputs,
      runConfig: options.runConfig,
      runsDir: options.runsDir,
    });
    autoSavePath ??= runPath;
    if (runPath == null)
      report.pipelineWarnings.push(
        "Failed to auto-save run report. The run will not appear in `evaluatorq redteam runs`.",
      );
  }
  return { autoSavePath, runPath };
}
