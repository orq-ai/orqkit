# RES-808 — Collapse, relocate, and unify the AgentTarget / Backend protocols

**Status:** Design approved 2026-05-26. Implementation pending.
**Linear:** [RES-808](https://linear.app/orqai/issue/RES-808). Merged scope from RES-844 (duplicate). Follow-up: [RES-876](https://linear.app/orqai/issue/RES-876) (multi-modal `ChatMessage`).
**Branch:** `bauke/res-808-collapse-redteam-backend-abstractions-abc-agenttarget`
**Author:** Bauke Brenninkmeijer

---

## 1. Problem

`packages/evaluatorq-py/src/evaluatorq/redteam/backends/base.py` defines ~12 abstract types (Protocols, dataclass, helpers) for target backends. Most are speculative flexibility, never composed, never extended by third parties, and mostly 1:1 with their two concrete impls (ORQ + OpenAI). Simulation has its own `TargetAgent` Protocol at `simulation/runner/simulation.py:73` that duplicates much of the same shape. `OrqResponsesTarget` (`simulation/target.py`) already structurally satisfies the redteam `AgentTarget` Protocol (verified by `tests/redteam/test_orq_responses_target_as_agent_target.py`, 17/17 passing) but doesn't inherit it.

Cumulative effects:

- Redteam runner duck-types `getattr(target, "map_error", None)` to detect optional capabilities (`runner.py:1341-1342`).
- `BackendBundle` dataclass + 4 collaborator protocols force factory boilerplate that two backends will never diverge on.
- `OrqResponsesTarget` carries a "fork contract" warning (`target.py:48-50`) about `__call__` vs `send_prompt` having different state semantics.
- Sim `TargetAgent` Protocol and redteam `AgentTarget` Protocol drifted independently — one structural match (`OrqResponsesTarget`) requires a dedicated 17-test conformance file to keep them aligned.

Out of scope here: dual endpoint families (`client.responses.create` vs `orq_client.agents.responses.create`) and their state channels (`previous_response_id`, `task_id`) coexist intentionally. `ORQAgentTarget` stays on its endpoint.

## 2. Goals

1. Collapse 12 abstract types in `redteam/backends/base.py` down to 2 ABCs (`AgentTarget`, `Backend`).
2. Move `AgentTarget` to `evaluatorq/contracts.py` so simulation can reuse without crossing module boundaries.
3. Unify `AgentTarget` and sim's `TargetAgent` Protocol on a single canonical method: `async def respond(messages: list[ChatMessage]) -> AgentResponse`.
4. Make `OrqResponsesTarget` stateless. Drop `_previous_response_id`.
5. Keep `ORQAgentTarget` on its current `orq_client.agents.responses.create` endpoint. Prefer `OrqResponsesTarget` for new call-sites where applicable; do not rewrite ORQAgentTarget.

## 3. Non-goals

- Multi-modal `ChatMessage.content` (text + image + file). Tracked in [RES-876](https://linear.app/orqai/issue/RES-876).
- ContentPart array, multi-part input via the ABC. Tool-call items stay inside target `respond()` implementations, never injected by callers.
- `validate_agent_target` helper removal. Public migration helper, deferred to a later cycle.
- `_coerce_to_agent_response` removal. Load-bearing for `callable_integration` users who return `str` from their target — kept.
- Router URL bump (`registry.py:_ROUTER_SUFFIX = "/v2/router"` → `"/v3/router"`). Both paths reach the same handler; bump is a separate follow-up.

## 4. Validation (probe results, 2026-05-26)

Direct probe of `/v3/router/responses` via `openai.AsyncOpenAI` pointed at `${ORQ_BASE_URL}/v2/router`:

| Test | Feature | Result |
|---|---|---|
| T1 | Single-string `input` | ✓ |
| T2 | Multi-message array + top-level `instructions` + `developer` role | ✓ |
| T3 | Stateless function-call continuation (echo `function_call` + `function_call_output` items in next input) | ✓ |
| T4 | `model="agent/<key>"` routing | ✓ — server returns `agent_not_found` for bogus key, confirming endpoint recognizes the shape |
| T5 | Multi-part content (text + image data URI in one user turn) | ✓ |

Side finding: both `/v2/router/responses` and `/v3/router/responses` reach the same handler. `/v3/responses` (without `/router/`) returns 405.

Conclusions:

- `previous_response_id` truly redundant for `/v3/router/responses` — full stateless tool-loop works by accumulating `function_call` + `function_call_output` in the input array.
- `model="agent/<key>"` invokes Orq agents through the OpenAI-compatible route. Feasible as a future option, but out of scope here — `ORQAgentTarget` stays on its existing endpoint.
- Multi-modal validated as a future capability (RES-876).

## 5. Design

### 5.1 `evaluatorq/contracts.py` additions

```python
class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system", "developer"]
    content: str
```

`ChatMessage` moves from `simulation/types.py:217` to `evaluatorq/contracts.py`. `developer` added to role Literal. `content` stays `str` for this cycle (RES-876 extends to multi-part union). `simulation/types.py` keeps a re-export shim for back-compat for one release cycle.

```python
class AgentTarget(ABC):
    def __init__(self, memory_entity_id: str | None = None) -> None:
        self.memory_entity_id = memory_entity_id

    @abstractmethod
    async def respond(self, messages: list[ChatMessage]) -> AgentResponse: ...

    @abstractmethod
    def new(self) -> Self: ...

    async def get_agent_context(self) -> AgentContext:
        """Default: minimal context. Override for platform-backed targets."""
        return AgentContext(key=getattr(self, "agent_key", "unknown"))

    async def send_prompt(self, prompt: str) -> AgentResponse:
        """Back-compat shim for single-prompt redteam callers. No drift surface."""
        return await self.respond([ChatMessage(role="user", content=prompt)])
```

- `respond` is the abstract method. Every target thinks about messages explicitly.
- `send_prompt` survives as a concrete one-line delegating shim — back-compat for orchestrator code that still calls it. Single body, no drift.
- `get_agent_context` has a sensible default. Targets backed by a control plane (ORQ) override.
- `memory_entity_id` is an instance attribute set in `__init__`, not a class-level default. Resolves collision with mutable instance assignment in target subclasses.

### 5.2 `redteam/backends/base.py` shrinks to `Backend` ABC

```python
class Backend(ABC):
    def __init__(self, name: str) -> None:
        self.name = name

    @abstractmethod
    def create_target(self, agent_key: str) -> AgentTarget: ...

    @abstractmethod
    async def cleanup_memory(self, ctx: AgentContext, entity_ids: list[str]) -> None: ...

    def map_error(self, exc: Exception) -> tuple[str, str]:
        """Default: (error_type, message) matching current DefaultErrorMapper."""
        return ("target_error", f"{type(exc).__name__}: {exc}")
```

- Three methods. `get_agent_context` moves to `AgentTarget`.
- `name` is an instance attribute set at construction. Registry key + class identity decoupled — two registrations of the same class with different names allowed.
- `map_error` has a concrete default (current `DefaultErrorMapper` body). Subclasses override for provider-specific HTTP/error-code mapping. Return shape locked to `(error_type, message)` — matches current contract, preserves `OrchestratorResult.error_code` semantics.
- `_BareTargetBackend` (private adapter, same file) wraps a bare `AgentTarget` instance so the runner's bring-your-own-target path satisfies `Backend`. Absorbs the `getattr(at, "cleanup_memory", None)` / `getattr(at, "map_error", None)` duck-checks that today scatter across `runner.py:1341-1342`.

### 5.3 Concrete backends collapse

| Today (9 classes) | After |
|---|---|
| `ORQAgentTarget`, `ORQContextProvider`, `ORQTargetFactory`, `ORQMemoryCleanup`, `ORQErrorMapper` | `ORQAgentTarget` + `ORQBackend` |
| `OpenAIModelTarget`, `OpenAIContextProvider`, `OpenAITargetFactory`, `OpenAIErrorMapper` | `OpenAIModelTarget` + `OpenAIBackend` |

- Target classes stay separate (per-job state holders, satisfy `AgentTarget` ABC explicitly).
- Provider/Factory/MemoryCleanup/ErrorMapper bodies fold into Backend methods. Backend holds client + config only; no per-job mutable state.
- ORQ context retrieval (was `ORQContextProvider.get_agent_context(agent_key)`) becomes `ORQAgentTarget.get_agent_context()` with internal caching. HTTP fetch happens lazily on first call. Bad agent key surfaces at first `get_agent_context()` invocation rather than at `create_target`.

### 5.4 `redteam/backends/_errors.py` (new)

Module-private helpers used by `ORQBackend.map_error` + `OpenAIBackend.map_error`:

- `extract_status_code(exc) -> int | None`
- `extract_provider_error_code(exc) -> str | None`

Moved verbatim from `base.py:236-292`.

### 5.5 Registry stays factory-based

```python
_BACKEND_REGISTRY: dict[str, Callable[..., Backend]] = {}

def register_backend(name: str, factory: Callable[..., Backend]) -> None: ...

def resolve_backend(
    backend: str = "orq",
    *,
    llm_client: AsyncOpenAI | None = None,
    target_config: TargetConfig | None = None,
    pipeline_config: LLMConfig | None = None,
) -> Backend:
    factory = _BACKEND_REGISTRY[backend.strip().lower()]
    return factory(llm_client=llm_client, target_config=target_config, pipeline_config=pipeline_config)
```

Same shape as today, just returns `Backend` instead of `BackendBundle`. Third-party backends register their own factory closures with whatever typed construction they need. No god-`__init__`, no `**kwargs` lock-in, no `type[Backend]` plugin-system trap.

### 5.6 `OrqResponsesTarget` becomes stateless

```python
class OrqResponsesTarget(AgentTarget):
    def __init__(self, config, *, client=None, instructions=None, memory_entity_id=None) -> None:
        super().__init__(memory_entity_id=memory_entity_id)
        self.config = config
        self._client = client or _make_default_client()
        self._instructions = instructions

    async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
        # /v3/router/responses with input=[messages converted to InputItems]
        # NO previous_response_id. Stateless.
        ...

    def new(self) -> Self:
        # Fresh instance: no client state, no memory_entity_id. Matches existing
        # test invariant test_new_fresh_memory_entity_id_is_none.
        return type(self)(self.config, client=self._client, instructions=self._instructions)

    async def get_agent_context(self) -> AgentContext:
        return AgentContext(key=self.config.model)
```

Deleted: `_previous_response_id` attr, `__call__` method, "fork contract" docstring, all logic at `target.py:178-185` that reads/writes thread state. `TestCallDoesNotCorruptAgentTargetState` deleted (invariant no longer exists).

### 5.7 `ORQAgentTarget` keeps current endpoint, conforms to ABC

```python
class ORQAgentTarget(AgentTarget):
    def __init__(self, *, orq_client, agent_key: str, timeout_ms=None, memory_entity_id=None) -> None:
        super().__init__(memory_entity_id=memory_entity_id)
        self._orq_client = orq_client
        self.agent_key = agent_key
        self._timeout_ms = timeout_ms
        self._cached_context: AgentContext | None = None

    async def respond(self, messages: list[ChatMessage]) -> AgentResponse:
        # Existing impl preserved: orq_client.agents.responses.create + task_id threading.
        # Server holds conversation state via task_id, so respond() forwards only the
        # last user message to the agents endpoint. Prior turns in `messages` are
        # asserted-consistent with task_id's server-side history (raise if last message
        # is not role=user). First call (task_id=None) sends the last user message
        # and seeds task_id from the response. Tool-loop body inside the call lifts
        # verbatim from current orq.py:200-260.
        ...

    async def get_agent_context(self) -> AgentContext:
        if self._cached_context is None:
            self._cached_context = await self._fetch_context()
        return self._cached_context
```

- Endpoint unchanged: `orq_client.agents.responses.create` stays.
- `task_id` threading stays.
- Only change: shape conforms to `AgentTarget` ABC (`respond(messages) -> AgentResponse`). Tool-loop body lifts mostly verbatim from current `orq.py`.
- Caller contract: `messages[-1].role == "user"`. Mismatch with server-side history (`task_id`) is caller bug. Documented in `ORQAgentTarget.respond` docstring.
- `OrqResponsesTarget` (OpenAI-compatible route, stateless) remains the preferred target for new call-sites. Co-existence of two ORQ-backed targets is intentional.

### 5.8 Sim runner — `TargetAgent` Protocol deleted

```python
# simulation/runner/simulation.py:73 — TargetAgent Protocol — DELETED
# Replaced by: from evaluatorq.contracts import AgentTarget

# simulation/runner/simulation.py:636 — dispatch
if self._target_agent:
    return (await self._target_agent.respond(messages)).text
```

`simulation/runner/__init__.py` re-exports `AgentTarget` (was `TargetAgent`). `simulation/__init__.py` follows.

`simulation/api.py:simulate()` gains auto-routing: if `target=` argument is an `AgentTarget` instance, route to `target_agent` path; otherwise treat as bare `target_callback`. Keeps `simulate(target=ort)` callers unchanged.

### 5.9 Bring-your-own-target adapter

Runner's `runner.py:1320-1358` block replaced:

```python
# before
at_factory = DirectTargetFactory(at)
at_mapper = at if callable(getattr(at, "map_error", None)) else DefaultErrorMapper()
at_cleanup = at if callable(getattr(at, "cleanup_memory", None)) else NoopMemoryCleanup()
at_dyn_job = create_dynamic_redteam_job(target_factory=..., error_mapper=..., ...)

# after
at_backend = _BareTargetBackend(at)
at_dyn_job = create_dynamic_redteam_job(backend=at_backend, ...)
```

`create_dynamic_redteam_job` signature accepts a `Backend` instance instead of three separate collaborators. Duck-checks concentrate in `_BareTargetBackend`.

### 5.10 Deletions

From `redteam/backends/base.py`:

- `BackendBundle` dataclass
- `AgentTargetFactory`, `AgentContextProvider`, `MemoryCleanup`, `ErrorMapper` Protocols
- `SupportsClone`, `SupportsTokenUsage`, `SupportsTargetMetadata`, `SupportsAgentContext`, `SupportsTargetFactory`, `SupportsMemoryCleanup`, `SupportsErrorMapping`
- `DirectTargetFactory`, `NoopMemoryCleanup`, `DefaultErrorMapper`
- `is_agent_target`, `adapt_legacy_target`

From `redteam/backends/orq.py`:

- `ORQContextProvider`, `ORQTargetFactory`, `ORQMemoryCleanup`, `ORQErrorMapper` (bodies move to `ORQBackend` / `ORQAgentTarget` methods)

From `redteam/backends/openai.py`:

- `OpenAIContextProvider`, `OpenAITargetFactory`, `OpenAIErrorMapper`

From `simulation/runner/simulation.py`:

- `TargetAgent` Protocol (`L73`)
- Re-exports in `simulation/runner/__init__.py` and `simulation/__init__.py`

From `simulation/target.py:OrqResponsesTarget`:

- `__call__` method
- `_previous_response_id` attribute and all read/write sites
- "Fork contract" docstring at L48-50, L91, L158-160
- Thread-id drift logging at L185

From `redteam/__init__.py:40-48`:

- `DirectTargetFactory`, `SupportsAgentContext`, `SupportsErrorMapping`, `SupportsMemoryCleanup`, `SupportsTargetFactory`, `is_agent_target`

### 5.11 Survivors (explicitly kept)

- `_coerce_to_agent_response` (`base.py:52`) — load-bearing for `callable_integration` users. Called at `runner.py:723,1437`, `pipeline.py:382`.
- `validate_agent_target` — public migration helper. Defer removal.
- `simulation.target_callback` parameter — bare-callable path for `wrap_agent.py`, `adapters.py`. Stays.

## 6. Stacked PR plan

| PR | Scope | Branch tip | Size |
|---|---|---|---|
| PR1: Collapse in place | Backend ABC + ORQBackend + OpenAIBackend in `redteam/backends/base.py`. Drop BackendBundle + Supports* + collaborator protocols. `_errors.py` extraction. `_BareTargetBackend` adapter. Runner + adaptive call-site migration. `AgentTarget` stays Protocol→ABC inside `base.py`. | `main` | M |
| PR2: Relocate `AgentTarget` | Move `AgentTarget` ABC to `evaluatorq/contracts.py`. Update 14 importers. `redteam/backends/base.py` keeps `Backend` only. | PR1 | S |
| PR3: Unify on `respond` | Add `respond(messages)` abstract + `send_prompt` shim. `OrqResponsesTarget` stateless refactor + drop `__call__`. `ORQAgentTarget` repackaged to `respond(messages)` — endpoint unchanged. Sim's `TargetAgent` Protocol deleted. `ChatMessage` relocates to contracts. 4 integration targets refactored to `respond`. Auto-routing in `api.py`. Smoke test for sim+redteam target interchange. | PR2 | L |

Merge order: PR1 → PR2 → PR3. Each squash-merged. PR2 + PR3 rebase if PR1 reviews land changes.

## 7. Testing strategy

### PR1

- Existing `tests/redteam/test_*` green.
- New: `tests/redteam/test_backend_abc.py` — `Backend.map_error` default returns `("target_error", ...)`; subclasses extract HTTP status / exception types.
- New: `tests/redteam/test_bare_target_backend.py` — adapter delegates `cleanup_memory`/`map_error` when target has them, falls back otherwise. `get_agent_context` returns minimal context when target lacks override.
- Pre-existing bug regression test: `resolved_error_mapper = DefaultErrorMapper()` at `runner.py:833` ignored bundle's `error_mapper`. After collapse, ORQ exceptions hit `ORQBackend.map_error`. Behavior change intentional — add test asserting ORQ HTTP exceptions map to ORQ-specific codes, not generic `target_error`.

### PR2

- Type-check `bunx nx typecheck` after each importer migration.
- All 17 tests in `tests/redteam/test_orq_responses_target_as_agent_target.py` stay green.
- Sanity: `from evaluatorq.contracts import AgentTarget` succeeds.

### PR3

- `tests/redteam/test_orq_responses_target_as_agent_target.py:206,219` updated to `target.respond(...)`.
- `TestCallDoesNotCorruptAgentTargetState` deleted (invariant no longer exists). Replaced by `TestRespondIsStateless` (verify `respond` doesn't accumulate state across calls).
- New: `tests/integration/test_sim_redteam_target_roundtrip.py` — one OrqResponsesTarget instance passes RES-844 acceptance: works as redteam target AND sim `target_agent`.
- ORQAgentTarget tests updated: callers switch from `send_prompt(str)` to `respond([ChatMessage(role="user", content=str)])`. Tool-loop body assertions (function-call extraction, task_id threading, memory cleanup) unchanged. New test: `respond([..., assistant, user])` forwards only the last user turn to the agents endpoint.
- All 7 target classes (ORQAgentTarget, OpenAIModelTarget, OrqResponsesTarget, LangGraphTarget, CallableTarget, VercelAISdkTarget, OpenAIAgentTarget) — each gets a `respond`-returns-`AgentResponse` smoke test.
- Sim test suite (`tests/simulation/`) green.

## 8. Risks

1. **Pre-existing `DefaultErrorMapper()` masking ORQ mapping** at `runner.py:833`. PR1 behavior change is intentional — document in PR description, verify retry/abort behavior unchanged via existing integration tests.

2. **`__call__` removal on OrqResponsesTarget**. External callers passing `target_callback=OrqResponsesTarget(...)` break. Migration: `target=ort` (auto-routes via `api.py`) or `target_agent=ort`. CHANGELOG entry. Internal grep shows no production sites using this pattern.

3. **`ChatMessage` move** from `simulation/types` to `contracts`. Re-export shim in `simulation/types.py` for one cycle. CHANGELOG entry: "ChatMessage moved to `evaluatorq.contracts`; old import path deprecated, removal in 1.5."

4. **7 target classes refactored to `respond`**. Risk of behavior drift between `send_prompt` shim and `respond` impl per class. Mitigation: shim is single-line delegation, no body to drift. CI runs full test suite across all integrations.

5. **Public re-exports removed** (`DirectTargetFactory`, 4 `Supports*`, `is_agent_target` from `redteam/__init__.py`). Semver-relevant. CHANGELOG entry: "Removed in 1.4: replaced by `Backend` ABC + `isinstance(x, AgentTarget)`." Package is past 1.0 per `base.py:154` reference to "evaluatorq 1.3".

## 9. Doc updates (post-PR3)

- `docs/types-uml.md` — replace 12-type protocol family in main classDiagram with 2-ABC end-state. Drop "Proposal — RES-844" appendix (implemented).
- `docs/types-uml.html` — re-render via `/html-artifacts`.

## 10. Decisions log

- **Single PR vs stacked**: Initially single. Reversed after hate-review surfaced bisect-hostility and review-quality concerns. Stacked PR1→PR2→PR3.
- **Module home for ABCs**: `AgentTarget` → `evaluatorq/contracts.py` (top-level exists, `AgentResponse` already there). `Backend` stays in `redteam/backends/base.py` (redteam-internal, sim doesn't need it).
- **Registry shape**: Factory functions (`Callable[..., Backend]`), not `type[Backend]` + `**kwargs`. Avoids god-init and plugin-trap.
- **`map_error` on Backend**: Stays. Skeptic argued cohesion; extensibility for third-party backends wins.
- **`name` on Backend**: Instance attribute via `__init__`, not `ClassVar[str]`. Registry key + class identity decoupled.
- **`respond` shape**: Abstract `respond(messages) -> AgentResponse`. `send_prompt(str) -> AgentResponse` becomes concrete shim. Pedant's "load-bearing lie" concern resolved by making `respond` abstract instead of concrete-with-lossy-default.
- **`__call__` on OrqResponsesTarget**: Removed entirely. Pedant's "two parallel APIs" concern resolved by deletion, not by 1-line shim.
- **Stateless `OrqResponsesTarget`**: Drop `_previous_response_id`. User confirmed bandwidth not a concern.
- **`ORQAgentTarget` endpoint**: Keep on `orq_client.agents.responses.create`. Only repackage to `respond(messages)`. Adopt `OrqResponsesTarget` for new call-sites instead of rewriting ORQAgentTarget. Probe T4 confirmed `model="agent/<key>"` routing is viable as a future option but not in scope here.
- **`ChatMessage` content shape**: Stays `str` in this cycle. Multi-modal deferred to RES-876.
- **Survivors**: `_coerce_to_agent_response`, `validate_agent_target`, `simulation.target_callback` parameter, `simulation/types.py:ChatMessage` re-export shim.
