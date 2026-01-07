/**
 * Span creation utilities for OpenTelemetry instrumentation.
 *
 * Span hierarchy:
 * - orq.evaluation_run (root or child of parent context)
 *   └── orq.job (per job per data point)
 *       ├── [User's instrumented code becomes child spans]
 *       └── orq.evaluation (per evaluator - child of its job)
 */

import type { Context, Span } from "@opentelemetry/api";

import { getTracer } from "./setup.js";

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

  try {
    const { context, SpanStatusCode } = await import("@opentelemetry/api");

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
      async (span) => {
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
      },
    );
  } catch {
    // OTEL not available, run without span
    return fn(undefined);
  }
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

  try {
    const { context, SpanStatusCode } = await import("@opentelemetry/api");

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
      async (span) => {
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
      },
    );
  } catch {
    // OTEL not available, run without span
    return fn(undefined);
  }
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

  try {
    const { SpanStatusCode } = await import("@opentelemetry/api");

    return await tracer.startActiveSpan(
      "orq.evaluation",
      {
        attributes: {
          "orq.run_id": options.runId,
          "orq.evaluator_name": options.evaluatorName,
        },
      },
      async (span) => {
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
      },
    );
  } catch {
    // OTEL not available, run without span
    return fn(undefined);
  }
}

/**
 * Set evaluation result attributes on a span.
 */
export function setEvaluationAttributes(
  span: Span | undefined,
  score: string | number | boolean,
  explanation?: string,
  pass?: boolean,
): void {
  if (!span) return;

  span.setAttribute("orq.score", String(score));
  if (explanation !== undefined) {
    span.setAttribute("orq.explanation", explanation);
  }
  if (pass !== undefined) {
    span.setAttribute("orq.pass", pass);
  }
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
