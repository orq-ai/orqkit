# Sim Target Redteam Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--target` to `eq sim simulate`, `eq sim run`, and `eq sim generate` so sim uses the same `agent:<key>` / `deployment:<key>` target semantics as red teaming, including automatic description discovery for Orq agent targets.

**Architecture:** Keep the simulation runner and public simulation API unchanged. Implement the new behavior at the sim CLI boundary by reusing redteam target parsing/backend machinery: `agent:` builds a stateless `OrqResponsesTarget(model="agent/<key>")`, `deployment:` uses the existing deployment callback bridge, and bare values default to `agent:`. Add one helper that resolves an omitted `--agent-description` from the redteam Orq SDK context backend for `agent:` targets only.

**Tech Stack:** Python, Typer CLI, pytest, evaluatorq redteam backend registry, `OrqResponsesTarget`.

---

## Files

- Modify: `packages/evaluatorq-py/src/evaluatorq/simulation/cli.py`
  - Add `--target` options to `simulate`, `run`, and `generate`.
  - Extend `_resolve_target` to understand `--target`.
  - Add `_resolve_agent_description` for `run` and `generate`.
  - Add sim-local wrapper helpers around redteam private helpers so tests patch stable names and imports stay lazy.
  - Make `run` and `generate` resolve missing descriptions before building execution targets.
  - Render target/description resolution failures as one-line CLI errors.
  - Update target-kind inference and CLI help text.
- Modify: `packages/evaluatorq-py/tests/simulation/test_cli.py`
  - Add unit tests for target parsing/building, description resolution, and CLI command behavior.
- Optional docs after tests pass: `packages/evaluatorq-py/src/evaluatorq/simulation/README.md`
  - Update usage examples from `--agent-key` to `--target`.

## Task 1: Lock Down Target Semantics With Tests

**Files:**
- Modify: `packages/evaluatorq-py/tests/simulation/test_cli.py`

- [ ] **Step 1: Add tests for `_infer_target_kind`**

Expected assertions:

```python
assert _infer_target_kind(target="agent:k", agent_key=None, vercel_url=None, openai_model=None) == "orq_agent"
assert _infer_target_kind(target="k", agent_key=None, vercel_url=None, openai_model=None) == "orq_agent"
assert _infer_target_kind(target="deployment:k", agent_key=None, vercel_url=None, openai_model=None) == "orq_deployment"
assert _infer_target_kind(target=None, agent_key="k", vercel_url=None, openai_model=None) == "orq_deployment"
```

- [ ] **Step 2: Add tests for `_resolve_target`**

Expected behavior:

```python
target = _resolve_target(target="agent:refund-agent-fixed", agent_key=None, vercel_url=None, openai_model=None)
assert target.config.model == "agent/refund-agent-fixed"
assert target.require_orq is True

target = _resolve_target(target="refund-agent-fixed", agent_key=None, vercel_url=None, openai_model=None)
assert target.config.model == "agent/refund-agent-fixed"
```

For deployments, patch `evaluatorq.simulation.adapters.from_orq_deployment` and assert it is called with the unprefixed key.

- [ ] **Step 3: Add CLI-level target tests**

Add tests for:

```python
run --target agent:refund-agent-fixed --no-save
generate --target agent:refund-agent-fixed --output dp.jsonl
run --target deployment:refund-agent-fixed --no-save
simulate --target badprefix:x --datapoints dp.jsonl --no-save
```

Expected:
- agent target without `--agent-description` passes Typer parsing and calls `_resolve_agent_description`.
- deployment target without `--agent-description` fails before `_resolve_target` constructs anything.
- invalid target prefixes render a one-line error without traceback.

- [ ] **Step 4: Run red tests**

Run:

```bash
cd packages/evaluatorq-py
uv run pytest tests/simulation/test_cli.py -q
```

Expected: new tests fail because `_resolve_target` and `_infer_target_kind` do not accept `target`.

## Task 2: Implement `--target` Resolution

**Files:**
- Modify: `packages/evaluatorq-py/src/evaluatorq/simulation/cli.py`

- [ ] **Step 1: Extend `_resolve_target` signature**

Change it to accept:

```python
def _resolve_target(
    *,
    target: str | None,
    agent_key: str | None,
    vercel_url: str | None,
    openai_model: str | None,
) -> Any:
```

Include `--target` in the exactly-one-target validation alongside the existing flags.

- [ ] **Step 2: Add sim-local wrappers for redteam helpers**

Add patchable wrappers in `simulation/cli.py`:

```python
def _parse_target_spec(target: str) -> tuple[Any, str]:
    from evaluatorq.redteam.runner import _parse_target
    return _parse_target(target)


def _make_sim_agent_backend() -> Any:
    from evaluatorq.redteam.contracts import LLMConfig, TargetConfig
    from evaluatorq.redteam.runner import _make_agent_backend
    return _make_agent_backend(
        target_config=TargetConfig(system_prompt=None),
        pipeline_config=LLMConfig(),
    )
```

Tests should patch `_make_sim_agent_backend`, not redteam internals.

- [ ] **Step 3: Implement `agent:` / bare target handling**

Use redteam’s existing parser and backend builder:

```python
from evaluatorq.redteam.contracts import TargetKind

kind, value = _parse_target_spec(target)
if kind == TargetKind.AGENT:
    backend = _make_sim_agent_backend()
    return backend.create_target(value)
```

This should produce an `OrqResponsesTarget` whose config model is `agent/<key>`.

- [ ] **Step 4: Implement `deployment:` handling**

Use the existing callback bridge:

```python
from evaluatorq.simulation.adapters import from_orq_deployment
return from_orq_deployment(value)
```

Add the same explicit `ORQ_API_KEY` check used by `--agent-key` before returning the deployment callback, so `--target deployment:<key>` fails early with the same clear credential message.

- [ ] **Step 5: Preserve existing flags**

Keep `--agent-key` as backward compatible deployment behavior. Treat it as deprecated in help text, but do not break users.

- [ ] **Step 6: Run target tests**

Run:

```bash
cd packages/evaluatorq-py
uv run pytest tests/simulation/test_cli.py::test_resolve_target_agent_prefix_uses_openresponses_backend tests/simulation/test_cli.py::test_resolve_target_bare_value_defaults_to_agent tests/simulation/test_cli.py::test_resolve_target_deployment_prefix_uses_deployment_callback -q
```

Expected: all pass.

## Task 3: Add Agent Description Auto-Discovery

**Files:**
- Modify: `packages/evaluatorq-py/src/evaluatorq/simulation/cli.py`
- Modify: `packages/evaluatorq-py/tests/simulation/test_cli.py`

- [ ] **Step 1: Add helper tests**

Test explicit values win:

```python
description = await _resolve_agent_description(
    agent_description="Explicit bot description.",
    target="agent:refund-agent-fixed",
)
assert description == "Explicit bot description."
```

Test agent context fallback:

```python
backend.resolve_context = AsyncMock(return_value=AgentContext(key="refund-agent-fixed", description="Handles refunds."))
description = await _resolve_agent_description(agent_description=None, target="agent:refund-agent-fixed")
assert description == "Handles refunds."
```

- [ ] **Step 2: Implement `_resolve_agent_description`**

Expected shape:

```python
async def _resolve_agent_description(*, agent_description: str | None, target: str | None) -> str:
    if agent_description:
        return agent_description
    if target is None:
        raise ValueError("--agent-description is required unless --target is an agent target")
    kind, value = _parse_target(target)
    if kind != TargetKind.AGENT:
        raise ValueError("--agent-description is required unless --target is an agent target")
    backend = _make_sim_agent_backend()
    ctx = await backend.resolve_context(value)
    if not ctx.description:
        raise ValueError(f"Agent {value!r} has no description; pass --agent-description explicitly.")
    return ctx.description
```

Let non-404/non-not-found context errors propagate as hard failures. Only add 404 fallback if the existing Orq SDK error taxonomy is easy to identify reliably.

- [ ] **Step 3: Wire `run`**

Make `agent_description` optional in the Typer signature:

```python
agent_description: Annotated[
    str | None,
    typer.Option("--agent-description", help="Free-text description of the agent under test."),
] = None
```

Before `_run_impl`, call:

```python
resolved_agent_description = asyncio.run(
    _resolve_agent_description(agent_description=agent_description, target=target)
)
```

Pass `resolved_agent_description` into `_run_impl`.

Do this before calling `_resolve_target`, so non-agent targets missing `--agent-description` fail before deployment/model target construction or credential checks.

Wrap both description resolution and target resolution in the same clean CLI error handling path as `_run_impl`, rendering `ValueError`, `RuntimeError`, `BackendError`, `CredentialError`, and missing-credential errors as `Error: ...` without traceback.

- [ ] **Step 4: Wire `generate`**

Add optional `--target` to `generate` and use the same `_resolve_agent_description` helper. Do not resolve or contact the execution target during generation.

Because `generate` has a required `--output`, keep Python/Typer signature ordering valid by placing `output` before optional `agent_description` or otherwise ensuring no required parameter follows a defaulted parameter.

- [ ] **Step 5: Run description tests**

Run:

```bash
cd packages/evaluatorq-py
uv run pytest tests/simulation/test_cli.py -q
```

Expected: all CLI tests pass.

## Task 4: Update CLI Help and Compatibility

**Files:**
- Modify: `packages/evaluatorq-py/src/evaluatorq/simulation/cli.py`
- Optional: `packages/evaluatorq-py/src/evaluatorq/simulation/README.md`

- [ ] **Step 1: Update help text**

Target text should state:

```text
--target TARGET     Target to simulate: agent:<key> or deployment:<key>. Bare values default to agent:<key>.
--agent-key KEY     Deprecated alias for deployment target behavior.
```

- [ ] **Step 2: Update command docstrings**

For `simulate` and `run`, document exactly-one target among `--target`, `--agent-key`, `--vercel-url`, `--openai-model`.

For `generate`, document that `--target agent:<key>` is only used to fetch the description.

- [ ] **Step 3: Run help smoke checks**

Run:

```bash
cd packages/evaluatorq-py
uv run python -m evaluatorq sim simulate --help
uv run python -m evaluatorq sim run --help
uv run python -m evaluatorq sim generate --help
```

Expected: help renders and includes `--target`.

## Task 5: Verification

**Files:**
- No production edits beyond prior tasks.

- [ ] **Step 1: Run focused tests**

Run:

```bash
cd packages/evaluatorq-py
uv run pytest tests/simulation/test_cli.py tests/simulation/test_simulate_injection.py tests/integration/test_sim_redteam_target_roundtrip.py -q
```

Expected: all pass.

- [ ] **Step 2: Run broader sim/openresponses tests if focused tests pass**

Run:

```bash
cd packages/evaluatorq-py
uv run pytest tests/simulation tests/openresponses -q
```

Expected: all pass.

- [ ] **Step 3: Optional real integration**

Only run if credentials are available and the environment is intended for live Orq calls:

```bash
cd packages/evaluatorq-py
uv run evaluatorq sim generate --target agent:refund-agent-fixed --output /tmp/refund-agent-fixed-dp.jsonl --num-personas 1 --num-scenarios 1
```

Expected: command fetches the agent description and writes one datapoint without requiring `--agent-description`.

## Self-Review

- Spec coverage: `--target` is added to sim commands; `agent:` routes to stateless Responses v3 target; `deployment:` keeps deployment callback; bare values default to agent; explicit description wins; missing description for agent target is fetched from Orq SDK context; non-agent targets still require explicit description.
- YAGNI check: no runner changes, no API thread-through, no factory abstraction.
- Risk: importing private redteam helpers (`_parse_target`, `_make_agent_backend`) couples sim CLI to redteam internals. This is intentional for now because the user explicitly wants behavior aligned with redteam; the sim-local wrappers keep that coupling in one place. A later cleanup could promote those helpers to a shared target utility module.
