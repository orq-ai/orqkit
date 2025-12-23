/**
 * OpenTelemetry SDK setup with lazy initialization and auto-detection.
 *
 * Tracing is enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * If ORQ_API_KEY is set without a custom endpoint, traces are sent to the ORQ receiver.
 */

import type { Tracer } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | null = null;
let tracer: Tracer | null = null;
let isInitialized = false;
let initializationAttempted = false;

/**
 * Check if tracing should be enabled based on environment variables.
 */
export function isTracingEnabled(): boolean {
  return !!(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.ORQ_API_KEY);
}

/**
 * Get the default OTLP endpoint based on environment configuration.
 */
function getOtlpEndpoint(): string | undefined {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  if (process.env.ORQ_API_KEY) {
    return "https://api.orq.ai/v2/otel";
  }
  return undefined;
}

/**
 * Initialize the OpenTelemetry SDK if not already initialized.
 * Uses dynamic imports to handle optional dependencies gracefully.
 *
 * @returns true if tracing was successfully initialized, false otherwise
 */
export async function initTracingIfNeeded(): Promise<boolean> {
  if (initializationAttempted) {
    return isInitialized;
  }
  initializationAttempted = true;

  if (!isTracingEnabled()) {
    return false;
  }

  const endpoint = getOtlpEndpoint();
  if (!endpoint) {
    return false;
  }

  try {
    const [
      { NodeSDK: NodeSDKClass },
      { OTLPTraceExporter },
      { Resource },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
      { trace },
      { SimpleSpanProcessor },
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace-base"),
    ]);

    // Build headers for the exporter
    const headers: Record<string, string> = {};
    const apiKey = process.env.ORQ_API_KEY;

    // Add Authorization header for any ORQ endpoint (production or staging)
    if (apiKey && endpoint.includes("orq.ai")) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Parse OTEL_EXPORTER_OTLP_HEADERS if present
    // Format: "key1=value1,key2=value2" - values may contain "=" (e.g., JWT tokens)
    const envHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    if (envHeaders) {
      const pairs = envHeaders.split(",");
      for (const pair of pairs) {
        const eqIndex = pair.indexOf("=");
        if (eqIndex > 0) {
          const key = pair.substring(0, eqIndex).trim();
          const value = pair.substring(eqIndex + 1).trim();
          if (key && value) {
            headers[key] = value;
          }
        }
      }
    }

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "evaluatorq",
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || "1.0.0",
    });

    // Ensure endpoint has the traces path
    const tracesEndpoint = endpoint.endsWith("/v1/traces")
      ? endpoint
      : `${endpoint}/v1/traces`;

    if (process.env.ORQ_DEBUG) {
      console.debug("[evaluatorq] OTEL endpoint:", tracesEndpoint);
      console.debug("[evaluatorq] OTEL headers:", Object.keys(headers));
      if (headers.Authorization) {
        console.debug(
          "[evaluatorq] Auth header length:",
          headers.Authorization.length,
        );
      }
    }

    const traceExporter = new OTLPTraceExporter({
      url: tracesEndpoint,
      headers,
      timeoutMillis: 30000, // 30 second timeout for export
    });

    // Use SimpleSpanProcessor to send spans immediately as they complete
    const spanProcessor = new SimpleSpanProcessor(traceExporter);

    sdk = new NodeSDKClass({
      resource,
      spanProcessors: [spanProcessor],
    });

    sdk.start();
    tracer = trace.getTracer("evaluatorq");
    isInitialized = true;

    return true;
  } catch (error) {
    // OTEL packages not installed or initialization failed
    if (process.env.ORQ_DEBUG) {
      console.debug("[evaluatorq] OpenTelemetry not available:", error);
    }
    return false;
  }
}

/**
 * Force flush all pending spans.
 * Use this to ensure spans are exported before continuing.
 */
export async function flushTracing(): Promise<void> {
  if (sdk) {
    try {
      // Access the trace provider to force flush
      const { trace } = await import("@opentelemetry/api");
      const provider = trace.getTracerProvider();
      // TracerProvider may have forceFlush method
      const providerWithFlush = provider as {
        forceFlush?: () => Promise<void>;
      };
      if (providerWithFlush.forceFlush) {
        await providerWithFlush.forceFlush();
      }
    } catch (error) {
      if (process.env.ORQ_DEBUG) {
        console.debug("[evaluatorq] Error flushing traces:", error);
      }
    }
  }
}

/**
 * Gracefully shutdown the OpenTelemetry SDK.
 * Should be called before process exit to ensure spans are flushed.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    try {
      // Force flush before shutdown
      await flushTracing();
      await sdk.shutdown();
    } catch (error) {
      if (process.env.ORQ_DEBUG) {
        console.debug("[evaluatorq] Error shutting down tracing:", error);
      }
    }
    sdk = null;
    tracer = null;
    isInitialized = false;
  }
}

/**
 * Get the tracer instance if tracing is initialized.
 * Returns undefined if tracing is not enabled.
 */
export function getTracer(): Tracer | undefined {
  return tracer || undefined;
}

/**
 * Check if tracing has been successfully initialized.
 */
export function isTracingInitialized(): boolean {
  return isInitialized;
}
