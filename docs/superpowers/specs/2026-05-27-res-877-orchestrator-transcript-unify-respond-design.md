# RES-877 — Orchestrator-owned transcript; collapse to a single `respond` path

**Ticket:** [RES-877](https://linear.app/orqai/issue/RES-877) (RES-808 PR4)
**Date:** 2026-05-27
**Status:** Design — awaiting review

## Goal

Eliminate the stateful/stateless target split introduced transitionally in RES-808 PR3.
Make `AgentTarget.respond(messages: list[Message]) -> AgentResponse` the **single**
response method. Conversation memory moves out of the targets and into the only
multi-turn caller — the redteam orchestrator. `send_prompt` is removed entirely.

## Background

After RES-808 PR3, two response interfaces coexist with divergent state semantics:

- `respond(messages)` — stateless; caller owns the transcript. Canonical.
- `send_prompt(prompt)` — single-prompt shim on the `AgentTarget` ABC, **overridden
  statefully** by `OpenAIModelTarget`, `VercelAISdkTarget`, and `OpenAIAgentTarget`,
  which accumulate `self._history` across turns.

This dual model is exactly what RES-808 set out to remove. The stateful overrides
exist only because the redteam orchestrator calls the target once per turn with a
single prompt and relies on the target to remember prior turns. Move that memory into
the orchestrator and the overrides become dead weight.

### Caller inventory (the reason the split can collapse)

`send_prompt` has exactly four `src/` call sites, and **only one is multi-turn**:

| Call site | Turns | Migration |
|---|---|---|
| `redteam/adaptive/orchestrator.py:658` | **multi-turn** | accumulate transcript, pass to `respond` |
| `redteam/adaptive/pipeline.py:372` | single (`turn: 1`) | `respond([Message(role="user", content=prompt)])` |
| `redteam/runner.py:716` | single (static job) | `respond([Message(role="user", content=prompt)])` |
| `redteam/runner.py:1419` | single (static job) | `respond([Message(role="user", content=prompt)])` |

Because only the orchestrator is multi-turn, only it needs to own a transcript.

## Decisions (locked during brainstorming)

1. **Remove `send_prompt` entirely** — from the `AgentTarget` ABC, all overrides, all
   callers, and all tests. `respond` is the sole response method. Public-API breaking
   change (CHANGELOG mandatory).
2. **Single PR.** Not split, despite the large test-migration surface (~25 files,
   ~150 call sites). Accept one large diff over multiple rebases.
3. **Skip failed turns (transcript parity).** Errored target turns never enter the
   transcript handed back to the target — matching today's `_history`, which appends
   only after a successful response (`openai.py:155`).
4. **ORQ stays server-stateful.** `ORQAgentTarget` already implements `respond`,
   forwards only `messages[-1]`, and threads server-side via `task_id`. It has no
   `_history` to drop. `respond(messages)` legitimately has two valid interpretations
   (client-transcript vs. server-stateful); both honor the contract.
5. **Transcript is derived, not a separate list.** The target transcript is the
   success-only projection of the existing `turns_record`, produced by a shared
   `turns_to_messages(turns, *, skip_errors=True)` function — not a parallel
   hand-maintained list. (See "Why derived" below.)
6. **Per-response error marker on `AgentResponse`**, not on `Turn`. New
   `AgentResponseError` type. Run-level `ErrorInfo` renamed to `RunError`.
7. **Attacker side unchanged.** Attacker (adversarial LLM) errors are terminal
   (`break`, no `Turn` recorded) and captured at run level by `RunError`; no
   per-response error field is added to `AttackerResponse`. Unifying the attacker onto
   `AgentResponse` is deferred to [RES-883](https://linear.app/orqai/issue/RES-883).

### Why derived (not a separate `target_transcript` list)

`OrchestratorResult.chat_completions` (`redteam/contracts.py:766`) already converts
`list[Turn] -> list[Message]`, handling text runs, assistant `tool_calls`, tool
results, and empty-output turns. A naive separate transcript built from
`Message(role="assistant", content=resp.text)` would **drop `tool_calls`** (`.text`
only joins `TextOutputItem`s) — a fidelity regression versus today's `_history`,
which preserves assistant `tool_calls` (`openai.py:139-152`). Reusing the existing
walk avoids that, removes duplicate state, and keeps a single source of truth.

The only gaps to close: (a) the walk lives on the assembled `OrchestratorResult`, but
the orchestrator needs it mid-loop on a bare `list[Turn]`; (b) it has no error filter.
Both solved by extracting a free function and adding an explicit error marker.

## Architecture

### Data flow — orchestrator turn loop

```python
attack_prompt = <adversarial LLM output for this turn>
transcript = turns_to_messages(turns_record, skip_errors=True)
resp = await target.respond([*transcript, Message(role="user", content=attack_prompt)])
# on success: append Turn(attacker=current_attacker, target=resp) to turns_record
# on error:   append Turn with target carrying AgentResponseError; loop continues or aborts
```

The transcript is rebuilt each turn from `turns_record`. `turns_record` is unchanged in
shape and still records every turn (including errors) for the report; the `skip_errors`
filter is applied **only** when projecting the target's view.

### Three message lists, clearly separated

| List | Owner | Includes errors? | Purpose |
|---|---|---|---|
| `adversarial_messages` | attacker LLM | n/a (terminal) | attacker's view (xml-escaped) — unchanged |
| `turns_record` | orchestrator | yes | canonical report log — unchanged |
| transcript (derived) | `turns_to_messages(skip_errors=True)` | no | target's view, drives `respond` |

### Two valid `respond(messages)` interpretations

- **Client-transcript** (`OpenAIModelTarget`, `VercelAISdkTarget`, `OpenAIAgentTarget`):
  consume the full list, prepend own system prompt, reply. Stateless.
- **Server-stateful** (`ORQAgentTarget`): take `messages[-1]`, thread via `task_id`.
  Ignores the rest. Unchanged. Safe because the orchestrator reuses one target
  instance per conversation (`run_attack(target, ...)`), and the transcript's last
  message is always `user` at call time (the last-user guard never trips).

## Components / file-by-file

### `src/evaluatorq/contracts.py` (shared)

- Add `AgentResponseError(BaseModel, frozen=True)`:
  ```python
  class AgentResponseError(BaseModel):
      model_config = ConfigDict(frozen=True)
      message: str
      error_type: str          # "timeout" | "exception" | "content_filter" | ...
      code: str | None = None  # optional provider/mapped code
  ```
- `AgentResponse`: add `error: AgentResponseError | None = None` (`None` = ok).
  `.text` is unchanged — for synthetic error responses it still returns the
  `[ERROR: ...]` text so the report is unaffected.
- `AgentTarget`: remove the `send_prompt` concrete shim. `respond` is the sole abstract
  response method, alongside `new` (abstract) and the concrete defaults
  `get_agent_context` / `cleanup_memory` / `map_error`.

### `src/evaluatorq/redteam/contracts.py`

- Rename `ErrorInfo` -> `RunError` (class, both `error_info` properties at :853 and
  :1059, the `redteam/__init__.py` import + `__all__` entry).
- Add module-level pure function:
  ```python
  def turns_to_messages(turns: list[Turn], *, skip_errors: bool = False) -> list[Message]:
      ...
  ```
  Extracted verbatim from `chat_completions`'s per-turn walk; when `skip_errors`,
  skip any turn where `turn.target.error is not None`.
- `OrchestratorResult.chat_completions` -> `return turns_to_messages(self.turns)`
  (default `skip_errors=False` — the report shows everything).

### `src/evaluatorq/redteam/adaptive/orchestrator.py`

- Turn loop (:658): build the transcript via `turns_to_messages(turns_record,
  skip_errors=True)` and call `target.respond([*transcript, Message(role="user",
  content=attack_prompt)])`.
- Error/abort paths (:675 timeout, :705 exception, :693 / :727 aborts, and the
  recovered-error fallthrough at :740): build the synthetic target `AgentResponse` with
  `error=AgentResponseError(...)` set, instead of bare `[ERROR: ...]` text. `.text`
  still carries the message.

### `src/evaluatorq/redteam/adaptive/pipeline.py:372`, `runner.py:716`, `runner.py:1419`

- Single-shot: `await target.respond([Message(role="user", content=prompt)])`.

### `src/evaluatorq/redteam/backends/openai.py`, `integrations/vercel_ai_sdk_integration/target.py`, `integrations/openai_agents_integration/target.py`

- Delete the stateful `send_prompt` override and `self._history`. Keep only `respond`.
  (For `OpenAIAgentTarget`, the shared `_build_response` helper stays; the stateful
  send path is removed.)

### `src/evaluatorq/redteam/backends/base.py`

- `validate_agent_target` and `_coerce_to_agent_response`: drop `send_prompt`
  references; key target detection off `respond`. Keep `_coerce_to_agent_response`
  only if a caller still feeds it a raw value — confirm by grep during impl; otherwise
  remove it.

### `src/evaluatorq/redteam/backends/orq.py`, `integrations/callable_integration/target.py`, `integrations/langgraph_integration/target.py`

- Already `respond`-based; no logic change. The inherited `send_prompt` shim simply
  disappears with the ABC change.

## Error handling

### Synthetic error responses

At each target-error site the orchestrator builds an `AgentResponse` whose `.text`
holds the human `[ERROR: ...]` message (report parity) **and** whose `error` field is
set:

- timeout (orchestrator :675, pipeline :383): `error_type="timeout"`.
- exception (orchestrator :705): `error_type` + `code` from `self._backend.map_error(e)`.
- abort appends (:693 / :727): the same error response as the turn that tripped them.

### Filter invariant

`turns_to_messages(skip_errors=True)` excludes any turn where
`turn.target.error is not None`. This reproduces today's parity bar: errored turns
never enter the target's view. The filter's real job is the **recovered single target
error** case (loop continues, errored turn sits in `turns_record`, must be dropped from
the next `respond` call). The abort case is filter-moot (no subsequent call); the
attacker-error case is filter-irrelevant (no `Turn` is ever recorded).

### Attacker / pipeline errors

Unchanged. The adversarial-LLM failure paths (`orchestrator.py:540-616`) `break`
before any `turns_record.append`, so no `Turn` exists. These remain captured at run
level by `RunError`. No `AgentResponseError` involved.

### No new swallowing

Removing `send_prompt` removes the string-return path that
`_coerce_to_agent_response` existed to wrap. Targets already return `AgentResponse`.
Do not introduce any new fallback that hides a target failure.

## Testing

### Rewrites (premise removed by the change)

- `test_send_prompt_multi_turn` and per-target `_history` threading tests
  (`test_openai_model_target.py`, vercel/openai-agents equivalents) -> orchestrator-level
  tests: a mock target records the `messages` argument of each `respond` call; assert
  the transcript grows `[user, assistant, user, assistant, ...]` across turns,
  **carries assistant `tool_calls`**, and **skips errored turns**.
- `test_backend_send_prompt_with_usage.py` (~30 calls) and the `send_prompt` cases in
  `test_orchestrator.py` -> `respond([Message(role="user", content=...)])`.

### New tests

- `turns_to_messages`: empty input; single turn; tool_calls preserved; tool results
  emitted; `skip_errors` drops an errored turn; multi-turn alternation.
- `AgentResponse.error`: round-trips; `.text` still returns the message; `error=None`
  default; `skip_errors` filter keys off it.
- `RunError` rename: import/export smoke test.
- Regression guard: a multi-turn target sees prior assistant `tool_calls` in its
  transcript (guards the lossy `.text`-only reimplementation we explicitly rejected).

### Detection

- `validate_agent_target` / `is_agent_target` tests switch from `send_prompt`-based to
  `respond`-based capability checks.

### Verification

- `uv run pytest -m 'not integration'`
- `uv run ruff check src`
- `uv run basedpyright`
- All test timeouts ≤ 2 minutes.

## Non-goals

- Multi-modal `Message.content` (RES-876).
- Simulation runner changes — sim already calls `runner.target_agent.respond(messages)`.
- Unifying `AttackerResponse` onto `AgentResponse` (RES-883).
- Transcript windowing / summarization for long runs (token-cost concern; separate).

## Risks

- **External callers of `target.send_prompt(str)`** break. Mandatory CHANGELOG entry.
- **Large test diff** (~150 call sites) in a single PR — long red-to-green window.
  Mitigation: migrate per-file, keep `turns_to_messages` + `AgentResponseError` landed
  first so target/orchestrator edits compile against them.
- **Token cost** grows linearly with turn count (full transcript every turn). Already
  true with `_history`; not a regression. Windowing deferred.
- **`chat_completions` refactor** must be behavior-preserving for the report
  (`skip_errors=False` path) — covered by existing report tests plus the new
  `turns_to_messages` unit tests.
