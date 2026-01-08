/**
 * OpenTelemetry tracing module for evaluatorq.
 *
 * Provides optional instrumentation that auto-enables when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set in the environment.
 */

export {
  captureParentContext,
  generateRunId,
  type TracingContext,
} from "./context.js";
export {
  flushTracing,
  getTracer,
  initTracingIfNeeded,
  isTracingEnabled,
  isTracingInitialized,
  shutdownTracing,
} from "./setup.js";
export {
  type EvaluationRunSpanOptions,
  type EvaluationSpanOptions,
  type JobSpanOptions,
  setEvaluationAttributes,
  setJobNameAttribute,
  withEvaluationRunSpan,
  withEvaluationSpan,
  withJobSpan,
} from "./spans.js";
