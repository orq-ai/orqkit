"""Tests for HybridAgentBackend composite backend."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from evaluatorq.redteam.backends.base import HybridAgentBackend
from evaluatorq.redteam.contracts import AgentContext


def _make_backend(name: str = "stub") -> MagicMock:
    """Return a MagicMock that quacks like a Backend."""
    backend = MagicMock(name=name)
    backend.resolve_context = AsyncMock()
    backend.cleanup_memory = AsyncMock()
    return backend


def test_create_target_prefixes_key_and_delegates_to_exec():
    context_backend = _make_backend("context")
    exec_backend = _make_backend("exec")
    sentinel_target = object()
    exec_backend.create_target.return_value = sentinel_target

    hybrid = HybridAgentBackend(context_backend=context_backend, exec_backend=exec_backend)
    result = hybrid.create_target("my-key")

    exec_backend.create_target.assert_called_once_with("agent/my-key")
    context_backend.create_target.assert_not_called()
    assert result is sentinel_target


@pytest.mark.asyncio
async def test_resolve_context_delegates_bare_key_to_context_backend():
    context_backend = _make_backend("context")
    exec_backend = _make_backend("exec")
    sentinel_ctx = AgentContext(key="my-key")
    context_backend.resolve_context.return_value = sentinel_ctx

    hybrid = HybridAgentBackend(context_backend=context_backend, exec_backend=exec_backend)
    result = await hybrid.resolve_context("my-key")

    context_backend.resolve_context.assert_called_once_with("my-key")
    exec_backend.resolve_context.assert_not_called()
    assert result is sentinel_ctx


@pytest.mark.asyncio
async def test_cleanup_memory_delegates_to_context_backend_not_exec():
    context_backend = _make_backend("context")
    exec_backend = _make_backend("exec")
    ctx = AgentContext(key="my-key")
    entity_ids = ["id-1", "id-2"]

    hybrid = HybridAgentBackend(context_backend=context_backend, exec_backend=exec_backend)
    await hybrid.cleanup_memory(ctx, entity_ids)

    context_backend.cleanup_memory.assert_called_once_with(ctx, entity_ids)
    exec_backend.cleanup_memory.assert_not_called()


def test_map_error_delegates_to_exec_backend():
    context_backend = _make_backend("context")
    exec_backend = _make_backend("exec")
    exec_backend.map_error.return_value = ("exec.error", "something went wrong")

    hybrid = HybridAgentBackend(context_backend=context_backend, exec_backend=exec_backend)
    exc = RuntimeError("boom")
    result = hybrid.map_error(exc)

    exec_backend.map_error.assert_called_once_with(exc)
    context_backend.map_error.assert_not_called()
    assert result == ("exec.error", "something went wrong")
