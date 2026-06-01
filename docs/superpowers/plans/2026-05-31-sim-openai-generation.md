# OpenAI-capable Simulation Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let simulation datapoint generation run against OpenAI (or any OpenAI-compatible endpoint) without `ORQ_API_KEY`, by routing generators through the shared `build_simulation_client` factory and exposing client injection on the SDK.

**Architecture:** The simulation loop (user-sim, judge) already resolves its provider via `build_simulation_client` (injected client → `ORQ_API_KEY` router → `OPENAI_API_KEY` + `OPENAI_BASE_URL`). Generators and the `api.py` generate paths bypass it with a hardcoded Orq-router client + a hard `_require_orq_api_key` gate. This plan removes that bypass so generation uses the same factory, adds a `generation_client` SDK param, renames the model param/flag to `sim_model`/`--sim-model`, and updates the default model.

**Tech Stack:** Python 3.10+, `openai` AsyncOpenAI, Typer CLI, pytest + pytest-asyncio, basedpyright, ruff. Package: `packages/evaluatorq-py`. All commands run from `packages/evaluatorq-py/`.

**Spec:** `docs/superpowers/specs/2026-05-31-sim-openai-generation-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/evaluatorq/simulation/types.py` | shared constants | `DEFAULT_MODEL` value |
| `src/evaluatorq/simulation/generators/persona_generator.py` | persona gen | default client → factory |
| `src/evaluatorq/simulation/generators/scenario_generator.py` | scenario gen | default client → factory |
| `src/evaluatorq/simulation/generators/first_message_generator.py` | first-msg gen | default client → factory |
| `src/evaluatorq/simulation/generators/datapoint_generator.py` | composite gen (owns client) | default client → factory + owned-close |
| `src/evaluatorq/simulation/api.py` | public `simulate`/`generate_and_simulate` | drop orq gate, add `generation_client`, rename `model`→`sim_model` |
| `src/evaluatorq/simulation/cli.py` | Typer commands `run`/`generate` | `--model`→`--sim-model`, thread `sim_model` |
| `tests/simulation/test_generator_client_resolution.py` | NEW — generator provider resolution | create |
| `tests/simulation/test_cli.py` | CLI kwarg capture | update for `--sim-model` |
| `tests/simulation/test_generation_injection.py` | NEW — SDK `generation_client` | create |

**Note for the implementer:** `build_simulation_client(config_client, *, extra_api_key=None) -> tuple[AsyncOpenAI, bool]` lives in `src/evaluatorq/simulation/_client.py`. It returns `(client, owned)`; `owned=False` means **the caller must not close it** (it was injected). Resolution order: injected `config_client` → `extra_api_key` (treated as an Orq key, routed to `…/v2/router`) → `ORQ_API_KEY` env (router) → `OPENAI_API_KEY` env (OpenAI SDK default base URL, which the SDK auto-fills from `OPENAI_BASE_URL` when `base_url is None`) → raises `ValueError("No API key found. Set ORQ_API_KEY or OPENAI_API_KEY, or pass a pre-built client.")`.

---

## Task 1: Change the default model

**Files:**
- Modify: `src/evaluatorq/simulation/types.py:15`
- Test: `tests/simulation/test_types_default_model.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/simulation/test_types_default_model.py`:
```python
from evaluatorq.simulation.types import DEFAULT_MODEL


def test_default_model_is_openai_gpt_5_4_mini():
    assert DEFAULT_MODEL == "openai/gpt-5.4-mini"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/test_types_default_model.py -v`
Expected: FAIL — `assert 'azure/gpt-4o-mini' == 'openai/gpt-5.4-mini'`

- [ ] **Step 3: Change the constant**

In `src/evaluatorq/simulation/types.py`, line 15:
```python
DEFAULT_MODEL = "openai/gpt-5.4-mini"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/simulation/test_types_default_model.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/simulation/types.py tests/simulation/test_types_default_model.py
git commit -m "feat(simulation): default to openai/gpt-5.4-mini"
```

---

## Task 2: Route persona/scenario/first-message generators through the shared factory

These three generators have an identical default-client block. They hold a client but never close it (ownership lives in their callers), so the `owned` flag from the factory is discarded here.

**Files:**
- Modify: `src/evaluatorq/simulation/generators/persona_generator.py` (`__init__`, ~lines 86-101)
- Modify: `src/evaluatorq/simulation/generators/scenario_generator.py` (`__init__`, ~lines 188-203)
- Modify: `src/evaluatorq/simulation/generators/first_message_generator.py` (`__init__`, ~lines 84-99)
- Test: `tests/simulation/test_generator_client_resolution.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/simulation/test_generator_client_resolution.py`:
```python
import pytest

from evaluatorq.simulation.generators.first_message_generator import FirstMessageGenerator
from evaluatorq.simulation.generators.persona_generator import PersonaGenerator
from evaluatorq.simulation.generators.scenario_generator import ScenarioGenerator

GEN_CLASSES = [PersonaGenerator, ScenarioGenerator, FirstMessageGenerator]


@pytest.mark.parametrize("gen_cls", GEN_CLASSES)
def test_openai_key_only_uses_openai_base_url(gen_cls, monkeypatch):
    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    gen = gen_cls()
    # OpenAI SDK default base URL — NOT the Orq router
    assert "api.openai.com" in str(gen._client.base_url)
    assert "/v2/router" not in str(gen._client.base_url)


@pytest.mark.parametrize("gen_cls", GEN_CLASSES)
def test_orq_key_wins_when_both_set(gen_cls, monkeypatch):
    monkeypatch.setenv("ORQ_API_KEY", "orq-test")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    gen = gen_cls()
    assert str(gen._client.base_url).rstrip("/").endswith("/v2/router")


@pytest.mark.parametrize("gen_cls", GEN_CLASSES)
def test_no_keys_raises(gen_cls, monkeypatch):
    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="No API key found"):
        gen_cls()


@pytest.mark.parametrize("gen_cls", GEN_CLASSES)
def test_injected_client_used_as_is(gen_cls, monkeypatch):
    from openai import AsyncOpenAI

    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    injected = AsyncOpenAI(api_key="sk-x", base_url="https://example.test/v1")
    gen = gen_cls(client=injected)
    assert gen._client is injected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/test_generator_client_resolution.py -v`
Expected: FAIL — `test_openai_key_only_*` raises `ValueError("ORQ_API_KEY environment variable is not set...")` (old block), `test_no_keys_raises` fails on the wrong message.

- [ ] **Step 3: Replace the default-client block in `persona_generator.py`**

Replace the `__init__` body (the `self._model = model` line onward through the `else:`-built client):
```python
        self._model = model
        from evaluatorq.simulation._client import build_simulation_client

        self._client, _ = build_simulation_client(client, extra_api_key=api_key)
```
Remove the now-unused module-level `from openai import AsyncOpenAI` **only if** nothing else in the file references `AsyncOpenAI` at runtime (keep it under `TYPE_CHECKING` for the param annotation). Leave `import os` if still used elsewhere; otherwise remove it to satisfy ruff.

- [ ] **Step 4: Apply the identical replacement in `scenario_generator.py` and `first_message_generator.py`**

Same three-line body in each `__init__`:
```python
        self._model = model
        from evaluatorq.simulation._client import build_simulation_client

        self._client, _ = build_simulation_client(client, extra_api_key=api_key)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `uv run pytest tests/simulation/test_generator_client_resolution.py -v`
Expected: PASS (all params × all 3 classes)

- [ ] **Step 6: Lint + typecheck the three files**

Run: `uv run ruff check src/evaluatorq/simulation/generators/ && uv run basedpyright src/evaluatorq/simulation/generators/persona_generator.py src/evaluatorq/simulation/generators/scenario_generator.py src/evaluatorq/simulation/generators/first_message_generator.py`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/evaluatorq/simulation/generators/persona_generator.py src/evaluatorq/simulation/generators/scenario_generator.py src/evaluatorq/simulation/generators/first_message_generator.py tests/simulation/test_generator_client_resolution.py
git commit -m "feat(simulation): generators resolve provider via build_simulation_client"
```

---

## Task 3: Route the composite DatapointGenerator through the factory (owned client)

`DatapointGenerator` **owns** its `_shared_client` and closes it in `close()`. It must build via the factory and only close when it owns the client.

**Files:**
- Modify: `src/evaluatorq/simulation/generators/datapoint_generator.py` (`__init__` ~lines 46-67, `close` ~lines 68-70)
- Test: `tests/simulation/test_generator_client_resolution.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/simulation/test_generator_client_resolution.py`:
```python
def test_datapoint_generator_openai_key_only(monkeypatch):
    from evaluatorq.simulation.generators.datapoint_generator import DatapointGenerator

    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    gen = DatapointGenerator()
    assert "api.openai.com" in str(gen._shared_client.base_url)
    assert gen._client_owned is True


def test_datapoint_generator_no_keys_raises(monkeypatch):
    from evaluatorq.simulation.generators.datapoint_generator import DatapointGenerator

    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="No API key found"):
        DatapointGenerator()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/test_generator_client_resolution.py -k datapoint -v`
Expected: FAIL — old block raises the ORQ-only message; `_client_owned` attribute does not exist.

- [ ] **Step 3: Replace the client construction in `datapoint_generator.py` `__init__`**

Replace:
```python
        resolved_key = os.environ.get("ORQ_API_KEY")
        if not resolved_key:
            raise ValueError(
                "ORQ_API_KEY environment variable is not set. "
                "Set it before creating a DatapointGenerator."
            )
        self._shared_client = AsyncOpenAI(
            base_url=f"{os.environ.get('ORQ_BASE_URL', 'https://api.orq.ai')}/v2/router",
            api_key=resolved_key,
        )
```
with:
```python
        from evaluatorq.simulation._client import build_simulation_client

        self._shared_client, self._client_owned = build_simulation_client(None)
```

- [ ] **Step 4: Guard `close()` on ownership**

Replace the `close` method:
```python
    async def close(self) -> None:
        """Close the shared HTTP client (only if this generator owns it)."""
        if self._client_owned:
            await self._shared_client.close()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/simulation/test_generator_client_resolution.py -k datapoint -v`
Expected: PASS

- [ ] **Step 6: Lint + typecheck**

Run: `uv run ruff check src/evaluatorq/simulation/generators/datapoint_generator.py && uv run basedpyright src/evaluatorq/simulation/generators/datapoint_generator.py`
Expected: no new errors (remove now-unused `import os` / `AsyncOpenAI` runtime import if flagged).

- [ ] **Step 7: Commit**

```bash
git add src/evaluatorq/simulation/generators/datapoint_generator.py tests/simulation/test_generator_client_resolution.py
git commit -m "feat(simulation): DatapointGenerator resolves provider via factory, owned-close"
```

---

## Task 4: `api.py` — drop the Orq gate on generation, add `generation_client`, rename `model`→`sim_model`

This task changes the two public functions and their internal helper chain together (signatures must stay consistent in one commit).

**Files:**
- Modify: `src/evaluatorq/simulation/api.py`
  - `simulate` signature (~line 50-66)
  - `generate_and_simulate` signature (~line 150-167) + body (~line 187-245)
  - `_simulate_core` signature (~line 254-272) + `_resolve_or_generate_datapoints` call (~line 287-293) + `_simulate_via_evaluatorq` call (~line 303-319)
  - `_resolve_or_generate_datapoints` signature (~line 358-365) + first-message branch (~line 401-413)
- Test: `tests/simulation/test_generation_injection.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/simulation/test_generation_injection.py`:
```python
from unittest.mock import AsyncMock, patch

import pytest

from evaluatorq.simulation.api import generate_and_simulate, simulate
from evaluatorq.simulation.types import Persona, Scenario


@pytest.mark.asyncio
async def test_generate_and_simulate_accepts_generation_client_without_orq(monkeypatch):
    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    from openai import AsyncOpenAI

    injected = AsyncOpenAI(api_key="sk-test", base_url="https://example.test/v1")

    # Stop before any network call: assert we reached generation with the
    # injected client and no ORQ-key ValueError was raised first.
    with patch(
        "evaluatorq.simulation.generators.PersonaGenerator.generate",
        new=AsyncMock(side_effect=RuntimeError("reached-generation")),
    ):
        with pytest.raises(RuntimeError, match="reached-generation"):
            await generate_and_simulate(
                agent_description="a test agent",
                target=lambda messages: "ok",
                num_personas=1,
                num_scenarios=1,
                generation_client=injected,
            )


@pytest.mark.asyncio
async def test_simulate_first_message_uses_generation_client_without_orq(monkeypatch):
    monkeypatch.delenv("ORQ_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    from openai import AsyncOpenAI

    injected = AsyncOpenAI(api_key="sk-test", base_url="https://example.test/v1")

    with patch(
        "evaluatorq.simulation.generators.FirstMessageGenerator.generate",
        new=AsyncMock(side_effect=RuntimeError("reached-first-message")),
    ):
        with pytest.raises(RuntimeError, match="reached-first-message"):
            await simulate(
                personas=[Persona(name="p")],
                scenarios=[Scenario(name="s", goal="g")],
                target=lambda messages: "ok",
                generation_client=injected,
            )


@pytest.mark.asyncio
async def test_sim_model_is_the_public_param(monkeypatch):
    # The public param is named sim_model; passing model= must error.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    with pytest.raises(TypeError):
        await simulate(
            datapoints=[],
            target=lambda messages: "ok",
            model="x",  # old name removed
        )
```
> Note: adjust `Persona(...)`/`Scenario(...)` constructor kwargs to match the real required fields if the model rejects these; the goal of those two tests is only to reach the generator call, so minimal valid instances are fine.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/test_generation_injection.py -v`
Expected: FAIL — `generate_and_simulate`/`simulate` reject `generation_client` (unexpected kwarg) and still accept `model=`.

- [ ] **Step 3: Update `simulate` signature**

In `simulate` (~line 50), rename `model: str = DEFAULT_MODEL` to `sim_model: str = DEFAULT_MODEL` and add `generation_client`:
```python
    max_turns: int = 10,
    sim_model: str = DEFAULT_MODEL,
    evaluator_names: list[str] | None = None,
    parallelism: int = 5,
    user_simulator: BaseAgent | None = None,
    judge: BaseAgent | None = None,
    generation_client: AsyncOpenAI | None = None,
    upload_results: bool = True,
```
Add `from openai import AsyncOpenAI` to the `TYPE_CHECKING` block at the top of the file if not already present (for the annotation). In `simulate`'s call to `_simulate_core`, pass `model=sim_model` and `generation_client=generation_client`:
```python
            return await _simulate_core(
                ...
                max_turns=max_turns,
                model=sim_model,
                ...
                generation_client=generation_client,
                ...
            )
```

- [ ] **Step 4: Update `generate_and_simulate` signature + body**

Rename `model` → `sim_model`, add `generation_client: AsyncOpenAI | None = None` (place it next to `judge`). Replace the body's hard gate + hardcoded client:
```python
    from openai import AsyncOpenAI  # noqa: F401  (kept only if still referenced)

    from evaluatorq.simulation._client import build_simulation_client
    from evaluatorq.simulation.generators import PersonaGenerator, ScenarioGenerator
    from evaluatorq.simulation.tracing import with_simulation_span
    from evaluatorq.tracing.setup import flush_tracing, init_tracing_if_needed

    await init_tracing_if_needed()

    try:
        async with with_simulation_span(
            "orq.simulation.pipeline",
            { ... unchanged span attrs ... },
        ) as pipeline_span:
            gen_client, gen_owned = build_simulation_client(generation_client)
            try:
                persona_gen = PersonaGenerator(model=sim_model, client=gen_client)
                scenario_gen = ScenarioGenerator(model=sim_model, client=gen_client)
                gen_personas, gen_scenarios = await asyncio.gather(
                    persona_gen.generate(
                        agent_description=agent_description,
                        num_personas=num_personas,
                    ),
                    scenario_gen.generate(
                        agent_description=agent_description,
                        num_scenarios=num_scenarios,
                    ),
                )
            finally:
                if gen_owned:
                    await gen_client.close()

            return await _simulate_core(
                caller="generate_and_simulate",
                ...
                model=sim_model,
                ...
                generation_client=generation_client,
                ...
            )
    finally:
        await flush_tracing()
```
Delete the `api_key = _require_orq_api_key("generate_and_simulate")` line. Remove the unused `os`/`AsyncOpenAI` import only if nothing else in the file uses it (`os` is still used by `_resolve_or_generate_datapoints` dataset path — keep it).

- [ ] **Step 5: Thread `generation_client` through `_simulate_core`**

Add `generation_client: AsyncOpenAI | None` to `_simulate_core`'s signature (next to `judge`), and pass it to `_resolve_or_generate_datapoints`:
```python
    sim_datapoints = await _resolve_or_generate_datapoints(
        caller=caller,
        datapoints=datapoints,
        personas=personas,
        scenarios=scenarios,
        dataset_id=dataset_id,
        model=model,
        generation_client=generation_client,
    )
```
(The `_simulate_via_evaluatorq` call is unchanged — it already receives `model=model`.)

- [ ] **Step 6: Update `_resolve_or_generate_datapoints` first-message branch**

Add `generation_client: AsyncOpenAI | None` to its signature. **Keep** `_require_orq_api_key(caller)` in the `dataset_id` branch (Orq dataset fetch genuinely needs it). Replace only the first-message-generation client block:
```python
    from evaluatorq.simulation._client import build_simulation_client
    from evaluatorq.simulation.generators import FirstMessageGenerator

    gen_client, gen_owned = build_simulation_client(generation_client)
    try:
        first_msg_gen = FirstMessageGenerator(model=model, client=gen_client)
        pairs = [(p, s) for p in personas for s in scenarios]
        # ... unchanged batch loop ...
    finally:
        if gen_owned:
            await gen_client.close()
```
Delete the `api_key = _require_orq_api_key(caller)` line **in this branch only** and the hardcoded `shared_client = AsyncOpenAI(...router...)`.

- [ ] **Step 7: Run test to verify it passes**

Run: `uv run pytest tests/simulation/test_generation_injection.py -v`
Expected: PASS

- [ ] **Step 8: Typecheck + lint**

Run: `uv run basedpyright src/evaluatorq/simulation/api.py && uv run ruff check src/evaluatorq/simulation/api.py`
Expected: 0 errors (pre-existing `×`-sign RUF002/RUF001 and the `async scorer` RUF029 in this file are baseline — do not introduce new ones).

- [ ] **Step 9: Commit**

```bash
git add src/evaluatorq/simulation/api.py tests/simulation/test_generation_injection.py
git commit -m "feat(simulation): generation honors OpenAI env + generation_client injection; rename model->sim_model"
```

---

## Task 5: CLI — `--sim-model` on `run` and `generate`

**Files:**
- Modify: `src/evaluatorq/simulation/cli.py`
  - `run` command option (~line 267-270) + `_run_impl` call (~line 320-329) + `_run_impl` def (~line 358-382)
  - `generate` command option (~line 426-429) + `_generate_impl` call (~line 482-491) + `_generate_impl` def (~line 540-562)
- Test: `tests/simulation/test_cli.py` (update/extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/simulation/test_cli.py` (follow the file's existing CliRunner + monkeypatch-the-impl pattern):
```python
def test_generate_forwards_sim_model(monkeypatch):
    from typer.testing import CliRunner

    from evaluatorq.simulation import cli as sim_cli

    captured = {}

    async def fake_generate_and_simulate(**kwargs):
        captured.update(kwargs)
        return []

    monkeypatch.setattr(
        "evaluatorq.simulation.api.generate_and_simulate", fake_generate_and_simulate
    )
    result = CliRunner().invoke(
        sim_cli.app,
        [
            "generate",
            "--agent-description", "x",
            "--openai-model", "gpt-5.4-mini",
            "--sim-model", "gpt-5.4-mini",
            "--num-personas", "1",
            "--num-scenarios", "1",
            "--no-save",
        ],
    )
    assert result.exit_code == 0, result.output
    assert captured["sim_model"] == "gpt-5.4-mini"


def test_old_model_flag_rejected(monkeypatch):
    from typer.testing import CliRunner

    from evaluatorq.simulation import cli as sim_cli

    result = CliRunner().invoke(
        sim_cli.app,
        ["generate", "--agent-description", "x", "--model", "gpt-4o"],
    )
    assert result.exit_code != 0
    assert "No such option" in result.output or "Got unexpected" in result.output
```
> If existing tests in `test_cli.py` already pass `--model`, update those invocations to `--sim-model` in this step too.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/simulation/test_cli.py -k "sim_model or old_model_flag" -v`
Expected: FAIL — `--sim-model` is "No such option"; `--model` still accepted.

- [ ] **Step 3: Rename the option in the `run` command**

`src/evaluatorq/simulation/cli.py` ~line 267:
```python
    sim_model: Annotated[
        str,
        typer.Option(
            "--sim-model",
            help=(
                "Model for the user-simulator and judge. Provider resolved from "
                "env: ORQ_API_KEY -> Orq router, else OPENAI_API_KEY "
                "(+ OPENAI_BASE_URL) -> OpenAI-compatible endpoint."
            ),
        ),
    ] = DEFAULT_MODEL,
```
Update the `_run_impl(...)` call (~line 323) `model=model` → `sim_model=sim_model`.

- [ ] **Step 4: Update `_run_impl`**

`_run_impl` def (~line 360): rename param `model: str` → `sim_model: str`; its `simulate(...)` call `model=model` → `sim_model=sim_model`.

- [ ] **Step 5: Rename the option in the `generate` command**

`src/evaluatorq/simulation/cli.py` ~line 426:
```python
    sim_model: Annotated[
        str,
        typer.Option(
            "--sim-model",
            help=(
                "Model for the user-simulator, the judge, and persona/scenario/"
                "first-message generation. Provider resolved from env: "
                "ORQ_API_KEY -> Orq router, else OPENAI_API_KEY (+ OPENAI_BASE_URL) "
                "-> OpenAI-compatible endpoint."
            ),
        ),
    ] = DEFAULT_MODEL,
```
Update the `_generate_impl(...)` call (~line 485) `model=model` → `sim_model=sim_model`.

- [ ] **Step 6: Update `_generate_impl`**

`_generate_impl` def (~line 542): rename param `model: str` → `sim_model: str`; its `generate_and_simulate(...)` call `model=model` → `sim_model=sim_model`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `uv run pytest tests/simulation/test_cli.py -k "sim_model or old_model_flag" -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/evaluatorq/simulation/cli.py tests/simulation/test_cli.py
git commit -m "feat(simulation): rename CLI --model to --sim-model on run and generate"
```

---

## Task 6: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full simulation suite**

Run: `uv run pytest tests/simulation -q`
Expected: all pass (≥ 253 prior + new tests). If any prior test passed `model=` to `simulate`/`generate_and_simulate` or used `--model`, fix it to the new names and re-run.

- [ ] **Step 2: Typecheck the whole simulation package**

Run: `uv run basedpyright src/evaluatorq/simulation/`
Expected: 0 errors.

- [ ] **Step 3: Lint**

Run: `uv run ruff check src/evaluatorq/simulation/`
Expected: no new errors vs the pre-existing baseline (the `×`-sign + async-scorer findings in `api.py` are pre-existing; everything else clean).

- [ ] **Step 4: Grep for stragglers**

Run: `grep -rn "_require_orq_api_key" src/evaluatorq/simulation/ ; grep -rn '"--model"' src/evaluatorq/simulation/`
Expected: `_require_orq_api_key` appears only in the `dataset_id` fetch path; no `"--model"` option remains.

- [ ] **Step 5: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "test(simulation): align suite with sim_model / OpenAI-capable generation"
```

---

## Self-Review notes (already reconciled)

- **Spec coverage:** §A generators → Tasks 2-3; §B drop orq gate → Task 4; §C injection + rename → Task 4; §D CLI → Task 5; §E default model → Task 1; §Testing → Tasks 2-6.
- **`_require_orq_api_key` retained** for the `dataset_id` Orq-dataset fetch (not deleted) — verified it is still referenced there.
- **Ownership:** injected clients (`owned=False`) are never closed; api.py/datapoint-generator close only when they built the client.
- **Naming consistency:** public param `sim_model`, CLI flag `--sim-model`, internal helpers keep `model=` (boundary maps `model=sim_model`).
