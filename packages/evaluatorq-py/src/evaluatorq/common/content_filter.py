"""Provider content-filter detection on the OpenAI-compatible wire protocol.

Domain-neutral: any caller making chat-completion calls through the Orq router (or
OpenAI directly) can use these to tell a *structural* content-filter block apart from
a model's natural-language self-refusal. Two shapes exist, both normalized to the
``content_filter`` code by the router:

1. 200 response with ``finish_reason='content_filter'`` (canonical OpenAI signal).
2. HTTP error with structured ``code='content_filter'`` — verified empirically: Azure
   via the Orq router raises ``openai.BadRequestError`` (HTTP 400) this way.

A model that self-censors in prose is deliberately NOT detected: at the protocol level
it is indistinguishable from a real response (``finish_reason='stop'``, no ``refusal``
field — verified for Anthropic and Gemini via the Orq router), so it is left for the
caller to forward downstream rather than treated as a block.
"""

from __future__ import annotations

from typing import Literal


def classify_finish_reason(finish_reason: str | None) -> Literal['content_filter'] | None:
    """Return ``'content_filter'`` when the provider blocked generation, else ``None``."""
    return 'content_filter' if finish_reason == 'content_filter' else None


def is_content_filter_error(exc: BaseException) -> bool:
    """Return True if ``exc`` is a provider content-filter block surfaced as an error.

    Keys on the structured error ``code`` (exposed by the OpenAI SDK as ``exc.code`` and
    mirrored in the JSON body), NOT on message prose, so it stays provider-agnostic for
    any block the router normalizes to that code.
    """
    if getattr(exc, 'code', None) == 'content_filter':
        return True
    body = getattr(exc, 'body', None)
    return isinstance(body, dict) and body.get('code') == 'content_filter'


__all__ = ['classify_finish_reason', 'is_content_filter_error']
