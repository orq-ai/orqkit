# RES-808 Collapse / Relocate / Unify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse 12 abstract types in `redteam/backends/base.py` to 2 ABCs (`AgentTarget`, `Backend`), relocate `AgentTarget` to `evaluatorq/contracts.py`, and unify `AgentTarget` + sim `TargetAgent` on a single `respond(messages) -> AgentResponse` method. Delivered as 3 stacked PRs.

**Architecture:** Backend ABC owns target factory + memory cleanup + error mapping. `AgentTarget` ABC owns `respond` + `new` + optional `get_agent_context`. `OrqResponsesTarget` becomes stateless. `ORQAgentTarget` keeps its existing `orq_client.agents.responses.create` endpoint and `task_id` threading — only signature conforms. `ChatMessage` moves to `evaluatorq/contracts.py` and gains `developer` role.

**Tech Stack:** Python 3.10+, `uv`, `pytest`, `pytest-asyncio`, `basedpyright`, `ruff`. Spec: `docs/superpowers/specs/2026-05-26-res-808-collapse-relocate-unify-design.md`.

**Working directory:** `packages/evaluatorq-py/`. All `uv` commands assume this CWD.

---

## File map

**PR1 — Collapse**

- Modify: `src/evaluatorq/redteam/backends/base.py` (Protocol→ABC for `AgentTarget`, add `Backend` ABC, add `_BareTargetBackend`, drop 9 dead types)
- Create: `src/evaluatorq/redteam/backends/_errors.py` (move `extract_status_code`, `extract_provider_error_code`)
- Modify: `src/evaluatorq/redteam/backends/orq.py` (fold `ORQContextProvider`/`ORQTargetFactory`/`ORQMemoryCleanup`/`ORQErrorMapper` into `ORQBackend` + `ORQAgentTarget`)
- Modify: `src/evaluatorq/redteam/backends/openai.py` (fold `OpenAIContextProvider`/`OpenAITargetFactory`/`OpenAIErrorMapper` into `OpenAIBackend` + `OpenAIModelTarget`)
- Modify: `src/evaluatorq/redteam/backends/registry.py` (registry returns `Backend`, not `BackendBundle`)
- Modify: `src/evaluatorq/redteam/runner.py` (replace BackendBundle accessors; fix `DefaultErrorMapper()` bug; use `_BareTargetBackend` for direct-target path)
- Modify: `src/evaluatorq/redteam/adaptive/pipeline.py`, `src/evaluatorq/redteam/adaptive/orchestrator.py` (import path updates)
- Modify: `src/evaluatorq/redteam/__init__.py` (remove `DirectTargetFactory`, 4 `Supports*`, `is_agent_target`)
- Test: `tests/redteam/test_backend_abc.py` (new)
- Test: `tests/redteam/test_bare_target_backend.py` (new)
- Test: `tests/redteam/test_backends.py` (update import paths to `_errors`)
- Test: `tests/redteam/e2e/conftest.py`, `tests/redteam/e2e/test_*.py` (replace `BackendBundle` with `Backend`)
- Test: `tests/unit/test_tool_call_interception.py` (kept import `_coerce_to_agent_response` — verify still works)

**PR2 — Relocate `AgentTarget` to `evaluatorq.contracts`**

- Modify: `src/evaluatorq/contracts.py` (add `AgentTarget` ABC)
- Modify: `src/evaluatorq/redteam/backends/base.py` (re-export `AgentTarget` from `contracts`; keep `Backend` here)
- Modify: 14 importers — switch `from evaluatorq.redteam.backends.base import AgentTarget` → `from evaluatorq.contracts import AgentTarget`

**PR3 — Unify on `respond(messages)`**

- Modify: `src/evaluatorq/contracts.py` (add `ChatMessage`, add abstract `respond` + concrete `send_prompt` shim on `AgentTarget`)
- Modify: `src/evaluatorq/simulation/types.py` (re-export shim for `ChatMessage`)
- Modify: `src/evaluatorq/simulation/target.py` (drop `__call__`, drop `_previous_response_id`, implement stateless `respond`)
- Modify: `src/evaluatorq/redteam/backends/orq.py` (`ORQAgentTarget.respond(messages)` — keeps endpoint, keeps task_id, takes only last user message)
- Modify: `src/evaluatorq/redteam/backends/openai.py` (`OpenAIModelTarget.respond`)
- Modify: `src/evaluatorq/integrations/{langgraph,callable,vercel_ai_sdk,openai_agents}_integration/target.py` (each implements `respond`)
- Modify: `src/evaluatorq/simulation/runner/simulation.py` (delete local `TargetAgent` Protocol; import `AgentTarget` from contracts; dispatch via `.respond`)
- Modify: `src/evaluatorq/simulation/api.py` (auto-route `target=AgentTarget` → target_agent path)
- Test: `tests/redteam/test_orq_responses_target_as_agent_target.py` (rewrite — drop `TestCallDoesNotCorruptAgentTargetState`, add `TestRespondIsStateless`)
- Test: `tests/integration/test_sim_redteam_target_roundtrip.py` (new)

---

# PR1 — Collapse

## Task 1.1: Add `Backend` ABC stub to `backends/base.py`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/base.py`

- [ ] **Step 1: Write failing test**

Create `tests/redteam/test_backend_abc.py`:

```python
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
```

- [ ] **Step 2: Run test, expect ImportError**

```bash
uv run pytest tests/redteam/test_backend_abc.py -v
```

Expected: `ImportError: cannot import name 'Backend' from 'evaluatorq.redteam.backends.base'`.

- [ ] **Step 3: Add `Backend` ABC**

Append to `src/evaluatorq/redteam/backends/base.py` (do not delete existing content yet):

```python
from abc import ABC, abstractmethod


class Backend(ABC):
    """Backend ABC. Owns target construction, memory cleanup, and error mapping.

    Subclasses must implement ``create_target`` and ``cleanup_memory``.
    ``map_error`` has a sensible default; override for provider-specific
    HTTP/status-code mapping.
    """

    def __init__(self, name: str) -> None:
        self.name = name

    @abstractmethod
    def create_target(self, agent_key: str) -> "AgentTarget":
        """Create a new AgentTarget for the given agent key."""
        ...

    @abstractmethod
    async def cleanup_memory(self, ctx: "AgentContext", entity_ids: list[str]) -> None:
        """Delete memory entities created during a red teaming run."""
        ...

    def map_error(self, exc: Exception) -> tuple[str, str]:
        """Return normalized ``(error_code, error_message)``."""
        return "target_error", f"{type(exc).__name__}: {exc}"
```

- [ ] **Step 4: Run test, expect PASS**

```bash
uv run pytest tests/redteam/test_backend_abc.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tests/redteam/test_backend_abc.py src/evaluatorq/redteam/backends/base.py
git commit -m "feat(redteam): add Backend ABC stub alongside existing types"
```

## Task 1.2: Extract HTTP/error helpers to `_errors.py`

**Files:**
- Create: `src/evaluatorq/redteam/backends/_errors.py`
- Modify: `src/evaluatorq/redteam/backends/base.py`, `orq.py`, `openai.py`
- Test: `tests/redteam/test_backends.py`

- [ ] **Step 1: Create `_errors.py` with the verbatim bodies**

`src/evaluatorq/redteam/backends/_errors.py`:

```python
"""Backend-internal exception extraction helpers.

Module-private. Used by ``ORQBackend.map_error`` and ``OpenAIBackend.map_error``.
"""

from __future__ import annotations

import re


def extract_status_code(exc: Exception) -> int | None:
    """Extract HTTP-like status code from structured exception fields or text."""
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int) and 100 <= status_code <= 599:
        return status_code

    for attr in ("status_code", "status"):
        value = getattr(exc, attr, None)
        if isinstance(value, int) and 100 <= value <= 599:
            return value

    text = str(exc)
    patterns = [
        r"\bstatus(?:_code)?\s*[=:]\s*(\d{3})\b",
        r"\bHTTP\s*(\d{3})\b",
        r"\bcode\s*[=:]\s*(\d{3})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        code = int(match.group(1))
        if 100 <= code <= 599:
            return code
    return None


def extract_provider_error_code(exc: Exception) -> str | None:
    """Extract provider-specific symbolic error code if present."""
    for attr in ("code", "error_code", "type"):
        value = getattr(exc, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()

    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error") if isinstance(body.get("error"), dict) else body
        for key in ("code", "type", "error_code"):
            value = error.get(key) if isinstance(error, dict) else None
            if isinstance(value, str) and value.strip():
                return value.strip().lower()

    text = str(exc)
    patterns = [
        r'\b(?:error_)?code\s*[=:]\s*["\']?([a-z0-9_.-]+)["\']?',
        r'\btype\s*[=:]\s*["\']?([a-z0-9_.-]+)["\']?',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip().lower()
    return None
```

- [ ] **Step 2: Update importers — `base.py`, `orq.py`, `openai.py`**

In `src/evaluatorq/redteam/backends/orq.py`, change:

```python
from evaluatorq.redteam.backends.base import extract_provider_error_code, extract_status_code
```

to:

```python
from evaluatorq.redteam.backends._errors import extract_provider_error_code, extract_status_code
```

Same change in `src/evaluatorq/redteam/backends/openai.py`.

In `src/evaluatorq/redteam/backends/base.py`, delete the `extract_status_code` (lines ~236-264) and `extract_provider_error_code` (lines ~267-292) definitions plus the `import re` at top (line 10). Do NOT delete the `DefaultErrorMapper` yet — that goes in Task 1.8.

- [ ] **Step 3: Update tests — `tests/redteam/test_backends.py`**

In `tests/redteam/test_backends.py`, replace every:

```python
from evaluatorq.redteam.backends.base import extract_status_code
```

```python
from evaluatorq.redteam.backends.base import extract_provider_error_code
```

with:

```python
from evaluatorq.redteam.backends._errors import extract_status_code
```

```python
from evaluatorq.redteam.backends._errors import extract_provider_error_code
```

(replace_all — there are ~22 occurrences total).

- [ ] **Step 4: Run affected tests**

```bash
uv run pytest tests/redteam/test_backends.py -v
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/backends/_errors.py src/evaluatorq/redteam/backends/base.py src/evaluatorq/redteam/backends/orq.py src/evaluatorq/redteam/backends/openai.py tests/redteam/test_backends.py
git commit -m "refactor(redteam): extract HTTP/error helpers to _errors.py"
```

## Task 1.3: Promote `AgentTarget` Protocol → ABC inside `base.py`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/base.py`

Per spec §6 PR1: `AgentTarget` stays in `base.py` for this PR but converts from `Protocol` to ABC. Relocate to `contracts.py` happens in PR2.

- [ ] **Step 1: Replace the `AgentTarget` Protocol with an ABC**

In `src/evaluatorq/redteam/backends/base.py`, replace the entire `class AgentTarget(Protocol):` block (currently lines ~22-49) with:

```python
class AgentTarget(ABC):
    """Abstract base class for agent targets that can receive prompts.

    Subclasses must implement ``send_prompt`` and ``new``. Targets that back a
    server-side memory store override ``get_agent_context``; otherwise the
    default minimal context is returned. ``memory_entity_id`` is an instance
    attribute (set in ``__init__``) so subclasses can mutate it without
    shadowing a class default.
    """

    def __init__(self, memory_entity_id: str | None = None) -> None:
        self.memory_entity_id = memory_entity_id

    @abstractmethod
    async def send_prompt(self, prompt: str) -> "AgentResponse":
        """Send a prompt; return the response."""
        ...

    @abstractmethod
    def new(self) -> "AgentTarget":
        """Return a fresh independent instance for a new attack."""
        ...

    async def get_agent_context(self) -> "AgentContext":
        """Default: minimal context. Override for platform-backed targets."""
        from evaluatorq.redteam.contracts import AgentContext
        return AgentContext(key=getattr(self, "agent_key", "unknown"))
```

(`ABC`, `abstractmethod` already imported from Task 1.1. `Protocol` import stays for now — other Protocols in this file still use it.)

- [ ] **Step 2: Update concrete targets to inherit `AgentTarget` and call `super().__init__`**

In `src/evaluatorq/redteam/backends/orq.py`, change `class ORQAgentTarget:` to `class ORQAgentTarget(AgentTarget):` and prepend `super().__init__(memory_entity_id=memory_entity_id)` inside `__init__`. Move the `self.memory_entity_id = ...` line *after* the `super().__init__` call so the auto-generated default still applies — adapt the auto-gen block:

```python
def __init__(
    self,
    agent_key: str,
    orq_client: Any,
    memory_entity_id: str | None = None,
    model: str | None = None,
    timeout_ms: int | None = None,
):
    if memory_entity_id is None:
        memory_entity_id = f'red-team-{uuid.uuid4().hex[:12]}'
    super().__init__(memory_entity_id=memory_entity_id)
    timeout_ms = timeout_ms or PIPELINE_CONFIG.target_agent_timeout_ms
    self.agent_key = agent_key
    self.orq_client = orq_client
    self.model = model
    self._timeout_ms = timeout_ms
    self._task_id: str | None = None
```

Remove the `from evaluatorq.redteam.backends.base import AgentTarget` `TYPE_CHECKING` import (since concrete inherits now).

Repeat for `src/evaluatorq/redteam/backends/openai.py`:

```python
class OpenAIModelTarget(AgentTarget):
    def __init__(
        self,
        model: str,
        system_prompt: str | None = None,
        *,
        client: AsyncOpenAI | None = None,
        max_tokens: int | None = None,
        timeout_ms: int | None = None,
    ):
        super().__init__(memory_entity_id=None)
        ...
```

Drop the class-level `memory_entity_id: str | None = None` attribute declaration; it's now set via `super().__init__`.

- [ ] **Step 3: Update integration targets**

For each of the four integration target files:
- `src/evaluatorq/integrations/langgraph_integration/target.py`
- `src/evaluatorq/integrations/callable_integration/target.py`
- `src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py`
- `src/evaluatorq/integrations/openai_agents_integration/target.py`

Change `class XxxTarget(AgentTarget):` (already inheriting) — add `super().__init__(memory_entity_id=<existing value or None>)` as first line of `__init__`. Drop any class-level `memory_entity_id: str | None = None` declarations. For `CallableTarget`, keep `memory_entity_id=None` in the super call (it has no entity).

- [ ] **Step 4: Run integration target tests**

```bash
uv run pytest tests/redteam/test_orq_responses_target_as_agent_target.py tests/integrations -v
```

Expected: all green (or no integrations tests dir — skip then).

```bash
uv run pytest -m 'not integration' -x -q
```

Expected: full unit test suite green.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/backends/base.py src/evaluatorq/redteam/backends/orq.py src/evaluatorq/redteam/backends/openai.py src/evaluatorq/integrations
git commit -m "refactor(redteam): promote AgentTarget Protocol to ABC"
```

## Task 1.4: Implement `ORQBackend`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/orq.py`

- [ ] **Step 1: Write failing test for ORQBackend.map_error**

Append to `tests/redteam/test_backend_abc.py`:

```python
def test_orq_backend_map_error_includes_status_code():
    from evaluatorq.redteam.backends.orq import ORQBackend

    class _HTTPError(Exception):
        def __init__(self):
            super().__init__("boom")
            self.status_code = 429

    backend = ORQBackend(orq_client=object(), timeout_ms=1000)
    code, _ = backend.map_error(_HTTPError())
    assert code == "orq.http.429"
```

- [ ] **Step 2: Run test, expect ImportError**

```bash
uv run pytest tests/redteam/test_backend_abc.py::test_orq_backend_map_error_includes_status_code -v
```

Expected: `ImportError: cannot import name 'ORQBackend'`.

- [ ] **Step 3: Add `ORQBackend` class**

Append to `src/evaluatorq/redteam/backends/orq.py` (above `create_orq_agent_target`):

```python
from evaluatorq.redteam.backends.base import Backend


class ORQBackend(Backend):
    """Backend for ORQ-hosted agents.

    Owns the ORQ SDK client. Creates ``ORQAgentTarget`` instances per job.
    Performs memory cleanup via the SDK. Maps ORQ exceptions to a normalized
    error taxonomy.
    """

    def __init__(self, *, orq_client: Any = None, timeout_ms: int | None = None) -> None:
        super().__init__(name="orq")
        timeout_ms = timeout_ms or PIPELINE_CONFIG.target_agent_timeout_ms
        self._timeout_ms = timeout_ms
        if orq_client is not None:
            self._orq_client = orq_client
        else:
            if _orq_cls is None:
                raise ImportError(
                    "ORQ backend requires the orq-ai-sdk package. "
                    "Install with: pip install evaluatorq[orq]"
                )
            self._orq_client = _orq_cls(
                api_key=_get_orq_api_key(),
                server_url=_get_orq_server_url(),
                timeout_ms=self._timeout_ms,
            )

    def create_target(self, agent_key: str) -> ORQAgentTarget:
        return ORQAgentTarget(
            agent_key=agent_key,
            orq_client=self._orq_client,
            timeout_ms=self._timeout_ms,
        )

    async def cleanup_memory(self, ctx: AgentContext, entity_ids: list[str]) -> None:
        for ms in ctx.memory_stores:
            if not ms.key:
                logger.warning(f'Memory store {ms.id} has no key, skipping cleanup')
                continue
            for entity_id in entity_ids:
                try:
                    await asyncio.to_thread(
                        self._orq_client.memory_stores.delete_memory,
                        memory_store_key=ms.key,
                        memory_entity_id=entity_id,
                    )
                    logger.debug(f'Deleted memory entity {entity_id} from store {ms.key}')
                except Exception as e:  # noqa: PERF203
                    if extract_status_code(e) == 404:
                        continue
                    logger.warning(f'Failed to cleanup memory entity {entity_id} from {ms.key}: {e}')

    def map_error(self, exc: Exception) -> tuple[str, str]:
        name = type(exc).__name__.lower()
        text = str(exc).lower()
        status_code = extract_status_code(exc)
        provider_code = extract_provider_error_code(exc)

        if status_code is not None:
            return f'orq.http.{status_code}', f'{type(exc).__name__}: {exc}'
        if provider_code:
            return f'orq.code.{provider_code}', f'{type(exc).__name__}: {exc}'
        if 'timeout' in name or 'timed out' in text:
            return 'orq.timeout', f'{type(exc).__name__}: {exc}'
        if 'auth' in name or 'unauthorized' in text or 'forbidden' in text:
            return 'orq.auth', f'{type(exc).__name__}: {exc}'
        if 'ratelimit' in name or '429' in text:
            return 'orq.rate_limit', f'{type(exc).__name__}: {exc}'
        return 'orq.unknown', f'{type(exc).__name__}: {exc}'
```

- [ ] **Step 4: Run test, expect PASS**

```bash
uv run pytest tests/redteam/test_backend_abc.py::test_orq_backend_map_error_includes_status_code -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/backends/orq.py tests/redteam/test_backend_abc.py
git commit -m "feat(redteam): add ORQBackend class"
```

## Task 1.5: Implement `OpenAIBackend`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/openai.py`

- [ ] **Step 1: Add failing test**

Append to `tests/redteam/test_backend_abc.py`:

```python
def test_openai_backend_map_error_returns_openai_prefix():
    from evaluatorq.redteam.backends.openai import OpenAIBackend

    backend = OpenAIBackend(client=None, system_prompt=None)
    code, _ = backend.map_error(TimeoutError("slow"))
    assert code.startswith("openai.")
```

- [ ] **Step 2: Run, expect ImportError**

```bash
uv run pytest tests/redteam/test_backend_abc.py::test_openai_backend_map_error_returns_openai_prefix -v
```

- [ ] **Step 3: Add `OpenAIBackend`**

Append to `src/evaluatorq/redteam/backends/openai.py`:

```python
from evaluatorq.redteam.backends.base import Backend


class OpenAIBackend(Backend):
    """Backend for direct OpenAI model targets.

    Targets are stateless. ``cleanup_memory`` is a no-op (OpenAI models do not
    own server-side memory).
    """

    def __init__(
        self,
        *,
        client: AsyncOpenAI | None = None,
        system_prompt: str | None = None,
        max_tokens: int | None = None,
        timeout_ms: int | None = None,
    ) -> None:
        super().__init__(name="openai")
        self._client = client or create_async_llm_client()
        self._system_prompt = system_prompt
        self._max_tokens = max_tokens
        self._timeout_ms = timeout_ms

    def create_target(self, agent_key: str) -> OpenAIModelTarget:
        return OpenAIModelTarget(
            model=agent_key,
            system_prompt=self._system_prompt,
            client=self._client,
            max_tokens=self._max_tokens,
            timeout_ms=self._timeout_ms,
        )

    async def cleanup_memory(self, ctx: AgentContext, entity_ids: list[str]) -> None:
        logger.debug('OpenAI backend has no memory store; cleanup is a no-op')

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
```

- [ ] **Step 4: Run test**

```bash
uv run pytest tests/redteam/test_backend_abc.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/backends/openai.py tests/redteam/test_backend_abc.py
git commit -m "feat(redteam): add OpenAIBackend class"
```

## Task 1.6: Switch registry to return `Backend`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/registry.py`

- [ ] **Step 1: Rewrite `registry.py` factories**

Replace the entire bottom half of `src/evaluatorq/redteam/backends/registry.py` (everything from `_BACKEND_REGISTRY` onward) with:

```python
_BACKEND_REGISTRY: dict[str, Callable[..., Backend]] = {}


def register_backend(name: str, factory: Callable[..., Backend]) -> None:
    """Register a backend factory for use with resolve_backend()."""
    _BACKEND_REGISTRY[name.strip().lower()] = factory


def resolve_backend(
    backend: str = "orq",
    *,
    llm_client: AsyncOpenAI | None = None,
    target_config: TargetConfig | None = None,
    pipeline_config: LLMConfig | None = None,
) -> Backend:
    """Resolve a backend by name."""
    normalized = backend.strip().lower()
    factory = _BACKEND_REGISTRY.get(normalized)
    if factory is None:
        raise BackendError(
            f"Unsupported backend: {backend!r}. Available: {sorted(_BACKEND_REGISTRY)}"
        )
    return factory(llm_client=llm_client, target_config=target_config, pipeline_config=pipeline_config)


def _create_openai_backend(
    llm_client: AsyncOpenAI | None = None,
    target_config: TargetConfig | None = None,
    **_: object,
) -> Backend:
    from evaluatorq.redteam.backends.openai import OpenAIBackend

    system_prompt = target_config.system_prompt if target_config else None
    return OpenAIBackend(client=llm_client, system_prompt=system_prompt)


def _create_orq_backend(
    llm_client: AsyncOpenAI | None = None,
    target_config: TargetConfig | None = None,
    pipeline_config: LLMConfig | None = None,
    **_: object,
) -> Backend:
    try:
        from evaluatorq.redteam.backends.orq import ORQBackend
    except ImportError as exc:
        raise BackendError("ORQ backend requested but ORQ dependencies are unavailable.") from exc

    timeout_ms = pipeline_config.target_agent_timeout_ms if pipeline_config else None
    return ORQBackend(timeout_ms=timeout_ms)


register_backend("openai", _create_openai_backend)
register_backend("orq", _create_orq_backend)
```

Update the top-of-file import block:

```python
from evaluatorq.redteam.backends.base import Backend
from evaluatorq.redteam.exceptions import BackendError, CredentialError
```

Delete `from evaluatorq.redteam.backends.base import BackendBundle, NoopMemoryCleanup` and `from evaluatorq.redteam.backends.openai import (OpenAIContextProvider, OpenAIErrorMapper, OpenAITargetFactory)` import lines.

- [ ] **Step 2: Run registry-touching tests**

```bash
uv run pytest tests/redteam/ -m 'not integration' -x -q
```

Expected: failures in `runner.py` callers (next task). Note them — they should disappear after Task 1.7.

If failures occur ONLY in callers, proceed. If `tests/redteam/test_backends.py` or `test_backend_abc.py` fail, investigate before continuing.

- [ ] **Step 3: Commit (red — caller fixes follow)**

```bash
git add src/evaluatorq/redteam/backends/registry.py
git commit -m "refactor(redteam): registry returns Backend, not BackendBundle"
```

## Task 1.7: Update `runner.py` call-sites

**Files:**
- Modify: `src/evaluatorq/redteam/runner.py`

- [ ] **Step 1: Replace BackendBundle accessors at the `_prepare_dynamic_target` site**

In `src/evaluatorq/redteam/runner.py`, around lines 831-834, replace:

```python
backend_bundle = resolve_backend('orq', llm_client=llm_client, target_config=target_config, pipeline_config=pipeline_config)
resolved_factory = backend_bundle.target_factory
resolved_error_mapper = DefaultErrorMapper()
resolved_memory_cleanup_t = backend_bundle.memory_cleanup
```

with:

```python
backend = resolve_backend('orq', llm_client=llm_client, target_config=target_config, pipeline_config=pipeline_config)
```

Then update line 841:

```python
agent_context = await backend_bundle.context_provider.get_agent_context(target_value)
```

becomes — but wait, we removed `context_provider`. Per spec §5.3, ORQ context retrieval moves to `ORQAgentTarget.get_agent_context()`. The runner can call it through a created target:

```python
probe_target = backend.create_target(target_value)
agent_context = await probe_target.get_agent_context()
```

- [ ] **Step 2: Update `create_dynamic_redteam_job` call (lines 907-919)**

Replace:

```python
dynamic_job = create_dynamic_redteam_job(
    agent_key=target_value,
    agent_context=agent_context,
    red_team_model=attack_model,
    max_turns=max_turns,
    target_factory=resolved_factory,
    error_mapper=resolved_error_mapper,
    attack_llm_client=resolved_llm_client,
    memory_entity_ids=memory_entity_ids,
    attacker_instructions=attacker_instructions,
    verbosity=verbosity,
    pipeline_config=pipeline_config,
)
```

with (note the new `backend` arg in place of `target_factory` + `error_mapper`):

```python
dynamic_job = create_dynamic_redteam_job(
    agent_key=target_value,
    agent_context=agent_context,
    red_team_model=attack_model,
    max_turns=max_turns,
    backend=backend,
    attack_llm_client=resolved_llm_client,
    memory_entity_ids=memory_entity_ids,
    attacker_instructions=attacker_instructions,
    verbosity=verbosity,
    pipeline_config=pipeline_config,
)
```

`create_dynamic_redteam_job` signature update happens in Task 1.9.

- [ ] **Step 3: Update bring-your-own-target path (lines 1320-1358)**

In the `if resolved_agent_targets:` block, replace lines 1337-1357:

```python
at_factory = DirectTargetFactory(at)
at_mapper = at if callable(getattr(at, 'map_error', None)) else DefaultErrorMapper()
at_cleanup = at if callable(getattr(at, 'cleanup_memory', None)) else NoopMemoryCleanup()

at_mem_ids: list[str] = []
all_at_cleanup_info.append((at_ctx, at_mem_ids, at_cleanup))
at_dyn_job = create_dynamic_redteam_job(
    agent_key=at_label,
    agent_context=at_ctx,
    red_team_model=attack_model,
    max_turns=max_turns,
    target_factory=cast("AgentTargetFactory", at_factory),
    error_mapper=cast("ErrorMapper", at_mapper),
    attack_llm_client=at_llm_client,
    memory_entity_ids=at_mem_ids,
    attacker_instructions=attacker_instructions,
    verbosity=verbosity,
    pipeline_config=pipeline_config,
)
```

with:

```python
from evaluatorq.redteam.backends.base import _BareTargetBackend

at_backend = _BareTargetBackend(at)
at_mem_ids: list[str] = []
all_at_cleanup_info.append((at_ctx, at_mem_ids, at_backend))
at_dyn_job = create_dynamic_redteam_job(
    agent_key=at_label,
    agent_context=at_ctx,
    red_team_model=attack_model,
    max_turns=max_turns,
    backend=at_backend,
    attack_llm_client=at_llm_client,
    memory_entity_ids=at_mem_ids,
    attacker_instructions=attacker_instructions,
    verbosity=verbosity,
    pipeline_config=pipeline_config,
)
```

`_BareTargetBackend` is added in Task 1.9. `all_at_cleanup_info` tuple's third element changes from "cleanup-like object" to "Backend instance" — confirm the consumer downstream (search for `all_at_cleanup_info`).

- [ ] **Step 4: Update memory cleanup consumer**

Find the consumer of `all_at_cleanup_info`. Likely calls `at_cleanup.cleanup_memory(ctx, ids)`. Change call to `at_backend.cleanup_memory(ctx, ids)`. Backend exposes the same method.

```bash
grep -n "all_at_cleanup_info" src/evaluatorq/redteam/runner.py
```

For each call-site that does `for at_ctx, at_mem_ids, at_cleanup in all_at_cleanup_info:`, change loop variable to `at_backend` and adjust subsequent method calls — they remain `await at_backend.cleanup_memory(at_ctx, at_mem_ids)`.

- [ ] **Step 5: Remove now-unused imports**

In `src/evaluatorq/redteam/runner.py`, top-of-file imports, remove `DirectTargetFactory`, `NoopMemoryCleanup`, `DefaultErrorMapper`, `AgentTargetFactory`, `ErrorMapper` from `from evaluatorq.redteam.backends.base import (...)`. Add `Backend` if needed.

- [ ] **Step 6: Run runner tests**

```bash
uv run pytest tests/redteam/ -m 'not integration' -x -q
```

Expected: green except `create_dynamic_redteam_job`-related failures (signature mismatch). Continue to Task 1.9.

## Task 1.8: Update `adaptive/pipeline.py` and `adaptive/orchestrator.py`

**Files:**
- Modify: `src/evaluatorq/redteam/adaptive/pipeline.py`
- Modify: `src/evaluatorq/redteam/adaptive/orchestrator.py`

- [ ] **Step 1: Read current usage**

```bash
grep -n "DefaultErrorMapper\|ErrorMapper\|target_factory\|AgentTargetFactory" src/evaluatorq/redteam/adaptive/pipeline.py src/evaluatorq/redteam/adaptive/orchestrator.py
```

- [ ] **Step 2: Update `pipeline.py` — `create_dynamic_redteam_job` signature**

In `src/evaluatorq/redteam/adaptive/pipeline.py`, locate `def create_dynamic_redteam_job(...)`. Replace parameters `target_factory: AgentTargetFactory, error_mapper: ErrorMapper, ...` with `backend: Backend, ...`. Inside the function body, replace every `target_factory.create_target(...)` with `backend.create_target(...)`, every `error_mapper.map_error(exc)` with `backend.map_error(exc)`.

Update imports at the top of the file:

```python
# delete
from evaluatorq.redteam.backends.base import DefaultErrorMapper, _coerce_to_agent_response

# add
from evaluatorq.redteam.backends.base import Backend, _coerce_to_agent_response
```

Delete TYPE_CHECKING block items `AgentTargetFactory`, `ErrorMapper`, `MemoryCleanup`.

- [ ] **Step 3: Update `orchestrator.py`**

In `src/evaluatorq/redteam/adaptive/orchestrator.py` line 23:

```python
# delete
from evaluatorq.redteam.backends.base import AgentTarget, DefaultErrorMapper, ErrorMapper, _coerce_to_agent_response

# add
from evaluatorq.redteam.backends.base import AgentTarget, _coerce_to_agent_response
```

Then audit usage of `DefaultErrorMapper`/`ErrorMapper` inside the file. If a class field references them, change type hint to `Backend | None` and call `backend.map_error(...)`. If `DefaultErrorMapper()` is instantiated as a fallback, replace with a tiny local `_default_map_error(exc) -> tuple[str, str]` helper:

```python
def _default_map_error(exc: Exception) -> tuple[str, str]:
    return "target_error", f"{type(exc).__name__}: {exc}"
```

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/redteam/ -m 'not integration' -x -q
```

Expected: green except the `_BareTargetBackend` reference in runner.py (added in 1.9).

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/runner.py src/evaluatorq/redteam/adaptive/pipeline.py src/evaluatorq/redteam/adaptive/orchestrator.py
git commit -m "refactor(redteam): runner+pipeline+orchestrator consume Backend ABC"
```

## Task 1.9: Add `_BareTargetBackend` adapter

**Files:**
- Modify: `src/evaluatorq/redteam/backends/base.py`
- Test: `tests/redteam/test_bare_target_backend.py` (new)

- [ ] **Step 1: Write failing test**

Create `tests/redteam/test_bare_target_backend.py`:

```python
"""Tests for _BareTargetBackend adapter."""
from __future__ import annotations

import pytest

from evaluatorq.redteam.backends.base import AgentTarget, _BareTargetBackend
from evaluatorq.redteam.contracts import AgentContext, AgentResponse


class _StubTarget(AgentTarget):
    def __init__(self, memory_entity_id: str | None = None) -> None:
        super().__init__(memory_entity_id=memory_entity_id)

    async def send_prompt(self, prompt: str) -> AgentResponse:
        return AgentResponse(text="ok")

    def new(self) -> "_StubTarget":
        return _StubTarget()


class _TargetWithCleanup(_StubTarget):
    def __init__(self):
        super().__init__()
        self.cleaned: list[str] = []

    async def cleanup_memory(self, ctx, entity_ids):
        self.cleaned.extend(entity_ids)


class _TargetWithMapping(_StubTarget):
    def map_error(self, exc):
        return ("byo.error", str(exc))


@pytest.mark.asyncio
async def test_bare_backend_delegates_cleanup_when_target_supports_it():
    target = _TargetWithCleanup()
    backend = _BareTargetBackend(target)
    await backend.cleanup_memory(AgentContext(key="x"), ["a", "b"])
    assert target.cleaned == ["a", "b"]


@pytest.mark.asyncio
async def test_bare_backend_cleanup_noop_when_target_lacks_it():
    backend = _BareTargetBackend(_StubTarget())
    # Must not raise.
    await backend.cleanup_memory(AgentContext(key="x"), ["a"])


def test_bare_backend_delegates_map_error_when_target_supports_it():
    target = _TargetWithMapping()
    backend = _BareTargetBackend(target)
    code, _ = backend.map_error(RuntimeError("boom"))
    assert code == "byo.error"


def test_bare_backend_create_target_returns_target_new():
    target = _StubTarget()
    backend = _BareTargetBackend(target)
    fresh = backend.create_target("ignored-agent-key")
    assert isinstance(fresh, _StubTarget)
    assert fresh is not target
```

- [ ] **Step 2: Add `_BareTargetBackend` to `base.py`**

Append to `src/evaluatorq/redteam/backends/base.py`:

```python
class _BareTargetBackend(Backend):
    """Adapter wrapping a bare ``AgentTarget`` so it satisfies the ``Backend`` ABC.

    Used by the runner's bring-your-own-target path. Absorbs the duck-typed
    capability checks (``cleanup_memory``, ``map_error``) that used to scatter
    across ``runner.py``.
    """

    def __init__(self, target: AgentTarget) -> None:
        super().__init__(name=type(target).__name__)
        self._target = target

    def create_target(self, agent_key: str) -> AgentTarget:
        fresh = self._target.new()
        if fresh is None:  # pyright: ignore[reportUnnecessaryComparison]
            raise TypeError(
                f"{type(self._target).__name__}.new() returned None. "
                "It must return a fresh AgentTarget instance."
            )
        return fresh

    async def cleanup_memory(self, ctx: AgentContext, entity_ids: list[str]) -> None:
        cleanup = getattr(self._target, "cleanup_memory", None)
        if callable(cleanup):
            await cleanup(ctx, entity_ids)

    def map_error(self, exc: Exception) -> tuple[str, str]:
        mapper = getattr(self._target, "map_error", None)
        if callable(mapper):
            return mapper(exc)
        return super().map_error(exc)
```

- [ ] **Step 3: Run tests**

```bash
uv run pytest tests/redteam/test_bare_target_backend.py -v
```

Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add src/evaluatorq/redteam/backends/base.py tests/redteam/test_bare_target_backend.py
git commit -m "feat(redteam): add _BareTargetBackend adapter"
```

## Task 1.10: Delete dead types from `base.py`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/base.py`

- [ ] **Step 1: Remove dead types**

In `src/evaluatorq/redteam/backends/base.py`, delete the following classes/functions in order:

- `SupportsClone` Protocol
- `SupportsTokenUsage` Protocol
- `SupportsTargetMetadata` Protocol
- `SupportsAgentContext` Protocol
- `SupportsTargetFactory` Protocol
- `SupportsMemoryCleanup` Protocol
- `SupportsErrorMapping` Protocol
- `is_agent_target` function
- `DirectTargetFactory` class
- `NoopMemoryCleanup` class
- `AgentContextProvider` Protocol
- `AgentTargetFactory` Protocol
- `MemoryCleanup` Protocol
- `ErrorMapper` Protocol
- `BackendBundle` dataclass
- `DefaultErrorMapper` class

Keep:

- `AgentTarget` ABC
- `_coerce_to_agent_response`
- `validate_agent_target`
- `Backend` ABC
- `_BareTargetBackend`

Drop now-unused imports: `dataclass`, `Protocol`, `Any` if unreferenced.

- [ ] **Step 2: Delete `ORQContextProvider`, `ORQTargetFactory`, `ORQMemoryCleanup`, `ORQErrorMapper` from `orq.py`**

In `src/evaluatorq/redteam/backends/orq.py`:

- Delete `class ORQContextProvider` (lines ~354-451 in current state)
- Delete `class ORQTargetFactory` (lines ~454-490)
- Delete `class ORQMemoryCleanup` (lines ~493-532)
- Delete `class ORQErrorMapper` (lines ~535-555)
- Delete `create_orq_backend` function at the bottom (now redundant with `ORQBackend`)

Move `ORQContextProvider._enrich_knowledge_base`, `_enrich_memory_store`, and the body of `get_agent_context` *into* `ORQAgentTarget` as private methods. The existing `ORQAgentTarget.get_agent_context` at line 325-327 currently delegates — replace its body with the inlined fetching code:

```python
async def get_agent_context(self) -> AgentContext:
    """Retrieve full agent context from ORQ API."""
    if getattr(self, "_cached_context", None) is not None:
        return self._cached_context
    logger.debug(f'Retrieving agent context for: {self.agent_key}')
    agent_data = await asyncio.to_thread(
        self.orq_client.agents.retrieve,
        agent_key=self.agent_key,
    )

    tools: list[ToolInfo] = []
    settings = getattr(agent_data, 'settings', None)
    if settings and hasattr(settings, 'tools') and settings.tools:
        tools.extend(
            ToolInfo(
                name=getattr(tool, 'key', None) or getattr(tool, 'display_name', None) or tool.id,
                description=getattr(tool, 'description', None),
                parameters=None,
            )
            for tool in settings.tools
        )

    raw_kb_ids: list[str] = []
    if hasattr(agent_data, 'knowledge_bases') and agent_data.knowledge_bases:
        raw_kb_ids = [getattr(kb, 'knowledge_id', None) or str(kb) for kb in agent_data.knowledge_bases]

    raw_ms_ids: list[str] = []
    if hasattr(agent_data, 'memory_stores') and agent_data.memory_stores:
        raw_ms_ids = [ms if isinstance(ms, str) else getattr(ms, 'key', str(ms)) for ms in agent_data.memory_stores]

    enrichment_tasks: list[Any] = [self._enrich_knowledge_base(kb_id) for kb_id in raw_kb_ids]
    enrichment_tasks.extend(self._enrich_memory_store(ms_id) for ms_id in raw_ms_ids)

    enriched_results = await asyncio.gather(*enrichment_tasks) if enrichment_tasks else []
    knowledge_bases = [r for r in enriched_results if isinstance(r, KnowledgeBaseInfo)]
    memory_stores = [r for r in enriched_results if isinstance(r, MemoryStoreInfo)]

    model_raw = getattr(agent_data, 'model', None)
    model_id = getattr(model_raw, 'id', None) if model_raw is not None else None

    self._cached_context = AgentContext(
        key=self.agent_key,
        display_name=getattr(agent_data, 'display_name', None),
        description=getattr(agent_data, 'description', None),
        system_prompt=getattr(agent_data, 'system_prompt', None),
        instructions=getattr(agent_data, 'instructions', None),
        tools=tools,
        memory_stores=memory_stores,
        knowledge_bases=knowledge_bases,
        model=model_id,
    )
    return self._cached_context
```

Add `_cached_context` init line in `ORQAgentTarget.__init__`:

```python
self._cached_context: AgentContext | None = None
```

Add `_enrich_knowledge_base` and `_enrich_memory_store` as instance methods on `ORQAgentTarget`, lifted verbatim from `ORQContextProvider`.

Also delete `ORQAgentTarget.create_target` (lines 330-341) — `ORQBackend.create_target` now owns that.

Delete `ORQAgentTarget.cleanup_memory` (lines 344-346) — `ORQBackend.cleanup_memory` now owns that.

Delete `ORQAgentTarget.map_error` (lines 349-351) — `ORQBackend.map_error` owns that.

- [ ] **Step 3: Delete `OpenAIContextProvider`, `OpenAITargetFactory`, `OpenAIErrorMapper` from `openai.py`**

In `src/evaluatorq/redteam/backends/openai.py`:

- Delete `class OpenAIContextProvider` (lines ~179-201)
- Delete `class OpenAITargetFactory` (lines ~204-222)
- Delete `class OpenAIErrorMapper` (lines ~225-244)
- Delete `OpenAIModelTarget.create_target`, `OpenAIModelTarget.map_error` methods (now on `OpenAIBackend`)

Keep `OpenAIModelTarget.get_agent_context` (inline minimal context fits the AgentTarget default behaviour anyway).

- [ ] **Step 4: Update `redteam/__init__.py`**

Remove from `from evaluatorq.redteam.backends.base import (...)`:

- `DirectTargetFactory`
- `SupportsAgentContext`
- `SupportsErrorMapping`
- `SupportsMemoryCleanup`
- `SupportsTargetFactory`
- `is_agent_target`

Remove the same names from `__all__`.

- [ ] **Step 5: Update e2e test conftests**

`tests/redteam/e2e/conftest.py`, `tests/redteam/e2e/test_hybrid_pipeline.py`, `tests/redteam/e2e/test_dynamic_pipeline.py`, `tests/redteam/e2e/test_pipeline_options.py` all import `BackendBundle`. Replace each with `Backend` and adjust constructors. For e2e fakes, typically a `class _FakeBackend(Backend):` with stub methods.

Example for `tests/redteam/e2e/conftest.py` — find the `BackendBundle(...)` construction and convert to a fake `Backend` subclass:

```python
from evaluatorq.redteam.backends.base import Backend

class _FakeBackend(Backend):
    def __init__(self, target_factory, memory_cleanup, error_mapper):
        super().__init__(name="fake")
        self._target_factory = target_factory
        self._memory_cleanup = memory_cleanup
        self._error_mapper = error_mapper

    def create_target(self, agent_key):
        return self._target_factory.create_target(agent_key)

    async def cleanup_memory(self, ctx, entity_ids):
        await self._memory_cleanup.cleanup_memory(ctx, entity_ids)

    def map_error(self, exc):
        return self._error_mapper.map_error(exc)
```

Apply the same shim wherever `BackendBundle(...)` appears.

- [ ] **Step 6: Update `tests/redteam/test_orchestrator_coverage.py:322`**

`from evaluatorq.redteam.backends.base import DefaultErrorMapper` no longer exists. If the test uses it as a fallback, replace with a local stub or remove. Search the surrounding code; if `DefaultErrorMapper` is being passed to the orchestrator, replace with a `Backend` subclass that has only the default `map_error` (which returns `("target_error", ...)`).

- [ ] **Step 7: Update `tests/redteam/test_orq_responses_target_as_agent_target.py:19`**

`from evaluatorq.redteam.backends.base import is_agent_target` — replace with `from evaluatorq.redteam.backends.base import AgentTarget`. In each test using `is_agent_target(x)`, switch to `isinstance(x, AgentTarget)`. There are 4 call-sites in the file.

- [ ] **Step 8: Run full unit test suite**

```bash
uv run pytest -m 'not integration' -x -q
```

Expected: all green. If failures: investigate; do not retry.

- [ ] **Step 9: Run type check**

```bash
uv run basedpyright src/evaluatorq/redteam
```

Expected: no new errors versus main.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(redteam): drop dead protocols and factory classes"
```

## Task 1.11: PR1 docs + ticket update

- [ ] **Step 1: Update Linear RES-808 with PR1 progress note**

Skip if subagent execution model is being used — orchestrator handles ticket sync. Otherwise:

```bash
# manual ticket update via Linear MCP
```

- [ ] **Step 2: Push branch, open PR1**

```bash
git push -u origin bauke/res-808-collapse-redteam-backend-abstractions-abc-agenttarget
gh pr create \
  --title "RES-808 (PR1/3): collapse redteam backend abstractions to Backend + AgentTarget ABCs" \
  --body "$(cat <<'EOF'
## Summary
- Drop ``BackendBundle`` dataclass + 4 collaborator protocols + 7 ``Supports*`` protocols.
- Introduce ``Backend`` ABC (``create_target`` / ``cleanup_memory`` / ``map_error``).
- Promote ``AgentTarget`` from Protocol to ABC inside ``redteam/backends/base.py`` (still in this file; relocation to ``evaluatorq.contracts`` is PR2).
- Replace ``DirectTargetFactory`` + duck-typed BYO-target plumbing with ``_BareTargetBackend`` adapter.
- Fix pre-existing bug at ``runner.py:833`` where ``DefaultErrorMapper()`` masked the ORQ-specific error mapper — ORQ HTTP exceptions now correctly hit ``ORQBackend.map_error`` and produce ``orq.http.<status>`` codes.

## Test plan
- [ ] ``uv run pytest -m 'not integration'`` green
- [ ] ``uv run basedpyright src/evaluatorq/redteam`` green
- [ ] Spot-check that an integration test (manual) maps an ORQ rate-limit exception to ``orq.rate_limit`` not ``target_error``.

## Spec
``docs/superpowers/specs/2026-05-26-res-808-collapse-relocate-unify-design.md``

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR2 — Relocate `AgentTarget` to `evaluatorq.contracts`

Branch off PR1 tip after PR1 merges (or open as stacked draft).

## Task 2.1: Move `AgentTarget` ABC to `evaluatorq/contracts.py`

**Files:**
- Modify: `src/evaluatorq/contracts.py`
- Modify: `src/evaluatorq/redteam/backends/base.py`

- [ ] **Step 1: Add `AgentTarget` to `contracts.py`**

Append to `src/evaluatorq/contracts.py` (after `AgentResponse` class, before `__all__`):

```python
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from evaluatorq.redteam.contracts import AgentContext


class AgentTarget(ABC):
    """Abstract base class for agent targets that can receive prompts."""

    def __init__(self, memory_entity_id: str | None = None) -> None:
        self.memory_entity_id = memory_entity_id

    @abstractmethod
    async def send_prompt(self, prompt: str) -> "AgentResponse":
        ...

    @abstractmethod
    def new(self) -> "AgentTarget":
        ...

    async def get_agent_context(self) -> "AgentContext":
        from evaluatorq.redteam.contracts import AgentContext
        return AgentContext(key=getattr(self, "agent_key", "unknown"))
```

Add `"AgentTarget"` to the `__all__` list.

- [ ] **Step 2: Replace `AgentTarget` in `backends/base.py` with re-export**

In `src/evaluatorq/redteam/backends/base.py`, delete the entire `class AgentTarget(ABC):` block. Replace with:

```python
from evaluatorq.contracts import AgentTarget  # noqa: F401  (back-compat re-export)
```

- [ ] **Step 3: Sanity check**

```bash
uv run python -c "from evaluatorq.contracts import AgentTarget; print(AgentTarget.__module__)"
uv run python -c "from evaluatorq.redteam.backends.base import AgentTarget; print(AgentTarget.__module__)"
```

Expected: both print `evaluatorq.contracts`.

- [ ] **Step 4: Run test suite**

```bash
uv run pytest -m 'not integration' -x -q
```

Expected: green — re-export keeps every existing importer working.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/contracts.py src/evaluatorq/redteam/backends/base.py
git commit -m "refactor(contracts): relocate AgentTarget ABC to evaluatorq.contracts"
```

## Task 2.2: Migrate 14 importers to `evaluatorq.contracts`

**Files (importers):**

- `src/evaluatorq/redteam/runner.py` (2 occurrences, lines 36 and 252)
- `src/evaluatorq/redteam/adaptive/orchestrator.py` (line 23)
- `src/evaluatorq/integrations/langgraph_integration/target.py` (line 16)
- `src/evaluatorq/integrations/callable_integration/target.py` (line 11)
- `src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py` (line 22)
- `src/evaluatorq/integrations/openai_agents_integration/target.py` (line 11)
- Any test file currently importing from `evaluatorq.redteam.backends.base import AgentTarget`

- [ ] **Step 1: Identify all importers**

```bash
grep -rn "from evaluatorq.redteam.backends.base import.*AgentTarget" packages/evaluatorq-py/src packages/evaluatorq-py/tests
```

- [ ] **Step 2: Update each importer**

For every match, change `from evaluatorq.redteam.backends.base import AgentTarget` to `from evaluatorq.contracts import AgentTarget`. If `AgentTarget` is imported alongside other names from `backends.base`, split the import into two lines (one for contracts, one for backends.base remainder).

Use `sed` only if confident — there are edge cases (e.g. multi-import lines, TYPE_CHECKING blocks). Manual via Edit is safer.

- [ ] **Step 3: Remove the back-compat re-export from `backends/base.py`**

Drop the `from evaluatorq.contracts import AgentTarget` re-export line in `src/evaluatorq/redteam/backends/base.py`. (Per spec §10 "Public re-exports removed" — semver entry in CHANGELOG.)

- [ ] **Step 4: Type-check + tests**

```bash
uv run basedpyright src/evaluatorq
uv run pytest -m 'not integration' -x -q
```

Expected: green.

- [ ] **Step 5: CHANGELOG entry**

Append to `CHANGELOG.md` (create if missing) under an `## Unreleased / Changed` section:

```markdown
- **BREAKING:** `AgentTarget` moved from `evaluatorq.redteam.backends.base` to `evaluatorq.contracts`. Update imports.
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: migrate AgentTarget importers to evaluatorq.contracts"
```

## Task 2.3: Push PR2

- [ ] **Step 1: Push**

```bash
git push
gh pr create \
  --title "RES-808 (PR2/3): relocate AgentTarget ABC to evaluatorq.contracts" \
  --body "$(cat <<'EOF'
## Summary
- Move ``AgentTarget`` ABC to ``evaluatorq.contracts`` so simulation can depend on it without crossing module boundaries.
- Update 14 importers (runner, adaptive, 4 integrations, tests).
- Drop back-compat re-export per spec.

## Test plan
- [ ] ``uv run pytest -m 'not integration'`` green
- [ ] ``uv run basedpyright src/evaluatorq`` green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR3 — Unify on `respond(messages)`

Branch off PR2 tip.

## Task 3.1: Move `ChatMessage` to `evaluatorq/contracts.py`

**Files:**
- Modify: `src/evaluatorq/contracts.py`
- Modify: `src/evaluatorq/simulation/types.py`

- [ ] **Step 1: Add `ChatMessage` to `contracts.py`**

Append to `src/evaluatorq/contracts.py` (after `AgentResponse`, before `AgentTarget`):

```python
class ChatMessage(BaseModel):
    """A single chat message — used by `AgentTarget.respond`."""

    role: Literal["user", "assistant", "system", "developer"]
    content: str
```

Add `"ChatMessage"` to `__all__`.

- [ ] **Step 2: Make `simulation/types.py:ChatMessage` a re-export shim**

In `src/evaluatorq/simulation/types.py`, replace lines 217-219 (`class ChatMessage(BaseModel): ...`) with:

```python
from evaluatorq.contracts import ChatMessage  # re-export shim — slated for removal in 1.5
```

Drop the local `class ChatMessage` definition. The shim preserves `from evaluatorq.simulation.types import ChatMessage` for one cycle.

- [ ] **Step 3: Verify**

```bash
uv run python -c "
from evaluatorq.contracts import ChatMessage as C1
from evaluatorq.simulation.types import ChatMessage as C2
assert C1 is C2
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 4: Run tests**

```bash
uv run pytest -m 'not integration' -x -q
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/contracts.py src/evaluatorq/simulation/types.py
git commit -m "refactor(contracts): relocate ChatMessage; add 'developer' role"
```

## Task 3.2: Add `respond` + `send_prompt` shim to `AgentTarget`

**Files:**
- Modify: `src/evaluatorq/contracts.py`

- [ ] **Step 1: Write failing test**

Create `tests/contracts/test_agent_target_shim.py`:

```python
"""Tests for AgentTarget.send_prompt back-compat shim."""
from __future__ import annotations

import pytest

from evaluatorq.contracts import AgentResponse, AgentTarget, ChatMessage


class _RespondOnlyTarget(AgentTarget):
    def __init__(self):
        super().__init__()
        self.received: list[list[ChatMessage]] = []

    async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
        self.received.append(messages)
        return AgentResponse(text=f"echo: {messages[-1].content}")

    def new(self):
        return _RespondOnlyTarget()


@pytest.mark.asyncio
async def test_send_prompt_delegates_to_respond_with_single_user_message():
    target = _RespondOnlyTarget()
    result = await target.send_prompt("hello")
    assert result.text == "echo: hello"
    assert len(target.received) == 1
    assert len(target.received[0]) == 1
    assert target.received[0][0].role == "user"
    assert target.received[0][0].content == "hello"
```

- [ ] **Step 2: Run, expect FAIL** (no `respond` abstract method yet)

```bash
uv run pytest tests/contracts/test_agent_target_shim.py -v
```

- [ ] **Step 3: Update `AgentTarget` to spec §5.1 shape**

In `src/evaluatorq/contracts.py`, replace the existing `AgentTarget` class with:

```python
class AgentTarget(ABC):
    """Abstract base class for agent targets.

    Subclasses implement ``respond`` (the canonical message-based interface)
    and ``new``. ``send_prompt`` is a concrete one-line shim retained for
    back-compat with single-prompt callers. ``get_agent_context`` has a
    minimal default; targets backed by a control plane (ORQ) override.
    """

    def __init__(self, memory_entity_id: str | None = None) -> None:
        self.memory_entity_id = memory_entity_id

    @abstractmethod
    async def respond(self, messages: list["ChatMessage"]) -> "AgentResponse":
        """Send a list of chat messages; return the response."""
        ...

    @abstractmethod
    def new(self) -> "AgentTarget":
        """Return a fresh independent instance."""
        ...

    async def get_agent_context(self) -> "AgentContext":
        from evaluatorq.redteam.contracts import AgentContext
        return AgentContext(key=getattr(self, "agent_key", "unknown"))

    async def send_prompt(self, prompt: str) -> "AgentResponse":
        """Back-compat shim: wraps prompt in a single user message and calls ``respond``."""
        return await self.respond([ChatMessage(role="user", content=prompt)])
```

- [ ] **Step 4: Run shim test, expect PASS**

```bash
uv run pytest tests/contracts/test_agent_target_shim.py -v
```

- [ ] **Step 5: Existing target classes now fail because `respond` is abstract** — Step 5 is the bulk of the PR: implement `respond` on every concrete target. Run the full suite to inventory failures:

```bash
uv run pytest -m 'not integration' --no-header -q 2>&1 | tail -50
```

Expected: many `TypeError: Can't instantiate abstract class XxxTarget with abstract method respond` failures. Each concrete target gets fixed in Tasks 3.3-3.7.

- [ ] **Step 6: Commit** (red — concrete impls follow)

```bash
git add src/evaluatorq/contracts.py tests/contracts/test_agent_target_shim.py
git commit -m "feat(contracts): add abstract respond() + send_prompt shim to AgentTarget"
```

## Task 3.3: `OrqResponsesTarget` — stateless `respond`, drop `__call__`

**Files:**
- Modify: `src/evaluatorq/simulation/target.py`
- Test: `tests/redteam/test_orq_responses_target_as_agent_target.py`

- [ ] **Step 1: Update the `OrqResponsesTarget` class**

Replace `src/evaluatorq/simulation/target.py` content with:

```python
"""Stateless OrqResponsesTarget — implements AgentTarget.respond."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from loguru import logger

from evaluatorq.contracts import AgentResponse, AgentTarget, ChatMessage, LLMCallConfig
from evaluatorq.simulation._client import build_simulation_client, extract_responses_output
from evaluatorq.simulation.types import TokenUsage
from evaluatorq.simulation.utils.retry import with_retry

if TYPE_CHECKING:
    from openai import AsyncOpenAI


@dataclass(frozen=True)
class _ResponsesCallResult:
    response: AgentResponse
    response_id: str | None
    usage: TokenUsage | None


class OrqResponsesTarget(AgentTarget):
    """Wraps Orq Responses v3 API as a stateless AgentTarget.

    Stateless: each ``respond(messages)`` call sends the full message list and
    holds no per-instance conversation state. Conversation continuity is owned
    by the caller (sim runner or red-team orchestrator).
    """

    def __init__(
        self,
        config: LLMCallConfig,
        *,
        instructions: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        memory_entity_id: str | None = None,
        client: AsyncOpenAI | None = None,
    ) -> None:
        super().__init__(memory_entity_id=memory_entity_id)
        self.config = config
        self.instructions = instructions
        self.tools = tools
        if client is not None:
            self._client = client
            self._client_owned = False
        else:
            self._client, self._client_owned = build_simulation_client(config.client)

    async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
        """Stateless: send all messages, return the response."""
        result = await self._call_responses_api(
            responses_input=self._messages_to_input(messages),
        )
        return result.response

    def new(self) -> OrqResponsesTarget:
        """Fresh instance: no memory_entity_id, propagated injected client."""
        return OrqResponsesTarget(
            self.config,
            instructions=self.instructions,
            tools=self.tools,
            memory_entity_id=None,
            client=self._client if not self._client_owned else None,
        )

    async def get_agent_context(self):
        from evaluatorq.redteam.contracts import AgentContext
        return AgentContext(key=self.config.model)

    async def close(self) -> None:
        if self._client_owned:
            await self._client.close()
            self._client_owned = False

    async def __aenter__(self) -> "OrqResponsesTarget":
        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        await self.close()

    async def _call_responses_api(
        self,
        *,
        responses_input: str | list[dict[str, Any]],
    ) -> _ResponsesCallResult:
        timeout_s = self.config.timeout_ms / 1000.0 if self.config.timeout_ms else None

        async def _do_call() -> _ResponsesCallResult:
            kwargs: dict[str, Any] = {
                "model": self.config.model,
                "input": responses_input,
            }
            if self.tools:
                kwargs["tools"] = self.tools
            if self.instructions is not None:
                kwargs["instructions"] = self.instructions

            coro = self._client.responses.create(**kwargs)
            response = await (
                asyncio.wait_for(coro, timeout=timeout_s) if timeout_s else coro
            )

            response_id = getattr(response, "id", None)
            if not isinstance(response_id, str) or not response_id:
                response_id = None

            output_items, usage = extract_responses_output(response)
            if not output_items:
                raise RuntimeError(
                    f"OrqResponsesTarget: response contained no extractable "
                    f"output items (model={self.config.model})."
                )

            return _ResponsesCallResult(
                response=AgentResponse(output=output_items),
                response_id=response_id,
                usage=usage,
            )

        try:
            return await with_retry(_do_call, label="OrqResponsesTarget._call_responses_api")
        except asyncio.TimeoutError as e:
            raise RuntimeError(
                f"OrqResponsesTarget timed out after {timeout_s}s (model={self.config.model})"
            ) from e

    @staticmethod
    def _messages_to_input(messages: list[ChatMessage]) -> list[dict[str, Any]]:
        return [{"role": m.role, "content": m.content} for m in messages]


__all__ = ["OrqResponsesTarget"]
```

Removed:
- `__call__` method
- `_previous_response_id` attribute and all related logic
- `_invoke_stateless` / `_invoke_stateful` split
- `_accumulated_usage`, `threading_disabled`, `get_usage()`
- `_validate_response_id` helper (inlined as 2 lines)
- Class-level `memory_entity_id: str | None` / `threading_disabled: bool` declarations

- [ ] **Step 2: Rewrite conformance test file**

Replace `tests/redteam/test_orq_responses_target_as_agent_target.py` with:

```python
"""Tests for OrqResponsesTarget conformance with the AgentTarget ABC.

After RES-808 PR3:
- ``respond(messages)`` is the canonical entry point
- ``send_prompt(str)`` is the shim
- ``OrqResponsesTarget`` is stateless — no ``_previous_response_id`` invariants
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from evaluatorq.contracts import AgentResponse, AgentTarget, ChatMessage, LLMCallConfig
from evaluatorq.simulation.target import OrqResponsesTarget


def _make_client() -> MagicMock:
    client = MagicMock()
    client.responses = MagicMock()
    client.responses.create = AsyncMock()
    return client


def _make_response(text: str = "all good") -> MagicMock:
    part = MagicMock()
    part.type = "output_text"
    part.text = text
    msg_item = MagicMock()
    msg_item.type = "message"
    msg_item.content = [part]
    usage = MagicMock()
    usage.input_tokens = 5
    usage.output_tokens = 3
    response = MagicMock()
    response.id = "resp-1"
    response.usage = usage
    response.output = [msg_item]
    return response


def _make_target() -> OrqResponsesTarget:
    client = _make_client()
    client.responses.create = AsyncMock(return_value=_make_response())
    return OrqResponsesTarget(LLMCallConfig(model="gpt-4o"), client=client)


class TestAgentTargetConformance:
    def test_is_agent_target_instance(self):
        assert isinstance(_make_target(), AgentTarget)

    def test_memory_entity_id_default_none(self):
        assert _make_target().memory_entity_id is None

    def test_memory_entity_id_settable(self):
        client = _make_client()
        target = OrqResponsesTarget(LLMCallConfig(model="gpt-4o"), client=client, memory_entity_id="x-1")
        assert target.memory_entity_id == "x-1"


class TestRespond:
    @pytest.mark.asyncio
    async def test_respond_returns_agent_response(self):
        target = _make_target()
        result = await target.respond([ChatMessage(role="user", content="hi")])
        assert isinstance(result, AgentResponse)
        assert result.text == "all good"

    @pytest.mark.asyncio
    async def test_send_prompt_delegates_to_respond(self):
        target = _make_target()
        result = await target.send_prompt("hi")
        assert isinstance(result, AgentResponse)


class TestRespondIsStateless:
    @pytest.mark.asyncio
    async def test_consecutive_respond_calls_pass_messages_as_sent(self):
        """respond is stateless: each call's input is exactly what the caller passed.

        No previous_response_id threading, no accumulation on self.
        """
        client = _make_client()
        client.responses.create = AsyncMock(side_effect=[_make_response("r1"), _make_response("r2")])
        target = OrqResponsesTarget(LLMCallConfig(model="gpt-4o"), client=client)

        await target.respond([ChatMessage(role="user", content="turn1")])
        await target.respond([ChatMessage(role="user", content="turn2")])

        # Both calls received exactly what was passed (no carry-over kwargs).
        call1_kwargs = client.responses.create.await_args_list[0].kwargs
        call2_kwargs = client.responses.create.await_args_list[1].kwargs
        assert "previous_response_id" not in call1_kwargs
        assert "previous_response_id" not in call2_kwargs
        assert call1_kwargs["input"] == [{"role": "user", "content": "turn1"}]
        assert call2_kwargs["input"] == [{"role": "user", "content": "turn2"}]


class TestNew:
    def test_new_returns_different_instance(self):
        target = _make_target()
        assert target.new() is not target

    def test_new_memory_entity_id_is_none(self):
        target = _make_target()
        assert target.new().memory_entity_id is None

    def test_new_propagates_injected_client(self):
        client = _make_client()
        client.responses.create = AsyncMock(return_value=_make_response())
        target = OrqResponsesTarget(LLMCallConfig(model="gpt-4o"), client=client)
        assert target.new()._client is client
```

- [ ] **Step 3: Run conformance tests**

```bash
uv run pytest tests/redteam/test_orq_responses_target_as_agent_target.py -v
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/evaluatorq/simulation/target.py tests/redteam/test_orq_responses_target_as_agent_target.py
git commit -m "refactor(simulation): OrqResponsesTarget becomes stateless; drop __call__"
```

## Task 3.4: `ORQAgentTarget.respond(messages)` — keeps endpoint, last-user-message contract

**Files:**
- Modify: `src/evaluatorq/redteam/backends/orq.py`

- [ ] **Step 1: Replace `send_prompt` with `respond`**

In `src/evaluatorq/redteam/backends/orq.py`, change the method signature:

```python
# was
async def send_prompt(self, prompt: str) -> AgentResponse:

# becomes
async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
    """Send the last user message to the ORQ agents endpoint, threaded via task_id.

    Caller contract: ``messages[-1].role == "user"``. Prior turns are assumed
    consistent with the server-side history that ``task_id`` references.
    First call (``task_id is None``) seeds task_id from the response.
    """
    if not messages or messages[-1].role != "user":
        raise ValueError(
            "ORQAgentTarget.respond requires messages[-1].role == 'user'. "
            "Server-side conversation state is held via task_id."
        )
    prompt = messages[-1].content
    # ... rest of the existing body, unchanged
```

The rest of the function body (span setup, kwargs construction, tool-loop, usage accumulation, return) stays verbatim — `prompt` is the local variable already used throughout.

Add `from evaluatorq.contracts import ChatMessage` to the imports.

- [ ] **Step 2: `send_prompt` is no longer overridden** — inherits the contracts shim.

Remove any `async def send_prompt(...)` left on `ORQAgentTarget`. Inherited shim `super().send_prompt(prompt) → respond([ChatMessage(role='user', content=prompt)])` reproduces previous behaviour.

- [ ] **Step 3: Update ORQAgentTarget conformance tests**

Find existing tests that call `target.send_prompt(...)`:

```bash
grep -rn "ORQAgentTarget\|send_prompt" tests/redteam tests/integrations 2>/dev/null
```

For each match where the test asserts a tool-loop body behaviour, keep the test but switch to `await target.send_prompt(prompt)` (which now delegates via the shim) OR migrate to `await target.respond([ChatMessage(role="user", content=prompt)])`. Either is acceptable; prefer `respond` for new tests, keep `send_prompt` for legacy unchanged.

Add one new test:

```python
@pytest.mark.asyncio
async def test_respond_rejects_non_user_last_message():
    target = ORQAgentTarget(agent_key="a", orq_client=MagicMock())
    with pytest.raises(ValueError, match="messages\\[-1\\].role"):
        await target.respond([ChatMessage(role="user", content="x"),
                              ChatMessage(role="assistant", content="y")])
```

Place in `tests/redteam/test_orq_agent_target_respond.py` (new file) or append to the existing orq agent target test file if one exists.

- [ ] **Step 4: Run ORQ agent target tests**

```bash
uv run pytest tests/redteam/ -k 'orq_agent' -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/backends/orq.py tests/redteam/
git commit -m "refactor(redteam): ORQAgentTarget.respond(messages); last-user contract"
```

## Task 3.5: `OpenAIModelTarget.respond`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/openai.py`

- [ ] **Step 1: Rename `send_prompt` to `respond(messages)`**

`OpenAIModelTarget` already keeps `_history`. With `respond`, we have two options: ignore history (caller owns conversation) or accept the full messages list and bypass history. Per spec §5.8 sim auto-routes a full message list — accept the caller's history and drop the per-instance `_history`.

In `src/evaluatorq/redteam/backends/openai.py`, replace `send_prompt` with:

```python
async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
    """Send chat completion with the provided message list + system prompt.

    Caller owns conversation history. ``_history`` is no longer accumulated
    on the target.
    """
    completion_messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": self.system_prompt},
        *[
            {"role": m.role, "content": m.content}  # type: ignore[misc]
            for m in messages
        ],
    ]
    async with with_llm_span(
        model=self.model,
        input_messages=completion_messages,
        attributes={"orq.redteam.llm_purpose": "target"},
    ) as span:
        response = await asyncio.wait_for(
            self.client.chat.completions.create(
                model=self.model,
                messages=completion_messages,
                max_tokens=self.max_tokens,
            ),
            timeout=self.timeout_ms / 1000.0,
        )
        msg = response.choices[0].message
        content = msg.content or ''
        record_llm_response(span, response, output_content=content)

        tool_call_items: list[ToolCallOutputItem] = []
        for tc in (getattr(msg, 'tool_calls', None) or []):
            func = getattr(tc, 'function', None)
            if func is None:
                continue
            tc_id = getattr(tc, 'id', None)
            kwargs: dict[str, Any] = {
                'name': func.name,
                'arguments': func.arguments or '{}',
            }
            if isinstance(tc_id, str) and tc_id:
                kwargs['id'] = tc_id
            tool_call_items.append(ToolCallOutputItem(**kwargs))

        usage = TokenUsage.from_completion(response)
        response_id = getattr(response, 'id', None)
        finish_reason = None
        choices = getattr(response, 'choices', None) or []
        if choices:
            finish_reason = getattr(choices[0], 'finish_reason', None)

    output: list[OutputMessage] = cast('list[OutputMessage]', list(tool_call_items))
    output.append(TextOutputItem(text=content, annotations=[]))
    return AgentResponse(
        output=output,
        usage=usage,
        model=getattr(response, 'model', None),
        response_id=response_id,
        finish_reason=finish_reason,
    )
```

Delete `self._history` initialization in `__init__`. Delete the history-append block at the end of the old `send_prompt`.

Add `from evaluatorq.contracts import ChatMessage` import.

- [ ] **Step 2: Run tests**

```bash
uv run pytest tests/redteam/ -k 'openai' -v
```

- [ ] **Step 3: Commit**

```bash
git add src/evaluatorq/redteam/backends/openai.py
git commit -m "refactor(redteam): OpenAIModelTarget.respond; drop per-instance history"
```

## Task 3.6: Integration targets — `respond` for each

**Files:**
- Modify: `src/evaluatorq/integrations/langgraph_integration/target.py`
- Modify: `src/evaluatorq/integrations/callable_integration/target.py`
- Modify: `src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py`
- Modify: `src/evaluatorq/integrations/openai_agents_integration/target.py`

For each integration target, the existing `send_prompt(self, prompt: str)` body wraps the wrapped framework. For `respond(self, messages)` we follow the spec rule: convert messages → whatever the wrapped framework expects, defaulting to "last user message as prompt" for opaque/callable integrations.

- [ ] **Step 1: `callable_integration/target.py`** — replace `send_prompt` with `respond`:

```python
async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
    """For opaque callables, use the last user message as the prompt."""
    if not messages or messages[-1].role != "user":
        raise ValueError("CallableTarget.respond requires messages[-1].role == 'user'")
    prompt = messages[-1].content
    # ... existing body unchanged below, operating on `prompt`
```

Add `from evaluatorq.contracts import ChatMessage` import. Drop the existing `send_prompt` override.

- [ ] **Step 2: `langgraph_integration/target.py`** — same pattern. LangGraph thread state belongs to LangGraph; the integration's job is to pass the latest user turn. Use last-user-message rule.

- [ ] **Step 3: `vercel_ai_sdk_integration/target.py`** — same pattern. Pass the full message list if the integration accepts a transcript (check `send_prompt`'s existing call shape); otherwise last user.

- [ ] **Step 4: `openai_agents_integration/target.py`** — OpenAI Agents SDK accepts a list of messages directly. Pass the full `messages` through:

```python
async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
    sdk_messages = [{"role": m.role, "content": m.content} for m in messages]
    # ... call OpenAI Agents SDK with sdk_messages
```

- [ ] **Step 5: Run integration unit tests + the conformance assertion**

```bash
uv run pytest tests/ -k 'integration_target' -m 'not integration' -v
```

- [ ] **Step 6: Add a smoke test per integration target**

Create `tests/integrations/test_respond_smoke.py`:

```python
"""Smoke tests: every integration target implements respond and returns AgentResponse."""
from __future__ import annotations

import pytest

from evaluatorq.contracts import AgentResponse, AgentTarget, ChatMessage


@pytest.mark.asyncio
async def test_callable_target_respond_returns_agent_response():
    from evaluatorq.integrations.callable_integration import CallableTarget
    target = CallableTarget(lambda prompt: f"echo: {prompt}")
    assert isinstance(target, AgentTarget)
    result = await target.respond([ChatMessage(role="user", content="hi")])
    assert isinstance(result, AgentResponse)
    assert "hi" in result.text
```

(Add similar smoke for the three other integrations if mocking their SDKs is straightforward; skip if not — the abstract-method enforcement at import time already guarantees `respond` exists.)

- [ ] **Step 7: Commit**

```bash
git add src/evaluatorq/integrations/ tests/integrations/
git commit -m "refactor(integrations): all four targets implement respond(messages)"
```

## Task 3.7: Delete sim `TargetAgent` Protocol; sim consumes `AgentTarget`

**Files:**
- Modify: `src/evaluatorq/simulation/runner/simulation.py`
- Modify: `src/evaluatorq/simulation/runner/__init__.py`
- Modify: `src/evaluatorq/simulation/__init__.py`

- [ ] **Step 1: Delete the local Protocol**

In `src/evaluatorq/simulation/runner/simulation.py`, delete lines 72-76:

```python
@runtime_checkable
class TargetAgent(Protocol):
    """Protocol for target agents being tested."""

    async def respond(self, messages: list[ChatMessage]) -> str: ...
```

Replace with:

```python
from evaluatorq.contracts import AgentTarget
```

- [ ] **Step 2: Update dispatch**

Find the call-site that uses `self._target_agent` (around line 636 per spec). Today it does:

```python
if self._target_agent:
    return (await self._target_agent.respond(messages))  # returns str today
```

After this PR `respond` returns `AgentResponse`. Update to:

```python
if self._target_agent:
    return (await self._target_agent.respond(messages)).text
```

(`.text` extracts the response string sim expects.)

- [ ] **Step 3: Update re-exports**

In `src/evaluatorq/simulation/runner/__init__.py`, replace any `TargetAgent` re-export with `AgentTarget`. Same in `src/evaluatorq/simulation/__init__.py`.

```bash
grep -rn "TargetAgent" src/evaluatorq/simulation
```

For each remaining reference, switch to `AgentTarget` imported from contracts.

- [ ] **Step 4: Run simulation tests**

```bash
uv run pytest tests/simulation -m 'not integration' -x -q
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation
git commit -m "refactor(simulation): drop local TargetAgent Protocol; consume AgentTarget"
```

## Task 3.8: Auto-route `target=AgentTarget` in `simulation/api.py`

**Files:**
- Modify: `src/evaluatorq/simulation/api.py`

- [ ] **Step 1: Detect AgentTarget instances in `simulate()`**

In `src/evaluatorq/simulation/api.py`, around line 184 (`resolved_callback = target or target_callback`), add:

```python
from evaluatorq.contracts import AgentTarget

# Auto-route: if target is an AgentTarget, hand it to the runner directly
# rather than treating it as a callable.
target_agent: AgentTarget | None = None
resolved_callback = target or target_callback
if isinstance(resolved_callback, AgentTarget):
    target_agent = resolved_callback
    resolved_callback = None
elif not resolved_callback and agent_key:
    resolved_callback = from_orq_deployment(agent_key)

if target_agent is None and not resolved_callback:
    raise ValueError("Either target (AgentTarget or callable) or agent_key is required")
```

Update `SimulationRunner(...)` construction to pass `target_agent=target_agent` if non-None:

```python
runner = SimulationRunner(
    target_callback=resolved_callback,
    target_agent=target_agent,
    model=model,
    max_turns=max_turns,
    user_simulator=user_simulator,
    judge=judge,
)
```

(Verify `SimulationRunner.__init__` accepts `target_agent`. If not, add it as an `AgentTarget | None = None` parameter and store as `self._target_agent`.)

- [ ] **Step 2: Run sim tests**

```bash
uv run pytest tests/simulation -m 'not integration' -x -q
```

- [ ] **Step 3: Commit**

```bash
git add src/evaluatorq/simulation/api.py src/evaluatorq/simulation/runner/simulation.py
git commit -m "feat(simulation): auto-route AgentTarget instances to runner.target_agent"
```

## Task 3.9: Round-trip integration test

**Files:**
- Create: `tests/integration/test_sim_redteam_target_roundtrip.py`

- [ ] **Step 1: Write the test**

```python
"""RES-808 acceptance: one OrqResponsesTarget instance works as both
sim target_agent and redteam AgentTarget without state corruption.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from evaluatorq.contracts import AgentResponse, ChatMessage, LLMCallConfig
from evaluatorq.simulation.target import OrqResponsesTarget


def _make_response(text: str) -> MagicMock:
    part = MagicMock()
    part.type = "output_text"
    part.text = text
    msg_item = MagicMock()
    msg_item.type = "message"
    msg_item.content = [part]
    usage = MagicMock()
    usage.input_tokens = 5
    usage.output_tokens = 3
    response = MagicMock()
    response.id = "resp"
    response.usage = usage
    response.output = [msg_item]
    return response


@pytest.mark.asyncio
async def test_one_instance_used_for_sim_then_redteam_path():
    client = MagicMock()
    client.responses = MagicMock()
    client.responses.create = AsyncMock(
        side_effect=[_make_response("sim-r1"), _make_response("redteam-r1")]
    )
    target = OrqResponsesTarget(LLMCallConfig(model="gpt-4o"), client=client)

    sim_result = await target.respond([ChatMessage(role="user", content="sim-q")])
    redteam_result = await target.send_prompt("redteam-q")

    assert isinstance(sim_result, AgentResponse)
    assert isinstance(redteam_result, AgentResponse)
    assert sim_result.text == "sim-r1"
    assert redteam_result.text == "redteam-r1"
```

- [ ] **Step 2: Run**

```bash
uv run pytest tests/integration/test_sim_redteam_target_roundtrip.py -v
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_sim_redteam_target_roundtrip.py
git commit -m "test: round-trip OrqResponsesTarget through sim and redteam paths"
```

## Task 3.10: Doc updates

**Files:**
- Modify: `docs/types-uml.md`
- Modify: `docs/types-uml.html`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `docs/types-uml.md`**

Replace any 12-type protocol family in the main classDiagram with the post-RES-808 end-state:

- `AgentTarget` ABC (in `evaluatorq.contracts`) — `respond`, `new`, `get_agent_context`, `send_prompt` (shim)
- `Backend` ABC (in `redteam/backends/base.py`) — `create_target`, `cleanup_memory`, `map_error`
- `ORQBackend`, `OpenAIBackend` — concrete subclasses
- `ORQAgentTarget`, `OpenAIModelTarget`, `OrqResponsesTarget`, integration targets — `AgentTarget` impls
- `ChatMessage` (in `evaluatorq.contracts`)

Drop any "Proposal — RES-844" appendix.

- [ ] **Step 2: Regenerate `docs/types-uml.html` via `/html-artifacts`**

```bash
# trigger inside the chat: /html-artifacts using types-uml.md as source
```

Or skip if html regen is owned by a separate process — leave a TODO in the PR description.

- [ ] **Step 3: CHANGELOG entry**

Append to `CHANGELOG.md`:

```markdown
## Unreleased

### Changed (BREAKING)
- `AgentTarget` moved from `evaluatorq.redteam.backends.base` to `evaluatorq.contracts`.
- `AgentTarget.respond(messages: list[ChatMessage]) -> AgentResponse` is now the abstract method. `send_prompt(prompt: str)` is retained as a back-compat shim.
- `ChatMessage` moved from `evaluatorq.simulation.types` to `evaluatorq.contracts`; old import path retained for one cycle via re-export, removal in 1.5.
- `ChatMessage.role` now includes `"developer"` in addition to `user`/`assistant`/`system`.
- `OrqResponsesTarget` is now stateless. `__call__`, `_previous_response_id`, and `get_usage()` removed.
- `BackendBundle` dataclass and all `Supports*` protocols removed. Implement `evaluatorq.redteam.backends.base.Backend` to register a new backend.
- `DirectTargetFactory` and `is_agent_target()` removed from `evaluatorq.redteam`. Use `isinstance(x, AgentTarget)`.

### Fixed
- `runner.py` no longer masks the ORQ-specific error mapper with `DefaultErrorMapper()`. ORQ HTTP exceptions now correctly produce `orq.http.<status>` error codes.
```

- [ ] **Step 4: Commit**

```bash
git add docs/types-uml.md docs/types-uml.html CHANGELOG.md
git commit -m "docs(redteam): update types-uml + CHANGELOG for RES-808"
```

## Task 3.11: Final check + push PR3

- [ ] **Step 1: Full suite + type-check**

```bash
uv run pytest -m 'not integration' -x -q
uv run basedpyright src/evaluatorq
uv run ruff check src
```

Expected: all green.

- [ ] **Step 2: Optional — run integration tests if ORQ_API_KEY is set**

```bash
uv run pytest -m integration -x -q
```

Skip if no key.

- [ ] **Step 3: Push and open PR3**

```bash
git push
gh pr create \
  --title "RES-808 (PR3/3): unify AgentTarget on respond(messages); stateless OrqResponsesTarget" \
  --body "$(cat <<'EOF'
## Summary
- Move ``ChatMessage`` to ``evaluatorq.contracts``; add ``developer`` role.
- ``AgentTarget`` gains abstract ``respond(messages: list[ChatMessage]) -> AgentResponse``; ``send_prompt`` becomes a one-line back-compat shim.
- ``OrqResponsesTarget`` becomes fully stateless — drops ``__call__``, ``_previous_response_id``, ``_accumulated_usage``, ``get_usage()``.
- ``ORQAgentTarget`` keeps the agents endpoint and ``task_id`` threading; signature conforms to ABC (forwards only last user message; raises if ``messages[-1].role != 'user'``).
- ``OpenAIModelTarget`` drops per-instance ``_history``; caller owns conversation.
- 4 integration targets refactored to ``respond``.
- Simulation runner deletes local ``TargetAgent`` Protocol; consumes ``AgentTarget`` from contracts.
- ``simulate(target=AgentTarget instance)`` auto-routes to ``target_agent`` path.

## Test plan
- [ ] ``uv run pytest -m 'not integration'`` green
- [ ] ``uv run basedpyright src/evaluatorq`` green
- [ ] ``tests/integration/test_sim_redteam_target_roundtrip.py`` passes
- [ ] Manual: at least one ORQ live red-team run still works against a real agent_key (validates task_id threading preserved).

## Breaking changes (CHANGELOG entry)
- ``ChatMessage`` import path moves to ``evaluatorq.contracts``.
- ``OrqResponsesTarget.__call__`` removed; pass the target as ``target=...`` (auto-routes) or ``target_agent=...``.
- ``AgentTarget.send_prompt`` is a shim now; subclasses must implement ``respond``.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Self-Review

**Spec coverage check:**

- §2 Goal 1 (collapse 12 → 2 ABCs): PR1 — Tasks 1.1, 1.4, 1.5, 1.10
- §2 Goal 2 (relocate to evaluatorq.contracts): PR2 — Tasks 2.1, 2.2
- §2 Goal 3 (unify on respond): PR3 — Tasks 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
- §2 Goal 4 (stateless OrqResponsesTarget): PR3 — Task 3.3
- §2 Goal 5 (ORQAgentTarget keeps endpoint): PR3 — Task 3.4
- §5.4 (_errors.py extraction): Task 1.2
- §5.9 (_BareTargetBackend): Task 1.9
- §5.10 (deletions): Task 1.10
- §7 testing strategy (per PR): tests included in each task
- §10 decisions log: reflected in choices throughout

**Type consistency check:**

- `Backend.create_target(agent_key: str) -> AgentTarget` — consistent across Tasks 1.1, 1.4, 1.5, 1.9
- `AgentTarget.respond(messages: list[ChatMessage]) -> AgentResponse` — consistent across Tasks 3.2-3.7
- `Backend.cleanup_memory(ctx: AgentContext, entity_ids: list[str]) -> None` — consistent
- `Backend.map_error(exc: Exception) -> tuple[str, str]` — consistent
- `ChatMessage.role: Literal["user", "assistant", "system", "developer"]` — Task 3.1
- `_BareTargetBackend(target).cleanup_memory` matches Backend signature — Task 1.9

**Known plan-execution risks (call out to executor):**

1. **Task 1.3 ordering** — `AgentTarget` becomes ABC before its concrete subclasses are updated. Run tests *after* Step 2 (concretes updated), not after Step 1. If you commit between steps, integration target tests will fail at Step 1.
2. **Task 1.7 Step 4** — `all_at_cleanup_info` consumer needs grepping; the precise call-site varies by current runner state. Read before editing.
3. **Task 3.4** — `ORQAgentTarget.respond` raises on non-user last message. Confirm no internal caller passes an assistant-terminated transcript before merging PR3.
4. **PR2 timing** — must merge cleanly between PR1 and PR3. If PR1 review delays, rebase PR2 + PR3 onto current PR1 tip.

---

# Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-res-808-collapse-relocate-unify.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks. Best for a large stacked-PR refactor like this where blast radius per task is bounded but the surface area is large.

**2. Inline Execution** — Run tasks in this session via the executing-plans skill; checkpoints between PRs.

Which approach?
