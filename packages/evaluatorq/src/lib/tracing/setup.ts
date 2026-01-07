/**
 * OpenTelemetry SDK setup with lazy initialization and auto-detection.
 *
 * Tracing is automatically enabled when:
 * 1. OTEL_EXPORTER_OTLP_ENDPOINT is set (explicit endpoint)
 * 2. ORQ_API_KEY is set (traces sent to Orq platform automatically)
 *
 * Tracing can be explicitly disabled by setting:
 * - ORQ_DISABLE_TRACING=1 or ORQ_DISABLE_TRACING=true
 *
 * When ORQ_API_KEY is provided:
 * - Uses ORQ_BASE_URL to derive the OTEL endpoint (my.*.orq.ai -> api.*.orq.ai/v2/otel)
 * - Falls back to https://api.orq.ai/v2/otel if ORQ_BASE_URL is not set
 * - Authorization header is automatically added with the API key
 *
 * Set ORQ_DEBUG=1 to enable debug logging for tracing setup.
 */

import type { Tracer } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | null = null;
let tracer: Tracer | null = null;
let isInitialized = false;
let initializationAttempted = false;

/**
 * Check if tracing is explicitly disabled via ORQ_DISABLE_TRACING.
 */
function isTracingExplicitlyDisabled(): boolean {
  const disableValue = process.env.ORQ_DISABLE_TRACING;
  return disableValue === "1" || disableValue === "true";
}

/**
 * Check if tracing should be enabled based on environment variables.
 * Tracing is enabled when ORQ_API_KEY or OTEL_EXPORTER_OTLP_ENDPOINT is set,
 * unless explicitly disabled via ORQ_DISABLE_TRACING.
 */
export function isTracingEnabled(): boolean {
  if (isTracingExplicitlyDisabled()) {
    return false;
  }
  return !!(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.ORQ_API_KEY);
}

/**
 * Get the default OTLP endpoint based on environment configuration.
 *
 * Priority:
 * 1. OTEL_EXPORTER_OTLP_ENDPOINT - explicit endpoint override
 * 2. ORQ_BASE_URL - derive API endpoint from base URL (e.g., my.orq.ai -> api.orq.ai)
 * 3. Default to production api.orq.ai when only ORQ_API_KEY is set
 */
function getOtlpEndpoint(): string | undefined {
  // Explicit endpoint takes precedence
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }

  // If ORQ_API_KEY is set, derive endpoint from ORQ_BASE_URL or use default
  if (process.env.ORQ_API_KEY) {
    const baseUrl = process.env.ORQ_BASE_URL;
    if (baseUrl) {
      // Transform my.*.orq.ai -> api.*.orq.ai/v2/otel
      // e.g., https://my.staging.orq.ai -> https://api.staging.orq.ai/v2/otel
      // e.g., https://my.orq.ai -> https://api.orq.ai/v2/otel
      try {
        const url = new URL(baseUrl);
        const host = url.host.replace(/^my\./, "api.");
        return `${url.protocol}//${host}/v2/otel`;
      } catch {
        // Invalid URL, fall through to default
      }
    }
    // Default to production endpoint
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
    if (process.env.ORQ_DEBUG) {
      if (isTracingExplicitlyDisabled()) {
        console.debug(
          "[evaluatorq] OTEL tracing disabled via ORQ_DISABLE_TRACING",
        );
      } else {
        console.debug(
          "[evaluatorq] OTEL tracing not enabled (no ORQ_API_KEY or OTEL_EXPORTER_OTLP_ENDPOINT)",
        );
      }
    }
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
      const source = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? "OTEL_EXPORTER_OTLP_ENDPOINT"
        : process.env.ORQ_BASE_URL
          ? "ORQ_BASE_URL (derived)"
          : "default (ORQ_API_KEY)";
      console.debug(`[evaluatorq] OTEL tracing enabled`);
      console.debug(`[evaluatorq] OTEL endpoint: ${tracesEndpoint}`);
      console.debug(`[evaluatorq] OTEL endpoint source: ${source}`);
      if (headers.Authorization) {
        console.debug(
          `[evaluatorq] Authorization: Bearer ***${apiKey?.slice(-8) || ""}`,
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
