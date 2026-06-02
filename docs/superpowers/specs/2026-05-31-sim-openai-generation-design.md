# OpenAI-capable simulation generation — design

**Date:** 2026-05-31
**Status:** Approved (brainstorm)
**Scope:** `packages/evaluatorq-py` — `evaluatorq.simulation`

## Problem

The simulation half (judge, user-simulator) already runs OpenAI-only: their
client comes from `build_simulation_client` (`_client.py`), which resolves an
injected client → `ORQ_API_KEY` (Orq router) → `OPENAI_API_KEY` (+ auto
`OPENAI_BASE_URL`) → error.

The generation half does **not**. The four generators (`persona`, `scenario`,
`first_message`, `datapoint`) each carry a private default-client block that
only honors `ORQ_API_KEY`. The high-level `generate_and_simulate()` and the
`simulate()` first-message branch go further: they call
`_require_orq_api_key(...)` and hardcode an Orq-router `AsyncOpenAI`. Result:
`eq sim generate` (and SDK `generate_and_simulate`) are Orq-locked even though
the rest of a run can be fully OpenAI. A user with only `OPENAI_API_KEY` cannot
generate datapoints.

## Goal

Make generation resolve its provider the same way the simulation loop already
does, and let SDK callers inject their own client. No new provider concepts —
reuse the one existing factory.

## Decisions (locked in brainstorm)

1. **Scope B**: env fallback **and** explicit SDK client injection.
2. **No coupling** between `--openai-model` (target) and the generation model —
   they stay orthogonal.
3. **Provider resolution = option A (no name munging).** The model string is
   passed through verbatim. `openai/gpt-5.4-mini` works on the Orq router;
   OpenAI-direct users pass a bare name. `OPENAI_BASE_URL` is honored
   automatically by the OpenAI SDK when `base_url is None`.
4. **CLI flag rename** `--model` → `--sim-model` on **both** `run` and
   `generate`. The param drives the user-simulator, the judge, and (in
   `generate` only) the persona/scenario/first-message generators — i.e.
   "the model for everything except the target under test". `run` loads
   datapoints from JSONL so it does no generation, but still needs the model
   for its live user-simulator + judge calls — hence a neutral name on both.
5. **SDK param rename** `model` → `sim_model` on the two public entry
   functions (`simulate`, `generate_and_simulate`) only, matching the CLI flag.
   Hard rename (sole internal caller is the CLI). Internal helpers / generators
   / agents / runner keep their generic `model` param.
6. **Default model** `DEFAULT_MODEL`: `azure/gpt-4o-mini` → `openai/gpt-5.4-mini`.

## Changes

### A. Generators — route default client through the shared factory
Files: `generators/{persona,scenario,first_message,datapoint}_generator.py`

Replace each private fallback block:
```python
if client is not None:
    self._client = client
else:
    resolved_key = api_key or os.environ.get("ORQ_API_KEY")
    if not resolved_key:
        raise ValueError("ORQ_API_KEY environment variable is not set. ...")
    self._client = AsyncOpenAI(base_url=f"{ORQ_BASE_URL}/v2/router", api_key=resolved_key)
```
with:
```python
from evaluatorq.simulation._client import build_simulation_client
self._client, self._client_owned = build_simulation_client(client, extra_api_key=api_key)
```
- Keeps `client=` and `api_key=` params (back-compat).
- `api_key` is passed as `extra_api_key` (treated as an Orq key by the factory —
  preserves the prior `api_key=` ORQ-router semantics).
- Gains `OPENAI_API_KEY` + `OPENAI_BASE_URL` support for free.
- Track ownership so an injected client is not closed by the generator (the
  factory already returns `owned=False` for injected clients). If a generator
  currently always closes its client, gate the close on `self._client_owned`.

### B. `api.py` — drop the hard Orq gate on generation
File: `simulation/api.py`

- `generate_and_simulate`: remove `_require_orq_api_key("generate_and_simulate")`
  and the hardcoded `shared_client = AsyncOpenAI(base_url=.../v2/router)`.
  Build the generation client via
  `build_simulation_client(generation_client)` and pass it to
  `PersonaGenerator(client=...)` / `ScenarioGenerator(client=...)`.
- `simulate` first-message branch (the `_resolve_or_generate_datapoints` path):
  same treatment — build via `build_simulation_client(generation_client)`,
  pass to `FirstMessageGenerator(client=...)`. Remove the `_require_orq_api_key`
  call on this branch.
- `_require_orq_api_key` may remain if still used elsewhere; otherwise delete.
  (It is **not** used for the upload gate — that lives in `evaluatorq.py:309`
  and stays untouched.)
- Client ownership: when `api.py` builds the client (no injection), it owns it
  and must close it in a `finally`, as today. When `generation_client` is
  injected, `build_simulation_client` returns `owned=False` → do not close.

### C. SDK injection + param rename
File: `simulation/api.py`

- Add `generation_client: AsyncOpenAI | None = None` to `simulate()` and
  `generate_and_simulate()`, threaded to the generators.
- Rename `model: str = DEFAULT_MODEL` → `sim_model: str = DEFAULT_MODEL`
  on both functions. Update `_simulate_core` / `_simulate_via_evaluatorq`
  internal call wiring (internal helpers keep `model=`; only the public param
  name changes — at the boundary pass `model=sim_model`).
- Docstrings: state the provider-resolution order and that `sim_model`
  drives the user-simulator, the judge, and the generators.

### D. CLI
File: `simulation/cli.py`

- `run` + `generate`: rename option `--model` → `--sim-model`
  (Python param `sim_model`). Help text:
  > "Model for the user-simulator, the judge, and (with `generate`) persona/
  > scenario/first-message generation. Provider resolved from env: ORQ_API_KEY →
  > Orq router, else OPENAI_API_KEY (+ OPENAI_BASE_URL) → OpenAI-compatible
  > endpoint."
- Pass `sim_model=sim_model` to `simulate()` / `generate_and_simulate()`.
- No client-injection flag (SDK-only). No coupling to `--openai-model`.

### E. Default model
File: `simulation/types.py`

- `DEFAULT_MODEL = "openai/gpt-5.4-mini"`.

## Data flow (generate, OpenAI-only)

```
eq sim generate --openai-model gpt-5.4-mini --sim-model gpt-5.4-mini
  (env: OPENAI_API_KEY=sk-..., optional OPENAI_BASE_URL)
    → cli.generate → generate_and_simulate(sim_model="gpt-5.4-mini", target=<openai>)
        → build_simulation_client(None) → OPENAI_API_KEY branch → AsyncOpenAI(base_url=None→OPENAI_BASE_URL)
        → PersonaGenerator(client) / ScenarioGenerator(client)
        → _simulate_core → user-sim + judge via build_simulation_client (same env)
        → evaluatorq(): _send_results gated on ORQ_API_KEY (absent → no upload, run completes)
```

## Error handling

- No provider resolvable (no injected client, no `ORQ_API_KEY`, no
  `OPENAI_API_KEY`): `build_simulation_client` raises
  `ValueError("No API key found. Set ORQ_API_KEY or OPENAI_API_KEY, or pass a
  pre-built client.")`. Generation no longer fails specifically on missing ORQ.
- Model-name / provider mismatch (e.g. prefixed name to api.openai.com) surfaces
  as the provider's call-time error — not pre-validated (option A).

## Testing

`tests/simulation/`:
- **Generator client resolution** (per generator or one representative + shared
  helper test):
  - only `OPENAI_API_KEY` set → default client `base_url` resolves to OpenAI
    (None/`OPENAI_BASE_URL`), not the Orq router.
  - both keys set → Orq router wins (`base_url` ends `/v2/router`).
  - injected `client=` → used as-is, not closed by the generator.
- **`generate_and_simulate`**: with `generation_client=<mock>` and no
  `ORQ_API_KEY` → runs without raising (no `_require_orq_api_key`).
- **`simulate`** first-message branch: same, with `generation_client` injected.
- **CLI**: `--sim-model X` forwards to `sim_model=X` (kwarg capture) on both
  `run` and `generate`; `--model` is no longer accepted.
- **Regression**: existing ORQ-path generation tests stay green; upload gate
  unchanged.

## Non-goals

- No prefix stripping / model-name rewriting.
- No CLI flag for client injection.
- No change to the upload gate or `evaluatorq()` routing.
- No rename of internal `model` params (runner, agents, generators).
```
