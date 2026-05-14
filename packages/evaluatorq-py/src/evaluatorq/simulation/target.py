"""Simulation target implementations backed by the Orq Responses API."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from loguru import logger

from evaluatorq.contracts import AgentResponse, LLMCallConfig
from evaluatorq.simulation._client import build_simulation_client, extract_responses_output
from evaluatorq.simulation.types import ChatMessage, TokenUsage
from evaluatorq.simulation.utils.retry import with_retry

if TYPE_CHECKING:
    from openai import AsyncOpenAI


class OrqResponsesTarget:
    """Wraps the Orq Responses v3 API as a simulation target.

    Implements both the sim callable shape (__call__) and the redteam
    AgentTarget protocol (send_prompt + new).

    Multi-turn state is threaded via previous_response_id — each instance
    tracks its own conversation thread. Call new() to start fresh.
    """

    memory_entity_id: str | None  # AgentTarget protocol field

    def __init__(
        self,
        config: LLMCallConfig,
        *,
        instructions: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        memory_entity_id: str | None = None,
        client: AsyncOpenAI | None = None,
    ) -> None:
        self.config = config
        self.instructions = instructions
        self.tools = tools
        self.memory_entity_id = memory_entity_id
        self._previous_response_id: str | None = None
        self._accumulated_usage = TokenUsage()
        if client is not None:
            self._client = client
            self._client_owned = False
        else:
            self._client, self._client_owned = build_simulation_client(config.client)


    async def __call__(self, messages: list[ChatMessage]) -> str:
        """Sim target_callback shape. Sends full message list each turn.

        Forks a fresh instance via new() before invoking so that this call
        never touches self._previous_response_id or self._accumulated_usage.
        The forked instance is discarded after the call; the sim runner owns
        usage accounting independently of the redteam AgentTarget state.
        """
        fork = self.new()
        result = await fork._invoke(input_=self._messages_to_input(messages))
        return result.text


    async def send_prompt(self, prompt: str) -> AgentResponse:
        """Redteam AgentTarget protocol shape."""
        return await self._invoke(input_=prompt)

    def new(self) -> OrqResponsesTarget:
        """Return a fresh instance with identical config but cleared state.

        Externally-injected clients (client_owned=False) are propagated to the
        new instance so callers sharing a single HTTP connection continue to do
        so. Self-owned clients are not propagated — the new instance builds its
        own from env vars, keeping connection lifetimes independent.

        Per AgentTarget protocol, each new() call must produce an independent
        memory scope, so we mint a fresh memory_entity_id if one was set.
        """
        import uuid

        fresh_memory_id = (
            str(uuid.uuid4()) if self.memory_entity_id is not None else None
        )

        return OrqResponsesTarget(
            self.config,
            instructions=self.instructions,
            tools=self.tools,
            memory_entity_id=fresh_memory_id,
            client=self._client if not self._client_owned else None,
        )


    async def _invoke(self, *, input_: str | list[dict[str, Any]]) -> AgentResponse:
        """Core invocation: calls client.responses.create, threads previous_response_id.

        Applies retry logic (rate-limit / server errors) via :func:`with_retry`
        and converts :class:`asyncio.TimeoutError` into a descriptive
        :class:`RuntimeError` so callers get a useful message.
        """
        timeout_s = self.config.timeout_ms / 1000.0 if self.config.timeout_ms else None

        async def _do_call() -> AgentResponse:
            kwargs: dict[str, Any] = {
                "model": self.config.model,
                "input": input_,
            }
            if self.tools:
                kwargs["tools"] = self.tools
            if self.instructions is not None:
                kwargs["instructions"] = self.instructions
            if self._previous_response_id is not None:
                kwargs["previous_response_id"] = self._previous_response_id

            coro = self._client.responses.create(**kwargs)
            response = await (
                asyncio.wait_for(coro, timeout=timeout_s) if timeout_s else coro
            )

            # Thread the conversation via previous_response_id
            response_id = getattr(response, "id", None)
            if isinstance(response_id, str) and response_id:
                self._previous_response_id = response_id
            else:
                logger.warning(
                    "OrqResponsesTarget._invoke: response missing 'id'; "
                    "conversation threading disabled (model={})",
                    self.config.model,
                )

            # Extract output items and usage via shared helper
            output_items, usage = extract_responses_output(response)

            if not output_items:
                raise RuntimeError(
                    f"OrqResponsesTarget._invoke: response contained no extractable "
                    f"output items (model={self.config.model}). This likely indicates "
                    f"an API error or unexpected response format."
                )

            # Accumulate token usage
            self._accumulated_usage = TokenUsage(
                prompt_tokens=self._accumulated_usage.prompt_tokens + usage.prompt_tokens,
                completion_tokens=self._accumulated_usage.completion_tokens + usage.completion_tokens,
                total_tokens=self._accumulated_usage.total_tokens + usage.total_tokens,
            )

            return AgentResponse(output=output_items)

        try:
            return await with_retry(_do_call, label="OrqResponsesTarget._invoke")
        except asyncio.TimeoutError as e:
            raise RuntimeError(
                f"OrqResponsesTarget._invoke timed out after {timeout_s}s "
                f"(model={self.config.model})"
            ) from e

    @staticmethod
    def _messages_to_input(messages: list[ChatMessage]) -> list[dict[str, Any]]:
        return [{"role": m.role, "content": m.content} for m in messages]

    def get_usage(self) -> TokenUsage:
        """Return cumulative token usage across all _invoke calls on this instance."""
        return self._accumulated_usage.model_copy()


__all__ = ["OrqResponsesTarget"]
