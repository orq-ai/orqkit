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
3. Keep caller-specific behaviour (result type, error policy) at the call sites
   where it legitimately differs.

## Non-goals

- Importing `evals-python-runner` as a dependency (unpublished monorepo app with
  heavy deps like `sentry_sdk`; evaluatorq-py is standalone + published).
- Supporting `retrievals` or user `variables` placeholders (no consumer here).
- Relocating `with_llm_span` or touching the simulation/openresponses tracing
  copies.

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
| Q3 | `output.tool_calls` naming | **Migrate** prompts to canonical `{{output.tools_called}}`; builder emits canonical keys only, no aliases. |
| Q4 | Judge boundary | **Render + judge-call → neutral `JudgeOutcome`**; callers map to their own result type + apply their own error policy. |
| — | Judge location | **Option A** — `run_judge` lives redteam-side (couples redteam tracing); only the pure engine goes to `common/`. |

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

redteam/judge.py                         # NEW (Option A: redteam-side)
    EvaluatorResponsePayload             # moved here, single source
    JudgeOutcome                         # neutral result
    build_eval_replacements(...)         # lean, our fields only
    async def run_judge(...) -> JudgeOutcome   # render + span + call + parse
```

Placed at the **redteam package root** (`redteam/judge.py`), not under
`frameworks/owasp/`: it is consumed by both `adaptive/` and `frameworks/owasp/`,
so it is a redteam-shared helper. `common/` is blocked by the tracing layering
constraint above (the closest we can get to the DRY-common rule without inverting
layers).

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
    messages: list[dict[str, Any]] | list[Message],
    response: str,
    tool_calls: list[ToolCallOutputItem] | None = None,
    expected_output: str | None = None,
    system_instructions: str | None = None,
) -> dict[str, Any]
```

Emits canonical keys only (no retrievals, no variables):

- **Flat overrides (formatted strings, win on exact match):** `input.all_messages`,
  `output.tools_called`, `log.messages`, `log.tool_calls`. **These keep OUR
  current `json.dumps` formatting** — our existing prompts were authored against
  the current renderer's JSON output, NOT upstream's human-readable prose. This
  is an intentional builder-level divergence from upstream; the **engine** is
  faithful, the **builder values are ours**. Documented in the builder docstring.
- **Nested (enable indexing):** `input.{all_messages, expected_output,
  system_instructions}`, `output.{response, tools_called}`, legacy
  `log.{input, output, reference, expected_output, messages, tool_calls}`.
- **Tool-call object key set is OURS:** `{name, arguments, result, id}` (matching
  the current renderer + existing prompts/tests), NOT upstream's `model_dump()`
  keys (`tool_name`, ...). Documented divergence.
- `{{output.tool_calls}}` is **NOT** emitted (Q3 migration target).

The engine stays generic — any future caller can pass its own dict and skip the
builder.

### Judge (`run_judge`)

Free function (honours the minimize-classes preference — no stateful config-bag
class):

```python
async def run_judge(
    *,
    client: AsyncOpenAI,
    model: str,
    cfg: <evaluator LLMCallConfig>,
    prompt_template: str,
    replacements: dict[str, Any],
    system_prompt: str = DEFAULT_SECURITY_EVALUATOR_SYSTEM_PROMPT,
    response_model: type[BaseModel] = EvaluatorResponsePayload,
    span_attributes: dict[str, str] | None = None,
    llm_kwargs: dict[str, Any] | None = None,
) -> JudgeOutcome
```

Flow: `render_template` → build judge messages (`system_prompt` + rendered user
prompt) → open `with_llm_span` (tracing baked in) → `asyncio.wait_for(
client.chat.completions.create(..., response_format={"type": "json_object"}))` →
`record_llm_response` + `TokenUsage.from_completion` → parse `response_model`.

`JudgeOutcome` captures **all** outcomes — it makes **no** policy decision:

```python
class JudgeOutcome:
    payload: EvaluatorResponsePayload | None
    token_usage: TokenUsage | None
    raw_content: str
    error: JudgeError | None   # typed: kind in {timeout, parse, api_connection,
                               # api_status, unknown} + message + timeout_ms
```

`run_judge` **does not raise** transient API errors — it captures them (typed) in
`JudgeOutcome.error`. Each caller decides what a given error kind means. This puts
the policy 100% at the call sites where it legitimately differs (the leaky-middle
fix from review).

Imports come from the **top level**: `TokenUsage` and `ToolCallOutputItem` are
defined in `evaluatorq.contracts` (re-exported through `redteam.contracts`); the
judge imports them from `evaluatorq.contracts`.

### Caller migration

**`adaptive/evaluator.py::_run_evaluator`:**

- build replacements → `run_judge` → map `JudgeOutcome` → `AttackEvaluationResult`.
- On `error.kind in {api_connection, api_status}`: **re-raise** the original
  exception (preserve orchestrator-retry behaviour; asserted by
  `tests/redteam/test_evaluator_errors.py`).
- On `timeout`: reconstruct `raw_output={'error': 'timeout', 'timeout_ms': <n>}`
  exactly (asserted by existing test).
- On `parse`: `passed=None` + explanation.
- `EvaluatorResponsePayload` import repointed to `judge.py`.

**`evaluatorq_bridge.py::scorer`:**

- build replacements → `run_judge` → map `JudgeOutcome` → evaluatorq
  `EvaluationResult`.
- **All** error kinds (incl. transient) → `{"value": "error", "pass": None,
  "explanation": ...}` — preserves current swallow-the-batch-row behaviour. No
  transient exception escapes the scorer.
- **value/pass mapping guard:** on success `value` is the bool verdict and `pass`
  the same bool — `value=False` (VULNERABLE) must NOT be coerced to `"error"`.
  Only the error branch sets `value="error"`, `pass=None`.
- Static path now opens `with_llm_span` (via `run_judge`) → gains tracing.

**Prompts:** rename `{{output.tool_calls}}` → `{{output.tools_called}}` in
`frameworks/owasp/agent_evaluators.py` and `llm_evaluators.py`. **Do NOT touch**
`output.get('tool_calls')` at `evaluatorq_bridge.py:152-153` — that reads the
agent-output dict (a different namespace that happens to share the string).

**Delete:** `frameworks/owasp/prompt_render.py` (incl. `_sanitize_placeholders`)
and its re-export shim in `adaptive/evaluator.py`. Find all import sites by **AST**
(not grep — grep misses multi-line imports) and repoint/remove them.

## Testing

### Engine parity suite (`tests/common/test_template_engine.py`)

Port upstream vectors; must include:

- flat-override-wins-over-nested (`{{output.tools_called}}` flat string vs
  `{{output.tools_called[0].name}}` nested) — the highest-risk divergence
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

### Security-semantics change

`tests/redteam/test_owasp_prompt_render.py::test_messages_json_double_braces_sanitized`
asserts the neutralized `{ {` form — that premise is gone. **Rewrite** the
assertion to expect the verbatim `{{output.response}}` (single-pass, never
re-scanned) and document that the defense changed from brace-neutralization to
single-pass-non-rescan + path whitelist. Repoint the rest of the file at
`render_template`.

### Judge tests (`tests/redteam/test_judge.py`)

- `JudgeOutcome` mapping for each error kind
- dynamic mapper re-raises on `api_connection`/`api_status`; reconstructs timeout
  `raw_output` shape
- static mapper swallows every error kind → error `EvaluationResult`; never raises
- value/pass guard: `passed=False` stays `{value: false, pass: false}`; error
  stays `{value: "error", pass: null}`
- static path emits exactly one `chat <model>` span with
  `llm_purpose=evaluation` (tracing addition)

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
