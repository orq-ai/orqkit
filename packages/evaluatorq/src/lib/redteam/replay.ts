import { basename, parse } from "node:path";

import { loadRunPayload, ReplayError } from "../common/replay.js";
import type { DataPoint } from "../types.js";
import { Pipeline, PipelineSchema } from "./contracts.js";

export const DATAPOINTS_KEY = "datapoints";
export const RUN_CONFIG_KEY = "runConfig";
export interface RedTeamReplay {
  readonly datapoints: DataPoint[];
  readonly pipeline: Pipeline;
  readonly categories: string[];
  readonly runName: string;
  readonly path: string;
  readonly maxTurns: number | null;
  readonly attackerInstructions: string | null;
  readonly maxBacktracks: number | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const savedField = (
  value: Record<string, unknown>,
  key: string,
  legacy: string,
) => (Object.hasOwn(value, key) ? value[key] : value[legacy]);
export function inferReplayPipeline(
  datapoints: readonly DataPoint[],
  stored: unknown,
): Pipeline {
  const parsed = PipelineSchema.safeParse(stored),
    pipeline = parsed.success ? parsed.data : null;
  const sources = new Set(
    datapoints.map((row) =>
      savedField(row.inputs, "hybridSource", "hybrid_source"),
    ),
  );
  if (sources.has("static")) {
    const tagged = sources.size > 1 ? Pipeline.HYBRID : Pipeline.STATIC;
    return pipeline === null || pipeline === Pipeline.DYNAMIC
      ? tagged
      : pipeline;
  }
  return pipeline ?? Pipeline.DYNAMIC;
}
export async function loadRedteamReplay(
  reference: string,
  runsDir: string,
): Promise<RedTeamReplay> {
  const { payload, path } = await loadRunPayload(reference, runsDir, {
    surface: "red team",
  });
  const raw = payload[DATAPOINTS_KEY],
    filename = basename(path);
  if (!Array.isArray(raw) || !raw.length)
    throw new ReplayError(
      `${filename} records no red team datapoints, so it cannot be replayed. Replay needs the cases themselves, which only the auto-saved run in the runs directory carries, rather than a detail summary report or runs saved before replay support. Re-run the original configuration once to produce a replayable run.`,
    );
  if (
    ["run", "simulate", "generate"].includes(String(payload.mode)) ||
    raw.some((row) => record(row) && "persona" in row && "scenario" in row)
  )
    throw new ReplayError(
      `${filename} is an agent simulation run, not a red team run. Replay it with: eq sim simulate --from-run ${filename} --target <target>`,
    );
  const datapoints = raw.map((inputs, index): DataPoint => {
    if (!record(inputs))
      throw new ReplayError(
        `Previous red team run ${filename}: datapoint ${index} is not an object.`,
      );
    if (
      !("strategy" in inputs) &&
      !(Array.isArray(inputs.messages)
        ? inputs.messages.length
        : inputs.messages)
    )
      throw new ReplayError(
        `Previous red team run ${filename}: datapoint ${index} (${JSON.stringify(inputs.id ?? "unnamed")}) has neither a 'strategy' (dynamic attack) nor 'messages' (static attack), so it cannot be replayed.`,
      );
    return { inputs: { ...inputs }, expectedOutput: null };
  });
  const categories = [
    ...new Set(
      datapoints.flatMap((row) =>
        row.inputs.category ? [String(row.inputs.category)] : [],
      ),
    ),
  ];
  const storedConfig = savedField(payload, RUN_CONFIG_KEY, "run_config"),
    config = record(storedConfig) ? storedConfig : {};
  const maxTurns = savedField(config, "maxTurns", "max_turns"),
    instructions = savedField(
      config,
      "attackerInstructions",
      "attacker_instructions",
    ),
    backtracks = savedField(config, "maxBacktracks", "max_backtracks");
  return Object.freeze({
    datapoints,
    pipeline: inferReplayPipeline(datapoints, payload.pipeline),
    categories,
    runName: String(
      savedField(payload, "runName", "run_name") || parse(path).name,
    ),
    path,
    maxTurns:
      typeof maxTurns === "number" && Number.isInteger(maxTurns)
        ? maxTurns
        : null,
    attackerInstructions:
      typeof instructions === "string" ? instructions : null,
    maxBacktracks:
      typeof backtracks === "number" && Number.isInteger(backtracks)
        ? backtracks
        : null,
  });
}
export { ReplayError };
