# Red Team Examples

Python examples demonstrating the evaluatorq red teaming module for automated security testing of LLM agents against OWASP vulnerability categories.

## Prerequisites

```bash
pip install evaluatorq[redteam]
```

Set at least one API key:

```bash
# ORQ platform (for agent targets)
export ORQ_API_KEY="orq-..."

# OpenAI (for direct model targets or custom LLM routing)
export OPENAI_API_KEY="sk-..."
```

## Examples

| # | File | Description |
|---|------|-------------|
| 01 | `01_basic_dynamic.py` | Simplest possible dynamic red team run against an ORQ agent |
| 02 | `02_static_dataset.py` | Run a fixed OWASP dataset for reproducible regression testing |
| 03 | `03_hybrid_mode.py` | Combine static dataset + dynamic strategy generation |
| 04 | `04_filter_categories.py` | Narrow scope to specific OWASP categories (ASI01, LLM07, etc.) |
| 05 | `05_custom_llm_client.py` | Route LLM calls through a custom endpoint or proxy |
| 06 | `06_multi_target.py` | Compare security posture across multiple agents |
| 07 | `07_report_inspection.py` | Parse reports, filter results, export JSON, display Rich tables |
| 08 | `08_quick_smoke_test.py` | Fast CI-friendly run with exit code gating |
| 09 | `09_custom_hooks.py` | Implement `PipelineHooks` for custom logging and run control |
| 10 | `10_openai_backend.py` | Test a raw OpenAI model without an ORQ agent |

## Quick Start

```bash
# Fastest way to verify the pipeline works
ORQ_API_KEY=orq-... python 08_quick_smoke_test.py

# Full dynamic run
ORQ_API_KEY=orq-... python 01_basic_dynamic.py

# Direct OpenAI model test (no ORQ account needed)
OPENAI_API_KEY=sk-... python 10_openai_backend.py
```

## CLI Reference

All examples use the Python API. The same functionality is available via the `evaluatorq-redteam` CLI. Below are example invocations covering common configurations.

### Target types

The `-t` / `--target` flag accepts two kinds of targets:

- **`agent:<key>`** — An ORQ platform agent. The agent's system prompt and tools are configured on the platform.
- **`llm:<model>`** — A plain LLM model. Use the Orq model format (e.g. `openai/gpt-4o`) when `ORQ_API_KEY` is set, which routes through the Orq proxy. To call OpenAI directly, set `OPENAI_API_KEY` and use `--backend openai` with the OpenAI model name (e.g. `gpt-4o`). Use `--system-prompt` to set the system message for LLM targets.

If no prefix is given, the target is treated as an agent key.

### Basic dynamic run (single agent, all categories)

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic --max-turns 2 --max-dynamic-datapoints 5 --no-generate-strategies -y
```

### Filter to specific OWASP categories

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic -c LLM01 -c LLM07 --max-turns 2 --max-dynamic-datapoints 3 -y
```

### Filter by specific vulnerabilities

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic -V prompt_injection -V goal_hijacking --max-turns 3 --max-dynamic-datapoints 5 -y
```

### Multi-target comparison

```bash
evaluatorq-redteam run -t "agent:my-agent-key" -t "agent:my-other-agent" --mode dynamic -c LLM07 --max-turns 2 --max-dynamic-datapoints 3 --no-generate-strategies -y
```

### With LLM strategy generation enabled

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic -c ASI01 -c ASI02 --generated-strategy-count 3 --max-turns 3 --max-dynamic-datapoints 10 --parallelism 3 -y
```

### LLM target via Orq proxy

Uses the Orq model format (`provider/model`). Requires `ORQ_API_KEY`.

```bash
evaluatorq-redteam run -t "llm:openai/gpt-4o" --mode dynamic -c LLM01 --system-prompt "You are a helpful assistant." --max-turns 2 --max-dynamic-datapoints 5 -y
```

### LLM target via OpenAI directly

Uses the OpenAI model name directly. Requires `OPENAI_API_KEY`.

```bash
evaluatorq-redteam run -t "llm:gpt-4o" --backend openai --mode dynamic -c LLM01 --system-prompt "You are a helpful assistant." --max-turns 2 --max-dynamic-datapoints 5 -y
```

### Custom attack/evaluator models

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic --attack-model "openai/gpt-4o" --evaluator-model "openai/gpt-4o-mini" --max-turns 2 --max-dynamic-datapoints 5 -y
```

### With report exports (JSON + Markdown + HTML)

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic -c LLM07 --max-turns 2 --max-dynamic-datapoints 5 --no-generate-strategies --save-report ./reports/report.json --export-md ./reports --export-html ./reports -y
```

### Quick smoke test (CI-friendly, minimal)

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic --no-generate-strategies --max-dynamic-datapoints 3 --max-turns 2 --parallelism 3 -y
```

### Verbose debug output

```bash
evaluatorq-redteam run -t "agent:my-agent-key" --mode dynamic -c ASI01 --max-turns 2 --max-dynamic-datapoints 3 -vv -y
```

### Key flags

| Flag                        | Description                                         |
|-----------------------------|-----------------------------------------------------|
| `-t` / `--target`           | Target (repeatable for multi-target)                |
| `--mode`                    | `dynamic`, `static`, or `hybrid`                    |
| `-c` / `--category`         | OWASP category filter (LLM01-10, ASI01-10)          |
| `-V` / `--vulnerability`    | Vulnerability ID filter (e.g. `prompt_injection`)   |
| `--max-turns`               | Max conversation turns per attack                   |
| `--max-dynamic-datapoints`  | Cap on generated attack datapoints                  |
| `--no-generate-strategies`  | Skip LLM strategy generation (faster)               |
| `--parallelism`             | Concurrent jobs                                     |
| `--backend`                 | `orq` (default) or `openai`                         |
| `--system-prompt`           | System message for `llm:` targets                   |
| `-y`                        | Skip confirmation prompt                            |
| `-v` / `-vv`                | Info / debug verbosity                              |

See `evaluatorq-redteam run --help` for the full list of options.
