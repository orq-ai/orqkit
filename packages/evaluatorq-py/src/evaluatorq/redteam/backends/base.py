"""Backend protocols for dynamic red teaming agent targets.

Defines the abstract interfaces that any agent backend must implement.
The ORQ implementation lives in ``backends.orq``; other backends (HTTP,
LangChain, custom callables) can implement these protocols independently.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from loguru import logger

from evaluatorq.redteam.contracts import AgentResponse

if TYPE_CHECKING:
    from evaluatorq.redteam.contracts import AgentContext, TokenUsage


class AgentTarget(ABC):
    """Abstract base class for agent targets that can receive prompts.

    Subclasses must implement ``send_prompt`` and ``new``. Targets that back a
    server-side memory store override ``get_agent_context``; otherwise the
    default minimal context is returned. ``memory_entity_id`` is an instance
    attribute (set in ``__init__``) so subclasses can mutate it without
    shadowing a class default.
    """

    def __init__(self, memory_entity_id: str | None = None) -> None:
        self.memory_entity_id = memory_entity_id

    @abstractmethod
    async def send_prompt(self, prompt: str) -> AgentResponse:
        """Send a prompt; return the response."""
        ...

    @abstractmethod
    def new(self) -> AgentTarget:
        """Return a fresh independent instance for a new attack."""
        ...

    async def get_agent_context(self) -> AgentContext:
        """Default: minimal context. Override for platform-backed targets."""
        from evaluatorq.redteam.contracts import AgentContext
        return AgentContext(key=getattr(self, "agent_key", "unknown"))


def _coerce_to_agent_response(raw: Any) -> AgentResponse:
    """Wrap a plain str return into AgentResponse for backward-compat with legacy targets.

    Any target that still returns ``str`` from ``send_prompt`` will be transparently
    wrapped here at the orchestrator call site.
    """
    from evaluatorq.redteam.contracts import OutputMessage, TextOutputItem
    if isinstance(raw, AgentResponse):
        return raw
    text_item: OutputMessage = TextOutputItem(text=str(raw) if raw is not None else '', annotations=[])
    return AgentResponse(output=[text_item])


class SupportsClone(Protocol):
    """Optional hook for target cloning per parallel job.

    Note: The runner detects this via duck-typing (``getattr``/``callable``),
    not ``isinstance``.  Implementing this protocol is recommended for
    documentation and static analysis but not strictly required.

    Clones are expected to own their own ``memory_entity_id`` (fresh one when
    the target backs a persistent memory store; ``None`` otherwise).
    """

    def clone(self) -> AgentTarget:
        """Return a fresh target instance with isolated state."""
        ...


class SupportsTokenUsage(Protocol):
    """Optional hook for exposing token usage from last target call.

    Deprecated: ``AgentResponse.usage`` is the canonical channel for token usage.
    Implementing this protocol is no longer required.
    """

    def consume_last_token_usage(self) -> 'TokenUsage | None':
        """Return and clear usage from last call."""
        ...


class SupportsTargetMetadata(Protocol):
    """Optional hook for backend-specific target metadata."""

    def target_metadata(self) -> dict[str, object]:
        """Return provider/target metadata for diagnostics."""
        ...


class SupportsAgentContext(Protocol):
    """Optional: target provides its own agent context."""

    async def get_agent_context(self) -> AgentContext: ...


class SupportsTargetFactory(Protocol):
    """Optional: target can create per-job instances.

    The factory owns no memory-entity concern. Targets that manage persistent
    memory generate their own ``memory_entity_id`` when constructed; callers
    read it off the resulting target.
    """

    def create_target(self, agent_key: str) -> AgentTarget: ...


class SupportsMemoryCleanup(Protocol):
    """Optional: target can clean up memory entities."""

    async def cleanup_memory(self, agent_context: AgentContext, entity_ids: list[str]) -> None: ...


class SupportsErrorMapping(Protocol):
    """Optional: target provides custom error classification."""

    def map_error(self, exc: Exception) -> tuple[str, str]: ...


def is_agent_target(obj: object) -> bool:
    """Return True if obj satisfies the AgentTarget protocol at runtime.

    Checks for ``send_prompt`` and ``new``.
    """
    has_send = callable(getattr(obj, 'send_prompt', None))
    has_new = callable(getattr(obj, 'new', None))
    return has_send and has_new


def validate_agent_target(obj: object) -> None:
    """Raise ``TypeError`` if ``obj`` implements only the removed ``clone()`` API.

    The check fires only when the object has ``clone()`` but neither
    ``send_prompt`` nor ``new()`` — i.e. a clone-only object that cannot be
    used as an :class:`AgentTarget` at all. Objects that implement the full
    protocol (``send_prompt`` + ``new``) are accepted regardless of whether
    they also define ``clone``.
    """
    has_send = callable(getattr(obj, 'send_prompt', None))
    has_new = callable(getattr(obj, 'new', None))
    if not has_send and not has_new and callable(getattr(obj, 'clone', None)):
        raise TypeError(
            f"{type(obj).__name__} implements 'clone()' which was removed in evaluatorq 1.3. "
            "Rename it to 'new(self) -> AgentTarget' — signature is the same, no memory_entity_id param."
        )


class DirectTargetFactory:
    """Fallback factory that wraps a bare AgentTarget."""

    def __init__(self, target: AgentTarget) -> None:
        self._target = target

    def create_target(self, agent_key: str) -> AgentTarget:
        result = self._target.new()
        if result is None:  # pyright: ignore[reportUnnecessaryComparison]
            raise TypeError(
                f"{type(self._target).__name__}.new() returned None. "
                "It must return a fresh AgentTarget instance."
            )
        return result


class NoopMemoryCleanup:
    """No-op memory cleanup for targets that do not manage memory stores."""

    async def cleanup_memory(self, agent_context: AgentContext, entity_ids: list[str]) -> None:
        logger.debug('Skipping memory cleanup: target does not manage memory stores')


class AgentContextProvider(Protocol):
    """Protocol for retrieving agent context (tools, memory, system prompt)."""

    async def get_agent_context(self, agent_key: str) -> AgentContext:
        """Retrieve full agent context for the given key."""
        ...


class AgentTargetFactory(Protocol):
    """Protocol for creating AgentTarget instances per job.

    The returned target owns its own ``memory_entity_id`` (auto-generated for
    targets with persistent memory, ``None`` otherwise). Callers read the
    attribute off the target rather than passing an ID in.
    """

    def create_target(self, agent_key: str) -> AgentTarget:
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


@dataclass(slots=True)
class BackendBundle:
    """Bundle of backend components used by dynamic runtime."""

    name: str
    target_factory: AgentTargetFactory
    context_provider: AgentContextProvider
    memory_cleanup: MemoryCleanup
    error_mapper: ErrorMapper


class DefaultErrorMapper:
    """Fallback error mapper for unknown backends."""

    def map_error(self, exc: Exception) -> tuple[str, str]:
        return 'target_error', f'{type(exc).__name__}: {exc}'


class Backend(ABC):
    """Backend ABC. Owns target construction, memory cleanup, and error mapping.

    Subclasses must implement ``create_target`` and ``cleanup_memory``.
    ``map_error`` has a sensible default; override for provider-specific
    HTTP/status-code mapping.
    """

    def __init__(self, name: str) -> None:
        self.name = name

    @abstractmethod
    def create_target(self, agent_key: str) -> AgentTarget:
        """Create a new AgentTarget for the given agent key."""
        ...

    @abstractmethod
    async def cleanup_memory(self, ctx: AgentContext, entity_ids: list[str]) -> None:
        """Delete memory entities created during a red teaming run."""
        ...

    def map_error(self, exc: Exception) -> tuple[str, str]:
        """Return normalized ``(error_code, error_message)``."""
        return "target_error", f"{type(exc).__name__}: {exc}"
