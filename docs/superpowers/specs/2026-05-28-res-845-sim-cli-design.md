# RES-845 — Agent Simulation CLI Design

**Ticket:** [RES-845](https://linear.app/orqai/issue/RES-845/add-cli-for-agent-simulation-parity-with-evaluatorq-redteam)
**Branch:** `bauke/res-845-add-cli-for-agent-simulation-parity-with-evaluatorq-redteam`
**Blocked by:** RES-808 (target protocol — merged), RES-847 (hooks lifecycle — not yet merged)
**Blocks:** RES-846 (report flags wire through CLI)
**Date:** 2026-05-28

---

## Goal

Ship `evaluatorq.simulation.cli` — Typer app exposing the simulation library through `eq sim` subcommands. Approximate the surface and ergonomics of `evaluatorq redteam` CLI (`packages/evaluatorq-py/src/evaluatorq/redteam/cli.py`) where the patterns transfer cleanly; diverge where simulation semantics differ.

## Non-Goals (Parity Honesty)

We claim *structural* parity (subcommand layout, run-store pattern, verbosity flags, exit codes), not *flag-for-flag* parity. Concretely:

- `validate-dataset` semantics differ — sim datasets are JSONL of `Datapoint`, redteam is dict-of-samples. Documented.
- No `ui` subcommand (no sim Streamlit viewer exists).
- No `--upload` flag — sim→Orq dataset upload is out of scope, tracked as a separate follow-up ticket (see Out of Scope).
- No HF dataset download path.

## Architecture

Single Typer app mounted as a subcommand on top-level `evaluatorq.cli` (`eq sim ...`). Also runnable standalone (`python -m evaluatorq.simulation.cli`). Each command body is a thin async-to-sync wrapper:

```python
@app.command()
def run(...): asyncio.run(_run_impl(...))
```

`_run_impl` does the actual orchestration. Keeps Typer signatures clean and lets us test the async core directly when useful.

## Entry Point

- Module: `src/evaluatorq/simulation/cli.py`
- Object: `app = typer.Typer(name="sim", help="Agent simulation CLI")`
- Mounted in `src/evaluatorq/cli.py` via `app.add_typer(sim_app, name="sim")` (pre-flight verify that `evaluatorq.cli` exposes a Typer object — if not, scope a small adapter in this ticket).
- Standalone: `if __name__ == "__main__": app()` in `cli.py`

## Subcommands

Three symmetric execution verbs mirror the SDK: `generate` (datapoints only), `simulate` (run pre-built datapoints), `run` (generate then simulate in one shot). `generate` contacts no agent target — it only calls the `--sim-model` generator; `simulate`/`run` require exactly one target flag.

`run` is a convenience wrapper over `generate_and_simulate` — it generates datapoints in-process and simulates them under a single `orq.simulation.pipeline` span. It is **not** a literal `generate` + `simulate` composition (no intermediate file, one span, datapoints not surfaced by default). To capture the exact generated inputs for reproducible re-runs, pass `run --save-datapoints PATH`, which writes the datapoints (raw `Datapoint` JSONL) that simulation consumed; that file re-feeds `simulate --datapoints`.

| Command | Maps to | Required | Output |
|---|---|---|---|
| `generate` | `generate(agent_description=..., sim_model=..., ...) -> list[Datapoint]` | `--agent-description` + `--output` | datapoints JSONL via `export_datapoints_to_jsonl` (no simulation, no run-store) |
| `simulate` | `simulate(datapoints=load_datapoints_from_jsonl(path), target=..., ...)` | `--datapoints <path.jsonl>` + one target flag | results JSONL via `export_results_to_jsonl` + auto-save run JSON |
| `run` | `generate_and_simulate(agent_description=..., target=..., ...)` | `--agent-description` + one target flag | same as `simulate` |
| `export` | per-result `to_open_responses(result)` over `parse_jsonl(Path(input).read_text(), cls=SimulationResult)` | `--input <results.jsonl>` | OpenResponses payload JSON (list of per-result payloads) |
| `validate-dataset` | `parse_jsonl(Path(path).read_text(), cls=Datapoint)` | positional `<path.jsonl>` | exit 0 / 1 + count |
| `runs` | filesystem scan of `.evaluatorq/sim-runs/` | optional positional `<dir>`, `--limit/-n` | Rich table |

### Signature notes (verified against source)

- `parse_jsonl(content: str, cls: type[T] | None = None)` — `dataset_export.py:128`. Takes **string content**, not a path. CLI must `Path(...).read_text(encoding="utf-8")` first.
- `to_open_responses(result: SimulationResult, model: str = "simulation")` — `convert.py:17`. **Single result**, not a list. CLI iterates.
- `load_datapoints_from_jsonl(input_path: str)` — `dataset_export.py:59`. Path-based (string), do *not* read first.
- `export_results_to_jsonl(results: list[SimulationResult], output_path: str)` — `dataset_export.py:46`.

## Target Resolution

Three mutually exclusive flag group, validated at command entry. Exactly one required for `simulate` and `run` (the verbs that contact an agent). `generate` takes no target — it only generates datapoints. Raises `typer.BadParameter` when zero or >1 supplied.

| Flag | Resolves to |
|---|---|
| `--agent-key TEXT` | `from_orq_deployment(key)` (Orq deployment via sim adapter) |
| `--vercel-url TEXT` | `VercelAISdkTarget(url)` |
| `--openai-model TEXT` | `OpenAIModelTarget(model=name)` (honours `OPENAI_BASE_URL` env for OpenAI-compatible HTTP endpoints) |

`--target-url` is **deliberately dropped**. `from_chat_completions` takes a callable, not a URL; bridging URL→callable would invent a sim-specific HTTP client when `--openai-model` already covers OpenAI-compatible HTTP via standard SDK env vars.

`OpenAIModelTarget` lives in `evaluatorq.redteam.backends.openai`. Sim importing from `redteam.backends` is a known layering smell — accepted as transitional debt; tracked as follow-up to move shared targets to `evaluatorq.backends` or `evaluatorq.targets`. Out of scope for this ticket.

Resolver `_resolve_target(*, agent_key, vercel_url, openai_model) -> AgentTarget` lives in `cli.py` (no helper module split — see "File Layout").

## Common Flags

| Flag | Commands | Maps to | Notes |
|---|---|---|---|
| `--sim-model TEXT` | generate, simulate, run | `sim_model=` | default = `DEFAULT_MODEL`; drives generation + user-sim/judge |
| `--max-turns INT` | simulate, run | `max_turns=` | default 10 (api default) |
| `--parallelism INT` | simulate, run | `parallelism=` | default 5 |
| `--evaluator TEXT` (repeatable) | simulate, run | `evaluator_names=...` | **flag absent → pass `None` (api uses defaults); flag present → pass the list** |
| `--output PATH` | generate, simulate, run, export | datapoints/results JSONL destination | required for `generate`/`export`; optional for `simulate`/`run` |
| `--num-personas INT` | generate, run | `num_personas=` | default 5 |
| `--num-scenarios INT` | generate, run | `num_scenarios=` | default 5 |
| `--save-datapoints PATH` | run | `emit_datapoints=` callback → `_write_datapoints` | optional; persists the generated datapoints (raw `Datapoint` JSONL) that simulation consumed, for reproducible re-runs via `simulate --datapoints` |
| `--name TEXT` | simulate, run | run name for auto-save filename | sanitised (see Run Store) |
| `--no-save` | simulate, run | skip `.evaluatorq/sim-runs/` write | |
| `-v / --verbose` | global | log level DEBUG | mirrors redteam |
| `-q / --quiet` | global | log level WARNING | mirrors redteam |
| `-y / --yes` | simulate, run | skip confirmation prompts (currently none, kept for forward compat) | mirrors redteam |

### Unknown evaluator name

`get_evaluator(name)` raises `ValueError` on unknown name (`scorers.py:101`). CLI catches at resolution time (after Typer parsing, before `simulate`) and re-raises as `typer.BadParameter(f"Unknown evaluator: {name}. Known: {list(SIMULATION_EVALUATORS)}")`. No ugly tracebacks for typos.

## Run Store

Path: `.evaluatorq/sim-runs/<sanitised_name>_<YYYYMMDD-HHMMSS>.json`. Distinct dir from redteam (`.evaluatorq/runs/`); a future ticket can unify under `.evaluatorq/runs/{redteam,sim}/` if/when worth it.

**Name sanitisation**: lower-case, replace non-`[a-z0-9_-]` with `_`, collapse runs of `_`, truncate to 64 chars. If `--name` omitted, default `sim`. Helper: `_sanitise_run_name(name: str) -> str`.

**Collision handling**: if target path exists (second run in same second), append `_001`, `_002` … to filename until free.

**Payload**: a Pydantic model in `evaluatorq.simulation.types` (new):

```python
class SimulationRun(BaseModel):
    run_name: str
    created_at: datetime
    mode: Literal["run", "simulate", "generate"]  # "generate" is a tolerated legacy value (old run-store files predating the verb rename)
    target_kind: Literal["orq_deployment", "vercel", "openai_model"]
    evaluator_names: list[str]
    total_results: int
    scorer_averages: dict[str, float]  # mean per scorer over results that report it
    results: list[SimulationResult]
```

**`scorer_averages` source**: each `SimulationResult` carries per-evaluator scores at `result.metadata["evaluator_scores"]` (dict `{scorer_name: float}`). Aggregation: for each scorer name observed across any result, take mean over results where it appears. Results missing a scorer are excluded from that scorer's mean (not zero-filled). When no results carry scores, emit `{}`.

`runs` cmd: scan dir, `sorted(... key=mtime, reverse=True)[:limit]`, Rich table (Name / Date / Mode / Target / N / mean scorer summary / File). Falls back to plain `typer.echo` when `rich` import fails (same pattern as redteam `runs`, `cli.py:611-692`). Malformed files are skipped and counted; warning printed at end (same pattern as redteam `runs`).

## Hooks Integration

CLI imports `RichHooks` from `evaluatorq.simulation.hooks` (lands in RES-847) for `simulate` and `run` progress. **Until RES-847 merges**, CLI uses a `_progress_callback` that prints one line per completed result via `typer.echo`. The swap to `RichHooks()` is a one-line change documented in the file. We do **not** commit a stub `RichHooks` import in this ticket; we import the symbol only when RES-847 lands, to avoid coupling on a not-yet-finalised constructor signature.

## Async Wrapping

Each command body is sync Typer + `asyncio.run(impl(...))`:

```python
@app.command(no_args_is_help=True)
def run(...) -> None:
    asyncio.run(_run_impl(...))
```

The API funcs (`simulate`, `generate_and_simulate`) handle their own tracing init/flush internally. No additional event-loop management in the CLI.

## Error Handling and Exit Codes

Mirrors redteam (`cli.py:365-376`):

| Condition | Exit code | Surface |
|---|---|---|
| Success | 0 | normal |
| `KeyboardInterrupt` / `CancelledError` | 130 | `^C aborted` to stderr |
| `typer.BadParameter` (target flags, unknown evaluator, missing files) | 2 | Typer renders red message |
| `ValueError` from sim API (missing `ORQ_API_KEY` etc.) | 1 | one-line stderr + remediation hint |
| `validate-dataset` invalid lines | 1 | count of bad lines to stderr, parse errors to stdout |
| Other exceptions | 1 | propagate (let Typer render); in `-v` mode include traceback, else one-line |

Specific cases:

- Missing `ORQ_API_KEY` when `--agent-key` used → `typer.BadParameter` pre-flight check
- Missing `OPENAI_API_KEY` when `--openai-model` used (and no `client=` injected) → `typer.BadParameter` pre-flight
- `--datapoints` file not found / unreadable → `typer.BadParameter`
- Run-store JSON file malformed during `runs` scan → skip + count, never crash

## Testing

`tests/simulation/test_cli.py` — uses `typer.testing.CliRunner`. Strategy is **black-box** behaviour over **per-flag mock-roundtrip**: most tests run the full command against a fake target (in-process callable). Where we genuinely need to assert flag → kwarg mapping (e.g. `--max-turns`), we patch `evaluatorq.simulation.cli._run_impl` (the inner async function the cmd dispatches into) and capture kwargs. **Important**: tests patch the cli-side wrapper, not `evaluatorq.simulation.api.simulate` — that decouples the test from how the cli imports the API.

| Group | Tests |
|---|---|
| `simulate` happy path | datapoints + `--openai-model` end-to-end with fake target; assert results JSONL written; assert run JSON saved |
| `simulate` no-save | `--no-save` skips run-store write |
| `simulate` target flags | one passing test per target flag (3); zero-target errors; two-target errors; three-target errors |
| `run` happy path | `--agent-description` + 2 personas + 2 scenarios + fake target; covers ticket acceptance (generate + simulate) |
| `run` no-save | as above |
| `generate` (gen-only) | `--agent-description` + `--output` writes datapoints JSONL; no target contacted; `--output` required; gen flags forwarded |
| Flag-forwarding (kwarg capture) | `--sim-model`, `--max-turns`, `--parallelism`, `--evaluator` (single + repeated + absent), `--num-personas`, `--num-scenarios`, `--name` — patch `_simulate_impl`/`_run_impl`, assert kwargs |
| `--evaluator` semantics | absent → None forwarded; `--evaluator goal_achieved` → `["goal_achieved"]` forwarded; unknown name → `BadParameter` |
| `export` | round-trip: 2-result JSONL → payload list of length 2; structural assertion on first payload |
| `export` error | unreadable input → `BadParameter` |
| `validate-dataset` | valid file → exit 0; malformed JSON line → exit 1 + count; schema mismatch → exit 1 |
| `runs` | empty dir → 0 + message; missing dir → 0 + message; 2 valid files → sorted by mtime; 1 valid + 1 malformed → table + warning count |
| Run-store | `scorer_averages` aggregation over results with mixed evaluator presence (results with/without `evaluator_scores`); empty results → `{}` |
| Filename | `--name "weird / name"` sanitised; collision in same second → `_001` suffix |
| Smoke (integration-marked) | full `run` (generate + simulate) with mocked `ORQ_API_KEY` env + fake target callable |

Smoke test sets `ORQ_API_KEY` via `monkeypatch.setenv` and patches the persona/scenario generator HTTP clients to return canned responses, so no real network.

Estimated total: ~25 tests.

## File Layout

```
src/evaluatorq/simulation/
└── cli.py    # Typer app + 5 commands + _resolve_target/_auto_save_run/_scan_run_dir/_sanitise_run_name
```

Helpers stay inline (mirror redteam `cli.py`). Target ~450-550 LOC, comparable to redteam after excluding HF download and report writers.

Mount in `src/evaluatorq/cli.py`:

```python
from evaluatorq.simulation.cli import app as sim_app
app.add_typer(sim_app, name="sim")
```

`pyproject.toml` — no new console_script; `eq` entry already exists.

`SimulationRun` model added to `src/evaluatorq/simulation/types.py` and exported through `simulation.__init__` lazy registry.

## Reuse, Not Invent

- `simulate`, `generate_and_simulate` — `evaluatorq.simulation.api`
- `load_datapoints_from_jsonl`, `export_results_to_jsonl`, `parse_jsonl` — `evaluatorq.simulation.utils.dataset_export`
- `to_open_responses` — `evaluatorq.simulation.convert`
- `from_orq_deployment` — `evaluatorq.simulation.adapters`
- `OpenAIModelTarget` — `evaluatorq.redteam.backends.openai` (layering smell, see Target Resolution)
- `VercelAISdkTarget` — `evaluatorq.integrations.vercel_ai_sdk_integration`
- `get_evaluator`, `get_all_evaluators`, `SIMULATION_EVALUATORS` — `evaluatorq.simulation.evaluators.scorers`
- Run-store filesystem pattern — mirrored from `evaluatorq.redteam.runner.get_runs_dir`
- `runs` Rich table + plain fallback — mirrored from `redteam.cli:runs` (lines 580–692)
- Exit-code map — mirrored from `redteam.cli` exception handlers (lines 365–376)

## Out of Scope (Follow-up Tickets)

- **Streamlit UI** for sim — no viewer exists
- **`--upload`** to Orq dataset (sim→datapoints) — file follow-up "Add sim→Orq dataset upload, parity with redteam `_upload_results_to_orq`"
- **HTML/Markdown report writers** — RES-846
- **Shared target layer** (`evaluatorq.targets` move for `OpenAIModelTarget`, `VercelAISdkTarget`) — file follow-up "De-couple sim/redteam target imports"
- **HF dataset download** path
- **`--target-url`** generic HTTP shape — users use `--openai-model` + `OPENAI_BASE_URL` env

## Acceptance

- `eq sim --help` lists `run`, `generate`, `export`, `validate-dataset`, `runs`
- `eq sim generate --agent-description "..." --num-personas 2 --num-scenarios 2 --openai-model gpt-4o-mini` runs end-to-end
- `eq sim run --datapoints fixture.jsonl --agent-key <key>` runs end-to-end
- `eq sim export --input results.jsonl --output payload.json` produces valid OpenResponses payload list
- `eq sim validate-dataset fixture.jsonl` exits 0 on valid, 1 on invalid
- `eq sim runs` shows table of `.evaluatorq/sim-runs/*.json`
- Mutually-exclusive target flag enforcement (zero/two/three errors with clear message)
- `--evaluator unknown` rejected with `BadParameter` before `simulate` runs
- Exit codes: 0/2/130/1 per error-handling table
- `tests/simulation/test_cli.py` per above strategy (~25 tests)
- `uv run ruff check src` and `uv run basedpyright` clean
