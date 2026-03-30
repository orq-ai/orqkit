"""Shared retry helper for LLM API calls."""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

from openai import APIStatusError

logger = logging.getLogger(__name__)

MAX_RETRY_ATTEMPTS = 5
RETRY_MIN_WAIT_S = 2.0
RETRY_MAX_WAIT_S = 60.0

T = TypeVar("T")


def _is_retryable_status(status: int | None) -> bool:
    if status is None:
        return False
    return status == 429 or status >= 500


async def with_retry(
    fn: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = MAX_RETRY_ATTEMPTS,
    label: str = "API call",
) -> T:
    """Execute an async callable with exponential backoff on retryable errors.

    Retries on rate-limit (429) and server errors (500+). All other errors
    are raised immediately.
    """
    last_error: Exception = RuntimeError("with_retry: no attempts made")

    for attempt in range(1, max_attempts + 1):
        try:
            return await fn()
        except Exception as err:
            last_error = err
            status = err.status_code if isinstance(err, APIStatusError) else None

            if not _is_retryable_status(status):
                raise

            if attempt < max_attempts:
                base_wait = RETRY_MIN_WAIT_S * (2 ** (attempt - 1))
                wait_s = min(base_wait, RETRY_MAX_WAIT_S)
                jitter = random.uniform(0, wait_s * 0.1)  # noqa: S311
                logger.warning(
                    "%s: attempt %d/%d failed (status=%s), retrying in %.1fs",
                    label,
                    attempt,
                    max_attempts,
                    status,
                    wait_s + jitter,
                )
                await asyncio.sleep(wait_s + jitter)

    raise last_error
