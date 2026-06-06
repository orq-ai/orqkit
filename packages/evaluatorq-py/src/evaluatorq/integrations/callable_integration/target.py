"""Red teaming target wrapper for arbitrary callables."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

from evaluatorq.contracts import AgentTarget, Message
from evaluatorq.redteam.contracts import AgentContext, AgentResponse, OutputMessage, TextOutputItem, TokenUsage

# Accepted callable signatures — receive the conversation as a list of OpenAI
# chat-format message dicts (``{"role", "content"}`` plus tool fields). The list
# holds one message for the opening turn and grows with each turn, so the same
# callable handles single- and multi-turn red teaming. May return ``str`` or
# :class:`AgentResponse`.
AgentCallable = (
    Callable[[list[dict[str, Any]]], Awaitable[AgentResponse]]
    | Callable[[list[dict[str, Any]]], Awaitable[str]]
    | Callable[[list[dict[str, Any]]], AgentResponse]
    | Callable[[list[dict[str, Any]]], str]
)


class CallableTarget(AgentTarget):
    """Wraps any sync or async function as a red teaming target.

    Use this as an escape hatch for frameworks that don't have a dedicated
    integration. You provide a function that takes the conversation (a list of
    OpenAI chat-format message dicts) and returns a response — the wrapper
    handles the rest. The list contains one message on the opening turn and
    every prior turn on later turns, so a stateless callable still sees full
    context, matching the stateless OpenAI / Vercel / OpenAI-Agents targets.

    Usage::

        from evaluatorq.integrations.callable_integration import CallableTarget

        # Async function — receives the whole conversation
        async def my_agent(messages: list[dict]) -> str:
            result = await some_framework.run(messages)
            return result.text

        target = CallableTarget(my_agent)

        # A simple sync function (reads the last user turn off the list)
        target = CallableTarget(lambda messages: "I can't help with that.")

        # Plumb token counts via usage_fn
        def get_usage(prompt: str, response: str) -> TokenUsage:
            return TokenUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15, calls=1)

        target = CallableTarget(my_agent, usage_fn=get_usage)

        # Pass to red teaming
        config = DynamicRunConfig(targets=[target])
    """

    def __init__(
        self,
        fn: AgentCallable,
        *,
        reset_fn: Callable[[], None] | None = None,
        usage_fn: Callable[[str, str], TokenUsage | None] | None = None,
        agent_context: AgentContext | None = None,
    ) -> None:
        """Create a callable red teaming target.

        Args:
            fn: A sync or async function taking the conversation as a ``list[dict]``
                in OpenAI chat format (``{"role", "content"}`` plus tool fields) and
                returning a ``str`` or an :class:`AgentResponse`. The list grows by
                one user turn each round, so the same callable serves single- and
                multi-turn runs.
            reset_fn: Optional callback invoked on ``new()`` to clear shared callable state between attacks.
            usage_fn: Optional callable taking ``(prompt, response) -> TokenUsage | None``.
                Use this to plumb token counts from your underlying framework when the
                callable itself only returns a string. ``prompt`` is the last user
                turn. The function must be synchronous; async usage extraction is not
                supported. Exceptions raised by ``usage_fn`` are logged as warnings
                and result in ``usage=None``.
            agent_context: Optional :class:`AgentContext` describing the wrapped
                callable's tools, memory, system prompt, etc. The red teaming
                pipeline uses this for capability-aware strategy filtering —
                without it, all strategies (including nonsensical ones) will be
                applied. If not provided, a minimal context is returned.
        Callables are opaque — the wrapper cannot manage memory isolation.
        If the wrapped callable holds state, use ``reset_fn`` to clear it.
        """
        super().__init__(memory_entity_id=None)
        self._fn = fn
        self._is_async = asyncio.iscoroutinefunction(fn)
        self._reset_fn = reset_fn
        self._usage_fn = usage_fn
        self._agent_context = agent_context

    async def respond(self, messages: list[Message]) -> AgentResponse:
        """Send the conversation to the wrapped callable; return a structured response.

        Forwards the full transcript as a list of OpenAI chat-format dicts —
        preserving tool turns — so a stateless callable sees prior context.
        The list holds a single message on the opening turn and grows each
        round. Callables that return a plain ``str`` are wrapped in an
        :class:`AgentResponse`; those returning :class:`AgentResponse` pass
        through. Token usage from ``usage_fn`` (if provided) is attached to the
        returned ``AgentResponse``.
        """
        if not messages or messages[-1].role != "user":
            raise ValueError("CallableTarget.respond requires messages[-1].role == 'user'")
        prompt = messages[-1].content or ""
        convo = [m.to_chat_completion() for m in messages]
        fn: Callable[[list[dict[str, Any]]], Any] = self._fn
        try:
            if self._is_async:
                result = await fn(convo)
            else:
                result = await asyncio.to_thread(fn, convo)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            raise
        except Exception as exc:
            raise RuntimeError(f"CallableTarget: callable raised {exc!r}") from exc

        if isinstance(result, AgentResponse):
            return result
        text = str(result) if result is not None else ""
        usage: TokenUsage | None = None
        if self._usage_fn is not None:
            try:
                usage = self._usage_fn(prompt, text)
            except Exception:
                logger.exception("usage_fn raised an exception; using usage=None")
        text_item: OutputMessage = TextOutputItem(text=text, annotations=[])
        return AgentResponse(output=[text_item], usage=usage)

    async def get_agent_context(self) -> AgentContext:
        """Return the user-provided agent context, or a minimal placeholder."""
        if self._agent_context is not None:
            return self._agent_context
        key = getattr(self._fn, "__name__", None) or "callable_target"
        return AgentContext(key=str(key), description="opaque callable target")

    def new(self) -> CallableTarget:
        """Return a fresh copy sharing the same callable, with state reset via reset_fn."""
        if self._reset_fn is not None:
            self._reset_fn()
        return CallableTarget(
            self._fn,
            reset_fn=self._reset_fn,
            usage_fn=self._usage_fn,
            agent_context=self._agent_context,
        )
