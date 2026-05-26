"""Tests for Backend ABC in redteam.backends.base."""
from __future__ import annotations

import pytest

from evaluatorq.redteam.backends.base import Backend


class _MinimalBackend(Backend):
    def create_target(self, agent_key):
        raise NotImplementedError

    async def cleanup_memory(self, ctx, entity_ids):
        return None


def test_backend_is_abstract():
    with pytest.raises(TypeError):
        Backend("x")  # type: ignore[abstract]


def test_backend_subclass_sets_name():
    b = _MinimalBackend("orq")
    assert b.name == "orq"


def test_default_map_error_returns_target_error_tuple():
    b = _MinimalBackend("orq")
    code, msg = b.map_error(RuntimeError("boom"))
    assert code == "target_error"
    assert "RuntimeError" in msg
    assert "boom" in msg


def test_orq_backend_map_error_includes_status_code():
    from evaluatorq.redteam.backends.orq import ORQBackend

    class _HTTPError(Exception):
        def __init__(self):
            super().__init__("boom")
            self.status_code = 429

    backend = ORQBackend(orq_client=object(), timeout_ms=1000)
    code, _ = backend.map_error(_HTTPError())
    assert code == "orq.http.429"
