# RES-877 — Orchestrator-owned transcript; single `respond` path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AgentTarget.respond(messages)` the single response method by moving conversation memory out of targets into the redteam orchestrator, and remove `send_prompt` entirely.

**Architecture:** The orchestrator derives the target's conversation transcript from its existing `turns_record` via a shared `turns_to_messages(turns, *, skip_errors=True)` function (the same walk `OrchestratorResult.chat_completions` already uses), so no parallel state is hand-maintained. Errored target turns are marked with a new per-response `AgentResponseError` and filtered out of that transcript. The three stateful targets (`OpenAIModelTarget`, `VercelAISdkTarget`, `OpenAIAgentTarget`) drop `_history` and their `send_prompt` overrides; the `send_prompt` shim is removed from the `AgentTarget` ABC.

**Tech Stack:** Python 3.10+, Pydantic v2, pytest + pytest-asyncio, `uv`, ruff, basedpyright. All commands run from `packages/evaluatorq-py/`.

**Spec:** `docs/superpowers/specs/2026-05-27-res-877-orchestrator-transcript-unify-respond-design.md`

---

## Conventions used throughout this plan

- Run all commands from `packages/evaluatorq-py/`.
- Run a single test: `uv run pytest <path>::<test> -v`
- Run the unit suite: `uv run pytest -m 'not integration'`
- Lint/type: `uv run ruff check src` · `uv run basedpyright`
- Keep per-test timeouts ≤ 2 minutes (the suite default is 120s).
- `Message`, `AgentResponse`, `AgentTarget`, `AgentContext`, `TextOutputItem`, `ToolCallOutputItem`, `TokenUsage` are all imported from `evaluatorq.contracts`.
- `Turn`, `AttackerResponse`, `OrchestratorResult`, `RunError` (renamed this PR), `turns_to_messages` (added this PR) live in `evaluatorq.redteam.contracts`.

## The mechanical test-migration rule (referenced by later tasks)

Wherever a test calls the single-prompt API, rewrite it to the message API:

```python
# BEFORE
result = await target.send_prompt("some prompt")

# AFTER
from evaluatorq.contracts import Message
result = await target.respond([Message(role="user", content="some prompt")])
```

This is behavior-preserving for every target EXCEPT the three formerly-stateful ones, where a test that called `send_prompt` twice and asserted the second call "remembered" the first is asserting removed behavior — those are rewritten per Task instructions, not mechanically substituted.

---

## File Structure

**Modified (src):**
- `src/evaluatorq/contracts.py` — add `AgentResponseError`; add `AgentResponse.error`; remove `send_prompt` from `AgentTarget`.
- `src/evaluatorq/redteam/contracts.py` — rename `ErrorInfo`→`RunError`; add `turns_to_messages`; `chat_completions` delegates.
- `src/evaluatorq/redteam/__init__.py` — export rename.
- `src/evaluatorq/redteam/adaptive/orchestrator.py` — transcript via `turns_to_messages`; error responses carry `AgentResponseError`.
- `src/evaluatorq/redteam/adaptive/pipeline.py` — single-shot `respond`.
- `src/evaluatorq/redteam/runner.py` — two single-shot `respond` sites.
- `src/evaluatorq/redteam/backends/openai.py` — drop `_history` + `send_prompt`.
- `src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py` — drop `_history` + `send_prompt`.
- `src/evaluatorq/integrations/openai_agents_integration/target.py` — drop `_history` + `send_prompt`.
- `src/evaluatorq/redteam/backends/base.py` — detection keys off `respond`.
- `CHANGELOG.md` — breaking-change entries.

**Modified (tests):** 24 files (see Task 9/10 for the exhaustive list).

---

## Task 1: Add `AgentResponseError` and `AgentResponse.error`

**Files:**
- Modify: `src/evaluatorq/contracts.py` (insert before `class AgentResponse` at ~line 203; `ConfigDict` already imported at line 9)
- Test: `tests/contracts/test_agent_response_error.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/contracts/test_agent_response_error.py`:

```python
"""AgentResponseError + AgentResponse.error — RES-877."""

from __future__ import annotations

from evaluatorq.contracts import AgentResponse, AgentResponseError


def test_agent_response_error_defaults_to_none():
    resp = AgentResponse(text="ok")
    assert resp.error is None


def test_agent_response_carries_error_and_text():
    err = AgentResponseError(message="[ERROR: boom]", error_type="exception", code="target.crash")
    resp = AgentResponse(text="[ERROR: boom]", error=err)
    assert resp.error is err
    assert resp.error.error_type == "exception"
    assert resp.error.code == "target.crash"
    # .text still returns the human message so the report is unaffected.
    assert resp.text == "[ERROR: boom]"


def test_agent_response_error_is_frozen():
    import pytest
    err = AgentResponseError(message="m", error_type="timeout")
    with pytest.raises(Exception):
        err.message = "changed"  # type: ignore[misc]


def test_agent_response_error_code_optional():
    err = AgentResponseError(message="m", error_type="timeout")
    assert err.code is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/contracts/test_agent_response_error.py -v`
Expected: FAIL — `ImportError: cannot import name 'AgentResponseError'`.

- [ ] **Step 3: Implement**

In `src/evaluatorq/contracts.py`, insert immediately before `class AgentResponse(BaseModel):` (line ~203):

```python
class AgentResponseError(BaseModel):
    """A per-response error marker on :class:`AgentResponse`.

    Set when a target (or simulation agent) failed to produce a real response,
    e.g. a timeout or backend exception. The orchestrator uses its presence to
    exclude the turn from the transcript replayed to the target. ``message`` is
    the same human text surfaced in ``AgentResponse.text``; ``error_type`` is a
    coarse kind ("timeout" | "exception" | "content_filter" | ...); ``code`` is
    an optional provider/mapped code.

    This is the leaf, per-response error. The whole-run rollup is
    :class:`evaluatorq.redteam.contracts.RunError`.
    """

    model_config = ConfigDict(frozen=True)

    message: str
    error_type: str
    code: str | None = None
```

Then add the field to `AgentResponse` (after `finish_reason: str | None = None`, line ~223):

```python
    error: AgentResponseError | None = None
```

Add `"AgentResponseError"` to `__all__` (the list at line ~392), keeping alphabetical order (after `"AgentResponse"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/contracts/test_agent_response_error.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/contracts.py tests/contracts/test_agent_response_error.py
git commit -m "feat(contracts): add AgentResponseError + AgentResponse.error (RES-877)"
```

---

## Task 2: Rename `ErrorInfo` → `RunError`

**Files:**
- Modify: `src/evaluatorq/redteam/contracts.py:664` (class def), `:853-864` and `:1058-1069` (two `error_info` props + return-type annotations)
- Modify: `src/evaluatorq/redteam/__init__.py:64` (import), `:153` (`__all__`)
- Test: `tests/redteam/test_run_error_rename.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/redteam/test_run_error_rename.py`:

```python
"""RunError rename (was ErrorInfo) — RES-877."""

from __future__ import annotations

import pytest


def test_run_error_importable_from_public_api():
    from evaluatorq.redteam import RunError

    err = RunError(message="boom", error_type="target_error")
    assert err.message == "boom"
    assert err.error_type == "target_error"


def test_error_info_name_is_gone():
    import evaluatorq.redteam as rt

    assert not hasattr(rt, "ErrorInfo")


def test_orchestrator_result_error_info_returns_run_error():
    from evaluatorq.redteam import RunError
    from evaluatorq.redteam.contracts import OrchestratorResult

    result = OrchestratorResult(error="boom", error_type="target_error")
    info = result.error_info
    assert isinstance(info, RunError)
    assert info.message == "boom"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/redteam/test_run_error_rename.py -v`
Expected: FAIL — `ImportError: cannot import name 'RunError'`.

- [ ] **Step 3: Implement**

In `src/evaluatorq/redteam/contracts.py`:
- Line 664: rename `class ErrorInfo(BaseModel):` → `class RunError(BaseModel):`. Update its docstring to: `"""Structured whole-run error for an attack/evaluation result (the rollup; per-response errors use AgentResponseError)."""`
- Line 853: change return annotation `-> 'ErrorInfo | None':` → `-> 'RunError | None':` and the constructor `return ErrorInfo(` → `return RunError(`.
- Line 1058-1063: same two changes for the `RedTeamResult.error_info` property.

In `src/evaluatorq/redteam/__init__.py`:
- Line 64: `    ErrorInfo,` → `    RunError,` (keep import block sorted — move if needed).
- Line 153: `    "ErrorInfo",` → `    "RunError",` (keep `__all__` sorted).

- [ ] **Step 4: Verify no stragglers + run tests**

Run: `grep -rn "ErrorInfo" src/ tests/` → Expected: no matches.
Run: `uv run pytest tests/redteam/test_run_error_rename.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/contracts.py src/evaluatorq/redteam/__init__.py tests/redteam/test_run_error_rename.py
git commit -m "refactor(redteam): rename ErrorInfo -> RunError (RES-877)"
```

---

## Task 3: Extract `turns_to_messages`; `chat_completions` delegates

**Files:**
- Modify: `src/evaluatorq/redteam/contracts.py` — add module-level `turns_to_messages` (place it just above `class OrchestratorResult` at ~line 704); rewrite `OrchestratorResult.chat_completions` (`:766-819`) to delegate.
- Test: `tests/redteam/test_turns_to_messages.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/redteam/test_turns_to_messages.py`:

```python
"""turns_to_messages: list[Turn] -> list[Message], with error filtering — RES-877."""

from __future__ import annotations

from evaluatorq.contracts import (
    AgentResponse,
    AgentResponseError,
    TextOutputItem,
    ToolCallOutputItem,
)
from evaluatorq.redteam.contracts import AttackerResponse, Turn, turns_to_messages


def _turn(prompt: str, reply: str, *, error: bool = False) -> Turn:
    err = AgentResponseError(message=reply, error_type="timeout") if error else None
    return Turn(
        attacker=AttackerResponse(generated_prompt=prompt),
        target=AgentResponse(output=[TextOutputItem(text=reply, annotations=[])], error=err),
    )


def test_empty_turns_gives_empty_list():
    assert turns_to_messages([]) == []


def test_single_turn_user_then_assistant():
    msgs = turns_to_messages([_turn("hi", "hello")])
    assert [(m.role, m.content) for m in msgs] == [("user", "hi"), ("assistant", "hello")]


def test_multi_turn_alternation():
    msgs = turns_to_messages([_turn("q1", "a1"), _turn("q2", "a2")])
    assert [(m.role, m.content) for m in msgs] == [
        ("user", "q1"), ("assistant", "a1"),
        ("user", "q2"), ("assistant", "a2"),
    ]


def test_tool_calls_preserved():
    turn = Turn(
        attacker=AttackerResponse(generated_prompt="go"),
        target=AgentResponse(output=[
            ToolCallOutputItem(name="lookup", arguments='{"q":"x"}', id="c1", call_id="c1"),
        ]),
    )
    msgs = turns_to_messages([turn])
    # user row + assistant row carrying the tool_call
    assert msgs[0].role == "user"
    assistant_with_tool = next(m for m in msgs if m.role == "assistant" and m.tool_calls)
    assert assistant_with_tool.tool_calls[0].function.name == "lookup"


def test_skip_errors_drops_errored_turn():
    turns = [_turn("q1", "a1"), _turn("q2", "[ERROR: boom]", error=True), _turn("q3", "a3")]
    kept = turns_to_messages(turns, skip_errors=True)
    assert [(m.role, m.content) for m in kept] == [
        ("user", "q1"), ("assistant", "a1"),
        ("user", "q3"), ("assistant", "a3"),
    ]


def test_default_includes_errored_turn():
    turns = [_turn("q1", "a1"), _turn("q2", "[ERROR: boom]", error=True)]
    everything = turns_to_messages(turns)  # skip_errors defaults False
    assert any(m.content == "[ERROR: boom]" for m in everything)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/redteam/test_turns_to_messages.py -v`
Expected: FAIL — `ImportError: cannot import name 'turns_to_messages'`.

- [ ] **Step 3: Implement — extract the function**

The existing `OrchestratorResult.chat_completions` body (contracts.py:782-819) is the canonical walk. Lift it verbatim into a module-level function, adding the `skip_errors` filter. Insert immediately above `class OrchestratorResult(BaseModel):` (line ~704):

```python
def turns_to_messages(turns: list[Turn], *, skip_errors: bool = False) -> list[Message]:
    """Convert per-turn records into an OpenAI chat-completions message list.

    Each turn becomes a ``user`` message (the attacker prompt) followed by the
    target's output rows: consecutive text runs collapse into one ``assistant``
    message; each tool call becomes an ``assistant`` message with one
    ``tool_calls`` entry, plus a following ``tool`` row when ``result`` is set;
    reasoning items are dropped. An empty target output still emits an empty
    ``assistant`` row so consumers can rely on a user/assistant pair per turn.

    When ``skip_errors`` is True, turns whose target carries an
    :class:`AgentResponseError` are omitted entirely — used to build the
    transcript replayed to the target so failed turns never re-enter its view.
    """
    out: list[Message] = []
    for turn in turns:
        if skip_errors and turn.target.error is not None:
            continue
        out.append(Message(role='user', content=turn.attacker.generated_prompt))
        text_buffer: list[str] = []
        target = turn.target

        def _flush_text() -> None:
            if text_buffer:
                out.append(Message(role='assistant', content=''.join(text_buffer)))
                text_buffer.clear()

        for item in target.output:
            if isinstance(item, TextOutputItem):
                text_buffer.append(item.text)
            elif isinstance(item, ToolCallOutputItem):
                _flush_text()
                out.append(Message(
                    role='assistant',
                    content=None,
                    tool_calls=[StrategyToolCall(
                        id=item.call_id,
                        function=FunctionCall(name=item.name, arguments=item.arguments),
                    )],
                ))
                if item.result is not None:
                    out.append(Message(
                        role='tool',
                        tool_call_id=item.call_id,
                        name=item.name,
                        content=item.result,
                    ))
            # ReasoningOutputItem intentionally dropped.
        _flush_text()
        if not target.output:
            out.append(Message(role='assistant', content=''))
    return out
```

Confirm `Message`, `StrategyToolCall`, `FunctionCall`, `TextOutputItem`, `ToolCallOutputItem` are already imported at the top of `redteam/contracts.py` (they are — `chat_completions` uses them today).

- [ ] **Step 4: Implement — make `chat_completions` delegate**

Replace the body of `OrchestratorResult.chat_completions` (lines 782-819) with:

```python
        return turns_to_messages(self.turns)
```

Keep the property decorator, signature, and docstring.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/redteam/test_turns_to_messages.py -v`
Expected: PASS (6 tests).
Run: `uv run pytest -k chat_completions -m 'not integration'`
Expected: PASS — existing `chat_completions` report tests still green (behavior-preserving).

- [ ] **Step 6: Commit**

```bash
git add src/evaluatorq/redteam/contracts.py tests/redteam/test_turns_to_messages.py
git commit -m "refactor(redteam): extract turns_to_messages; chat_completions delegates (RES-877)"
```

---

## Task 4: Orchestrator owns the transcript

**Files:**
- Modify: `src/evaluatorq/redteam/adaptive/orchestrator.py` — turn loop (:657-660), the three error/abort response constructions (:678, :695, :709, :729), and the timeout/exception error responses.
- Test: `tests/redteam/test_orchestrator_transcript.py` (create)
- Migrate: `tests/redteam/test_orchestrator.py`, `tests/redteam/test_orchestrator_coverage.py` (mocks now need `respond`)

- [ ] **Step 1: Write the failing test (orchestrator-level transcript behavior)**

Create `tests/redteam/test_orchestrator_transcript.py`:

```python
"""Orchestrator builds the target transcript across turns — RES-877.

Replaces the per-target _history multi-turn tests: conversation memory now
lives in the orchestrator, which threads the growing transcript into
target.respond(messages) and skips errored turns.
"""

from __future__ import annotations

from evaluatorq.contracts import AgentResponse, AgentTarget, Message, TextOutputItem


class _RecordingTarget(AgentTarget):
    """Records the messages list handed to each respond() call."""

    def __init__(self, replies: list[str]) -> None:
        super().__init__(memory_entity_id=None)
        self._replies = list(replies)
        self.calls: list[list[Message]] = []

    async def respond(self, messages: list[Message]) -> AgentResponse:
        self.calls.append(list(messages))
        text = self._replies.pop(0)
        return AgentResponse(output=[TextOutputItem(text=text, annotations=[])])

    def new(self) -> "_RecordingTarget":
        return _RecordingTarget(self._replies)


async def _drive(target: AgentTarget, prompts: list[str]) -> None:
    """Minimal stand-in for the orchestrator's transcript-threading contract.

    NOTE: this helper documents the EXPECTED contract for the test; the real
    assertion is against the production orchestrator in the integration-style
    test below. Implementers: if you change how the orchestrator builds the
    transcript, this must stay equivalent.
    """
    raise NotImplementedError  # replaced by real orchestrator call in Step 3


def test_recording_target_is_constructible():
    t = _RecordingTarget(["a"])
    assert t.calls == []
```

> Implementer note: the meaningful behavioral assertions live in Step 3 against the real `AdversarialOrchestrator.run_attack`, using mocked adversarial-LLM + a `_RecordingTarget`. Step 1 only locks the harness so the file imports.

- [ ] **Step 2: Run to verify it fails / harness imports**

Run: `uv run pytest tests/redteam/test_orchestrator_transcript.py -v`
Expected: PASS for `test_recording_target_is_constructible` only (harness compiles). Proceed.

- [ ] **Step 3: Implement the orchestrator change**

In `src/evaluatorq/redteam/adaptive/orchestrator.py`:

Add the import near the other `redteam.contracts` imports at the top of the file:

```python
from evaluatorq.redteam.contracts import turns_to_messages
```

Replace the target call (lines 657-660):

```python
                            transcript = turns_to_messages(turns_record, skip_errors=True)
                            raw_response = await asyncio.wait_for(
                                target.respond([*transcript, Message(role="user", content=attack_prompt)]),
                                timeout=target_timeout_s,
                            )
```

(`Message` is imported from `evaluatorq.contracts` — add to the existing import if not present.)

Make every synthetic error target response carry an `AgentResponseError`. Import it at the top:

```python
from evaluatorq.contracts import AgentResponseError
```

Timeout path (line ~678) — replace:
```python
                        _tgt_result = AgentResponse(output=[TextOutputItem(text=agent_response, annotations=[])])
```
with:
```python
                        _tgt_result = AgentResponse(
                            output=[TextOutputItem(text=agent_response, annotations=[])],
                            error=AgentResponseError(message=agent_response, error_type="timeout", code="target.timeout"),
                        )
```

Timeout-abort append (line ~695) — replace the inline `target=AgentResponse(output=[TextOutputItem(text=agent_response, annotations=[])])` with `target=_tgt_result` (reuse the response built just above so it carries the error).

Exception path (line ~709) — replace:
```python
                        _tgt_result = AgentResponse(output=[TextOutputItem(text=agent_response, annotations=[])])
```
with:
```python
                        _tgt_result = AgentResponse(
                            output=[TextOutputItem(text=agent_response, annotations=[])],
                            error=AgentResponseError(message=agent_response, error_type="target_error", code=mapped_code),
                        )
```

Exception-abort append (line ~729) — replace the inline `target=AgentResponse(...)` with `target=_tgt_result`.

The success append (line ~741, `turns_record.append(Turn(attacker=current_attacker, target=_tgt_result))`) is unchanged — `_tgt_result` there is the real response with `error=None`.

- [ ] **Step 4: Add the real behavioral assertions**

Append to `tests/redteam/test_orchestrator_transcript.py` a test that constructs an `AdversarialOrchestrator`, patches the adversarial-LLM call to emit a fixed sequence of attack prompts (`q1`, `q2`, `q3`) over 3 turns, injects a `_RecordingTarget(["a1", "a2", "a3"])`, runs `run_attack`, and asserts:

```python
    # turn 2's respond() saw turn 1 as prior context
    assert [(m.role, m.content) for m in target.calls[1]] == [
        ("user", "q1"), ("assistant", "a1"), ("user", "q2"),
    ]
    # turn 3 saw turns 1+2
    assert [(m.role, m.content) for m in target.calls[2]][:4] == [
        ("user", "q1"), ("assistant", "a1"), ("user", "q2"), ("assistant", "a2"),
    ]
```

Use the same orchestrator construction + adversarial-LLM patching pattern already in `tests/redteam/test_orchestrator.py` (copy its fixture setup; do not invent a new mocking style). Add a second test where turn 2's target raises `asyncio.TimeoutError` once (recovered) and assert turn 3's transcript **excludes** the errored turn (`("user","q2")` is absent because the recovered error turn carries `AgentResponseError` and is filtered by `skip_errors=True`).

- [ ] **Step 5: Migrate `test_orchestrator.py` and `test_orchestrator_coverage.py`**

These define mock targets that implement `send_prompt` and assert it was called. For each mock target class, rename its `async def send_prompt(self, prompt)` to `async def respond(self, messages)` and read the prompt from `messages[-1].content`. For assertions like `target.send_prompt.assert_awaited()` or call-count checks, switch to `respond`. Apply the mechanical rule for any direct `await target.send_prompt("x")` call. The timeout test (`test_orchestrator.py:410`, "Timeout from target.send_prompt()") asserts the orchestrator catches a target timeout — repoint it at `respond`.

- [ ] **Step 6: Run tests**

Run: `uv run pytest tests/redteam/test_orchestrator_transcript.py tests/redteam/test_orchestrator.py tests/redteam/test_orchestrator_coverage.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/evaluatorq/redteam/adaptive/orchestrator.py tests/redteam/test_orchestrator_transcript.py tests/redteam/test_orchestrator.py tests/redteam/test_orchestrator_coverage.py
git commit -m "feat(redteam): orchestrator owns target transcript via turns_to_messages (RES-877)"
```

---

## Task 5: Migrate single-shot callers to `respond`

**Files:**
- Modify: `src/evaluatorq/redteam/adaptive/pipeline.py:371-374`
- Modify: `src/evaluatorq/redteam/runner.py:716`, `:1419`
- Migrate: `tests/redteam/test_dynamic_job.py`, `tests/redteam/test_token_usage_pipeline.py`, `tests/redteam/test_runner_error_mapping_regression.py`

- [ ] **Step 1: Implement the three call-site changes**

`pipeline.py` (lines 371-374) — replace:
```python
                        raw = await asyncio.wait_for(
                            target.send_prompt(prompt),
                            timeout=target_timeout_s,
                        )
```
with:
```python
                        raw = await asyncio.wait_for(
                            target.respond([Message(role="user", content=prompt)]),
                            timeout=target_timeout_s,
                        )
```
Add `from evaluatorq.contracts import Message` to `pipeline.py` imports if absent.

`runner.py:716` — replace `raw_response = await target.send_prompt(prompt)` with:
```python
            raw_response = await target.respond([Message(role="user", content=prompt)])
```

`runner.py:1419` — replace `raw = await target_instance.send_prompt(prompt)` with:
```python
                        raw = await target_instance.respond([Message(role="user", content=prompt)])
```
Update the docstring at `runner.py:1406` ("Send a static datapoint to the AgentTarget via send_prompt.") → "...via respond.". Add `Message` to `runner.py` imports if absent (`runner.py` already imports from `evaluatorq.contracts`; add `Message` to that import).

- [ ] **Step 2: Migrate the coupled tests**

In `test_dynamic_job.py` (8 refs), `test_token_usage_pipeline.py` (2), `test_runner_error_mapping_regression.py` (1): any mock target defining `send_prompt` → define `respond(self, messages)` reading `messages[-1].content`; any `assert ... send_prompt ...` → `respond`. Apply the mechanical rule to direct calls.

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/redteam/test_dynamic_job.py tests/redteam/test_token_usage_pipeline.py tests/redteam/test_runner_error_mapping_regression.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/evaluatorq/redteam/adaptive/pipeline.py src/evaluatorq/redteam/runner.py tests/redteam/test_dynamic_job.py tests/redteam/test_token_usage_pipeline.py tests/redteam/test_runner_error_mapping_regression.py
git commit -m "refactor(redteam): single-shot callers use respond([user]) (RES-877)"
```

---

## Task 6: Drop stateful state on `OpenAIModelTarget`

**Files:**
- Modify: `src/evaluatorq/redteam/backends/openai.py` — remove `_history` (line 86), the `send_prompt` override (lines 88-166).
- Migrate/rewrite: `tests/redteam/test_openai_model_target.py` (8), `tests/redteam/test_openai_target_respond.py` (7), `tests/unit/test_redteam_targets.py` (9), `tests/unit/test_tool_call_interception.py` (6), `tests/redteam/test_backends.py` (4), `tests/redteam/test_backend_send_prompt_with_usage.py` (32)

- [ ] **Step 1: Implement the src change**

In `src/evaluatorq/redteam/backends/openai.py`:
- Delete `self._history: list[ChatCompletionMessageParam] = []` (line 86).
- Delete the entire `async def send_prompt(...)` method (lines 88-166).
- Keep `respond` (lines 168-231), `new`, `get_agent_context`, `map_error`, etc.

Verify `new()` (line 233) no longer references `_history` (it doesn't — it constructs a fresh target).

- [ ] **Step 2: Rewrite the stateful-split test**

In `tests/redteam/test_openai_target_respond.py`, DELETE `test_send_prompt_remains_stateful_accumulates_history` (lines 106-130) and `test_respond_is_stateless_does_not_touch_history`'s reference to `target._history` — rewrite the latter to assert statelessness without `_history`:

```python
@pytest.mark.asyncio
async def test_respond_is_stateless_across_calls():
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=_make_openai_response())
    target = _make_target(client)

    with patch("evaluatorq.redteam.tracing.get_tracer", return_value=None):
        await target.respond([Message(role="user", content="one")])
        await target.respond([Message(role="user", content="two")])

    second_sent = client.chat.completions.create.call_args_list[1].kwargs["messages"]
    assert second_sent == [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "two"},
    ]
```

- [ ] **Step 3: Migrate the remaining OpenAI/backend tests**

Apply the mechanical rule across `test_openai_model_target.py`, `test_redteam_targets.py`, `test_tool_call_interception.py`, `test_backends.py`, `test_backend_send_prompt_with_usage.py`. For any test that called `send_prompt` twice to assert multi-turn memory, DELETE it (that behavior moved to the orchestrator and is covered by `test_orchestrator_transcript.py`). For `test_backend_send_prompt_with_usage.py` — the happy-path/error-path/usage assertions remain valid against `respond([Message(role="user", content=...)])`; rename the file's tests away from `send_prompt` wording where it appears in test names.

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/redteam/test_openai_model_target.py tests/redteam/test_openai_target_respond.py tests/unit/test_redteam_targets.py tests/unit/test_tool_call_interception.py tests/redteam/test_backends.py tests/redteam/test_backend_send_prompt_with_usage.py -v`
Expected: PASS (deleted tests gone; rest green).

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/redteam/backends/openai.py tests/redteam/test_openai_model_target.py tests/redteam/test_openai_target_respond.py tests/unit/test_redteam_targets.py tests/unit/test_tool_call_interception.py tests/redteam/test_backends.py tests/redteam/test_backend_send_prompt_with_usage.py
git commit -m "refactor(redteam): drop _history + send_prompt on OpenAIModelTarget (RES-877)"
```

---

## Task 7: Drop stateful state on `VercelAISdkTarget`

**Files:**
- Modify: `src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py` — remove `_history` (line 82), `send_prompt` (lines 85-120).
- Migrate/rewrite: `tests/unit/test_vercel_ai_sdk_target.py` (12), `tests/integration/...` (covered in Task 9)

- [ ] **Step 1: Implement**

In `src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py`:
- Delete `self._history: list[dict[str, str]] = []` (line 82).
- Delete the `async def send_prompt(...)` method (lines 85-120), including its `_history.pop()` rollback block.
- Update the `__init__` docstring (line 74-75) — remove "conversation history is tracked client-side in `_history`."
- Keep `respond` (lines 122-144).

- [ ] **Step 2: Rewrite the Vercel tests**

In `tests/unit/test_vercel_ai_sdk_target.py`: delete any multi-turn `send_prompt`+`_history` tests (the conversation-rollback test and the history-accumulation test). For the rollback behavior, add an equivalent `respond` test asserting that an HTTP error propagates (no `_history` to roll back, so just assert the exception):

```python
@pytest.mark.asyncio
async def test_respond_propagates_http_error(respx_mock):
    # ... arrange the endpoint to 500 ...
    target = VercelAISdkTarget(url="http://x/agent")
    with pytest.raises(httpx.HTTPStatusError):
        await target.respond([Message(role="user", content="hi")])
```

Apply the mechanical rule to remaining single-prompt calls.

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/unit/test_vercel_ai_sdk_target.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/evaluatorq/integrations/vercel_ai_sdk_integration/target.py tests/unit/test_vercel_ai_sdk_target.py
git commit -m "refactor(integrations): drop _history + send_prompt on VercelAISdkTarget (RES-877)"
```

---

## Task 8: Drop stateful state on `OpenAIAgentTarget`

**Files:**
- Modify: `src/evaluatorq/integrations/openai_agents_integration/target.py` — remove `_history` (line 51), `send_prompt` (lines 53-77).
- Migrate/rewrite: `tests/unit/test_openai_agents_target.py` (17)

- [ ] **Step 1: Implement**

In `src/evaluatorq/integrations/openai_agents_integration/target.py`:
- Delete `self._history: list[Any] = []` (line 51).
- Delete the `async def send_prompt(...)` method (lines 53-77).
- Update the `__init__` docstring (lines 45-46) — remove "keeps conversation state client-side in `_history`".
- Keep `respond` (lines 79-106) and `_build_response` (line 108+).

- [ ] **Step 2: Rewrite the OpenAI-Agents tests**

In `tests/unit/test_openai_agents_target.py`: delete multi-turn `send_prompt`+`_history` tests (history accumulation across calls). Keep/convert tool-call extraction + final-output + error (`Runner.run` raises → `RuntimeError`; `final_output=None` → `ValueError`) tests to drive `respond([Message(role="user", content=...)])`. Apply the mechanical rule otherwise.

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/unit/test_openai_agents_target.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/evaluatorq/integrations/openai_agents_integration/target.py tests/unit/test_openai_agents_target.py
git commit -m "refactor(integrations): drop _history + send_prompt on OpenAIAgentTarget (RES-877)"
```

---

## Task 9: Remove the `send_prompt` shim from the ABC + fix detection

**Files:**
- Modify: `src/evaluatorq/contracts.py` — remove `send_prompt` (lines 371-373); update `AgentTarget` docstring.
- Modify: `src/evaluatorq/redteam/backends/base.py` — `validate_agent_target` (lines 36-51) + `_coerce_to_agent_response` (lines 23-33) drop `send_prompt` references.
- Migrate: remaining test files — `tests/contracts/test_agent_target_shim.py` (5), `tests/integration/test_callable_integration.py` (5), `tests/integration/test_langgraph_integration.py` (6), `tests/integration/test_openai_agents_integration.py` (5), `tests/integration/test_sim_redteam_target_roundtrip.py` (3), `tests/redteam/e2e/conftest.py` (1), `tests/redteam/test_orq_agent_target_respond.py` (3), `tests/redteam/test_orq_responses_target_as_agent_target.py` (5), `tests/redteam/test_review_followup.py` (2), `tests/simulation/test_orq_responses_target.py` (6), `tests/unit/test_langgraph_target.py` (30)

- [ ] **Step 1: Implement the ABC + detection change**

In `src/evaluatorq/contracts.py`:
- Delete `async def send_prompt(...)` (lines 371-373).
- Update the `AgentTarget` docstring (lines 336-346): remove the sentence "``send_prompt`` is a concrete shim retained for single-prompt callers — it wraps the prompt in one user message and calls ``respond``." Replace with: "``respond`` is the sole response method; callers own the conversation transcript."

In `src/evaluatorq/redteam/backends/base.py`:
- `validate_agent_target` (lines 45-51): replace `has_send = callable(getattr(obj, 'send_prompt', None))` with `has_respond = callable(getattr(obj, 'respond', None))` and the condition `if not has_send and not has_new and callable(getattr(obj, 'clone', None)):` with `if not has_respond and not has_new and callable(getattr(obj, 'clone', None)):`. Update the docstring (lines 37-43) `send_prompt` → `respond`.
- `_coerce_to_agent_response` (lines 23-33): update the docstring (lines 24-27) — "Any target that still returns ``str`` from ``send_prompt``..." → "...from ``respond``...". Keep the function; the orchestrator still wraps via `_coerce_to_agent_response(raw_response)`.

- [ ] **Step 2: Verify no `send_prompt` remains in src**

Run: `grep -rn "send_prompt" src/`
Expected: no matches.

- [ ] **Step 3: Migrate / delete remaining test files**

- `tests/contracts/test_agent_target_shim.py` — this file tests the shim that no longer exists. Either DELETE it, or repurpose to assert `AgentTarget` has no `send_prompt` attribute:
  ```python
  def test_agent_target_has_no_send_prompt():
      from evaluatorq.contracts import AgentTarget
      assert not hasattr(AgentTarget, "send_prompt")
  ```
  Keep the existing `_Bare`-abstract instantiation test (asserting `TypeError` because `respond`/`new` are abstract).
- All other files in the list: apply the mechanical rule; convert mock targets' `send_prompt` → `respond(self, messages)`. `tests/unit/test_langgraph_target.py` (30 refs) is the largest — LangGraphTarget already implements `respond`, so these are mostly direct `send_prompt("x")` → `respond([Message(role="user", content="x")])` substitutions plus deleting any multi-turn-memory test (LangGraph is stateless per the PR3 work).
- `tests/redteam/e2e/conftest.py` — the e2e fixture target: rename its `send_prompt` to `respond`.

- [ ] **Step 4: Run the full unit suite**

Run: `uv run pytest -m 'not integration'`
Expected: PASS (no `send_prompt` references resolve to a missing attr).

Run: `grep -rn "send_prompt" tests/`
Expected: no matches (except possibly a deliberate `assert not hasattr(... "send_prompt")`).

- [ ] **Step 5: Commit**

```bash
git add src/evaluatorq/contracts.py src/evaluatorq/redteam/backends/base.py tests/
git commit -m "refactor!: remove send_prompt shim from AgentTarget; respond is the sole path (RES-877)"
```

---

## Task 10: CHANGELOG + full verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append breaking-change entries**

Add under the current unreleased section of `CHANGELOG.md`:

```markdown
### Breaking changes (RES-877)

- Removed `AgentTarget.send_prompt(prompt)`. `respond(messages: list[Message])` is now
  the sole response method; callers own the conversation transcript. Migrate
  `target.send_prompt("x")` to `target.respond([Message(role="user", content="x")])`.
- `OpenAIModelTarget`, `VercelAISdkTarget`, and `OpenAIAgentTarget` no longer keep a
  per-instance `_history`; they are stateless. Multi-turn conversation state is owned
  by the red-team orchestrator.
- Renamed `evaluatorq.redteam.ErrorInfo` to `RunError`.

### Added

- `AgentResponseError` (on `AgentResponse.error`) — a per-response error marker used to
  exclude failed turns from the replayed transcript.
- `evaluatorq.redteam.contracts.turns_to_messages(turns, *, skip_errors=False)`.
```

- [ ] **Step 2: Full verification**

Run, in order:
```bash
uv run ruff check src
uv run basedpyright
uv run pytest -m 'not integration'
```
Expected: ruff clean; basedpyright no new errors; full unit suite green.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): RES-877 breaking changes + additions"
```

- [ ] **Step 4: Integration sanity (optional, requires ORQ_API_KEY)**

If `.env` has `ORQ_API_KEY`:
Run: `uv run pytest -m integration -k "respond or roundtrip" -v`
Expected: PASS. If no key, note it and skip.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Remove `send_prompt` entirely → Tasks 6–9. ✓
- Single PR → all tasks on one branch, no PR split. ✓
- Skip-failed-turns parity → Task 3 (`skip_errors`) + Task 4 (errored responses carry `AgentResponseError`). ✓
- ORQ stays server-stateful → no task touches `backends/orq.py` logic (only its inherited shim disappears, covered by Task 9). ✓
- Derived transcript via `turns_to_messages` → Task 3 + Task 4. ✓
- `AgentResponseError` on `AgentResponse` → Task 1. ✓
- `ErrorInfo`→`RunError` → Task 2. ✓
- Attacker deferred (RES-883) → no task adds an attacker error field. ✓
- Detection off `respond` → Task 9. ✓
- Test rewrites for multi-turn `_history` → Tasks 4, 6, 7, 8. ✓
- CHANGELOG → Task 10. ✓

**Type/name consistency:** `AgentResponseError(message, error_type, code)`, `AgentResponse.error`, `turns_to_messages(turns, *, skip_errors=False)`, `RunError` are used identically across Tasks 1–10. `_RecordingTarget` implements `respond` + `new` (the two abstract methods after Task 9). ✓

**Ordering note:** Tasks 6–8 drop the stateful overrides while the ABC `send_prompt` shim still exists (removed in Task 9). After a target loses its override but before Task 9, the inherited shim would route `send_prompt` → stateless `respond`; this is why each of Tasks 6–8 deletes that target's multi-turn `_history` tests in the same commit rather than leaving them to fail against the shim. The orchestrator (Task 4) already drives `respond` directly, so production multi-turn behavior is correct from Task 4 onward.
