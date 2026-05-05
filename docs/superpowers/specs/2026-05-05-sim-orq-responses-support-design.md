# Design: Orq Responses v3 Support in Agent Simulation

**Date:** 2026-05-05
**Status:** Approved
**Scope:** `packages/evaluatorq-py` only (Python). TypeScript mirror deferred.
**Stacks on:** PR #100 (`karinakalicka/res-651-add-tool-call-interception-to-agenttarget-protocol-output`)

---

## Problem

Agent simulation (`evaluatorq.simulation`) can target Orq **deployments** today (`from_orq_deployment`), but not Orq's **Responses v3 API** (`client.responses.create_async`). Responses v3 provides agentic-LLM behavior — tools, server-side agentic loop, system-prompt override — without requiring a pre-created agent on the platform.

Users need to:
1. **Target** an agentic LLM (Responses v3) as the system under test.
2. **Drive** simulations with a Responses-backed user simulator or judge.

---

## Non-Goals

- Pre-created Orq agents as sim targets (memory + task_id). Defer.
- TypeScript mirror.
- Generator (datapoint/persona/scenario) backend swap.
- Migrating redteam attacker/evaluator LLMs to Responses.
- Widening redteam `AgentTarget.send_prompt_with_usage` signature.

---

## Design Principles

1. **Restraint on abstraction.** Two endpoints from one vendor = `Literal` field + `if`, not a Protocol hierarchy. No new `LLMBackend` protocol.
2. **Pattern reuse.** `ORQAgentTarget._task_id` (redteam) == Responses v3 `previous_response_id`. Same per-instance threading pattern. One class serves both subsystems.
3. **Instance-over-config-bundle.** `simulate(user_simulator=..., judge=...)` accepts ready-to-use agent instances, not nested config bundles.
4. **Minimize class count.** 1 new class (`OrqResponsesTarget`), 1 deleted (`AgentConfig`), net 0.

---

## Architecture

### Shared types (`evaluatorq/contracts.py`)

**Move from `redteam/contracts.py`:**

| Type | Change |
|------|--------|
| `LLMCallConfig` | Add `api: Literal["chat_completions","responses"] = "chat_completions"` field. Backwards compatible — redteam ignores. |
| `AgentResponse` | Move post-#100 merge. Already defined on PR #100 branch. |
| `ExecutedToolCall` | Move with `AgentResponse`. |

Re-export both from `redteam/contracts.py` to preserve existing imports.

`LLMCallConfig` shape (after change):
```python
class LLMCallConfig(BaseModel):
    model: str = DEFAULT_PIPELINE_MODEL
    api: Literal["chat_completions", "responses"] = "chat_completions"
    temperature: float | None = None
    max_tokens: int | None = None
    timeout_ms: int | None = None
    client: Any | None = None
    extra_kwargs: dict[str, Any] = {}
    # existing fields unchanged
```

### Class diagram

```
┌─────────────────────────────────────────────────────────┐
│                    SHARED (evaluatorq/)                  │
│                                                         │
│  LLMCallConfig (Pydantic)                               │
│    model, api, temperature, max_tokens, timeout_ms      │
│                                                         │
│  AgentResponse (dataclass, post-#100)                   │
│    text, tool_calls, usage                              │
└───────────────────────┬─────────────────────────────────┘
                        │ used by
        ┌───────────────┴───────────────────┐
        │                                   │
┌───────▼────────────────┐    ┌─────────────▼────────────────┐
│    SIM (simulation/)   │    │   REDTEAM (redteam/)         │
│                        │    │                              │
│  BaseAgent (abstract)  │    │  AgentTarget (Protocol)      │
│    config: LLMCallConfig│   │    send_prompt_with_usage    │
│    _call_llm() ──────► ├────►    new()                     │
│    _call_responses()   │    │    memory_entity_id          │
│    _call_chat_compl()  │    │                              │
│         │              │    │  ORQAgentTarget (impl)       │
│  UserSimulatorAgent    │    │    agent_key, task_id        │
│  JudgeAgent            │    │                              │
│                        │    │  LLMConfig                   │
│  OrqResponsesTarget ◄──┼────►    attacker: LLMCallConfig  │
│    __call__(messages)  │    │    evaluator: LLMCallConfig  │
│    send_prompt_with_usage   └──────────────────────────────┘
│    new()               │
│    previous_response_id│
└────────────────────────┘
```

### `OrqResponsesTarget` — single class, two interfaces

Implements both sim's callable shape AND redteam's `AgentTarget` protocol.

```python
class OrqResponsesTarget:
    memory_entity_id: str | None          # AgentTarget protocol
    config: LLMCallConfig
    instructions: str | None
    tools: list[dict] | None
    _previous_response_id: str | None     # threads multi-turn

    def __init__(self, config: LLMCallConfig, *, instructions=None,
                 tools=None, memory_entity_id=None): ...

    async def __call__(self, messages: list[ChatMessage]) -> str:
        """Sim target_callback shape. Threads previous_response_id."""

    async def send_prompt_with_usage(self, prompt: str) -> AgentResponse:
        """Redteam AgentTarget shape. Same threading."""

    def new(self) -> "OrqResponsesTarget":
        """Fresh instance, identical config, cleared previous_response_id."""

    async def _invoke(self, *, input_: str | list) -> AgentResponse:
        # client.responses.create_async(
        #   model=self.config.model,
        #   input_=input_,
        #   instructions=self.instructions,
        #   tools=self.tools,
        #   previous_response_id=self._previous_response_id,
        # )
        # self._previous_response_id = response.id
        # return AgentResponse(text=..., tool_calls=..., usage=...)
```

**Multi-turn:** `previous_response_id` threads across calls within the same instance. `new()` clears it.

**Tool calls:** Resolve server-side in the normal case (Orq handles them). If the server emits unresolved pending tool calls (rare, local-tool edge case), they surface in `AgentResponse.tool_calls` for callers using `send_prompt_with_usage` directly. `__call__` returns only text.

### `BaseAgent` refactor

Replace `AgentConfig` dataclass with direct `LLMCallConfig` usage:

```python
class BaseAgent(ABC):
    def __init__(self, config: LLMCallConfig | None = None) -> None:
        self.config = config or LLMCallConfig()
        self._client: AsyncOpenAI = _build_client(self.config)

    async def _call_llm(
        self,
        system: str | None,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
    ) -> AgentResponse:
        if self.config.api == "responses":
            return await self._call_responses(system, messages, tools)
        return await self._call_chat_completions(system, messages, tools)

    async def _call_responses(...) -> AgentResponse:
        # client.responses.create_async w/ instructions, input_, tools
        # NO previous_response_id threading here — agents are stateless per turn

    async def _call_chat_completions(...) -> AgentResponse:
        # existing logic, return value wrapped into AgentResponse
```

`AgentConfig` dataclass is **deleted**. `LLMCallConfig` absorbs its role.

`UserSimulatorAgent` and `JudgeAgent` call `_call_llm()` exactly as today — dispatch is transparent.

**Note:** `BaseAgent` does NOT thread `previous_response_id` — it's stateless per LLM call. `OrqResponsesTarget` owns that state because it represents a persistent conversation participant. Agents (sim/judge) are stateless LLM wrappers.

### `simulate()` API

```python
async def simulate(
    *,
    # Existing params (unchanged):
    target_callback: Callable[[list[ChatMessage]], Awaitable[str]] | None = None,
    datapoints: list[Datapoint] | None = None,
    personas: list[Persona] | None = None,
    scenarios: list[Scenario] | None = None,
    evaluation_name: str = "simulation",
    max_turns: int = 10,
    evaluators: list[str] | None = None,
    # New params:
    target: Callable[[list[ChatMessage]], Awaitable[str]] | None = None,
    user_simulator: BaseAgent | None = None,
    judge: BaseAgent | None = None,
) -> list[SimulationResult]:
```

- `target` is the preferred name; `target_callback` kept as alias.
- When `user_simulator=None`, defaults to `UserSimulatorAgent()` (default `LLMCallConfig`).
- When `judge=None`, defaults to `JudgeAgent()` (default `LLMCallConfig`).
- Existing `model: str` param preserved for backwards compat — used to construct default agents.

---

## Usage examples

### Basic (backwards compat — unchanged):
```python
results = await simulate(
    target_callback=lambda msgs: my_agent(msgs),
    personas=[p], scenarios=[s],
)
```

### Responses-backed target:
```python
from evaluatorq.contracts import LLMCallConfig
from evaluatorq.simulation.target import OrqResponsesTarget

results = await simulate(
    target=OrqResponsesTarget(
        LLMCallConfig(model="openai/gpt-4o", api="responses"),
        instructions="You are a helpful support agent.",
        tools=[web_search_tool],
    ),
    personas=[p], scenarios=[s],
)
```

### Responses-backed user simulator + target:
```python
sim_cfg = LLMCallConfig(model="openai/gpt-4o-mini", api="responses")
target_cfg = LLMCallConfig(model="openai/gpt-4o", api="responses")

results = await simulate(
    target=OrqResponsesTarget(target_cfg, instructions="Support agent."),
    user_simulator=UserSimulatorAgent(config=sim_cfg),
    judge=JudgeAgent(config=sim_cfg),
    personas=[p], scenarios=[s],
)
```

### As redteam target:
```python
# OrqResponsesTarget also works as a redteam AgentTarget:
await red_team(
    target=OrqResponsesTarget(LLMCallConfig(model="openai/gpt-4o", api="responses")),
    ...
)
```

---

## Files changed

| Path | Action |
|------|--------|
| `src/evaluatorq/contracts.py` | NEW — shared `LLMCallConfig`, `AgentResponse`, `ExecutedToolCall` |
| `src/evaluatorq/redteam/contracts.py` | EDIT — re-export shared types, drop duplicates |
| `src/evaluatorq/simulation/agents/base.py` | EDIT — replace `AgentConfig` with `LLMCallConfig`, dispatch in `_call_llm` |
| `src/evaluatorq/simulation/agents/user_simulator.py` | EDIT — accept `config: LLMCallConfig` |
| `src/evaluatorq/simulation/agents/judge.py` | EDIT — accept `config: LLMCallConfig` |
| `src/evaluatorq/simulation/api.py` | EDIT — add `target=`, `user_simulator=`, `judge=` |
| `src/evaluatorq/simulation/runner/simulation.py` | EDIT — use injected agent instances |
| `src/evaluatorq/simulation/target.py` | NEW — `OrqResponsesTarget` |
| `src/evaluatorq/simulation/__init__.py` | EDIT — export new symbols |
| `tests/simulation/test_responses_dispatch.py` | NEW |
| `tests/simulation/test_orq_responses_target.py` | NEW |
| `tests/redteam/test_orq_responses_target_as_agent_target.py` | NEW |
| `scripts/simulation_live_test.py` | EDIT — Responses-backed scenario |

---

## Testing

### Unit tests (mocked SDK, no live API)
- `_call_llm` dispatches to correct branch based on `config.api`.
- `previous_response_id` threads across calls in responses mode.
- `OrqResponsesTarget.__call__` returns text only.
- `OrqResponsesTarget.send_prompt_with_usage` returns `AgentResponse`.
- `OrqResponsesTarget.new()` produces fresh instance with cleared `previous_response_id`.
- `OrqResponsesTarget` passes `is_agent_target` check.
- `simulate()` accepts custom `user_simulator`/`judge` instances.

### Regression
- All 972 existing non-integration tests pass.
- `LLMCallConfig` re-export from `redteam.contracts` works (no import breakage).

### Type check + lint
```bash
uv run basedpyright
uv run ruff check src
```

### End-to-end live test (`ORQ_API_KEY` required)
`scripts/simulation_live_test.py` scenario:
- `OrqResponsesTarget` as target (with tools).
- `UserSimulatorAgent(config=LLMCallConfig(api="responses"))` as user sim.
- `JudgeAgent(config=LLMCallConfig(api="responses"))` as judge.
- Verify: multi-turn dialog, `previous_response_id` continuity, judge verdict, token usage populated.
