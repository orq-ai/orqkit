/**
 * Tracing context utilities for run correlation and parent context capture.
 */

export interface TracingContext {
  runId: string;
  runName: string;
  enabled: boolean;
  parentContext?: unknown;
}

/**
 * Generates a unique run ID for correlating spans across an evaluation run.
 */
export function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Captures the parent OpenTelemetry context if available.
 * Returns undefined if OTEL is not initialized or no active context exists.
 */
export async function captureParentContext(): Promise<unknown | undefined> {
  try {
    const { context, trace } = await import("@opentelemetry/api");
    const activeContext = context.active();
    const activeSpan = trace.getSpan(activeContext);
    if (activeSpan) {
      return activeContext;
    }
    return undefined;
  } catch {
    // OTEL not available
    return undefined;
  }
}
