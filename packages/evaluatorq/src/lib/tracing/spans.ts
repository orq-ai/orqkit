/**
 * Span creation utilities for OpenTelemetry instrumentation.
 *
 * Span hierarchy:
 * - orq.evaluation_run (root or child of parent context)
 *   └── orq.job (per job per data point)
 *       ├── [User's instrumented code becomes child spans]
 *       └── orq.evaluation (per evaluator - child of its job)
 */

import type {
  Context,
  Span,
  SpanStatusCode as SpanStatusCodeType,
} from "@opentelemetry/api";

import { recordSpanPayload } from "../common/tracing.js";
import { getTracer } from "./setup.js";

async function loadOtelApi() {
  try {
    return await import("@opentelemetry/api");
  } catch {
    return undefined;
  }
}

/**
 * Execute a callback within a span, handling status and error recording.
 */
async function executeWithSpan<T>(
  span: Span,
  SpanStatusCode: typeof SpanStatusCodeType,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  } finally {
    span.end();
  }
}

export interface EvaluationRunSpanOptions {
  runId: string;
  runName: string;
  dataPointsCount: number;
  jobsCount: number;
  evaluatorsCount: number;
  parentContext?: Context;
}

export interface JobSpanOptions {
  runId: string;
  rowIndex: number;
  jobName?: string;
  parentContext?: unknown;
}

export interface EvaluationSpanOptions {
  runId: string;
  evaluatorName: string;
  evaluatorType?: string;
}

/**
 * Execute a function within an orq.evaluation_run span.
 * This is the root span for an evaluation run.
 */
export async function withEvaluationRunSpan<T>(
  options: EvaluationRunSpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn(undefined);
  }

  const otel = await loadOtelApi();
  if (!otel) {
    return fn(undefined);
  }
  const { context, SpanStatusCode } = otel;

  // Use parent context if provided, otherwise use active context
  const parentCtx = options.parentContext || context.active();

  return await tracer.startActiveSpan(
    "orq.evaluation_run",
    {
      attributes: {
        "orq.run_id": options.runId,
        "orq.run_name": options.runName,
        "orq.data_points_count": options.dataPointsCount,
        "orq.jobs_count": options.jobsCount,
        "orq.evaluators_count": options.evaluatorsCount,
      },
    },
    parentCtx,
    (span) => executeWithSpan(span, SpanStatusCode, fn),
  );
}

/**
 * Execute a function within an orq.job span.
 * Job spans are independent roots, or children of a parent context if provided.
 */
export async function withJobSpan<T>(
  options: JobSpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn(undefined);
  }

  const otel = await loadOtelApi();
  if (!otel) {
    return fn(undefined);
  }
  const { context, SpanStatusCode } = otel;

  // Use parent context if provided, otherwise use active context
  const parentCtx = (options.parentContext as Context) || context.active();

  return await tracer.startActiveSpan(
    "orq.job",
    {
      attributes: {
        "orq.run_id": options.runId,
        "orq.row_index": options.rowIndex,
        ...(options.jobName && { "orq.job_name": options.jobName }),
      },
    },
    parentCtx,
    (span) => executeWithSpan(span, SpanStatusCode, fn),
  );
}

/**
 * Execute a function within an orq.evaluation span.
 * Evaluation spans are children of the job span.
 */
export async function withEvaluationSpan<T>(
  options: EvaluationSpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn(undefined);
  }

  const otel = await loadOtelApi();
  if (!otel) {
    return fn(undefined);
  }
  const { SpanStatusCode } = otel;

  return await tracer.startActiveSpan(
    `orq.evaluation ${options.evaluatorName}`,
    {
      attributes: {
        "orq.run_id": options.runId,
        "orq.evaluator_name": options.evaluatorName,
      },
    },
    (span) => {
      setEvaluatorIdentity(span, options);
      return executeWithSpan(span, SpanStatusCode, fn);
    },
  );
}

function setEvaluatorIdentity(
  span: Span,
  options: { evaluatorName?: string; evaluatorType?: string },
): void {
  if (options.evaluatorType === undefined) return;
  span.setAttribute("orq.span_type", "span.evaluator");
  span.setAttribute("orq.evaluator.type", options.evaluatorType);
  if (options.evaluatorName !== undefined) {
    span.setAttribute("gen_ai.evaluation.name", options.evaluatorName);
    span.setAttribute("orq.evaluator.key", options.evaluatorName);
  }
}

/**
 * Set evaluation result attributes on a span.
 */
export function setEvaluationAttributes(
  span: Span | undefined,
  score: string | number | boolean | Record<string, unknown> | null,
  explanation?: string | null,
  pass?: boolean,
  options: {
    evaluatorName?: string;
    evaluatorType?: string;
    rawOutput?: Record<string, unknown> | null;
  } = {},
): void {
  if (!span) return;
  const fullExplanation = explanation;
  if (explanation != null && Array.from(explanation).length > 512)
    explanation = `${Array.from(explanation).slice(0, 511).join("")}…`;

  if (score !== null) {
    span.setAttribute(
      "orq.score",
      typeof score === "object" && score !== null
        ? JSON.stringify(score)
        : String(score),
    );
  }
  if (explanation != null) {
    span.setAttribute("orq.explanation", explanation);
  }
  if (pass !== undefined) {
    span.setAttribute("orq.pass", pass);
  }
  if (options.evaluatorType === undefined) return;
  setEvaluatorIdentity(span, options);
  span.setAttribute(
    "orq.evaluator.output_type",
    typeof score === "boolean"
      ? "boolean"
      : typeof score === "number"
        ? "number"
        : "string",
  );
  if (typeof score === "boolean" || typeof score === "number")
    span.setAttribute("gen_ai.evaluation.score.value", Number(score));
  if (explanation != null)
    span.setAttribute("gen_ai.evaluation.explanation", explanation);
  if (pass !== undefined) {
    span.setAttribute("gen_ai.evaluation.passed", pass);
    span.setAttribute("gen_ai.evaluation.score.label", pass ? "pass" : "fail");
    span.setAttribute("orq.evaluator.score.label", pass ? "pass" : "fail");
  }
  recordSpanPayload(span, {
    key: "orq.evaluation.output",
    payload: {
      passed: pass ?? null,
      value: score,
      type: options.evaluatorType,
      ...(fullExplanation != null ? { reason: fullExplanation } : {}),
    },
    optionalFields:
      options.rawOutput != null ? { raw_output: options.rawOutput } : undefined,
  });
}

/**
 * Set the job name attribute on a span after job execution.
 */
export function setJobNameAttribute(
  span: Span | undefined,
  jobName: string,
): void {
  if (!span) return;
  span.setAttribute("orq.job_name", jobName);
}
