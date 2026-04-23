# RedTeam Config API Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate `PipelineLLMConfig` + `RedTeamConfig` into a single `LLMConfig` class, thread it through all internal pipeline components so `config=LLMConfig(...)` actually controls behaviour, remove the `llm:` string target prefix in favour of `OpenAIModelTarget`, and remove top-level params (`attack_model`, `evaluator_model`, `llm_kwargs`, `backend`) from `red_team()`.

**Architecture:** `LLMConfig` becomes the single source of truth for every LLM-related pipeline knob. It is threaded as `pipeline_config` through every internal component that previously read the module-level `PIPELINE_CONFIG` singleton directly, so user-supplied config actually applies at runtime. `PIPELINE_CONFIG = LLMConfig()` stays as the module-level default — components fall back to it when no explicit config is passed. `OpenAIModelTarget` (already in `backends/openai.py`) is promoted to first-class public type. Backend routing becomes fully automatic — string targets are always ORQ; `AgentTarget` objects use `DirectTargetFactory` and never touch backend routing.

**Tech Stack:** Python 3.10+, Pydantic v2, `loguru`, `openai` SDK, `typer` (CLI). Test runner: `pytest` + `pytest-asyncio`. Package manager: `uv`.

---

## File Map

| Status | File | What changes |
|--------|------|-------------|
| Modify | `src/evaluatorq/redteam/contracts.py` | Merge `PipelineLLMConfig` fields into new `LLMConfig`; keep `RedTeamConfig = LLMConfig` and `PipelineLLMConfig = LLMConfig` as aliases; drop `backend` field and `resolve_backend()`; update `PIPELINE_CONFIG = LLMConfig()` |
| Modify | `src/evaluatorq/redteam/adaptive/orchestrator.py` | Accept `pipeline_config: LLMConfig \| None` instead of reading `PIPELINE_CONFIG` directly |
| Modify | `src/evaluatorq/redteam/adaptive/pipeline.py` | Thread `pipeline_config` to orchestrator and generator functions |
| Modify | `src/evaluatorq/redteam/adaptive/capability_classifier.py` | Accept and use `pipeline_config` instead of `PIPELINE_CONFIG` |
| Modify | `src/evaluatorq/redteam/adaptive/objective_generator.py` | Accept and use `pipeline_config` |
| Modify | `src/evaluatorq/redteam/adaptive/attack_generator.py` | Accept and use `pipeline_config` |
| Modify | `src/evaluatorq/redteam/backends/orq.py` | `ORQTargetFactory` accepts `timeout_ms`; `ORQAgentTarget` uses it instead of `PIPELINE_CONFIG` |
| Modify | `src/evaluatorq/redteam/backends/registry.py` | `resolve_backend()` accepts `pipeline_config`; passes `timeout_ms` to ORQ factory |
| Modify | `src/evaluatorq/redteam/backends/openai.py` | Make `client` optional; rename `model_id` → `model`; remove `create_openai_target` wrapper |
| Modify | `src/evaluatorq/redteam/runner.py` | Drop `backend`/`attack_model`/`evaluator_model`/`llm_kwargs` params; drop `llm:`/`openai:` parsing; pass `pipeline_config=config` to all sub-functions; preserve `llm_client` guard in `uses_orq_router` check |
| Modify | `src/evaluatorq/redteam/__init__.py` | Export `LLMConfig`, `OpenAIModelTarget`; add `__getattr__` deprecation shims; remove `RedTeamConfig`/`PipelineLLMConfig` from static import block |
| Modify | `src/evaluatorq/redteam/cli.py` | Remove `--backend`; keep `--attack-model`/`--evaluator-model` but plumb into `LLMConfig`; update `--target` help |
| Modify | `examples/redteam/11_redteam_config.py` | Use `LLMConfig` with flat fields; add `OpenAIModelTarget` example |
| Modify | `tests/redteam/test_runner.py` | Remove `backend=` kwargs |
| Modify | `tests/redteam/e2e/test_pipeline_options.py` | Remove `backend=` kwargs |
| Create | `tests/redteam/test_llm_config.py` | Unit tests for `LLMConfig` (fusion, aliases, deprecation) |
| Create | `tests/redteam/test_openai_model_target.py` | Unit tests for `OpenAIModelTarget` (optional client, clone, get_agent_context) |
| Create | `tests/redteam/test_target_parsing.py` | Unit tests for `_parse_target` including `llm:` removal |
| Create | `tests/redteam/test_public_api.py` | Tests that `LLMConfig`/`OpenAIModelTarget` importable; deprecation shims work |

---

## Task 1: Fuse `PipelineLLMConfig` into `LLMConfig` in `contracts.py`

**Files:**
- Modify: `src/evaluatorq/redteam/contracts.py` (lines 552–682)
- Create: `tests/redteam/test_llm_config.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/redteam/test_llm_config.py
import os
import pytest
from evaluatorq.redteam.contracts import LLMConfig, PIPELINE_CONFIG


def test_llm_config_has_pipeline_fields():
    cfg = LLMConfig()
    assert cfg.adversarial_temperature == 1.0
    assert cfg.adversarial_max_tokens == 5000
    assert cfg.strategy_generation_temperature == 1.0
    assert cfg.strategy_generation_max_tokens == 5000
    assert cfg.capability_classification_max_tokens == 5000
    assert cfg.capability_classification_temperature == 1.0
    assert cfg.tool_adaptation_max_tokens == 5000
    assert cfg.tool_adaptation_temperature == 1.0
    assert cfg.target_max_tokens == 5000
    assert cfg.llm_call_timeout_ms == 90_000
    assert cfg.target_agent_timeout_ms == 240_000
    assert cfg.cleanup_timeout_ms == 60_000
    assert cfg.retry_count == 3
    assert cfg.log_level == 'INFO'


def test_llm_config_has_model_fields():
    cfg = LLMConfig(attack_model='gpt-4o', evaluator_model='gpt-4o-mini')
    assert cfg.attack_model == 'gpt-4o'
    assert cfg.evaluator_model == 'gpt-4o-mini'


def test_llm_config_has_llm_kwargs():
    cfg = LLMConfig(llm_kwargs={'temperature': 0.5})
    assert cfg.llm_kwargs == {'temperature': 0.5}


def test_llm_config_no_backend_field():
    cfg = LLMConfig()
    assert not hasattr(cfg, 'backend')


def test_llm_config_no_llm_sub_field():
    cfg = LLMConfig()
    assert not hasattr(cfg, 'llm')


def test_pipeline_config_is_llm_config():
    assert isinstance(PIPELINE_CONFIG, LLMConfig)


def test_retry_config_empty_when_openai_key_set(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test')
    monkeypatch.delenv('ORQ_API_KEY', raising=False)
    cfg = LLMConfig()
    assert cfg.retry_config == {}


def test_retry_config_populated_when_only_orq_key(monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv('ORQ_API_KEY', 'orq-test')
    cfg = LLMConfig()
    result = cfg.retry_config
    assert 'retry' in result
    assert result['retry']['count'] == 3


def test_resolve_model_adds_prefix_for_orq_router():
    cfg = LLMConfig()
    assert cfg.resolve_model('gpt-5-mini', uses_orq_router=True) == 'openai/gpt-5-mini'
    assert cfg.resolve_model('openai/gpt-5-mini', uses_orq_router=True) == 'openai/gpt-5-mini'
    assert cfg.resolve_model('gpt-5-mini', uses_orq_router=False) == 'gpt-5-mini'
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_llm_config.py -v 2>&1 | head -30
```

Expected: `ImportError: cannot import name 'LLMConfig'`

- [ ] **Step 3: Replace `PipelineLLMConfig` and `RedTeamConfig` with `LLMConfig` in `contracts.py`**

Replace everything from `class PipelineLLMConfig` (line 552) through the end of `RedTeamConfig` (line 682) with:

```python
class LLMConfig(BaseModel):
    """Unified LLM configuration for the red teaming pipeline.

    Covers model selection, per-request kwargs, per-step call tuning
    (temperature, max_tokens), timeouts, and retry behaviour. Pass an
    instance as ``config=LLMConfig(...)`` to :func:`red_team`.

    Pipeline steps:

    1. **Capability classification** — analyses agent tools/resources.
    2. **Strategy generation** — LLM generates novel attack strategies.
    3. **Tool adaptation** — rewrites generic prompts to target specific tools.
    4. **Adversarial prompt generation** — crafts the actual attack messages.
    """

    # --- Model selection -------------------------------------------------------
    attack_model: str = DEFAULT_PIPELINE_MODEL
    evaluator_model: str = DEFAULT_PIPELINE_MODEL

    # --- Extra kwargs forwarded to every chat.completions.create() call -------
    llm_kwargs: dict[str, Any] = Field(default_factory=dict)

    # --- Retry configuration --------------------------------------------------
    retry_count: int = 3
    retry_on_codes: list[int] = Field(default=[429, 500, 502, 503, 504])

    # --- Step 1: Capability classification ------------------------------------
    capability_classification_max_tokens: int = 5000
    capability_classification_temperature: float = 1.0

    # --- Step 2: Strategy generation ------------------------------------------
    strategy_generation_max_tokens: int = 5000
    strategy_generation_temperature: float = 1.0

    # --- Step 3: Tool adaptation ----------------------------------------------
    tool_adaptation_max_tokens: int = 5000
    tool_adaptation_temperature: float = 1.0

    # --- Step 4: Adversarial prompt generation --------------------------------
    adversarial_max_tokens: int = 5000
    adversarial_temperature: float = 1.0

    # --- Target call settings -------------------------------------------------
    target_max_tokens: int = 5000
    target_agent_timeout_ms: int = 240_000
    llm_call_timeout_ms: int = 90_000
    cleanup_timeout_ms: int = 60_000

    # --- Logging --------------------------------------------------------------
    log_level: str = 'INFO'

    @property
    def retry_config(self) -> dict[str, Any]:
        """ORQ retry config dict for ``extra_body``.

        Returns empty dict when using the OpenAI API directly (the
        ``retry`` parameter is ORQ-specific and rejected by OpenAI).
        """
        if os.getenv('OPENAI_API_KEY') or not os.getenv('ORQ_API_KEY'):
            return {}
        return {'retry': {'count': self.retry_count, 'on_codes': self.retry_on_codes}}

    def resolve_model(self, model: str, *, uses_orq_router: bool) -> str:
        """Add ``openai/`` prefix when routing through the ORQ router.

        If the model already contains ``/`` it is returned unchanged.
        """
        if uses_orq_router and '/' not in model:
            return f'openai/{model}'
        return model

    @property
    def uses_orq_router(self) -> bool:
        """True when LLM calls route through the ORQ router.

        The ORQ router is used when no ``OPENAI_API_KEY`` is set but
        ``ORQ_API_KEY`` is available.
        """
        return not os.getenv('OPENAI_API_KEY') and bool(os.getenv('ORQ_API_KEY'))


# Module-level default used by internal pipeline components.
# Import this in other modules; tests can monkeypatch it.
PIPELINE_CONFIG = LLMConfig()

# Backward-compatibility aliases — emit DeprecationWarning when
# accessed via ``evaluatorq.redteam`` (handled in __init__.py).
RedTeamConfig = LLMConfig
PipelineLLMConfig = LLMConfig
```

Also update `TargetKind` (lines 214–226) — remove `LLM`, simplify `is_model`:

```python
class TargetKind(StrEnum):
    """Kind of target being red-teamed."""

    AGENT = 'agent'
    DEPLOYMENT = 'deployment'
    DIRECT = 'direct'
    OPENAI = 'openai'  # used internally by OpenAIModelTarget; not a valid string prefix

    @property
    def is_model(self) -> bool:
        """True when this target kind represents a model (not an agent key)."""
        return self == TargetKind.OPENAI
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_llm_config.py -v
```

Expected: all 10 tests PASS.

- [ ] **Step 5: Run full unit test suite to catch regressions**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -x -q 2>&1 | tail -20
```

Fix any failures before proceeding.

- [ ] **Step 6: Commit**

```bash
git add packages/evaluatorq-py/src/evaluatorq/redteam/contracts.py \
        packages/evaluatorq-py/tests/redteam/test_llm_config.py
git commit -m "refactor(evaluatorq-py): fuse PipelineLLMConfig + RedTeamConfig into LLMConfig"
```

---

## Task 2: Thread `pipeline_config` through all internal pipeline components

**Files:**
- Modify: `src/evaluatorq/redteam/adaptive/orchestrator.py`
- Modify: `src/evaluatorq/redteam/adaptive/capability_classifier.py`
- Modify: `src/evaluatorq/redteam/adaptive/objective_generator.py`
- Modify: `src/evaluatorq/redteam/adaptive/attack_generator.py`
- Modify: `src/evaluatorq/redteam/adaptive/pipeline.py`

The pattern for every internal function: add `pipeline_config: LLMConfig | None = None` as a param, then resolve at the top with `cfg = pipeline_config or PIPELINE_CONFIG`. Replace every `PIPELINE_CONFIG.foo` reference with `cfg.foo`.

- [ ] **Step 1: Update `orchestrator.py` — `RedTeamOrchestrator.__init__`**

Find the `__init__` signature of `RedTeamOrchestrator` (around line 291). Add `pipeline_config`:

```python
def __init__(
    self,
    ...
    llm_kwargs: dict[str, Any] | None = None,
    pipeline_config: LLMConfig | None = None,
):
    ...
    self._cfg = pipeline_config or PIPELINE_CONFIG
    self.llm_kwargs = llm_kwargs or {}
```

Replace every `PIPELINE_CONFIG.` reference in this file with `self._cfg.`:
- `PIPELINE_CONFIG.adversarial_temperature` → `self._cfg.adversarial_temperature`
- `PIPELINE_CONFIG.adversarial_max_tokens` → `self._cfg.adversarial_max_tokens`
- `PIPELINE_CONFIG.llm_call_timeout_ms` → `self._cfg.llm_call_timeout_ms`
- `PIPELINE_CONFIG.target_agent_timeout_ms` → `self._cfg.target_agent_timeout_ms`

Add the import at the top of `orchestrator.py`:
```python
from evaluatorq.redteam.contracts import ..., LLMConfig
```

- [ ] **Step 2: Update `capability_classifier.py`**

For each public function that references `PIPELINE_CONFIG` (there are two: `_infer_resource_capabilities` and `_classify_tools`, and their callers), add `pipeline_config: LLMConfig | None = None` and resolve:

```python
from evaluatorq.redteam.contracts import ..., LLMConfig

async def classify_agent_capabilities(
    agent_context: AgentContext,
    llm_client: AsyncOpenAI,
    model: str,
    llm_kwargs: dict[str, Any] | None = None,
    pipeline_config: LLMConfig | None = None,
) -> AgentCapabilities:
    cfg = pipeline_config or PIPELINE_CONFIG
    ...
    # replace PIPELINE_CONFIG.capability_classification_temperature with cfg.capability_classification_temperature
    # replace PIPELINE_CONFIG.capability_classification_max_tokens with cfg.capability_classification_max_tokens
    # replace PIPELINE_CONFIG.retry_config with cfg.retry_config
```

Apply the same pattern to `_infer_resource_capabilities` and `_classify_tools` — add `pipeline_config` param, pass `cfg` down.

- [ ] **Step 3: Update `objective_generator.py`**

Add `pipeline_config: LLMConfig | None = None` to every function that reads `PIPELINE_CONFIG`:

```python
from evaluatorq.redteam.contracts import ..., LLMConfig

async def generate_objectives(
    ...,
    llm_kwargs: dict[str, Any] | None = None,
    pipeline_config: LLMConfig | None = None,
) -> list[str]:
    cfg = pipeline_config or PIPELINE_CONFIG
    # replace PIPELINE_CONFIG.strategy_generation_temperature → cfg.strategy_generation_temperature
    # replace PIPELINE_CONFIG.strategy_generation_max_tokens → cfg.strategy_generation_max_tokens
    # replace PIPELINE_CONFIG.retry_config → cfg.retry_config
```

Thread `pipeline_config` through all internal helper functions in this file.

- [ ] **Step 4: Update `attack_generator.py`**

```python
from evaluatorq.redteam.contracts import ..., LLMConfig

async def generate_attack(
    ...,
    llm_kwargs: dict[str, Any] | None = None,
    pipeline_config: LLMConfig | None = None,
) -> str:
    cfg = pipeline_config or PIPELINE_CONFIG
    # replace PIPELINE_CONFIG.tool_adaptation_temperature → cfg.tool_adaptation_temperature
    # replace PIPELINE_CONFIG.tool_adaptation_max_tokens → cfg.tool_adaptation_max_tokens
    # replace PIPELINE_CONFIG.retry_config → cfg.retry_config
```

- [ ] **Step 5: Update `pipeline.py` — thread through to all callees**

`pipeline.py` calls capability classifier, objective generator, attack generator, and creates the orchestrator. Add `pipeline_config: LLMConfig | None = None` to:
- `generate_dynamic_datapoints()`
- `generate_dynamic_datapoints_for_vulnerabilities()`
- `create_dynamic_redteam_job()`

In each, resolve `cfg = pipeline_config or PIPELINE_CONFIG` and pass it down to callees:

```python
from evaluatorq.redteam.contracts import ..., LLMConfig

async def generate_dynamic_datapoints(
    ...,
    llm_kwargs: dict[str, Any] | None = None,
    pipeline_config: LLMConfig | None = None,
) -> tuple[list[DataPoint], dict[str, Any]]:
    cfg = pipeline_config or PIPELINE_CONFIG
    # pass pipeline_config=cfg to capability_classifier calls
    # pass pipeline_config=cfg to objective_generator calls
    # pass pipeline_config=cfg to attack_generator calls
    # replace remaining PIPELINE_CONFIG.xxx with cfg.xxx
```

For `create_dynamic_redteam_job`, pass `pipeline_config` to `RedTeamOrchestrator`:

```python
def create_dynamic_redteam_job(
    ...,
    pipeline_config: LLMConfig | None = None,
) -> Callable:
    orchestrator = RedTeamOrchestrator(
        ...,
        pipeline_config=pipeline_config,
    )
```

Also replace `PIPELINE_CONFIG.target_agent_timeout_ms` and `PIPELINE_CONFIG.cleanup_timeout_ms` with `cfg.xxx` in this file.

- [ ] **Step 6: Thread `timeout_ms` into `backends/orq.py` via `ORQTargetFactory`**

In `src/evaluatorq/redteam/backends/orq.py`, find `ORQAgentTarget.__init__` and add `timeout_ms`:

```python
def __init__(
    self,
    ...
    timeout_ms: int = PIPELINE_CONFIG.target_agent_timeout_ms,
):
    ...
    self._timeout_ms = timeout_ms
```

Replace every direct `PIPELINE_CONFIG.target_agent_timeout_ms` reference in the file with `self._timeout_ms`:
- Lines 424, 455, 513, 537 (approx) — all async call sites that pass the timeout value.

In `ORQTargetFactory`, add `timeout_ms` param:

```python
class ORQTargetFactory:
    def __init__(
        self,
        ...
        timeout_ms: int = PIPELINE_CONFIG.target_agent_timeout_ms,
    ):
        ...
        self._timeout_ms = timeout_ms

    def create_target(self, agent_key: str) -> ORQAgentTarget:
        return ORQAgentTarget(..., timeout_ms=self._timeout_ms)
```

- [ ] **Step 7: Thread `pipeline_config` into `backends/registry.py`**

In `src/evaluatorq/redteam/backends/registry.py`, update `resolve_backend`:

```python
from evaluatorq.redteam.contracts import LLMConfig, PIPELINE_CONFIG

def resolve_backend(
    backend: str,
    ...
    pipeline_config: LLMConfig | None = None,
) -> Any:
    cfg = pipeline_config or PIPELINE_CONFIG
    if backend == 'orq':
        return ORQTargetFactory(
            ...,
            timeout_ms=cfg.target_agent_timeout_ms,
        )
    ...
```

- [ ] **Step 8: Run full unit test suite**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -x -q 2>&1 | tail -20
```

Expected: no failures. The internal components now accept but don't require `pipeline_config`, so all existing callers still work with their defaults.

- [ ] **Step 9: Commit**

```bash
git add \
  packages/evaluatorq-py/src/evaluatorq/redteam/adaptive/orchestrator.py \
  packages/evaluatorq-py/src/evaluatorq/redteam/adaptive/capability_classifier.py \
  packages/evaluatorq-py/src/evaluatorq/redteam/adaptive/objective_generator.py \
  packages/evaluatorq-py/src/evaluatorq/redteam/adaptive/attack_generator.py \
  packages/evaluatorq-py/src/evaluatorq/redteam/adaptive/pipeline.py \
  packages/evaluatorq-py/src/evaluatorq/redteam/backends/orq.py \
  packages/evaluatorq-py/src/evaluatorq/redteam/backends/registry.py
git commit -m "feat(evaluatorq-py): thread pipeline_config through internal pipeline components and ORQ backend"
```

---

## Task 3: Make `OpenAIModelTarget` public with optional client

**Files:**
- Modify: `src/evaluatorq/redteam/backends/openai.py`
- Create: `tests/redteam/test_openai_model_target.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/redteam/test_openai_model_target.py
import pytest
from unittest.mock import MagicMock, patch
from evaluatorq.redteam.backends.openai import OpenAIModelTarget
from evaluatorq.redteam.contracts import AgentContext, TargetKind


def test_optional_client_auto_creates():
    with patch('evaluatorq.redteam.backends.openai.create_async_llm_client') as mock_create:
        mock_client = MagicMock()
        mock_create.return_value = mock_client
        target = OpenAIModelTarget(model='gpt-4o')
        mock_create.assert_called_once()
        assert target.client is mock_client


def test_explicit_client_skips_auto_create():
    with patch('evaluatorq.redteam.backends.openai.create_async_llm_client') as mock_create:
        client = MagicMock()
        target = OpenAIModelTarget(model='gpt-4o', client=client)
        mock_create.assert_not_called()
        assert target.client is client


def test_model_param_name():
    client = MagicMock()
    target = OpenAIModelTarget(model='gpt-4o', client=client)
    assert target.model == 'gpt-4o'


def test_system_prompt_default():
    client = MagicMock()
    target = OpenAIModelTarget(model='gpt-4o', client=client)
    assert target.system_prompt == 'You are a helpful assistant.'


def test_clone_preserves_fields():
    client = MagicMock()
    target = OpenAIModelTarget(model='gpt-4o', system_prompt='Be terse.', client=client)
    clone = target.clone()
    assert clone.model == 'gpt-4o'
    assert clone.system_prompt == 'Be terse.'
    assert clone.client is client


def test_target_kind_is_openai():
    client = MagicMock()
    target = OpenAIModelTarget(model='gpt-4o', client=client)
    assert target.target_kind == TargetKind.OPENAI


def test_name_returns_model():
    client = MagicMock()
    target = OpenAIModelTarget(model='gpt-5-mini', client=client)
    assert target.name == 'gpt-5-mini'


@pytest.mark.asyncio
async def test_get_agent_context_returns_agent_context():
    client = MagicMock()
    target = OpenAIModelTarget(model='gpt-4o', client=client)
    ctx = await target.get_agent_context()
    assert isinstance(ctx, AgentContext)
    assert ctx.key == 'gpt-4o'
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_openai_model_target.py -v 2>&1 | head -20
```

Expected: `test_optional_client_auto_creates` and `test_explicit_client_skips_auto_create` FAIL (`client` currently required), `test_model_param_name` FAIL (`model_id` not `model`).

- [ ] **Step 3: Update `OpenAIModelTarget.__init__` signature**

Replace the `__init__` (lines 23–33) with:

```python
def __init__(
    self,
    model: str,
    system_prompt: str | None = None,
    *,
    client: AsyncOpenAI | None = None,
):
    from evaluatorq.redteam.backends.registry import create_async_llm_client
    self.model = model
    self.client = client or create_async_llm_client()
    self.system_prompt = system_prompt or 'You are a helpful assistant.'
    self._last_token_usage: TokenUsage | None = None
```

Update all internal `self.model_id` references → `self.model` (lines 44, 83, 95, 101, 108 in the original — note these shift after the `__init__` change):
- In `send_prompt`: `model=self.model_id` → `model=self.model`
- In `name` property: `return self.model_id` → `return self.model`
- In `clone`: `OpenAIModelTarget(model_id=self.model_id, ...)` → `OpenAIModelTarget(model=self.model, system_prompt=self.system_prompt, client=self.client)`
- In `create_target`: `OpenAIModelTarget(model_id=agent_key, ...)` → `OpenAIModelTarget(model=agent_key, system_prompt=self.system_prompt, client=self.client)`

Update `OpenAITargetFactory.create_target`:

```python
def create_target(self, agent_key: str) -> OpenAIModelTarget:
    return OpenAIModelTarget(model=agent_key, system_prompt=self._system_prompt, client=self._client)
```

Remove `create_openai_target` entirely — it is dead code (`client or None` is a no-op and the function adds nothing over direct construction):

```python
# DELETE the entire create_openai_target function:
def create_openai_target(model: str, client: Any = None) -> OpenAIModelTarget:
    ...
```

Also remove it from any `__all__` list in `backends/openai.py` if present.

- [ ] **Step 4: Run tests**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_openai_model_target.py -v
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Run full unit suite**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -x -q 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add packages/evaluatorq-py/src/evaluatorq/redteam/backends/openai.py \
        packages/evaluatorq-py/tests/redteam/test_openai_model_target.py
git commit -m "feat(evaluatorq-py): make OpenAIModelTarget public with optional client"
```

---

## Task 4: Drop `llm:` prefix, `backend` param, and wire `pipeline_config` in `runner.py`

**Files:**
- Modify: `src/evaluatorq/redteam/runner.py`
- Modify: `src/evaluatorq/redteam/contracts.py` (TargetKind update)
- Create: `tests/redteam/test_target_parsing.py`
- Modify: `tests/redteam/test_runner.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/redteam/test_target_parsing.py
import pytest
from evaluatorq.redteam.runner import _parse_target
from evaluatorq.redteam.contracts import TargetKind


def test_agent_prefix():
    kind, value = _parse_target('agent:my-key')
    assert kind == TargetKind.AGENT
    assert value == 'my-key'


def test_deployment_prefix():
    kind, value = _parse_target('deployment:my-dep')
    assert kind == TargetKind.DEPLOYMENT
    assert value == 'my-dep'


def test_no_prefix_defaults_to_agent():
    kind, value = _parse_target('my-key')
    assert kind == TargetKind.AGENT
    assert value == 'my-key'


def test_llm_prefix_raises_with_migration_hint():
    with pytest.raises(ValueError, match='OpenAIModelTarget'):
        _parse_target('llm:gpt-4o')


def test_openai_prefix_raises_with_migration_hint():
    with pytest.raises(ValueError, match='OpenAIModelTarget'):
        _parse_target('openai:gpt-4o')


def test_backend_not_a_param():
    import inspect
    from evaluatorq.redteam.runner import red_team
    assert 'backend' not in inspect.signature(red_team).parameters


def test_attack_model_not_a_param():
    import inspect
    from evaluatorq.redteam.runner import red_team
    assert 'attack_model' not in inspect.signature(red_team).parameters


def test_evaluator_model_not_a_param():
    import inspect
    from evaluatorq.redteam.runner import red_team
    assert 'evaluator_model' not in inspect.signature(red_team).parameters


def test_llm_kwargs_not_a_param():
    import inspect
    from evaluatorq.redteam.runner import red_team
    assert 'llm_kwargs' not in inspect.signature(red_team).parameters
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_target_parsing.py -v 2>&1 | head -30
```

Expected: `test_llm_prefix_raises_with_migration_hint`, `test_openai_prefix_raises_with_migration_hint` FAIL; `test_backend_not_a_param` and the `*_not_a_param` tests FAIL.

- [ ] **Step 3: Update `_parse_target()` in `runner.py`**

Replace the function body (lines 600–623):

```python
def _parse_target(target: str) -> tuple[TargetKind, str]:
    if ':' not in target:
        return TargetKind.AGENT, target
    kind, _, value = target.partition(':')
    if not value:
        raise ValueError(f'Target {target!r} is missing a value after the colon.')
    if kind.lower() in ('llm', 'openai'):
        raise ValueError(
            f'The "{kind}:" target prefix has been removed. '
            f'Use OpenAIModelTarget to test OpenAI models directly:\n'
            f'    from evaluatorq.redteam import OpenAIModelTarget\n'
            f'    await red_team(OpenAIModelTarget("{value}"))'
        )
    try:
        kind_enum = TargetKind(kind.lower())
    except ValueError:
        valid = ', '.join(
            f'"{k.value}"' for k in TargetKind
            if k not in (TargetKind.DIRECT, TargetKind.OPENAI)
        )
        raise ValueError(
            f'Unknown target kind {kind!r} in {target!r}. Valid kinds: {valid}.'
        ) from None
    if kind_enum is TargetKind.DIRECT:
        valid = ', '.join(
            f'"{k.value}"' for k in TargetKind
            if k not in (TargetKind.DIRECT, TargetKind.OPENAI)
        )
        raise ValueError(
            f'Target kind "direct" is not valid in string targets — '
            f'pass an AgentTarget object directly instead. Valid string kinds: {valid}.'
        )
    return kind_enum, value
```

- [ ] **Step 4: Remove `backend`, `attack_model`, `evaluator_model`, `llm_kwargs` from `red_team()` signature**

Delete these four params from the `red_team()` signature (lines ~278–300):
```python
# DELETE all four:
attack_model: str = DEFAULT_PIPELINE_MODEL,
evaluator_model: str = DEFAULT_PIPELINE_MODEL,
backend: str = 'openai',
llm_kwargs: dict[str, Any] | None = None,
```

Remove the corresponding merge-with-config block (lines ~432–441):
```python
# DELETE:
if attack_model == DEFAULT_PIPELINE_MODEL:
    attack_model = config.attack_model
if evaluator_model == DEFAULT_PIPELINE_MODEL:
    evaluator_model = config.evaluator_model
if not llm_kwargs and config.llm_kwargs:
    llm_kwargs = config.llm_kwargs
```

Remove the backend auto-detection block (lines ~439–453). Replace with nothing — backend is always ORQ for string targets; `AgentTarget` objects bring their own factory.

After removing the params, add an explicit rebind near the top of the `red_team()` body (right after config resolution):

```python
# Explicit rebind — downstream functions receive these as local vars,
# not from config, to avoid threading config through every call site.
llm_kwargs = config.llm_kwargs
```

Replace all remaining downstream local variable references:
- `attack_model` → `config.attack_model`
- `evaluator_model` → `config.evaluator_model`
- remaining `llm_kwargs` references are already covered by the rebind above

Also compute `uses_orq_router` in `red_team()` body (not solely from the property, which can't see `llm_client`):

```python
# Property alone doesn't know about the llm_client param — check both:
uses_orq_router = llm_client is None and config.uses_orq_router
```

Replace every subsequent `config.uses_orq_router` call in the function body with the local `uses_orq_router` variable.

- [ ] **Step 5: Remove `backend` from `_run_dynamic_or_hybrid`, `_prepare_target`, `_run_static` signatures**

Remove `backend: str` param from all three functions. Replace `resolve_backend(backend, ...)` with `resolve_backend('orq', ...)` in `_prepare_target` and `_run_static`. In `_run_dynamic_or_hybrid`, the same.

Note: this is safe because string targets are always `agent:` or `deployment:` (ORQ). `AgentTarget` objects already use `DirectTargetFactory` and never call `resolve_backend` for job execution — only for context retrieval at line ~1052, which is a string-target-only path.

Remove `backend` from `common_prepare_kwargs` dict in `_run_dynamic_or_hybrid`.

- [ ] **Step 6: Pass `pipeline_config=config` to all sub-functions that now accept it**

In `red_team()`, pass `pipeline_config=config` to `_run_dynamic_or_hybrid` and `_run_static`.

In `_run_dynamic_or_hybrid`, pass `pipeline_config=pipeline_config` (or `config`) to `_prepare_target`.

In `_prepare_target`, pass `pipeline_config` to `generate_dynamic_datapoints*()` and `create_dynamic_redteam_job()`.

In `_run_static`, no direct dynamic datapoint generation — nothing extra needed there.

Update the `_run_dynamic_or_hybrid` and `_run_static` and `_prepare_target` signatures to accept `pipeline_config: LLMConfig | None = None`.

- [ ] **Step 7: Update `_create_job_for_target` to use `config.target_max_tokens`**

Currently line ~704: `max_tokens=PIPELINE_CONFIG.target_max_tokens`. Since this function doesn't receive a config, add `pipeline_config: LLMConfig | None = None` param and resolve:

```python
def _create_job_for_target(
    target: str,
    llm_client: Any,
    system_prompt: str | None,
    pipeline_config: LLMConfig | None = None,
) -> Any:
    cfg = pipeline_config or PIPELINE_CONFIG
    common = dict(llm_client=llm_client, system_prompt=system_prompt, max_tokens=cfg.target_max_tokens)
    ...
```

Pass `pipeline_config` from `_prepare_target` and `_run_static` when calling this.

- [ ] **Step 8: Fix `test_runner.py` — remove `backend=` kwargs**

```bash
cd packages/evaluatorq-py
grep -n "backend=" tests/redteam/test_runner.py
# Lines 244 and 285 — remove the backend= kwarg from those calls
```

- [ ] **Step 9: Run tests**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_target_parsing.py tests/redteam/test_runner.py -v 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 10: Run full unit suite**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -x -q 2>&1 | tail -20
```

- [ ] **Step 11: Commit**

```bash
git add packages/evaluatorq-py/src/evaluatorq/redteam/runner.py \
        packages/evaluatorq-py/src/evaluatorq/redteam/contracts.py \
        packages/evaluatorq-py/tests/redteam/test_target_parsing.py \
        packages/evaluatorq-py/tests/redteam/test_runner.py
git commit -m "feat(evaluatorq-py): remove llm: prefix, backend/attack_model/evaluator_model/llm_kwargs params; thread pipeline_config"
```

---

## Task 5: Update `__init__.py` — export `LLMConfig` + `OpenAIModelTarget`, add working deprecation shims

**Files:**
- Modify: `src/evaluatorq/redteam/__init__.py`
- Create: `tests/redteam/test_public_api.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/redteam/test_public_api.py
import importlib
import warnings
import pytest


def test_llm_config_importable():
    from evaluatorq.redteam import LLMConfig
    assert LLMConfig is not None


def test_openai_model_target_importable():
    from evaluatorq.redteam import OpenAIModelTarget
    assert OpenAIModelTarget is not None


@pytest.fixture(autouse=True)
def reset_deprecated_warned():
    """Clear the deprecation-warned set so warnings fire afresh each test."""
    import evaluatorq.redteam as rt
    rt._deprecated_warned.clear()
    yield
    rt._deprecated_warned.clear()


def test_red_team_config_alias_warns():
    import evaluatorq.redteam as rt
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        _ = rt.RedTeamConfig  # triggers __getattr__
    dep = [x for x in w if issubclass(x.category, DeprecationWarning)]
    assert dep, "Expected DeprecationWarning, got none"
    assert any('LLMConfig' in str(x.message) for x in dep)


def test_pipeline_llm_config_alias_warns():
    import evaluatorq.redteam as rt
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        _ = rt.PipelineLLMConfig
    dep = [x for x in w if issubclass(x.category, DeprecationWarning)]
    assert dep, "Expected DeprecationWarning, got none"
    assert any('LLMConfig' in str(x.message) for x in dep)


def test_red_team_config_still_returns_llm_config_class():
    import evaluatorq.redteam as rt
    from evaluatorq.redteam.contracts import LLMConfig
    with warnings.catch_warnings(record=True):
        warnings.simplefilter('always')
        assert rt.RedTeamConfig is LLMConfig
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_public_api.py -v 2>&1 | head -20
```

Expected: `test_llm_config_importable`, `test_openai_model_target_importable` FAIL; deprecation tests FAIL.

- [ ] **Step 3: Update the `from evaluatorq.redteam.contracts import (...)` block in `__init__.py`**

Remove `PipelineLLMConfig` and `RedTeamConfig` from the static import list (lines 62–63). These must not appear in the module `__dict__` or `__getattr__` will never fire.

Add `LLMConfig` to the import list.

Add a new import line for `OpenAIModelTarget`:
```python
from evaluatorq.redteam.backends.openai import OpenAIModelTarget
```

- [ ] **Step 4: Update `__all__` in `__init__.py`**

Add:
```python
"LLMConfig",
"OpenAIModelTarget",
```

Remove `"PipelineLLMConfig"` and `"RedTeamConfig"` from `__all__` (they are served by `__getattr__` for backward compat but not advertised).

- [ ] **Step 5: Update `__getattr__` to handle both deprecated names**

```python
def __getattr__(name: str):
    if name in ('RedTeamConfig', 'PipelineLLMConfig'):
        if name not in _deprecated_warned:
            import warnings
            _deprecated_warned.add(name)
            warnings.warn(
                f'{name} is deprecated. Use LLMConfig instead.',
                DeprecationWarning,
                stacklevel=2,
            )
        from evaluatorq.redteam.contracts import LLMConfig
        return LLMConfig
    if name == 'EvaluationResult':
        if name not in _deprecated_warned:
            import warnings
            _deprecated_warned.add(name)
            warnings.warn(
                'EvaluationResult is deprecated in evaluatorq.redteam. '
                'Use AttackEvaluationResult instead.',
                DeprecationWarning,
                stacklevel=2,
            )
        return AttackEvaluationResult
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
```

- [ ] **Step 6: Run tests**

```bash
cd packages/evaluatorq-py
uv run pytest tests/redteam/test_public_api.py -v
```

Expected: all PASS.

- [ ] **Step 7: Run full unit suite**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -x -q 2>&1 | tail -20
```

- [ ] **Step 8: Commit**

```bash
git add packages/evaluatorq-py/src/evaluatorq/redteam/__init__.py \
        packages/evaluatorq-py/tests/redteam/test_public_api.py
git commit -m "feat(evaluatorq-py): export LLMConfig + OpenAIModelTarget; add deprecation shims for old names"
```

---

## Task 6: Update CLI — remove `--backend`, keep model flags plumbed into `LLMConfig`

**Files:**
- Modify: `src/evaluatorq/redteam/cli.py`
- Modify: `tests/redteam/e2e/test_pipeline_options.py`

- [ ] **Step 1: Remove `--backend` from `run()` and plumb model flags into `LLMConfig`**

Delete the `backend` option block (lines 233–236):
```python
# DELETE:
backend: Annotated[
    str,
    typer.Option(help='Backend name ("openai" or "orq").'),
] = "openai",
```

Keep `attack_model` and `evaluator_model` CLI options — they are still valid user-facing knobs. Instead of passing them directly to `red_team()` (which no longer accepts them), build a `LLMConfig` in the command body:

```python
# In the run() command body, before the await red_team(...) call:
from evaluatorq.redteam.contracts import LLMConfig
config = LLMConfig(
    attack_model=attack_model,
    evaluator_model=evaluator_model,
)

report = await red_team(
    targets,
    config=config,
    mode=mode,
    # ... rest of params, no attack_model/evaluator_model/backend
)
```

Remove `backend=backend` and `attack_model=attack_model` and `evaluator_model=evaluator_model` from the `red_team(...)` call (lines 324–332).

- [ ] **Step 2: Update `--target` help text**

Change line 153:
```python
help='Target identifier(s), e.g. "agent:<key>" or "llm:<model>". Repeatable.',
```
to:
```python
help='Target identifier(s), e.g. "agent:<key>" or "deployment:<key>". For OpenAI models use OpenAIModelTarget in the Python API. Repeatable.',
```

- [ ] **Step 3: Fix e2e tests — remove `backend=` kwargs**

```bash
cd packages/evaluatorq-py
grep -n "backend=" tests/redteam/e2e/test_pipeline_options.py
```

Remove all 6 `backend="openai"` kwargs from the `red_team(...)` calls in that file.

- [ ] **Step 4: Run unit tests**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -x -q 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add packages/evaluatorq-py/src/evaluatorq/redteam/cli.py \
        packages/evaluatorq-py/tests/redteam/e2e/test_pipeline_options.py
git commit -m "feat(evaluatorq-py): remove --backend flag; plumb CLI model flags into LLMConfig"
```

---

## Task 7: Update examples

**Files:**
- Modify: `examples/redteam/11_redteam_config.py`

- [ ] **Step 1: Update imports and config construction**

Replace:
```python
from evaluatorq.redteam import RedTeamConfig, PipelineLLMConfig
...
config_tuned = RedTeamConfig(
    attack_model="gpt-4.1-mini",
    evaluator_model="gpt-4.1-mini",
    llm=PipelineLLMConfig(
        adversarial_temperature=0.7,
        llm_call_timeout_ms=90_000,
        target_agent_timeout_ms=180_000,
        retry_count=5,
        retry_on_codes=[429, 500, 502, 503, 504],
    ),
)
```

With:
```python
from evaluatorq.redteam import LLMConfig
...
config_tuned = LLMConfig(
    attack_model="gpt-4.1-mini",
    evaluator_model="gpt-4.1-mini",
    adversarial_temperature=0.7,
    llm_call_timeout_ms=90_000,
    target_agent_timeout_ms=180_000,
    retry_count=5,
    retry_on_codes=[429, 500, 502, 503, 504],
)
```

- [ ] **Step 2: Add `OpenAIModelTarget` example replacing old `"llm:<model>"` syntax**

Append to the file:
```python
# --- Example: Testing an OpenAI model directly ----------------------------
# Use OpenAIModelTarget instead of the removed "llm:<model>" string prefix.
from evaluatorq.redteam import OpenAIModelTarget

report = await red_team(
    OpenAIModelTarget("gpt-4o", system_prompt="You are a helpful assistant."),
    config=LLMConfig(attack_model="gpt-4.1-mini"),
    mode="dynamic",
    categories=["LLM01"],
    max_dynamic_datapoints=3,
)
```

- [ ] **Step 3: Verify syntax**

```bash
cd packages/evaluatorq-py
uv run python -c "import ast; ast.parse(open('examples/redteam/11_redteam_config.py').read()); print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Run full suite one final time**

```bash
cd packages/evaluatorq-py
uv run pytest -m 'not integration' -q 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/redteam/11_redteam_config.py
git commit -m "docs(evaluatorq-py): update config example to use LLMConfig + OpenAIModelTarget"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| Fuse `PipelineLLMConfig` + `RedTeamConfig` → `LLMConfig` | Task 1 |
| Remove `TargetKind.LLM`; simplify `is_model` | Task 1 |
| Thread `pipeline_config` so `LLMConfig` fields actually apply | Task 2 |
| Thread `timeout_ms` into `ORQTargetFactory` via `resolve_backend` | Task 2 |
| `OpenAIModelTarget` optional client, public; remove `create_openai_target` | Tasks 3, 5 |
| Remove `llm:`/`openai:` string target prefix | Task 4 |
| Drop `backend`/`attack_model`/`evaluator_model`/`llm_kwargs` params | Task 4 |
| Explicit `llm_kwargs = config.llm_kwargs` rebind before downstream calls | Task 4 |
| `uses_orq_router = llm_client is None and config.uses_orq_router` guard | Task 4 |
| Pass `pipeline_config=config` through runner → pipeline | Task 4 |
| Export `LLMConfig`, `OpenAIModelTarget`; working deprecation shims | Task 5 |
| `_deprecated_warned` test isolation via fixture | Task 5 |
| Remove `--backend` CLI flag; keep model flags via `LLMConfig` | Task 6 |
| Update examples | Task 7 |

### Known limitations (out of scope)

- **`register_backend()`** stays public. It is now an internal-extension mechanism; users cannot select a registered backend via any public param. Document this in its docstring.
- **`resolve_model`** hardcodes `openai/` prefix for ORQ router. Models from other providers (Anthropic, Mistral) need caller to pass the full provider-prefixed name. This pre-existing limitation is unchanged.

### Placeholder scan

No TBD, TODO, or "implement later" left in this plan. All code steps are complete.

### Type consistency

- `LLMConfig` used consistently across all tasks (not `LlmConfig`)
- `OpenAIModelTarget(model=..., ...)` — `model` param name used consistently (Tasks 3, 7)
- `pipeline_config: LLMConfig | None = None` pattern used consistently in Tasks 2 and 4
