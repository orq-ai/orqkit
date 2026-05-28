# RES-845 — Agent Simulation CLI Design

**Ticket:** [RES-845](https://linear.app/orqai/issue/RES-845/add-cli-for-agent-simulation-parity-with-evaluatorq-redteam)
**Branch:** `bauke/res-845-add-cli-for-agent-simulation-parity-with-evaluatorq-redteam`
**Blocked by:** RES-808 (target protocol), RES-847 (hooks)
**Blocks:** RES-846 (report flags wire through CLI)
**Date:** 2026-05-28

---

## Goal

Ship `evaluatorq.simulation.cli` — a Typer app exposing the simulation library through `eq sim` subcommands, at parity with `evaluatorq redteam` CLI (`packages/evaluatorq-py/src/evaluatorq/redteam/cli.py`, 692 LOC).

## Architecture

Single Typer app mounted as a subcommand on top-level `evaluatorq.cli` (`eq sim ...`). Also runnable standalone (`python -m evaluatorq.simulation.cli`). Command bodies thin — each maps to one existing high-level `evaluatorq.simulation` API function. A small `_cli_helpers.py` module owns target resolution, auto-save, and run-store scanning so commands stay focused on flag parsing and result formatting.

## Entry Point

- Module: `src/evaluatorq/simulation/cli.py`
- Object: `app = typer.Typer(name="sim", help=...)`
- Mounted in `evaluatorq.cli` via `app.add_typer(sim_app, name="sim")`
- Standalone: `python -m evaluatorq.simulation.cli`

## Subcommands

| Command | Maps to | Required | Output |
|---|---|---|---|
| `run` | `simulate(datapoints=load_datapoints_from_jsonl(...), target=..., ...)` | `--datapoints <path.jsonl>` + one target flag | results JSONL via `export_results_to_jsonl` + auto-save run JSON |
| `generate` | `generate_and_simulate(agent_description=..., ...)` | `--agent-description` + one target flag | same |
| `export` | `parse_jsonl(content, cls=SimulationResult)` + `to_open_responses(results)` | `--input <results.jsonl>` | OpenResponses payload JSON |
| `validate-dataset` | `parse_jsonl(content, cls=Datapoint)` | positional `<path.jsonl>` | exit 0 / non-zero + count |
| `runs` | filesystem scan of `.evaluatorq/sim-runs/` | optional positional `<dir>` | Rich table |

## Target Resolution

Mutually exclusive flag group, validated at command entry. Exactly one required for `run` and `generate`. Raises `typer.BadParameter` when zero or >1 supplied.

| Flag | Resolves to |
|---|---|
| `--agent-key TEXT` | `from_orq_deployment(key)` |
| `--target-url TEXT` | `from_chat_completions(url)` |
| `--vercel-url TEXT` | `VercelAISdkTarget(url)` |
| `--openai-model TEXT` | `OpenAIModelTarget(model=name)` |

Resolver: `_resolve_target(*, agent_key, target_url, vercel_url, openai_model) -> AgentTarget` in `_cli_helpers.py`.

## Common Flags

| Flag | Commands | Maps to |
|---|---|---|
| `--model TEXT` | run, generate | `model=` |
| `--max-turns INT` | run, generate | `max_turns=` |
| `--parallelism INT` | run, generate | `parallelism=` |
| `--evaluator TEXT` (repeatable) | run, generate | `evaluator_names=[...]` |
| `--output PATH` | run, generate, export | results JSONL / payload destination |
| `--num-personas INT` | generate | `num_personas=` |
| `--num-scenarios INT` | generate | `num_scenarios=` |
| `--name TEXT` | run, generate | run name for auto-save filename |
| `--no-save` | run, generate | skip `.evaluatorq/sim-runs/` write |
| `--upload` | run, generate | reserved hook for Orq dataset upload (no-op until RES-846 lands) |

## Run Store

Path: `.evaluatorq/sim-runs/<name>_<YYYYMMDD-HHMMSS>.json` (mirrors redteam `.evaluatorq/runs/`).

Auto-write on `run` / `generate` success unless `--no-save`. Payload shape:

```json
{
  "run_name": "...",
  "created_at": "2026-05-28T12:34:56Z",
  "mode": "run|generate",
  "target_kind": "agent_key|target_url|vercel_url|openai_model",
  "evaluator_names": ["..."],
  "total_results": 12,
  "scorer_averages": {"goal_achieved": 0.83, ...},
  "results": [SimulationResult, ...]
}
```

`runs` cmd: scan dir, `sorted(... key=mtime, reverse=True)[:limit]`, Rich table (Name / Date / Mode / Target / N / scorer / File). Falls back to plain `typer.echo` when `rich` import fails (same pattern as redteam).

## Hooks Integration

CLI imports `RichHooks` from `evaluatorq.simulation.hooks` (lands in RES-847) for `run` and `generate` progress. CLI ships skeleton-compatible: until RES-847 merges, `_progress_hook()` returns `None` and the cmd falls back to plain `typer.echo` per completed result. After RES-847 lands, swap to `RichHooks()` instance.

## Error Handling

- Missing `ORQ_API_KEY` when `--agent-key` used → `typer.BadParameter` with remediation line
- Missing `OPENAI_API_KEY` when `--openai-model` used → same
- `--datapoints` file not found / unreadable → `typer.BadParameter`
- Malformed JSONL during `validate-dataset` → exit code 1, count of bad lines on stderr
- Zero or >1 target flags → `typer.BadParameter` listing the four flags
- `run`/`generate` raises → propagate; Typer renders traceback (no swallow)

## Testing

`tests/simulation/test_cli.py` — uses `typer.testing.CliRunner`. **One test per flag per command** is the floor.

| Group | Tests |
|---|---|
| `run` per-flag | `--datapoints`, `--model`, `--max-turns`, `--parallelism`, `--evaluator` (single + repeated), `--output`, `--name`, `--no-save`, each target flag (4) |
| `generate` per-flag | `--agent-description`, `--num-personas`, `--num-scenarios`, `--model`, `--max-turns`, `--parallelism`, `--evaluator`, `--output`, `--name`, `--no-save`, each target flag (4) |
| Target mutual exclusion | zero flags errors; two flags errors; one flag passes (×4) |
| `export` | round-trip results JSONL → OpenResponses payload, structural assertion on output |
| `validate-dataset` | valid file passes; malformed JSON line fails; schema-mismatch line fails |
| `runs` | empty dir, missing dir, 2 files sorted by mtime, malformed file skipped |
| Smoke (integration-marked) | `eq sim generate --agent-description "..." --num-personas 2 --num-scenarios 2` end-to-end with mocked target |

Mocking strategy: monkeypatch `evaluatorq.simulation.cli.simulate` / `generate_and_simulate` to capture kwargs; assert flag → kwarg mapping. Integration smoke uses real generators with a fake target callable.

Estimated total: ~30 tests.

## File Layout

```
src/evaluatorq/simulation/
├── cli.py             # Typer app + 5 commands (~400 LOC)
└── _cli_helpers.py    # _resolve_target, _auto_save_run, _scan_run_dir (~150 LOC)
```

Mount point in `src/evaluatorq/cli.py`:

```python
from evaluatorq.simulation.cli import app as sim_app
app.add_typer(sim_app, name="sim")
```

`pyproject.toml` — no new console_script; `eq` entry already exists.

## Reuse, Not Invent

- `simulate`, `generate_and_simulate` — `evaluatorq.simulation.api`
- `load_datapoints_from_jsonl`, `export_results_to_jsonl`, `parse_jsonl` — `evaluatorq.simulation.utils.dataset_export`
- `to_open_responses` — `evaluatorq.simulation.convert`
- `from_orq_deployment`, `from_chat_completions` — `evaluatorq.simulation.adapters`
- `OpenAIModelTarget`, `VercelAISdkTarget` — `evaluatorq.redteam.backends.openai`, `evaluatorq.integrations.vercel_ai_sdk_integration`
- `get_evaluator`, `get_all_evaluators` — `evaluatorq.simulation.evaluators.scorers`
- Run-store filesystem pattern — `evaluatorq.redteam.runner.get_runs_dir` (mirrored, separate dir)
- Rich table fallback pattern — `redteam.cli:runs` (lines 580–692)

## Out of Scope

- Streamlit UI (no sim viewer exists; ticket excludes)
- Run-store DB / index file — filesystem-only, matches redteam
- `--upload` actual implementation — reserved flag; RES-846 wires Orq upload
- HTML/Markdown report writers — RES-846 owns these; this CLI exposes flags but no-ops until wired

## Acceptance

- `eq sim --help` lists `run`, `generate`, `export`, `validate-dataset`, `runs`
- `eq sim generate --agent-description "..." --num-personas 2 --num-scenarios 2 --openai-model gpt-4o-mini` runs end-to-end
- `eq sim run --datapoints fixture.jsonl --agent-key <key>` runs end-to-end
- `eq sim export --input results.jsonl --output payload.json` produces valid OpenResponses payload
- `eq sim validate-dataset fixture.jsonl` exits 0 on valid, non-zero on invalid
- `eq sim runs` shows table of `.evaluatorq/sim-runs/*.json`
- Per-flag test coverage in `tests/simulation/test_cli.py`
- `uv run ruff check src` and `uv run basedpyright` clean
