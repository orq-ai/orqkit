# Changelog

All notable changes to `evaluatorq` are documented here.

---

## [1.3.0] — unreleased

### Breaking Changes

- **Red-team `AgentTarget` protocol** (RES-715): `send_prompt(prompt) -> str` removed; `send_prompt_with_usage(prompt) -> SendResult` is now mandatory. Token usage is part of the call return value (`SendResult.usage`) instead of a side-channel.
- **`SupportsTokenUsage` protocol + `consume_last_token_usage()` removed.** Read `result.usage` from `SendResult` instead.
- **`TokenUsage` is now `frozen=True`.** Mutating fields after construction raises. Use `__add__` / `sum([a, b])` to combine, or `model_copy(update=...)` to derive.
- **`TokenUsage` fields gained `ge=0` Pydantic validation.** Negative counts raise `ValidationError` instead of silently passing.
- **`truncate_for_span(text, max_chars=-N)` no longer raises `ValueError`** — warns and returns the text unchanged. Symmetric with the env-var path. `EVALUATORQ_SPAN_MAX_TEXT_CHARS=-N` likewise warns instead of raising.
- `red_team()` parameter renamed: `config=` → `llm_config=`. The old `config=` keyword still works in 1.3.0 but emits a `DeprecationWarning` and **will be removed in 1.4.0**.
- `LLMConfig` flat fields removed: `attack_model`, `evaluator_model`, `adversarial_temperature`, `adversarial_max_tokens`, `llm_call_timeout_ms`, `llm_kwargs` — replaced by role-based `attacker` / `evaluator` sub-configs (`LLMCallConfig`)

**Migration — AgentTarget protocol:**

```python
# Before — legacy target with optional usage hook
class MyTarget:
    async def send_prompt(self, prompt: str) -> str:
        return await self._llm.complete(prompt)

    def consume_last_token_usage(self):  # optional, easily forgotten
        return self._last_usage

# After — usage is part of the return value
from evaluatorq.redteam.contracts import SendResult, TokenUsage

class MyTarget:
    async def send_prompt_with_usage(self, prompt: str) -> SendResult:
        text, usage = await self._llm.complete_with_usage(prompt)
        return SendResult(text=text, usage=TokenUsage.from_completion(usage))

    def new(self) -> "MyTarget":
        return MyTarget()
```

For a transitional bridge, wrap legacy targets at runtime — emits a `DeprecationWarning` so out-of-tree code gets a visible migration signal:

```python
from evaluatorq.redteam.backends.base import adapt_legacy_target

target = adapt_legacy_target(my_legacy_target)  # adds send_prompt_with_usage
```

Built-in targets (`OpenAIModelTarget`, `ORQAgentTarget`, `CallableTarget`, `LangGraphTarget`, `OpenAIAgentTarget`, `VercelAISdkTarget`) keep a thin `send_prompt() -> str` shim that emits `DeprecationWarning`. **The shims will be removed in evaluatorq 2.0.**

**Migration:**

```python
# Before
red_team(target, config=LLMConfig(attack_model="gpt-4o", evaluator_model="gpt-4o-mini"))

# After
from evaluatorq.redteam.contracts import LLMCallConfig, LLMConfig

red_team(
    target,
    llm_config=LLMConfig(
        attacker=LLMCallConfig(model="gpt-4o"),
        evaluator=LLMCallConfig(model="gpt-4o-mini"),
    ),
)
```

### New Features

- **Token tracking aligned across all red-team targets** (RES-715). All four external integrations (`CallableTarget`, `LangGraphTarget`, `OpenAIAgentTarget`, `VercelAISdkTarget`) now surface token usage in `RedTeamReport.token_usage_target`; previously only the OpenAI/ORQ backends did. Also adds:
  - `SendResult` (frozen dataclass) returned by `send_prompt_with_usage()` — bundles `text`, `usage`, `model`, `response_id`, `finish_reason` so the call result and its telemetry are atomic.
  - `TokenUsage.__add__` / `__radd__` — enables `sum([usage_a, usage_b, ...])` for aggregation.
  - `gen_ai.usage.calls` attribute on aggregate trace spans.
  - `EVALUATORQ_SPAN_MAX_TEXT_CHARS` env var to cap span text payloads (default unlimited; invalid/negative values warn-and-ignore).
  - `evaluatorq.redteam.backends.base.adapt_legacy_target` migration shim for legacy `send_prompt`-only targets.
- **`LLMCallConfig`** — per-role LLM configuration with `model`, `temperature`, `max_tokens`, `timeout_ms`, `extra_kwargs`, and `client` fields
- **`LLMConfig`** — now role-based via `attacker: LLMCallConfig` and `evaluator: LLMCallConfig`; retry, cleanup, and target-agent timeout settings retained at top level
- `LLMCallConfig` exported from the `evaluatorq.redteam` public API
- `OpenAIModelTarget.send_prompt` now enforces `timeout_ms` via `asyncio.wait_for`
- Evaluator role config (`temperature`, `max_tokens`, `timeout_ms`, `extra_kwargs`, `client`) fully propagated through `OWASPEvaluator`, `create_dynamic_evaluator`, and `create_owasp_evaluator`

### Bug Fixes

- `safe_substitute()` dict keys were broken by Ruff RUF027 auto-fix in `attack_generator`, `capability_classifier`, and `objective_generator` — LLM prompts were receiving unsubstituted `{placeholder}` text, silently producing degraded attacks
- `generate_recommendations=True` now correctly uses `llm_config.evaluator.client` before falling back to `create_async_llm_client()`
- All hardcoded timeout literals (`240_000`, `90_000`) replaced with config-driven values from `LLMConfig` / `DEFAULT_TARGET_TIMEOUT_MS`
- `OpenAITargetFactory` now propagates `max_tokens` and `timeout_ms` to created targets

### Internal

- `SaveMode` converted from `Literal` to `StrEnum`
- Timeout defaults centralised in `contracts.py` (`DEFAULT_TARGET_TIMEOUT_MS = 240_000`); `PIPELINE_CONFIG` import removed from `openai.py` and `registry.py`
- `MultiTurnOrchestrator.llm_kwargs` constructor param deprecated — merged into `_cfg.attacker.extra_kwargs` at init time; use `LLMCallConfig.extra_kwargs` instead
- RUF027 added to Ruff ignore list (intentional literal string keys used as `safe_substitute` template placeholders)
- CLI `--save` flag migrated to `typer.Choice`
- Ruff cleanup across all redteam modules (import sorting, `Optional[X]` → `X | None`, `TYPE_CHECKING` guards)
