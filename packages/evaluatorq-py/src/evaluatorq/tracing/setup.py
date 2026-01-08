"""
OpenTelemetry SDK setup with lazy initialization and auto-detection.

Tracing is automatically enabled when:
1. OTEL_EXPORTER_OTLP_ENDPOINT is set (explicit endpoint)
2. ORQ_API_KEY is set (traces sent to Orq platform automatically)

Tracing can be explicitly disabled by setting:
- ORQ_DISABLE_TRACING=1 or ORQ_DISABLE_TRACING=true

When ORQ_API_KEY is provided:
- Uses ORQ_BASE_URL to derive the OTEL endpoint (my.*.orq.ai -> api.*.orq.ai/v2/otel)
- Falls back to https://api.orq.ai/v2/otel if ORQ_BASE_URL is not set
- Authorization header is automatically added with the API key

Set ORQ_DEBUG=1 to enable debug logging for tracing setup.
"""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.trace import Tracer

# Module-level state
_sdk: Any = None
_tracer: "Tracer | None" = None
_is_initialized = False
_initialization_attempted = False


def _is_tracing_explicitly_disabled() -> bool:
    """Check if tracing is explicitly disabled via ORQ_DISABLE_TRACING."""
    disable_value = os.environ.get("ORQ_DISABLE_TRACING", "")
    return disable_value in ("1", "true")


def is_tracing_enabled() -> bool:
    """
    Check if tracing should be enabled based on environment variables.
    Tracing is enabled when ORQ_API_KEY or OTEL_EXPORTER_OTLP_ENDPOINT is set,
    unless explicitly disabled via ORQ_DISABLE_TRACING.
    """
    if _is_tracing_explicitly_disabled():
        return False
    return bool(
        os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or os.environ.get("ORQ_API_KEY")
    )


def _get_otlp_endpoint() -> str | None:
    """
    Get the default OTLP endpoint based on environment configuration.

    Priority:
    1. OTEL_EXPORTER_OTLP_ENDPOINT - explicit endpoint override
    2. ORQ_BASE_URL - derive API endpoint from base URL (e.g., my.orq.ai -> api.orq.ai)
    3. Default to production api.orq.ai when only ORQ_API_KEY is set
    """
    # Explicit endpoint takes precedence
    explicit_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if explicit_endpoint:
        return explicit_endpoint

    # If ORQ_API_KEY is set, derive endpoint from ORQ_BASE_URL or use default
    if os.environ.get("ORQ_API_KEY"):
        base_url = os.environ.get("ORQ_BASE_URL")
        if base_url:
            try:
                parsed = urlparse(base_url)
                # Transform my.*.orq.ai -> api.*.orq.ai/v2/otel
                # e.g., https://my.staging.orq.ai -> https://api.staging.orq.ai/v2/otel
                # e.g., https://my.orq.ai -> https://api.orq.ai/v2/otel
                host = re.sub(r"^my\.", "api.", parsed.netloc)
                return f"{parsed.scheme}://{host}/v2/otel"
            except Exception:
                # Invalid URL, fall through to default
                pass
        # Default to production endpoint
        return "https://api.orq.ai/v2/otel"

    return None


async def init_tracing_if_needed() -> bool:
    """
    Initialize the OpenTelemetry SDK if not already initialized.
    Uses dynamic imports to handle optional dependencies gracefully.

    Returns:
        True if tracing was successfully initialized, False otherwise
    """
    global _sdk, _tracer, _is_initialized, _initialization_attempted

    if _initialization_attempted:
        return _is_initialized
    _initialization_attempted = True

    debug = os.environ.get("ORQ_DEBUG")

    if not is_tracing_enabled():
        if debug:
            if _is_tracing_explicitly_disabled():
                print("[evaluatorq] OTEL tracing disabled via ORQ_DISABLE_TRACING")
            else:
                print(
                    "[evaluatorq] OTEL tracing not enabled (no ORQ_API_KEY or OTEL_EXPORTER_OTLP_ENDPOINT)"
                )
        return False

    endpoint = _get_otlp_endpoint()
    if not endpoint:
        return False

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor

        # Service name and version attribute keys
        SERVICE_NAME = "service.name"
        SERVICE_VERSION = "service.version"

        # Build headers for the exporter
        headers: dict[str, str] = {}
        api_key = os.environ.get("ORQ_API_KEY")

        # Add Authorization header for any ORQ endpoint (production or staging)
        if api_key and "orq.ai" in endpoint:
            headers["Authorization"] = f"Bearer {api_key}"

        # Parse OTEL_EXPORTER_OTLP_HEADERS if present
        # Format: "key1=value1,key2=value2" - values may contain "=" (e.g., JWT tokens)
        env_headers = os.environ.get("OTEL_EXPORTER_OTLP_HEADERS")
        if env_headers:
            for pair in env_headers.split(","):
                eq_index = pair.find("=")
                if eq_index > 0:
                    key = pair[:eq_index].strip()
                    value = pair[eq_index + 1 :].strip()
                    if key and value:
                        headers[key] = value

        resource = Resource.create(
            {
                SERVICE_NAME: os.environ.get("OTEL_SERVICE_NAME", "evaluatorq"),
                SERVICE_VERSION: os.environ.get("OTEL_SERVICE_VERSION", "1.0.0"),
            }
        )

        # Ensure endpoint has the traces path
        traces_endpoint = (
            endpoint if endpoint.endswith("/v1/traces") else f"{endpoint}/v1/traces"
        )

        if debug:
            if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
                source = "OTEL_EXPORTER_OTLP_ENDPOINT"
            elif os.environ.get("ORQ_BASE_URL"):
                source = "ORQ_BASE_URL (derived)"
            else:
                source = "default (ORQ_API_KEY)"
            print("[evaluatorq] OTEL tracing enabled")
            print(f"[evaluatorq] OTEL endpoint: {traces_endpoint}")
            print(f"[evaluatorq] OTEL endpoint source: {source}")
            if "Authorization" in headers:
                print(
                    f"[evaluatorq] Authorization: Bearer ***{api_key[-8:] if api_key else ''}"
                )

        exporter = OTLPSpanExporter(
            endpoint=traces_endpoint,
            headers=headers,
            timeout=30,  # 30 second timeout
        )

        # Use SimpleSpanProcessor to send spans immediately as they complete
        span_processor = SimpleSpanProcessor(exporter)

        provider = TracerProvider(resource=resource)
        provider.add_span_processor(span_processor)
        trace.set_tracer_provider(provider)

        _sdk = provider
        _tracer = trace.get_tracer("evaluatorq")
        _is_initialized = True

        return True

    except ImportError as e:
        # OTEL packages not installed
        if debug:
            print(f"[evaluatorq] OpenTelemetry not available: {e}")
        return False
    except Exception as e:
        if debug:
            print(f"[evaluatorq] OpenTelemetry initialization failed: {e}")
        return False


async def flush_tracing() -> None:
    """
    Force flush all pending spans.
    Use this to ensure spans are exported before continuing.
    """
    global _sdk

    if _sdk is not None:
        try:
            provider: "TracerProvider" = _sdk
            provider.force_flush()
        except Exception as e:
            if os.environ.get("ORQ_DEBUG"):
                print(f"[evaluatorq] Error flushing traces: {e}")


async def shutdown_tracing() -> None:
    """
    Gracefully shutdown the OpenTelemetry SDK.
    Should be called before process exit to ensure spans are flushed.
    """
    global _sdk, _tracer, _is_initialized

    if _sdk is not None:
        try:
            # Force flush before shutdown
            await flush_tracing()
            provider: "TracerProvider" = _sdk
            provider.shutdown()
        except Exception as e:
            if os.environ.get("ORQ_DEBUG"):
                print(f"[evaluatorq] Error shutting down tracing: {e}")

        _sdk = None
        _tracer = None
        _is_initialized = False


def get_tracer() -> "Tracer | None":
    """
    Get the tracer instance if tracing is initialized.
    Returns None if tracing is not enabled.
    """
    return _tracer


def is_tracing_initialized() -> bool:
    """Check if tracing has been successfully initialized."""
    return _is_initialized
