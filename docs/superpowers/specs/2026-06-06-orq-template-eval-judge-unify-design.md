# Design: Orq template engine port + LLM-judge unification

**Date:** 2026-06-06
**Package:** `packages/evaluatorq-py`
**Status:** Approved design (pre-implementation)

## Problem

OWASP evaluator prompts are templates containing `{{...}}` placeholders. They are
executed **locally** via direct `client.chat.completions.create()` calls — NOT
through Orq's platform eval-execution engine — so nothing substitutes the
placeholders automatically.

Today substitution is done by a hand-rolled renderer
(`redteam/frameworks/owasp/prompt_render.py::render_owasp_evaluator_prompt`) that:

- handles only 3 placeholders (`{{input.all_messages}}`, `{{output.tool_calls}}`,
  `{{output.response}}`)
- chains naive `str.replace()` calls
- carries a `_sanitize_placeholders` hack (`{{` → `{ {`) to stop a crafted
  tool-call name like `{{output.response}}` from being re-expanded by a later
  replace

Separately, two near-identical LLM-judge execution paths exist (~90% duplicated):

- `redteam/adaptive/evaluator.py::_run_evaluator` — dynamic/adaptive pipeline.
  Has OTel tracing (`with_llm_span`), captures `TokenUsage`, **re-raises**
  transient API errors for orchestrator retry, returns `AttackEvaluationResult`.
- `redteam/frameworks/owasp/evaluatorq_bridge.py::scorer` — static dataset path.
  **No tracing**, **swallows** all errors into an error result, returns
  evaluatorq `EvaluationResult`.

Both use the same verbatim system prompt and parse into the same
`EvaluatorResponsePayload` (currently duplicated in both files).

## Goals

1. Replace the hand-rolled renderer with a faithful port of Orq's canonical
   template engine, deleting the `_sanitize_placeholders` hack.
2. Collapse the duplicated judge execution into one reusable unit; static path
   gains tracing.
3. Extract the chat-completion mechanic shared by both redteam judges **and**
   `simulation`'s `BaseAgent` into one `common/` helper (kills the third copy).
4. Keep caller-specific behaviour (result type, error policy, retry) at the call
   sites where it legitimately differs.

## Non-goals

- Importing `evals-python-runner` as a dependency (unpublished monorepo app with
  heavy deps like `sentry_sdk`; evaluatorq-py is standalone + published).
- Supporting `retrievals` or user `variables` placeholders (no consumer here).
- Merging the simulation **judge** (`JudgeAgent`) — it is tool-call/`JUDGE_TOOLS`-based,
  not JSON-object scoring; only the low-level call mechanic is shared, not the judge.
- Unifying the three `with_llm_span` copies (redteam/simulation/openresponses) or
  relocating them — the shared core takes an already-open span, so this stays a
  documented follow-up, out of scope here.
- Adding `delimit`-style wrapping of adversary values in the judge prompt — kept as
  today.

## Reference

Canonical engine in `orquesta-web`, implemented twice in lockstep:

- Python (source of truth): `apps/evals/python-runner/evals_python_runner/utils/evaluator_manager/llm/evaluator.py`
  — `replace_curly_entries`, `_build_template_replacements`, `VALID_PATH_PATTERN`,
  `is_valid_template_path`.
- Go (mirror): `libs/go/graders/template_engine.go`.

The port pins the upstream commit SHA in a provenance comment (see Decisions).

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Port vs import | **Port** the algorithm into evaluatorq-py. |
| Q2 | Engine vs builder scope | **Engine full fidelity** (generic `dict[str, Any]`); **builder lean** (only fields we emit). |
| Q3 | `output.tool_calls` naming | **Migrate** prompts to canonical `{{output.tools_called}}`; no `tool_calls` alias. Stay canonical; the sole sanctioned non-canonical addition is `output.messages` (see builder). |
| Q4 | Judge boundary | **Render + judge-call → neutral `JudgeOutcome`**; callers map to their own result type + apply their own error policy. |
| — | Judge location | **Option A** — `run_judge` lives redteam-side (couples redteam tracing); only the pure engine goes to `common/`. |
| — | Shared call mechanic | Extract `execute_chat_completion` to `common/llm_call.py`; span + retry + parsing stay caller-owned (consumed by `run_judge` **and** `BaseAgent`). |

## Architecture

### Layering — why the split

`common/` may never import `redteam/`. The template engine is pure (string in,
string out, zero deps) → it belongs in `common/` and is genuinely reusable. The
judge couples the LLM client **and** redteam's `with_llm_span` (which carries a
domain-specific `orq.redteam.llm_purpose` → `orq.llm.purpose` attribute mirror,
and a deliberately non-aliasing `_derive_provider`). Putting the judge in
`common/` and importing `redteam.tracing` would invert the layering:

```
common/<judge>  ──needs tracing──>  redteam/tracing.with_llm_span
      ▲                                       │
      └──────────  redteam imports common  ◀──┘   ← CYCLE
```

So the judge stays in the redteam package, where importing
`redteam.tracing.with_llm_span` is a normal same-layer import. The static caller
(`evaluatorq_bridge.py`) is already inside redteam, so it gains tracing for free —
**no module relocation needed.** `with_llm_span` stays in `redteam/tracing.py`.

### Module layout

```
common/template_engine.py
    render_template(template: str, replacements: dict[str, Any]) -> str
    is_valid_template_path(path: str) -> bool
    # pure port. provenance comment pins upstream SHA. NO external deps.

common/llm_call.py                       # NEW — shared chat-completion mechanic
    async def execute_chat_completion(...) -> (ChatCompletion, TokenUsage | None)

redteam/judge.py                         # NEW (Option A: redteam-side)
    EvaluatorResponsePayload             # moved here, single source
    JudgeError(StrEnum)                  # typed failure kind
    JudgeOutcome                         # neutral result
    build_eval_replacements(...)         # lean, our fields only
    async def run_judge(...) -> JudgeOutcome   # render + span + execute + parse
```

`run_judge` placed at the **redteam package root** (`redteam/judge.py`), not under
`frameworks/owasp/`: consumed by both `adaptive/` and `frameworks/owasp/`, so it is
a redteam-shared helper. The redteam-flavoured `with_llm_span` keeps it out of
`common/` — but the *call mechanic* underneath the span is domain-neutral and DOES
move to `common/` (see next section), which is the real reuse.

`EvaluatorResponsePayload` is re-exported from `adaptive/evaluator.py` and
`evaluatorq_bridge.py` only if tests still import it from the old locations;
**prefer repointing the test imports** over stacking re-export shims.

### Template engine (`common/template_engine.py`)

Faithful port of `replace_curly_entries`:

- **Single-pass** `re.sub(r"{{(.*?)}}", replacer)` where `replacer` is a
  **function** (NOT a replacement string). The callback form is mandatory: it
  emits resolved values verbatim, so a value containing `\1` / `\g<0>` is not
  treated as a group reference. (Regression test required.)
- `replacer` logic, in order:
  1. strip surrounding whitespace (Jinja-tolerant `{{ key }}`)
  2. reject internal whitespace → return original `{{...}}`
  3. `is_valid_template_path` whitelist (`VALID_PATH_PATTERN`, byte-identical to
     upstream) → reject → return original `{{...}}`
  4. flat exact-match against `replacements` wins
  5. else nested traversal via `get_nested_value`
  6. unresolved → return original `{{...}}`
- `get_nested_value`: split on `.`; per segment, key-before-bracket lookup then
  iterate `re.finditer(r"\[(-?\d+)\]")` indices. **Dotted-numeric segments stay
  string keys** (`{{data.0}}` → `data["0"]`), bracket indices are int list
  indices (`{{items[0]}}` → `items[0]`). Use a `_NOT_FOUND` sentinel — distinct
  from a resolved `None`/`False`/`0`/`""`. Any `KeyError`/`IndexError`/
  `TypeError` → `_NOT_FOUND` → placeholder left intact.
- value formatting: `dict`/`list` → `json.dumps(value, indent=2)`; `str` →
  passthrough; else → `str(value)` (so `None`→`"None"`, `False`→`"False"`,
  `0`→`"0"`, `""`→`""`).

Single-pass + path whitelist replaces the `_sanitize_placeholders` hack: resolved
values are never re-scanned, so an injected `{{output.response}}` inside a tool
name is emitted literally and never expanded. Security comes from the whitelist,
matching upstream.

### Replacements builder (`build_eval_replacements`)

```python
build_eval_replacements(
    *,
    input_messages: list[dict[str, Any]] | list[Message],   # INPUT thread only
    output_messages: list[OutputMessage],                    # structured OUTPUT source
    expected_output: str | None = None,
    system_instructions: str | None = None,
) -> dict[str, Any]
```

**Two sources, one per side.** `input_messages` = the input thread.
`output_messages: list[OutputMessage]` uses the **existing** type
(`contracts.py:94`): `OutputMessage = TextOutputItem | ToolCallOutputItem |
ReasoningOutputItem` (discriminated on `type`). `ToolCallOutputItem` already
carries `{name, arguments, result, id}`; this is exactly the structured output,
NOT raw OpenAI chat dicts. The dynamic path needs **no adaptation** — each turn's
`target.output` is already `list[OutputMessage]` (`contracts.py:298`); concatenate
across turns. The three output views are **projections** of `output_messages`,
not separate inputs:

- `output.response` ← `"".join(i.text for i in output_messages if isinstance(i,
  TextOutputItem))` — the existing **`AgentResponse.text`** rule (`contracts.py:337`),
  NOT a hand-rolled "last item" scan. **Behaviour note:** for multi-turn output
  this joins all assistant text, vs. the old dynamic path's `final_response`
  (last-turn-only). Deliberate — the judge benefits from full output text, and
  `output.messages` carries the structured per-step breakdown anyway. If exact
  last-turn parity is ever needed, the caller scopes `output_messages` to the final
  turn; validate during implementation against existing evaluator-prompt
  expectations.
- `output.tools_called` ← filter `ToolCallOutputItem` records out of
  `output_messages`. Emit `{name, arguments, result, id}` where **`arguments` is the
  parsed dict (`tc.arguments_dict`, matching the current renderer), NOT the raw
  `tc.arguments` JSON string**, and `id` is `tc.id` (the item id, as the current
  renderer emits — not `call_id`). Pin both; getting `arguments` wrong silently
  changes the JSON shape and breaks existing prompts/tests.
- `output.messages` ← the transcript itself. `ReasoningOutputItem` entries are
  dropped from this projection (reuse the item-projection logic from
  `turns_to_messages` — text-collapse, tool-call→assistant row, result→tool row,
  drop reasoning — **adapted for output-only**, since `turns_to_messages` interleaves
  the user turns we now exclude; extract that inner logic rather than calling the
  whole function).

This is why there is no separate `response` or `tool_calls` parameter: they would
let a caller pass values contradicting the transcript. Single source per side →
no inconsistency, and no lossy reconstruction (the structured records already
carry parsed args + paired results; projecting *down* to a chat transcript is
lossless, the reverse is not — which is the option we rejected).

Naming: `input_messages` / `output_messages` (not bare `input`/`output` — `input`
shadows the builtin and trips ruff `A002`).

**Strict input/output separation** (the canonical model, validated against
upstream `nats_service.py::build_signal_messages` + `evaluator.py::_build_template_replacements`):

- `input.all_messages` carries **only input messages** — the prompt thread. It
  does NOT contain the agent's responses or tool calls. Upstream's grader never
  folds output into `messages`; in upstream the output side is the independent
  `response` + `tool_calls` config fields.
- `output.response` = the **plaintext** response — all assistant text joined (see
  the projection rule above), NOT last-turn-only.
- `output.tools_called` = **only the output tool calls** the agent made — a subset
  of `output.messages`.
- `output.messages` = **NEW evaluatorq extension** — the agent's full output
  transcript (assistant text + `tool_calls` rows + `tool` result rows,
  interleaved). Superset that captures multi-step agentic output (tool call →
  reflect → tool call → final) that `output.response` (final text only) and
  `output.tools_called` (calls only, no interleaved reasoning text) cannot.
  **Not a canonical upstream placeholder** — a deliberate, documented local
  extension (contrast the accidental `output.tool_calls` drift we are removing).

Emitted keys (no retrievals, no variables):

- **Flat overrides (formatted strings, win on exact match):** `input.all_messages`,
  `output.tools_called`, `output.messages`, `log.messages`.
  **These keep OUR current `json.dumps` formatting** — our existing prompts were
  authored against the current renderer's JSON output, NOT upstream's
  human-readable prose. Intentional builder-level divergence; the **engine** is
  faithful, the **builder values are ours**. Documented in the builder docstring.
- **Nested (enable indexing):** `input.{all_messages, expected_output,
  system_instructions}`, `output.{response, tools_called, messages}`, legacy
  `log.{input, output, reference, expected_output, messages}`.
- **Legacy `log.*` mapping** (kept for backward-compat with prompts using the old
  namespace; dropped vs upstream: `retrievals` and `tool_calls` — no consumer):
  `log.input` = last user query; `log.output` = `output.response` (plaintext, all
  assistant text joined); `log.reference` = `log.expected_output` = the reference
  (expected output) passed at evaluation; `log.messages` = `input.all_messages`
  (the input thread — we drop upstream's trailing-user-drop nuance; the two are
  identical here). `log.*` carries **no** tool calls.
- **Tool-call object key set is OURS:** `{name, arguments, result, id}` (matching
  the current renderer + existing prompts/tests), NOT upstream's `model_dump()`
  keys (`tool_name`, ...). Documented divergence.
- `{{output.tool_calls}}` is **NOT** emitted (Q3 migration target).

**Call-site sourcing** (the part that changes vs. today):

- **Dynamic** (`pipeline.py`): today it passes `messages=conversation` where
  `conversation = output.chat_completions` (the FULL interleaved transcript) — this
  wrongly puts agent output into `all_messages`. Split it from the per-turn
  records: attacker/user turns → `input_messages`; the structured target output
  items (text + tool calls + results) → `output_messages`. Stop using the
  pre-merged `chat_completions`, and drop the pre-flattened `final_response` /
  `all_tool_calls` plumbing (now projected by the builder).
- **Static** (`evaluatorq_bridge.py`): datapoint inputs → `input_messages`; the
  recorded agent output adapted into the structured `output_messages` shape (a
  `{response, tool_calls}` datapoint becomes one assistant text record + tool-call
  records). Verify the dataset carries an output transcript; if it only stores
  final text, `output.messages` degrades to a single assistant record (acceptable).

The engine stays generic — any future caller can pass its own `dict` and skip the
builder entirely.

### Shared call mechanic (`common/llm_call.py`) — the third-path reuse

Review surfaced a **third** copy of the render→span→call→record→usage pipeline:
`simulation/agents/base.py::BaseAgent._call_chat_completions` (the most mature one,
with W3C trace-header injection + retry). The two redteam judge paths +
`BaseAgent` = three copies of the same `chat.completions.create` mechanic. We do
NOT merge the judges (simulation's judge is tool-call/`JUDGE_TOOLS`-based and uses
`simulation/tracing.with_llm_span`, not JSON-object scoring) — instead we extract
the **domain-neutral inner mechanic** both share:

```python
# common/llm_call.py
async def execute_chat_completion(
    *,
    client: AsyncOpenAI,
    model: str,
    messages: list[dict[str, Any]],
    span: Span | None,                 # caller opens its OWN domain with_llm_span
    timeout_s: float,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    inject_trace_headers: bool = True,
    extra_kwargs: dict[str, Any] | None = None,
) -> tuple[ChatCompletion, TokenUsage | None]:
    # build params (+ tools/tool_choice, + response_format, + extra_kwargs)
    # record_llm_input(span, messages)
    # if inject_trace_headers: extra_headers = await get_trace_context_headers()
    # response = await asyncio.wait_for(client.chat.completions.create(**params), timeout_s)
    # record_llm_response(span, response)
    # return response, TokenUsage.from_completion(response)
```

All deps already live low: `record_llm_input` / `record_llm_response` /
`get_trace_context_headers` in `common/tracing.py`, `TokenUsage` in
`evaluatorq.contracts`, `with_retry` in `common/retry.py` — so `common/llm_call.py`
imports cleanly with **no layering inversion**.

Boundary decisions:
- **Span stays caller-owned.** The core takes an already-open `span`; each domain
  keeps its own `with_llm_span` (redteam/simulation/openresponses). This avoids
  pulling the three divergent span builders into the core. *Noted follow-up (not
  in scope): those three `with_llm_span` copies are ~80% identical and are the next
  consolidation target — out of scope here to keep the blast radius contained.*
- **Retry stays caller-owned.** The core does not retry. `BaseAgent` keeps its
  `with_retry` wrap; `run_judge` does NOT retry (dynamic path relies on
  orchestrator-level retry, static path swallows) — an intentional resilience
  difference, documented, not an oversight.
- **Parsing/result-shaping stays caller-owned.** Core returns the raw
  `ChatCompletion` + token usage; callers extract choices and build their own
  result type (`LLMResult` / `JudgeOutcome`).

`BaseAgent._call_chat_completions` is refactored onto `execute_chat_completion`
(keeps its sim span, `with_retry`, `self._usage` accumulation, `LLMResult` build);
`run_judge` builds on it too. Net: one mechanic, three consumers — real
unification, and the redteam judge **gains trace-header injection for free**.

### Judge (`run_judge`)

Free function (honours the minimize-classes preference — no stateful config-bag
class):

```python
async def run_judge(
    *,
    client: AsyncOpenAI,
    model: str,
    cfg: LLMCallConfig,                 # the existing type, contracts.py:43
    prompt_template: str,
    replacements: dict[str, Any],
    system_prompt: str = DEFAULT_SECURITY_EVALUATOR_SYSTEM_PROMPT,
    response_model: type[BaseModel] = EvaluatorResponsePayload,
    span_attributes: dict[str, str] | None = None,
) -> JudgeOutcome
```

`cfg` is the existing `LLMCallConfig` (`contracts.py:43`: `temperature`,
`max_tokens`, `timeout_ms`, `extra_kwargs`, `client`, `api`) — already used at both
call sites via `PIPELINE_CONFIG.evaluator`. Its `extra_kwargs` flows into the call;
no separate `llm_kwargs` parameter.

Flow: `render_template` → build judge messages (`system_prompt` + rendered user
prompt) → open redteam `with_llm_span(span_attributes)` → call
**`execute_chat_completion`** (the shared core, with `response_format={"type":
"json_object"}`) → parse `response_model`. The wait_for / create / record / usage
mechanics live in the core, not duplicated here.

**Error capture is `run_judge`'s job** (the core propagates, per its boundary
contract). `run_judge` wraps the `execute_chat_completion` + parse in try/except and
maps: `asyncio.TimeoutError` (caught specifically, not builtin `TimeoutError`) →
`TIMEOUT`; `ValidationError`/`JSONDecodeError` → `PARSE`; `APIConnectionError` →
`API_CONNECTION`; `APIStatusError` → `API_STATUS`; anything else → `UNKNOWN`. The
original exception is stashed in `error_exc` for caller re-raise.

**Timeout units:** the core takes `timeout_s` (seconds — native to
`asyncio.wait_for`, and what `BaseAgent` already uses). `run_judge` converts
`cfg.timeout_ms / 1000` for the core and stamps `outcome.timeout_ms = cfg.timeout_ms`
on a `TIMEOUT` (the existing dynamic test asserts the ms-shaped `raw_output`).
Milliseconds live only at the `LLMCallConfig` / `JudgeOutcome` edges; seconds
everywhere inside.

`JudgeOutcome` captures **all** outcomes — it makes **no** policy decision:

```python
class JudgeError(StrEnum):              # StrEnum, not a bare string set
    TIMEOUT = "timeout"
    PARSE = "parse"
    API_CONNECTION = "api_connection"
    API_STATUS = "api_status"
    UNKNOWN = "unknown"

class JudgeOutcome:
    payload: EvaluatorResponsePayload | None
    token_usage: TokenUsage | None
    raw_content: str
    error_kind: JudgeError | None
    error_message: str | None
    error_exc: Exception | None        # original exception, for caller re-raise
    timeout_ms: int | None
```

`run_judge` **does not raise** transient API errors — it captures them (typed) in
the outcome, preserving the original exception so a caller can re-raise it
verbatim. Each caller decides what a given `error_kind` means. Policy stays 100% at
the call sites where it legitimately differs (the leaky-middle fix from review).
Error classification reuses the existing discriminators where they fit
(`common/retry.py::_is_retryable_error` for connection-vs-status) rather than
inventing parallel logic.

Imports come from the **top level**: `TokenUsage` and `ToolCallOutputItem` are
defined in `evaluatorq.contracts` (re-exported through `redteam.contracts`); the
judge imports them from `evaluatorq.contracts`. `JudgeError` uses the `StrEnum`
polyfill already used across the package (native 3.11+, polyfilled on 3.10).

### Caller migration

**`simulation/agents/base.py::BaseAgent._call_chat_completions`:**

- refactor onto `execute_chat_completion` — keep its own `simulation` `with_llm_span`,
  `with_retry` wrap, `self._usage` accumulation, empty-choice check, and `LLMResult`
  build; delegate only the params-build / record / `wait_for(create)` / usage mechanic.
- **No behavioural change** — purely removes the duplicated inner block. Existing
  simulation tests are the guard.

**`adaptive/evaluator.py::_run_evaluator`:**

- build replacements → `run_judge` → map `JudgeOutcome` → `AttackEvaluationResult`.
- On `error_kind in {API_CONNECTION, API_STATUS}`: **re-raise** `error_exc` (the
  preserved original exception) for orchestrator retry; asserted by
  `tests/redteam/test_evaluator_errors.py`.
- On `TIMEOUT`: reconstruct `raw_output={'error': 'timeout', 'timeout_ms': <n>}`
  exactly (asserted by existing test); use `outcome.timeout_ms`.
- On `PARSE`: `passed=None` + explanation.
- `EvaluatorResponsePayload` import repointed to `judge.py`.

**`evaluatorq_bridge.py::scorer`:**

- build replacements → `run_judge` → map `JudgeOutcome` → evaluatorq
  `EvaluationResult`.
- **All** `error_kind`s (incl. transient) → `{"value": "error", "pass": None,
  "explanation": ...}` — preserves current swallow-the-batch-row behaviour. No
  transient exception escapes the scorer (it never re-raises `error_exc`).
- **value/pass mapping guard:** on success `value` is the bool verdict and `pass`
  the same bool — `value=False` (VULNERABLE) must NOT be coerced to `"error"`.
  Only the error branch sets `value="error"`, `pass=None`.
- Static path now opens `with_llm_span` (via `run_judge`) → gains tracing.

**Prompts:** rename `{{output.tool_calls}}` → `{{output.tools_called}}` in
`frameworks/owasp/agent_evaluators.py` and `llm_evaluators.py`. **Do NOT touch**
`output.get('tool_calls')` at `evaluatorq_bridge.py:152-153` — that reads the
agent-output dict (a different namespace that happens to share the string).
Prompts that must inspect multi-step agent behaviour may additionally reference
the new `{{output.messages}}` (e.g. agentic ASI evaluators); this is optional and
done per-evaluator, not a blanket rename.

**Delete:** `frameworks/owasp/prompt_render.py` (incl. `_sanitize_placeholders`)
and its re-export shim in `adaptive/evaluator.py`. Find all import sites by **AST**
(not grep — grep misses multi-line imports) and repoint/remove them. Known
importers to handle: `tests/redteam/test_owasp_prompt_render.py` AND
`tests/unit/test_tool_call_interception.py` (imports `_sanitize_placeholders` +
has a `TestSanitizePlaceholders` class + `test_tool_calls_json_is_sanitized_before_injection`
constructing `ToolCallOutputItem(name="{{output.response}}", ...)`). The AST sweep
must catch any others.

## Testing

### Engine parity suite (`tests/common/test_template_engine.py`)

Port upstream vectors; must include:

- flat-override-wins-over-nested (`{{output.tools_called}}` flat string vs
  `{{output.tools_called[0].name}}` nested) — the highest-risk divergence
- input/output separation: `{{input.all_messages}}` contains NO output/tool-call
  rows; `{{output.messages}}` contains the agent output transcript;
  `{{output.tools_called}}` contains only tool calls; no double-representation
- backslash survival: value containing `\g<0>` / `\1` emitted verbatim (callback
  invariant)
- `_NOT_FOUND` vs falsy: resolve `False`/`None`/`0`/`""`/`{}`/`[]` → exact
  `"False"`/`"None"`/`"0"`/`""`/`"{}"`/`"[]"`
- `{{data.0}}` string-key vs `{{items[0]}}` index
- negative index (`[-1]`) and out-of-range (`[-99]` / `[99]`) → placeholder intact
- nested-after-bracket (`{{a.b[-1].c}}`)
- internal-whitespace reject (`{{log input}}` → intact)
- invalid-path reject (`{{eval(x)}}`, `{{a;b}}`, `{{a()}}` → intact)
- Jinja whitespace tolerance (`{{ key }}`)
- unresolved → intact

### Builder projection tests (`tests/redteam/test_eval_replacements.py`)

- **tool-call `arguments` stays a parsed object, not an escaped JSON string**
  (the `arguments_dict` vs `.arguments` regression — highest-risk silent change)
- `output.response` derivation: multi-`TextOutputItem` output → joined text
  (`AgentResponse.text` rule); pin the multi-turn behaviour
- `output.tools_called` filtered from `output_messages`; `id` = `tc.id`
- `output.messages` drops `ReasoningOutputItem`; input/output never cross-contaminate

### Security-semantics change

`tests/redteam/test_owasp_prompt_render.py::test_messages_json_double_braces_sanitized`
AND `tests/unit/test_tool_call_interception.py` (`TestSanitizePlaceholders`,
`test_tool_calls_json_is_sanitized_before_injection`) assert the neutralized `{ {`
form — that premise is gone. **Rewrite** those assertions to expect the verbatim
`{{output.response}}` (single-pass, never re-scanned) and document that the defense
changed from brace-neutralization to single-pass-non-rescan + path whitelist.
Repoint both files at `render_template`. (`delimit` is **not** added to the judge —
adversary values stay embedded as today; deliberate, unchanged scope.)

### Shared core tests (`tests/common/test_llm_call.py`)

- `execute_chat_completion` builds params (tools/tool_choice, response_format,
  extra_kwargs), records input+response on the span, returns response + TokenUsage
- trace-header injection toggles via `inject_trace_headers`
- does NOT retry (no `with_retry` inside) and does NOT swallow — raises propagate
- existing `tests/simulation/` suite still green after `BaseAgent` refactor (no
  behavioural change: retry, `self._usage` accumulation, `LLMResult` preserved)

### Judge tests (`tests/redteam/test_judge.py`)

- `JudgeOutcome` mapping for each `JudgeError` kind
- dynamic mapper re-raises `error_exc` on `API_CONNECTION`/`API_STATUS`;
  reconstructs timeout `raw_output` shape from `timeout_ms`
- static mapper swallows every `error_kind` → error `EvaluationResult`; never raises
- value/pass guard: `passed=False` stays `{value: false, pass: false}`; error
  stays `{value: "error", pass: null}`
- static path emits exactly one `chat <model>` span with
  `llm_purpose=evaluation` (tracing addition); redteam judge now injects trace
  headers (was absent)

## Conventions

- 4-space indentation in new `common/` + judge files (match `evaluator.py` /
  `evaluatorq_bridge.py`; `tracing.py`'s tabs are the outlier — do not copy).
- `from __future__ import annotations`; Python 3.10+ (`asyncio.TimeoutError`
  caught specifically, not builtin `TimeoutError`).
- `loguru` for logging.

## Open risk (accepted)

A port is a fork: upstream `evaluator.py` / `template_engine.go` evolve in a repo
evaluatorq-py does not depend on, with no CI link. Mitigation: provenance comment
pinning the upstream commit SHA at port time. The parity suite encodes behaviour
at that SHA; drift is a manual re-sync, not automatic.
