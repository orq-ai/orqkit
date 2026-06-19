from __future__ import annotations

# ruff: noqa: S101
from unittest.mock import AsyncMock, MagicMock

import pytest
from openai import LengthFinishReasonError
from pydantic import BaseModel

from evaluatorq.simulation.utils.structured_output import generate_structured


class SampleResponse(BaseModel):
    value: str


@pytest.mark.asyncio
async def test_generate_structured_falls_back_when_parse_hits_length_limit() -> None:
    parsed_completion = MagicMock()
    parse_error = LengthFinishReasonError(completion=parsed_completion)

    fallback_message = MagicMock()
    fallback_message.content = '{"value": "fallback"}'
    fallback_choice = MagicMock()
    fallback_choice.message = fallback_message
    fallback_response = MagicMock()
    fallback_response.choices = [fallback_choice]

    client = MagicMock()
    client.chat.completions.parse = AsyncMock(side_effect=parse_error)
    client.chat.completions.create = AsyncMock(return_value=fallback_response)

    parsed, raw = await generate_structured(
        client,
        model="local-model",
        messages=[{"role": "user", "content": "return json"}],
        response_format=SampleResponse,
        temperature=0.0,
        max_tokens=4000,
        label="Sample.generate",
    )

    assert parsed is None
    assert raw == '{"value": "fallback"}'
    client.chat.completions.create.assert_awaited_once()
