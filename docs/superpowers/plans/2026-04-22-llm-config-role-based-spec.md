# LLMConfig Role-Based Redesign — Design Spec

## Problem

Current flat `LLMConfig` has two issues:

1. **Field explosion** — 4 separate `*_temperature` / `*_max_tokens` fields for pipeline steps nobody tunes differently. `adversarial_temperature`, `capability_classification_temperature`, `strategy_generation_temperature`, `tool_adaptation_temperature` — all conceptually "attacker tuning."

2. **Single `llm_kwargs` bleeds into all calls** — one dict shared across attacker, evaluator, and all pipeline steps. No way to give the evaluator different kwargs than the attacker.

## Design

### `LLMCallConfig` — per-role LLM call config

```python
class LLMCallConfig(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str = DEFAULT_PIPELINE_MODEL
    temperature: float = 1.0
    max_tokens: int = 5000
    timeout_ms: int = 90_000
    extra_kwargs: dict[str, Any] = Field(default_factory=dict)
    client: AsyncOpenAI | None = None  # None = auto from env
```

### `LLMConfig` — top-level pipeline config

```python
class LLMConfig(BaseModel):
    attacker: LLMCallConfig = Field(default_factory=LLMCallConfig)
    evaluator: LLMCallConfig = Field(default_factory=LLMCallConfig)

    retry_count: int = 3
    retry_on_codes: list[int] = Field(default=[429, 500, 502, 503, 504])
    cleanup_timeout_ms: int = 60_000
    log_level: str = 'INFO'

    @property
    def retry_config(self) -> dict[str, Any]: ...

    @property
    def uses_orq_router(self) -> bool:
        return not os.getenv('OPENAI_API_KEY') and bool(os.getenv('ORQ_API_KEY'))
```

No `target` role — target config lives on the `AgentTarget` object itself (see below).

---

## Backend / routing design

### Model naming — fully user-controlled

**`resolve_model` is removed.** No auto-prefixing. The user always specifies the full model string appropriate for their backend:

```python
LLMCallConfig(model="openai/gpt-4o")                   # ORQ router → OpenAI
LLMCallConfig(model="anthropic/claude-3-5-sonnet")      # ORQ router → Anthropic
LLMCallConfig(model="google/gemini-2.0-flash")          # ORQ router → Google
LLMCallConfig(model="gpt-4o")                           # direct OpenAI (no prefix needed)
```

Auto-prefixing `openai/` was wrong for non-OpenAI models — removed entirely.

### Base URL — env vars or explicit client

Two modes:

**Mode 1 — auto (`client=None`):**
```bash
export ORQ_API_KEY=orq-xxx   # no OPENAI_API_KEY
```
→ `uses_orq_router=True` → `create_async_llm_client()` builds:
```python
AsyncOpenAI(base_url="https://gateway.orq.ai/v2", api_key=ORQ_API_KEY)
```
User is responsible for including provider prefix in model string.

**Mode 2 — explicit client:**
```python
LLMCallConfig(
    model="anthropic/claude-3-5-sonnet",
    client=AsyncOpenAI(
        base_url="https://gateway.orq.ai/v2",
        api_key="orq-xxx",  # ORQ key in the api_key slot
    ),
)
```
`uses_orq_router` ignored. User owns client config and model naming entirely.

`uses_orq_router` controls only which base_url `create_async_llm_client()` uses when `client=None`. It no longer drives any model string transformation.

### Target agent — config lives on `AgentTarget`

`ORQAgentTarget` uses the ORQ Python SDK (`orq_client.agents.responses.create`) — a different client from `AsyncOpenAI`. Target config (`timeout_ms`, `max_tokens`) belongs on the `AgentTarget` object directly, not in `LLMConfig`.

```python
# Explicit target config:
await red_team(
    ORQAgentTarget("my-key", timeout_ms=60_000, max_tokens=2000),
    config=LLMConfig(...),
)

# String targets use AgentTarget defaults internally:
await red_team("agent:my-key", config=LLMConfig(...))
```

---

## Usage examples

```python
from evaluatorq.redteam import LLMConfig, LLMCallConfig

# Minimal — auto-detect backend from env
config = LLMConfig()

# Role customization
config = LLMConfig(
    attacker=LLMCallConfig(
        model="anthropic/claude-3-5-sonnet",
        temperature=0.9,
        extra_kwargs={"seed": 42},
    ),
    evaluator=LLMCallConfig(
        model="openai/gpt-4o-mini",
        temperature=0.0,
    ),
)

# Explicit client per role (e.g. attacker via ORQ, evaluator direct OpenAI)
config = LLMConfig(
    attacker=LLMCallConfig(
        model="anthropic/claude-3-5-sonnet",
        client=AsyncOpenAI(base_url="https://gateway.orq.ai/v2", api_key=orq_key),
    ),
    evaluator=LLMCallConfig(
        model="gpt-4o-mini",
        client=AsyncOpenAI(api_key=openai_key),
    ),
)
```

---

## What changes from current implementation

| Current | New |
|---|---|
| Flat `attack_model`, `evaluator_model` | `attacker.model`, `evaluator.model` |
| Single `llm_kwargs` (global) | `attacker.extra_kwargs`, `evaluator.extra_kwargs` |
| 4× `*_temperature` fields | `attacker.temperature` |
| 4× `*_max_tokens` fields | `attacker.max_tokens` |
| `target_agent_timeout_ms`, `target_max_tokens` in `LLMConfig` | On `AgentTarget` directly |
| `llm_call_timeout_ms` | `attacker.timeout_ms` |
| `resolve_model` auto-prefixes `openai/` | Removed — user owns model string |
| `uses_orq_router` drives prefix logic | `uses_orq_router` drives base_url only |
| No per-role client override | `LLMCallConfig.client: AsyncOpenAI | None` |

## Files affected

- `contracts.py` — add `LLMCallConfig`, rewrite `LLMConfig`
- `adaptive/orchestrator.py`, `capability_classifier.py`, `objective_generator.py`, `attack_generator.py`, `strategy_planner.py`, `pipeline.py` — use `cfg.attacker.*`
- `backends/orq.py` — add `max_tokens` to `ORQAgentTarget`; `timeout_ms` already there
- `backends/openai.py` — add `max_tokens`, `timeout_ms` to `OpenAIModelTarget`
- `backends/registry.py` — `create_async_llm_client()` gets optional `role_config: LLMCallConfig` to use explicit client if set
- `runner.py` — `config.attacker.model`, `config.evaluator.model`, per-role `uses_orq_router` check
- `cli.py` — `LLMConfig(attacker=LLMCallConfig(model=attack_model), evaluator=LLMCallConfig(model=evaluator_model))`
- `__init__.py` — export `LLMCallConfig`
- Tests, examples
