"""Backend protocols for dynamic red teaming agent targets.

Defines the abstract interfaces that any agent backend must implement.
Targets self-describe their capabilities via optional protocols; the runner
detects and uses them automatically.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from loguru import logger

if TYPE_CHECKING:
    from evaluatorq.redteam.contracts import AgentContext, TokenUsage


# ---------------------------------------------------------------------------
# Core protocol (required)
# ---------------------------------------------------------------------------


class AgentTarget(Protocol):
    """Protocol for agent targets that can receive prompts."""

    async def send_prompt(self, prompt: str) -> str:
        """Send a prompt and return the response."""
        ...

    def reset_conversation(self) -> None:
        """Reset conversation state for a new attack."""
        ...


# ---------------------------------------------------------------------------
# Optional capability protocols
# ---------------------------------------------------------------------------


class SupportsClone(Protocol):
    """Optional hook for target cloning per parallel job."""

    def clone(self) -> AgentTarget:
        """Return a fresh target instance."""
        ...


class SupportsTokenUsage(Protocol):
    """Optional hook for exposing token usage from last target call."""

    def consume_last_token_usage(self) -> TokenUsage | None:
        """Return and clear usage from last call."""
        ...


class SupportsTargetMetadata(Protocol):
    """Optional hook for backend-specific target metadata."""

    def target_metadata(self) -> dict[str, object]:
        """Return provider/target metadata for diagnostics."""
        ...


class SupportsAgentContext(Protocol):
    """Optional: target provides its own agent context (tools, description, etc.)."""

    async def get_agent_context(self) -> AgentContext:
        """Return agent context for strategy generation and reporting."""
        ...


class SupportsTargetFactory(Protocol):
    """Optional: target can create per-job instances.

    Needed for parallel job safety and ORQ memory_entity_id routing.
    """

    def create_target(self, agent_key: str, memory_entity_id: str | None = None) -> AgentTarget:
        """Create a new AgentTarget for the given agent key."""
        ...


class SupportsMemoryCleanup(Protocol):
    """Optional: target can clean up memory entities it created."""

    async def cleanup_memory(self, agent_context: AgentContext, entity_ids: list[str]) -> None:
        """Delete memory entities created during a red teaming run."""
        ...


class SupportsErrorMapping(Protocol):
    """Optional: target provides custom error classification."""

    def map_error(self, exc: Exception) -> tuple[str, str]:
        """Return normalized (error_code, error_message)."""
        ...


# ---------------------------------------------------------------------------
# Legacy protocols (kept for backward compatibility)
# ---------------------------------------------------------------------------


class AgentContextProvider(Protocol):
    """Protocol for retrieving agent context (tools, memory, system prompt)."""

    async def get_agent_context(self, agent_key: str) -> AgentContext:
        """Retrieve full agent context for the given key."""
        ...


class AgentTargetFactory(Protocol):
    """Protocol for creating AgentTarget instances per job."""

    def create_target(self, agent_key: str, memory_entity_id: str | None = None) -> AgentTarget:
        """Create a new AgentTarget for the given agent key."""
        ...


class MemoryCleanup(Protocol):
    """Protocol for cleaning up memory entities created during red teaming."""

    async def cleanup_memory(self, agent_context: AgentContext, entity_ids: list[str]) -> None:
        """Delete memory entities created during a red teaming run."""
        ...


class ErrorMapper(Protocol):
    """Protocol for backend-specific exception normalization."""

    def map_error(self, exc: Exception) -> tuple[str, str]:
        """Return normalized (error_code, error_message)."""
        ...


# ---------------------------------------------------------------------------
# Runtime helpers
# ---------------------------------------------------------------------------


def is_agent_target(obj: object) -> bool:
    """Check if *obj* satisfies the :class:`AgentTarget` protocol at runtime."""
    return callable(getattr(obj, 'send_prompt', None)) and callable(getattr(obj, 'reset_conversation', None))


# ---------------------------------------------------------------------------
# Fallback / default implementations
# ---------------------------------------------------------------------------


class DefaultErrorMapper:
    """Fallback error mapper for unknown backends."""

    def map_error(self, exc: Exception) -> tuple[str, str]:
        return 'target_error', f'{type(exc).__name__}: {exc}'


class DirectTargetFactory:
    """Factory that wraps a pre-built :class:`AgentTarget`.

    Uses ``clone()`` if available, otherwise reuses the same instance
    (with a one-time warning about potential race conditions).
    """

    def __init__(self, target: AgentTarget) -> None:
        self._target = target
        self._clone_fn = getattr(target, 'clone', None) if callable(getattr(target, 'clone', None)) else None
        if self._clone_fn is None:
            logger.warning(
                f'Target {type(target).__name__} does not implement clone(). '
                f'Reusing the same instance across parallel jobs may cause race conditions. '
                f'Consider implementing clone() or SupportsTargetFactory.create_target().'
            )

    def create_target(self, agent_key: str, memory_entity_id: str | None = None) -> AgentTarget:
        if self._clone_fn is not None:
            return self._clone_fn()
        return self._target


class NoopMemoryCleanup:
    """No-op cleanup for targets without managed memory stores."""

    async def cleanup_memory(self, agent_context: AgentContext, entity_ids: list[str]) -> None:
        logger.debug('Skipping memory cleanup: target has no managed memory API')


@dataclass(slots=True)
class BackendBundle:
    """Bundle of backend components.

    .. deprecated::
        Targets now self-describe their capabilities via optional protocols.
        This class is kept for backward compatibility only.
    """

    name: str
    target_factory: AgentTargetFactory
    context_provider: AgentContextProvider
    memory_cleanup: MemoryCleanup
    error_mapper: ErrorMapper


# ---------------------------------------------------------------------------
# Error extraction utilities
# ---------------------------------------------------------------------------


def extract_status_code(exc: Exception) -> int | None:
    """Extract HTTP-like status code from structured exception fields or text."""
    # Structured response.status_code (httpx/openai-like)
    response = getattr(exc, 'response', None)
    status_code = getattr(response, 'status_code', None)
    if isinstance(status_code, int) and 100 <= status_code <= 599:
        return status_code

    # Some SDKs expose status/status_code directly on exception.
    for attr in ('status_code', 'status'):
        value = getattr(exc, attr, None)
        if isinstance(value, int) and 100 <= value <= 599:
            return value

    # Fallback to regex on raw error text.
    text = str(exc)
    patterns = [
        r'\bstatus(?:_code)?\s*[=:]\s*(\d{3})\b',
        r'\bHTTP\s*(\d{3})\b',
        r'\bcode\s*[=:]\s*(\d{3})\b',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        code = int(match.group(1))
        if 100 <= code <= 599:
            return code
    return None


def extract_provider_error_code(exc: Exception) -> str | None:
    """Extract provider-specific symbolic error code if present."""
    # Common structured fields.
    for attr in ('code', 'error_code', 'type'):
        value = getattr(exc, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()

    body = getattr(exc, 'body', None)
    if isinstance(body, dict):
        error = body.get('error') if isinstance(body.get('error'), dict) else body
        for key in ('code', 'type', 'error_code'):
            value = error.get(key) if isinstance(error, dict) else None
            if isinstance(value, str) and value.strip():
                return value.strip().lower()

    text = str(exc)
    patterns = [
        r'\b(?:error_)?code\s*[=:]\s*["\']?([a-z0-9_.-]+)["\']?',
        r'\btype\s*[=:]\s*["\']?([a-z0-9_.-]+)["\']?',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip().lower()
    return None
