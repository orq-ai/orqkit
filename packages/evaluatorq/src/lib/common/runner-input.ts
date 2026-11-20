import type { ExperimentInput } from "../experiment.js";
import { TraceInput } from "../trace.js";
import type { DataPoint, EvaluatorParams, Job, Output } from "../types.js";
import { fetchExperimentDataPoints } from "./fetch-data.js";
import { coerceContentText } from "./messages.js";
import { hasMeaningfulOutput } from "./output-adapters.js";
import { pythonStrip } from "./sanitize.js";
import { loadTraces } from "./trace-input.js";

const experimentSource = (
  data: EvaluatorParams["data"],
): data is ExperimentInput => !Array.isArray(data) && "experimentId" in data;
const error = (message: string) =>
  Object.assign(new Error(message), { jobName: "recorded" });
export function extractRecordedResponse(messages: unknown): string {
  if (!Array.isArray(messages) || !messages.length)
    throw error(
      "inference=false requires a recorded response in the 'messages' column, but this row has no messages.",
    );
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || message.role !== "assistant")
      continue;
    const text = coerceContentText(message.content);
    if (pythonStrip(text)) return text;
  }
  throw error(
    "inference=false requires a recorded response in the 'messages' column, but this row has no assistant message with text content.",
  );
}
export const replayRecordedResponse: Job = async (dataPoint: DataPoint) => {
  const inputs = dataPoint.inputs,
    importError = inputs.traceImportError ?? inputs.trace_import_error;
  if (importError)
    throw error(`The source trace could not be imported: ${importError}`);
  const key = Object.hasOwn(inputs, "recordedOutput")
    ? "recordedOutput"
    : Object.hasOwn(inputs, "recorded_output")
      ? "recorded_output"
      : null;
  if (key !== null) {
    const output = inputs[key];
    if (hasMeaningfulOutput(output))
      return { name: "recorded", output: output as Output };
    throw error(
      "inference=false requires a non-empty 'recordedOutput' for an imported trace, but the selected trace span has no recorded assistant response.",
    );
  }
  return { name: "recorded", output: extractRecordedResponse(inputs.messages) };
};
export function resolveEvaluationMode(
  data: EvaluatorParams["data"],
  jobs: Job[] | undefined,
  inference: boolean | null | undefined,
): { inference: boolean; jobs: Job[] } {
  const experiment = experimentSource(data),
    trace = data instanceof TraceInput,
    replay = experiment || trace;
  if (inference === true && replay)
    throw new Error(
      experiment
        ? "data=ExperimentInput(...) sources pre-recorded responses from an experiment and is only valid with inference=false."
        : "data=TraceInput(...) sources recorded responses from traces and is only valid with inference=false.",
    );
  const resolved = inference ?? !replay;
  if (resolved && !jobs?.length)
    throw new Error("'jobs' is required unless inference=false");
  if (!resolved && jobs?.length)
    console.error(
      "inference=false: ignoring the provided 'jobs'; responses are replayed from recorded output when available, otherwise from the messages column.",
    );
  return {
    inference: resolved,
    jobs: resolved ? (jobs as Job[]) : [replayRecordedResponse],
  };
}
export async function resolveEvaluationData(
  data: EvaluatorParams["data"],
  options: { apiKey?: string; baseUrl?: string } = {},
): Promise<Exclude<EvaluatorParams["data"], ExperimentInput | TraceInput>> {
  if (experimentSource(data)) {
    if (!options.apiKey)
      throw new Error(
        "ORQ_API_KEY environment variable must be set to load responses from an Orq experiment.",
      );
    return fetchExperimentDataPoints(
      options.apiKey,
      data.experimentId,
      data.runId ?? undefined,
      { baseUrl: options.baseUrl },
    );
  }
  if (data instanceof TraceInput) {
    const batch = await loadTraces(data, {
      caller: "evaluatorq",
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
    if (!batch.traces.length)
      throw new Error(
        "data=TraceInput(...) selected no traces. Widen the query (limit, search, filters, startTime/endTime) or name a traceId.",
      );
    console.error(
      `Imported ${batch.traces.length} trace(s) (${batch.usable.length} usable, ${batch.failed.length} failed).`,
    );
    return batch.traces.map((trace) => trace.toDatapoint());
  }
  return data;
}
