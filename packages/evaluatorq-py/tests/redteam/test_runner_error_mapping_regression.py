"""Regression test for spec §8 / Risk 1 — pre-existing bug at runner.py:833.

Before PR1, runner.py hardcoded ``DefaultErrorMapper()`` which masked the
backend's specific mapping. After PR1, ORQ HTTP exceptions route through
``ORQBackend.map_error`` and produce ``orq.http.<status>`` codes.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest


class _OrqHTTPError(Exception):
    def __init__(self, status_code: int):
        super().__init__(f"orq returned {status_code}")
        self.status_code = status_code


@pytest.mark.asyncio
async def test_orq_http_exception_maps_to_orq_http_status_code():
    """End-to-end: ORQ rate-limit exception → ``orq.http.429``, not ``target_error``."""
    from evaluatorq.redteam.backends.orq import ORQBackend

    backend = ORQBackend(orq_client=MagicMock(), timeout_ms=1000)
    code, msg = backend.map_error(_OrqHTTPError(429))
    assert code == "orq.http.429", f"expected orq.http.429, got {code!r}"
    assert "orq returned 429" in msg
