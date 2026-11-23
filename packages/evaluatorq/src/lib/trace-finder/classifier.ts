import type OpenAI from "openai";

import {
  type ClassifyQuestion,
  type JudgeOutcome,
  judgeErrorPayload,
  runClassifyJudges,
} from "../common/judge.js";
import { classifyRequestBody } from "../common/llm-call.js";
import {
  effectiveTraceInputChars,
  fitClassifierInput,
} from "../common/model-input.js";
import { withRunLifecycle } from "../common/run-lifecycle.js";
import { pythonString } from "../common/sanitize.js";
import {
  addUsage,
  JuryRepetitionSchema,
  JuryResultSchema,
  JuryVoteSchema,
  LLMCallConfig,
  type Usage,
} from "../contracts.js";
import { evaluatorq } from "../evaluatorq.js";
import type {
  DataPoint,
  DataPointResult,
  EvaluationResult,
  Evaluator,
} from "../types.js";
import { enabled as debugEnabled } from "./debug.js";
import {
  type CompiledQuery,
  type DimensionAnswer,
  DimensionAnswerSchema,
  type TraceClassification,
  TraceClassificationSchema,
  type TraceProjection,
  type TraceRecord,
} from "./models.js";
import { truth } from "./orq-source-data.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value: Row, key: string) =>
  Object.hasOwn(value, key)
    ? value[key]
    : value[key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())];
const repr = (value: unknown) => pythonString([value]).slice(1, -1);
class TerminalResultError extends Error {
  override readonly name = "TerminalResultError";
}
export function buildDatapoint(
  trace: TraceRecord,
  projection: TraceProjection,
): DataPoint {
  return {
    inputs: {
      trace_id: trace.traceId,
      span_id: trace.spanId,
      classifier_state: projection.payload,
      messages: [{ role: "assistant", content: "classifier state prepared" }],
    },
  };
}
export function classifierQuestions(
  dimensions: readonly CompiledQuery[],
): Record<string, ClassifyQuestion> {
  return Object.fromEntries(
    dimensions.map((dimension, index) => [`d${index}`, dimension.task]),
  );
}
export async function buildClassifierEvaluator(
  dimensions: readonly CompiledQuery[],
  options: {
    model: string;
    client: OpenAI;
    globalCharCap?: number | null;
    questionPayloads?: Readonly<Record<string, ClassifyQuestion>> | null;
  },
): Promise<Evaluator> {
  const { model, client } = options,
    questions = options.questionPayloads ?? classifierQuestions(dimensions),
    inputCap = options.globalCharCap ?? (await effectiveTraceInputChars()),
    cfg = new LLMCallConfig({ model, timeoutMs: 90000 });
  return {
    name: "classifier",
    scorer: async (params) => {
      const traceId = pythonString(params.data.inputs.trace_id || ""),
        state = fitClassifierInput(params.data.inputs.classifier_state as Row, {
          model,
          questions,
          globalCharCap: inputCap,
        });
      if (debugEnabled())
        console.error(
          "Trace finder trace classifier request",
          traceId,
          model,
          JSON.stringify(classifyRequestBody(model, state, questions)),
        );
      const outcomes = await runClassifyJudges({
          client,
          model,
          cfg,
          state: state as ClassifyQuestion["state"],
          questions,
          spanAttributes: { "orq.llm.purpose": "judge" },
        }),
        keys = Object.keys(questions),
        results = keys.map((key) =>
          outcomeResult(outcomes[key] as JudgeOutcome, model),
        );
      if (debugEnabled())
        for (const [key, outcome] of Object.entries(outcomes))
          console.error(
            "Trace finder trace classifier response",
            traceId,
            key,
            model,
            outcome.endpoint,
            outcome.rawContent || JSON.stringify(outcome.rawOutput),
            outcome.errorMessage,
          );
      let tokenUsage: Usage | null = null;
      for (const usage of new Set(
        Object.values(outcomes).map((outcome) => outcome.tokenUsage),
      ))
        if (usage !== null)
          tokenUsage =
            tokenUsage === null ? usage : addUsage(tokenUsage, usage);
      return {
        value: Object.fromEntries(
          keys.map((key, index) => [key, results[index]?.value]),
        ),
        tokenUsage,
        rawOutput: {
          dimensions: results.map((result) => ({
            value: result.value,
            explanation: result.explanation,
            raw_output: result.rawOutput,
          })),
        },
      };
    },
  };
}
export function outcomeResult(
  outcome: JudgeOutcome,
  model: string,
): EvaluationResult<string | number | boolean> {
  const payload = outcome.payload,
    value = payload?.value ?? null,
    explanation = payload?.explanation ?? null,
    mechanical = outcome.errorKind === null && payload !== null,
    abstained = mechanical && Boolean(payload?.abstain),
    decisive = mechanical && !abstained && value !== null,
    success = decisive || abstained,
    message =
      outcome.errorMessage ||
      (success ? null : "The classifier returned no verdict"),
    repetition = JuryRepetitionSchema.parse({
      value: decisive ? value : null,
      explanation,
      rawOutput: outcome.rawOutput,
    }),
    vote = JuryVoteSchema.parse({
      model,
      success,
      abstained,
      value: decisive ? value : null,
      explanation: explanation || "",
      error: success ? null : message,
      repetitions: [repetition],
      repetitionsFailed: success ? 0 : 1,
    }),
    jury = JuryResultSchema.parse({
      judgesConfigured: 1,
      judgesSucceeded: decisive ? 1 : 0,
      judgesFailed: success ? 0 : 1,
      inconclusive: !decisive,
      votes: [vote],
      rawAgreement: decisive ? 1 : null,
    }),
    rawOutput: Row = { jury };
  if (!success)
    rawOutput.evaluation_error =
      outcome.errorKind !== null
        ? judgeErrorPayload(outcome, "classifier")
        : {
            message,
            error_type: "no_verdict",
            stage: "evaluation",
            code: "no_verdict",
            details: { evaluator_id: "classifier" },
          };
  return {
    value: success && value !== null ? value : "inconclusive",
    explanation: payload !== null ? explanation : message,
    tokenUsage: outcome.tokenUsage,
    rawOutput,
  };
}
export function matchesSelection(
  value: unknown,
  compiled: CompiledQuery,
): boolean {
  if (value === null || value === undefined) return false;
  const selection = compiled.selection;
  if (selection.kind === "values")
    return selection.values.some(
      (candidate) => typeof value === typeof candidate && value === candidate,
    );
  if (typeof value !== "number") return false;
  return selection.operator === "gte"
    ? value >= selection.value
    : value <= selection.value;
}
export function validateVerdict(
  value: unknown,
  compiled: CompiledQuery,
  rawOutput: Row | null,
): boolean | number | string {
  if (rawOutput) {
    const failure = rawOutput.evaluation_error;
    if (truth(failure))
      throw new TerminalResultError(
        ((record(failure)
          ? failure.message
          : pythonString(failure)) as string) || "Classifier evaluation failed",
      );
    const jury = rawOutput.jury;
    if (
      record(jury) &&
      (truth(jury.inconclusive) || truth(field(jury, "judges_failed")))
    ) {
      const errors: string[] = [];
      for (const vote of Array.isArray(jury.votes) ? jury.votes : [])
        if (record(vote)) {
          if (vote.abstained === true)
            throw new TerminalResultError("judge abstained");
          if (typeof vote.error === "string" && vote.error)
            errors.push(vote.error);
        }
      throw new TerminalResultError(
        errors.join("; ") || "classifier jury returned an inconclusive verdict",
      );
    }
  }
  const { kind, criteria } = compiled.task;
  if (
    kind === "choice" &&
    typeof value === "string" &&
    record(criteria) &&
    Object.hasOwn(criteria, value)
  )
    return value;
  if (kind === "noul" && typeof value === "boolean") return value;
  if (kind === "score" && typeof value === "number" && value >= 0 && value <= 1)
    return value;
  throw new TerminalResultError(`Invalid ${kind} verdict: ${repr(value)}`);
}
export function rawAnswer(rawOutput: Row | null): Row | null {
  if (rawOutput === null) return null;
  const jury = rawOutput.jury,
    vote = record(jury) && Array.isArray(jury.votes) ? jury.votes[0] : null,
    repetition =
      record(vote) && Array.isArray(vote.repetitions)
        ? vote.repetitions[0]
        : null;
  if (!record(repetition))
    throw new TerminalResultError("malformed classifier result tree");
  const answer = field(repetition, "raw_output");
  if (answer === null || answer === undefined) return null;
  if (!record(answer))
    throw new TerminalResultError("malformed classifier result tree");
  return { ...answer };
}
export function classificationDetails(
  answer: Row | null,
): readonly [number | null, Record<string, number> | null] {
  if (answer === null) return [null, null];
  const confidence = answer.confidence ?? null,
    probabilities = answer.probabilities ?? null,
    valid = (value: unknown): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1;
  if (confidence !== null && !valid(confidence))
    throw new TerminalResultError("malformed classifier confidence");
  if (
    probabilities !== null &&
    (!record(probabilities) ||
      Object.values(probabilities).some((value) => !valid(value)))
  )
    throw new TerminalResultError("malformed classifier probabilities");
  return [
    confidence as number | null,
    probabilities as Record<string, number> | null,
  ];
}
export function dimensionAnswer(
  entry: unknown,
  dimension: CompiledQuery,
): DimensionAnswer {
  let value: boolean | number | string,
    confidence: number | null,
    probabilities: Record<string, number> | null;
  try {
    if (!record(entry))
      throw new TerminalResultError("malformed dimension result");
    const output = field(entry, "raw_output") ?? null;
    if (output !== null && !record(output))
      throw new TerminalResultError("malformed dimension result");
    value = validateVerdict(entry.value, dimension, output);
    [confidence, probabilities] = classificationDetails(rawAnswer(output));
  } catch (error) {
    if (error instanceof TerminalResultError)
      return DimensionAnswerSchema.parse({ error: error.message });
    throw error;
  }
  return DimensionAnswerSchema.parse({
    value,
    confidence,
    probabilities,
    matched: matchesSelection(value, dimension),
    summary:
      record(entry) && typeof entry.explanation === "string"
        ? entry.explanation
        : null,
  });
}
export function parseDatapointResult(
  result: DataPointResult,
  dimensions: readonly CompiledQuery[],
): TraceClassification {
  const rawResult = JSON.parse(
      JSON.stringify(result, (_, value) =>
        value instanceof Error ? value.message : value,
      ),
    ) as Row,
    inputs = result.dataPoint.inputs,
    traceId = pythonString(inputs.trace_id ?? ""),
    spanId = pythonString(inputs.span_id ?? "");
  let entries: unknown[];
  try {
    if (result.error)
      throw new TerminalResultError(
        result.error.message || String(result.error),
      );
    const jobs = result.jobResults;
    if (!jobs || jobs.length !== 1)
      throw new TerminalResultError("expected exactly one job result");
    const job = jobs[0];
    if (job?.error)
      throw new TerminalResultError(job.error.message || String(job.error));
    const scores = job?.evaluatorScores;
    if (!scores || scores.length !== 1)
      throw new TerminalResultError("expected exactly one evaluator score");
    const score = scores[0];
    if (score?.error)
      throw new TerminalResultError(score.error.message || String(score.error));
    const output = score?.score.rawOutput ?? {},
      values = output.dimensions;
    if (!Array.isArray(values) || values.length !== dimensions.length)
      throw new TerminalResultError(
        `expected ${dimensions.length} dimension results`,
      );
    entries = values;
  } catch (error) {
    if (!(error instanceof TerminalResultError)) throw error;
    console.warn(
      `Classifier result parsing failed for trace_id=${traceId} span_id=${spanId}: ${error.message}`,
    );
    return TraceClassificationSchema.parse({
      traceId,
      spanId,
      error: error.message,
      rawResult,
    });
  }
  const answers = entries.map((entry, index) =>
      dimensionAnswer(entry, dimensions[index] as CompiledQuery),
    ),
    errors = answers.flatMap((answer, index) =>
      answer.error === null
        ? []
        : [`${dimensions[index]?.name}: ${answer.error}`],
    );
  if (errors.length)
    console.warn(
      `Classifier dimensions failed for trace_id=${traceId} span_id=${spanId}: ${errors.join("; ")}`,
    );
  return TraceClassificationSchema.parse({
    traceId,
    spanId,
    answers,
    matched: errors.length === 0 && answers.every((answer) => answer.matched),
    error: errors.join("; ") || null,
    rawResult,
  });
}

export async function runClassifier(
  traces: readonly TraceRecord[],
  projections: Readonly<Record<string, TraceProjection>>,
  dimensions: readonly CompiledQuery[],
  options: {
    model: string;
    client: OpenAI;
    parallelism: number;
    signal?: AbortSignal;
    onComplete: (classification: TraceClassification) => Promise<void> | void;
    traceInputChars?: number | null;
    questionPayloads?: Readonly<Record<string, ClassifyQuestion>> | null;
  },
): Promise<TraceClassification[]> {
  const classifications: TraceClassification[] = [];
  options.signal?.throwIfAborted();
  if (dimensions.length === 0) {
    for (const trace of traces) {
      options.signal?.throwIfAborted();
      const classification = TraceClassificationSchema.parse({
        traceId: trace.traceId,
        spanId: trace.spanId,
        matched: true,
      });
      await options.onComplete(classification);
      options.signal?.throwIfAborted();
      classifications.push(classification);
    }
    return classifications;
  }
  const evaluator = await buildClassifierEvaluator(dimensions, {
    model: options.model,
    client: options.client,
    globalCharCap: options.traceInputChars,
    questionPayloads: options.questionPayloads,
  });
  await withRunLifecycle(
    undefined,
    () =>
      evaluatorq("classifier-trace-finder", {
        data: traces.map((trace) => {
          if (!Object.hasOwn(projections, trace.traceId))
            throw new Error(`Missing trace projection: ${trace.traceId}`);
          return buildDatapoint(
            trace,
            projections[trace.traceId] as TraceProjection,
          );
        }),
        evaluators: [evaluator],
        inference: false,
        datapointParallelism: options.parallelism,
        llmParallelism: options.parallelism,
        onDatapointComplete: async (result) => {
          const classification = parseDatapointResult(result, dimensions);
          await options.onComplete(classification);
          classifications.push(classification);
        },
        print: false,
        sendResults: false,
        exitOnFailure: false,
      }),
    options.signal,
  );
  return classifications;
}
