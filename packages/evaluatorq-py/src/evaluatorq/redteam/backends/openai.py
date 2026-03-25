"""OpenAI SDK backend implementation for dynamic red teaming."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from loguru import logger

from evaluatorq.redteam.backends.base import (
    NoopMemoryCleanup as NoopMemoryCleanup,  # noqa: F401 — re-export for backward compat
    extract_provider_error_code,
    extract_status_code,
)
from evaluatorq.redteam.contracts import AgentContext

if TYPE_CHECKING:
    from openai import AsyncOpenAI
    from openai.types.chat import ChatCompletionMessageParam


class OpenAIModelTarget:
    """Target adapter that treats ``agent_key`` as an OpenAI model identifier.

    Implements all optional capability protocols so it can be used directly
    with ``red_team(target)`` or resolved from a ``"openai:<model>"`` string.
    """

    def __init__(
        self,
        model_id: str,
        client: AsyncOpenAI,
        system_prompt: str | None = None,
    ):
        self.model_id: str = model_id
        self.client: AsyncOpenAI = client
        self.system_prompt: str = system_prompt or 'You are a helpful assistant.'
        self._messages: list[dict[str, str]] = [
            {'role': 'system', 'content': self.system_prompt},
        ]

    @property
    def name(self) -> str:
        """Label used in reports."""
        return self.model_id

    async def send_prompt(self, prompt: str) -> str:
        self._messages.append({'role': 'user', 'content': prompt})
        response = await self.client.chat.completions.create(
            model=self.model_id,
            messages=cast('list[ChatCompletionMessageParam]', self._messages),
        )
        content = response.choices[0].message.content or ''
        self._messages.append({'role': 'assistant', 'content': content})
        return content

    def reset_conversation(self) -> None:
        """Reset conversation history, keeping only the system prompt."""
        self._messages = [
            {'role': 'system', 'content': self.system_prompt},
        ]

    def clone(self) -> OpenAIModelTarget:
        """Create a fresh target instance for parallel job safety."""
        return OpenAIModelTarget(
            model_id=self.model_id,
            client=self.client,
            system_prompt=self.system_prompt,
        )

    # -- SupportsAgentContext --------------------------------------------------

    async def get_agent_context(self) -> AgentContext:
        """Return minimal agent context (no tools/memory/KB for raw model)."""
        return AgentContext(
            key=self.model_id,
            display_name=self.model_id,
            description='OpenAI model target',
            model=self.model_id,
        )

    # -- SupportsTargetFactory -------------------------------------------------

    def create_target(self, agent_key: str, memory_entity_id: str | None = None) -> OpenAIModelTarget:
        """Create a new target for the given model."""
        return OpenAIModelTarget(model_id=agent_key, client=self.client, system_prompt=self.system_prompt)

    # -- SupportsErrorMapping --------------------------------------------------

    def map_error(self, exc: Exception) -> tuple[str, str]:
        """Classify OpenAI exceptions."""
        return OpenAIErrorMapper().map_error(exc)


def create_openai_target(model_id: str, client: AsyncOpenAI | None = None) -> OpenAIModelTarget:
    """Create an :class:`OpenAIModelTarget`, building a client from env if needed.

    Args:
        model_id: Model identifier (e.g., ``"gpt-4o"``).
        client: Optional pre-configured :class:`AsyncOpenAI` client. If *None*,
            one is created via :func:`create_async_llm_client`.
    """
    from evaluatorq.redteam.backends.registry import create_async_llm_client

    resolved = client or create_async_llm_client()
    return OpenAIModelTarget(model_id=model_id, client=resolved)


# ---------------------------------------------------------------------------
# Legacy classes (kept for backward compatibility)
# ---------------------------------------------------------------------------


class OpenAIContextProvider:
    """Context provider for plain model targets.

    .. deprecated::
        Use ``OpenAIModelTarget.get_agent_context()`` instead.
    """

    async def get_agent_context(self, agent_key: str) -> AgentContext:
        logger.info(f'Using OpenAI model target context for model={agent_key}')
        return AgentContext(
            key=agent_key,
            display_name=agent_key,
            description='OpenAI model target',
            tools=[],
            memory_stores=[],
            knowledge_bases=[],
            model=agent_key,
        )


class OpenAITargetFactory:
    """Factory creating OpenAI model targets.

    .. deprecated::
        Use :func:`create_openai_target` or ``OpenAIModelTarget.create_target()`` instead.
    """

    def __init__(self, client: AsyncOpenAI):
        self._client: AsyncOpenAI = client

    def create_target(self, agent_key: str, memory_entity_id: str | None = None) -> OpenAIModelTarget:
        _ = memory_entity_id
        return OpenAIModelTarget(model_id=agent_key, client=self._client)


class OpenAIErrorMapper:
    """Normalize OpenAI exceptions into runtime error taxonomy."""

    def map_error(self, exc: Exception) -> tuple[str, str]:
        name = type(exc).__name__.lower()
        status_code = extract_status_code(exc)
        provider_code = extract_provider_error_code(exc)

        if status_code is not None:
            return f'openai.http.{status_code}', f'{type(exc).__name__}: {exc}'
        if provider_code:
            return f'openai.code.{provider_code}', f'{type(exc).__name__}: {exc}'
        if 'ratelimit' in name:
            return 'openai.rate_limit', f'{type(exc).__name__}: {exc}'
        if 'authentication' in name:
            return 'openai.auth', f'{type(exc).__name__}: {exc}'
        if 'timeout' in name:
            return 'openai.timeout', f'{type(exc).__name__}: {exc}'
        return 'openai.unknown', f'{type(exc).__name__}: {exc}'
