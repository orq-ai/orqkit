"""
OpenTelemetry tracing configuration for LangChain/LangGraph and custom spans.

This module provides two levels of tracing:

1. Simple setup for LangChain/LangGraph (env vars only):
   ```python
   from workspace_agent.tracing import setup_langchain_tracing
   setup_langchain_tracing()
   ```

2. Full OTEL SDK setup with @traced decorator:
   ```python
   from workspace_agent.tracing import setup_otel_tracing, traced
   setup_otel_tracing(service_name="my-service")

   @traced
   def my_function():
       pass
   ```

Required environment variables:
    ORQ_API_KEY: Your Orq.ai API key

Optional environment variables:
    OTEL_EXPORTER_OTLP_ENDPOINT: Override OTEL endpoint (default: https://api.orq.ai/v2/otel)
    OTEL_RESOURCE_ATTRIBUTES: Additional resource attributes
"""

import os
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Default Orq.ai OTEL endpoint
DEFAULT_OTEL_ENDPOINT = "https://api.orq.ai/v2/otel"

# Global tracer instance
_tracer = None
_provider = None


def _get_api_key(orq_api_key: str | None = None) -> str:
    """Get API key from parameter or environment."""
    api_key = orq_api_key or os.environ.get("ORQ_API_KEY")
    if not api_key:
        raise ValueError(
            "ORQ_API_KEY is required. Either pass it as a parameter or set the ORQ_API_KEY environment variable."
        )
    return api_key


def setup_langchain_tracing(
    orq_api_key: str | None = None,
    otel_endpoint: str | None = None,
) -> bool:
    """
    Configure environment variables for LangChain/LangGraph OTEL tracing.

    This is a lightweight setup that only sets environment variables.
    LangChain/LangGraph will automatically pick these up.

    Args:
        orq_api_key: Orq.ai API key. If not provided, reads from ORQ_API_KEY env var.
        otel_endpoint: OTEL endpoint URL. Defaults to Orq.ai endpoint.

    Returns:
        True if tracing was configured successfully.

    Raises:
        ValueError: If ORQ_API_KEY is not provided and not set in environment.
    """
    api_key = _get_api_key(orq_api_key)
    endpoint = otel_endpoint or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or DEFAULT_OTEL_ENDPOINT

    # Configure OTEL exporter
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Bearer {api_key}"

    # Enable LangSmith tracing in OTEL-only mode
    os.environ["LANGSMITH_OTEL_ENABLED"] = "true"
    os.environ["LANGSMITH_TRACING"] = "true"
    os.environ["LANGSMITH_OTEL_ONLY"] = "true"

    logger.info(f"LangChain OTEL tracing configured to export to: {endpoint}")
    return True


def setup_otel_tracing(
    orq_api_key: str | None = None,
    otel_endpoint: str | None = None,
    service_name: str = "workspace-agent",
    service_version: str = "1.0.0",
) -> Any:
    """
    Configure full OpenTelemetry SDK with TracerProvider and OTLP exporter.

    This provides complete control over tracing with support for:
    - Custom spans with tracer.start_as_current_span()
    - GenAI semantic convention attributes
    - The @traced decorator from orq_ai_sdk

    Args:
        orq_api_key: Orq.ai API key. If not provided, reads from ORQ_API_KEY env var.
        otel_endpoint: OTEL endpoint URL. Defaults to Orq.ai endpoint.
        service_name: Name of your service for resource attributes.
        service_version: Version of your service.

    Returns:
        The configured tracer instance.

    Raises:
        ValueError: If ORQ_API_KEY is not provided and not set in environment.

    Example:
        ```python
        from workspace_agent.tracing import setup_otel_tracing

        tracer = setup_otel_tracing(service_name="my-agent")

        with tracer.start_as_current_span("my-operation") as span:
            span.set_attribute("gen_ai.system", "openai")
            span.set_attribute("gen_ai.request.model", "gpt-4o")
            # ... your code ...
        ```
    """
    global _tracer, _provider

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION

    api_key = _get_api_key(orq_api_key)
    endpoint = otel_endpoint or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or DEFAULT_OTEL_ENDPOINT

    # Set environment variables (for compatibility with other tools)
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Bearer {api_key}"
    os.environ["OTEL_RESOURCE_ATTRIBUTES"] = f"service.name={service_name},service.version={service_version}"

    # Create resource with service info
    resource = Resource.create({
        SERVICE_NAME: service_name,
        SERVICE_VERSION: service_version,
    })

    # Create and configure the TracerProvider
    _provider = TracerProvider(resource=resource)

    # Configure OTLP exporter
    exporter = OTLPSpanExporter(
        endpoint=f"{endpoint}/v1/traces",
        headers={"Authorization": f"Bearer {api_key}"},
    )

    # Add batch processor for efficient export
    _provider.add_span_processor(BatchSpanProcessor(exporter))

    # Set as global tracer provider
    trace.set_tracer_provider(_provider)

    # Get tracer instance
    _tracer = trace.get_tracer(service_name, service_version)

    logger.info(f"OTEL SDK configured: service={service_name}, endpoint={endpoint}")
    return _tracer


def get_tracer() -> Any:
    """
    Get the configured tracer instance.

    Returns:
        The tracer instance, or None if not configured.

    Raises:
        RuntimeError: If setup_otel_tracing() hasn't been called.
    """
    if _tracer is None:
        raise RuntimeError("Tracer not configured. Call setup_otel_tracing() first.")
    return _tracer


def setup_orq_sdk_tracing(orq_api_key: str | None = None) -> Any:
    """
    Initialize the Orq SDK with tracing enabled.

    This enables the @traced decorator from orq_ai_sdk to work automatically.

    Args:
        orq_api_key: Orq.ai API key. If not provided, reads from ORQ_API_KEY env var.

    Returns:
        The initialized Orq client.

    Example:
        ```python
        from workspace_agent.tracing import setup_orq_sdk_tracing, traced

        orq = setup_orq_sdk_tracing()

        @traced
        def my_function(x: int) -> int:
            return x * 2

        @traced(type="llm", name="GPT Analysis")
        def analyze(prompt: str) -> str:
            # ... call LLM ...
            return result
        ```
    """
    from orq_ai_sdk import Orq

    api_key = _get_api_key(orq_api_key)
    return Orq(api_key=api_key)


# Re-export traced decorator for convenience
try:
    from orq_ai_sdk.traced import traced, current_span
except ImportError:
    # Provide stub if orq_ai_sdk not installed
    def traced(*args, **kwargs):
        """Stub decorator when orq_ai_sdk is not installed."""
        def decorator(func):
            logger.warning("orq_ai_sdk not installed - @traced decorator is a no-op")
            return func
        if args and callable(args[0]):
            return args[0]
        return decorator

    def current_span():
        """Stub for current_span when orq_ai_sdk is not installed."""
        raise ImportError("orq_ai_sdk is required for current_span()")


# Backwards compatibility aliases
setup_tracing = setup_langchain_tracing

# Global Orq client for @traced decorator
_orq_client = None
_initialized = False


def init_tracing(
    service_name: str = "workspace-agent",
    service_version: str = "1.0.0",
) -> None:
    """
    Initialize tracing with both OTEL SDK and Orq SDK.

    This is the recommended way to set up tracing - it configures everything
    and enables both custom spans and the @traced decorator.

    Call this once at application startup.

    Example:
        ```python
        from workspace_agent.tracing import init_tracing, traced, tracer

        # At app startup
        init_tracing(service_name="my-app")

        # Use @traced decorator
        @traced
        def my_function():
            pass

        # Or use tracer directly
        with tracer.start_as_current_span("my-span"):
            pass
        ```
    """
    global _tracer, _orq_client, _initialized

    if _initialized:
        return

    # Set up LangChain tracing (env vars)
    try:
        setup_langchain_tracing()
    except ValueError:
        logger.warning("Could not set up LangChain tracing - ORQ_API_KEY not set")

    # Set up OTEL SDK
    try:
        setup_otel_tracing(service_name=service_name, service_version=service_version)
    except ValueError:
        logger.warning("Could not set up OTEL SDK - ORQ_API_KEY not set")

    # Set up Orq SDK for @traced decorator
    try:
        _orq_client = setup_orq_sdk_tracing()
    except Exception as e:
        logger.warning(f"Could not initialize Orq SDK for @traced: {e}")

    _initialized = True
    logger.info(f"Tracing initialized: service={service_name}")


class _LazyTracer:
    """Lazy tracer that auto-initializes on first use."""

    def __getattr__(self, name: str) -> Any:
        global _tracer
        if _tracer is None:
            # Auto-initialize with defaults
            try:
                init_tracing()
            except Exception as e:
                logger.error(f"Failed to auto-initialize tracing: {e}")
                raise RuntimeError(f"Tracing not configured and auto-init failed: {e}")
        return getattr(_tracer, name)

    def __bool__(self) -> bool:
        return _tracer is not None


# Export a lazy tracer that initializes automatically on first use
tracer = _LazyTracer()


def is_tracing_configured() -> bool:
    """Check if OTEL tracing is already configured."""
    return (
        os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") is not None
        and os.environ.get("OTEL_EXPORTER_OTLP_HEADERS") is not None
    )


def disable_tracing() -> None:
    """Disable OTEL tracing and clean up."""
    global _tracer, _provider

    # Shutdown provider if exists
    if _provider is not None:
        try:
            _provider.shutdown()
        except Exception:
            pass
        _provider = None
        _tracer = None

    # Clear environment variables
    os.environ.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)
    os.environ.pop("OTEL_EXPORTER_OTLP_HEADERS", None)
    os.environ.pop("OTEL_RESOURCE_ATTRIBUTES", None)
    os.environ["LANGSMITH_OTEL_ENABLED"] = "false"
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGSMITH_OTEL_ONLY"] = "false"

    logger.info("OTEL tracing disabled")
