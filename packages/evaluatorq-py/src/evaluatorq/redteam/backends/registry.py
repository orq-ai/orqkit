"""Backend resolution for dynamic red teaming runtime."""

from __future__ import annotations

import os

from openai import AsyncOpenAI

from evaluatorq.redteam.backends.base import BackendBundle
from evaluatorq.redteam.backends.openai import (
    NoopMemoryCleanup,
    OpenAIContextProvider,
    OpenAIErrorMapper,
    OpenAITargetFactory,
)
from evaluatorq.redteam.contracts import TargetConfig


ORQ_DEFAULT_BASE_URL = "https://my.orq.ai"
_ROUTER_SUFFIX = "/v2/router"


def create_async_llm_client() -> AsyncOpenAI:
    """Create an OpenAI-compatible async client.

    Preference order:
    1. Standard OpenAI env (``OPENAI_API_KEY`` + optional ``OPENAI_BASE_URL``)
    2. ORQ env (``ORQ_API_KEY`` + optional ``ORQ_BASE_URL``, defaults to https://my.orq.ai)

    When using ORQ, the router suffix ``/v2/router`` is appended automatically
    to produce the OpenAI-compatible completions endpoint.
    """
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if openai_api_key:
        openai_base_url = os.getenv("OPENAI_BASE_URL")
        kwargs: dict[str, str] = {"api_key": openai_api_key}
        if openai_base_url:
            kwargs["base_url"] = openai_base_url
        return AsyncOpenAI(**kwargs)

    orq_api_key = os.getenv("ORQ_API_KEY")
    if orq_api_key:
        base_url = os.getenv("ORQ_BASE_URL", ORQ_DEFAULT_BASE_URL).rstrip("/")
        router_url = f"{base_url}{_ROUTER_SUFFIX}"
        return AsyncOpenAI(api_key=orq_api_key, base_url=router_url)

    msg = (
        "Missing LLM credentials. Set either OPENAI_API_KEY (optionally OPENAI_BASE_URL) "
        "or ORQ_API_KEY (optionally ORQ_BASE_URL)."
    )
    raise RuntimeError(msg)


def resolve_backend(
    backend: str = "orq",
    llm_client: AsyncOpenAI | None = None,
    target_config: TargetConfig | None = None,
) -> BackendBundle:
    """Resolve runtime backend bundle with lazy optional imports.

    Args:
        backend: Backend name (``"orq"`` or ``"openai"``).
        llm_client: Pre-configured client for the OpenAI backend.
            When provided, skips ``create_async_llm_client()`` for
            the ``"openai"`` backend.
        target_config: Optional target configuration (e.g. system prompt).
    """
    system_prompt = target_config.system_prompt if target_config else None
    normalized = backend.strip().lower()
    if normalized == "openai":
        client = llm_client or create_async_llm_client()
        return BackendBundle(
            name="openai",
            target_factory=OpenAITargetFactory(client, system_prompt=system_prompt),
            context_provider=OpenAIContextProvider(system_prompt=system_prompt),
            memory_cleanup=NoopMemoryCleanup(),
            error_mapper=OpenAIErrorMapper(),
        )

    if normalized != "orq":
        msg = f"Unsupported backend: {backend!r}. Expected 'orq' or 'openai'."
        raise ValueError(msg)

    try:
        from evaluatorq.redteam.backends.orq import ORQErrorMapper, create_orq_backend
    except ImportError as exc:
        msg = "ORQ backend requested but ORQ dependencies are unavailable. Install ORQ extras or use backend='openai'."
        raise RuntimeError(msg) from exc

    target_factory, context_provider, memory_cleanup = create_orq_backend()
    return BackendBundle(
        name="orq",
        target_factory=target_factory,
        context_provider=context_provider,
        memory_cleanup=memory_cleanup,
        error_mapper=ORQErrorMapper(),
    )
