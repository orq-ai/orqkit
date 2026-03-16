# Red Team Examples

Python examples for automated security testing of LLMs and AI agents against OWASP vulnerability categories.

## Prerequisites

```bash
pip install evaluatorq[redteam]
```

## Quick Start

Most examples work with just an OpenAI API key:

```bash
export OPENAI_API_KEY="sk-..."

# Fastest way to verify the pipeline works
python 08_quick_smoke_test.py

# Full dynamic run against a model
python 01_basic_dynamic.py
```

If your application is an ORQ platform agent, see example 10 instead:

```bash
export ORQ_API_KEY="orq-..."
# Edit 10_orq_agent.py and replace YOUR_AGENT_KEY
python 10_orq_agent.py
```

## Examples

### OpenAI backend (OPENAI_API_KEY)

These examples test LLMs directly via the OpenAI API. You provide a system prompt that simulates your application.

| # | File | Description |
|---|------|-------------|
| 01 | `01_basic_dynamic.py` | Simplest dynamic red team run |
| 02 | `02_static_dataset.py` | Fixed dataset for reproducible regression testing |
| 03 | `03_hybrid_mode.py` | Static dataset + dynamic generation combined |
| 04 | `04_filter_categories.py` | Narrow scope to specific OWASP categories |
| 05 | `05_custom_llm_client.py` | Route through a custom endpoint or proxy |
| 06 | `06_multi_target.py` | Compare permissive vs restrictive system prompts |
| 07 | `07_report_inspection.py` | Parse reports, filter results, export JSON |
| 08 | `08_quick_smoke_test.py` | Fast CI-friendly run with exit code gating |
| 09 | `09_custom_hooks.py` | Custom `PipelineHooks` for logging and control |

### ORQ platform (ORQ_API_KEY)

When your application is an ORQ agent, the pipeline auto-discovers its tools, memory stores, and system prompt — then generates attacks tailored to its capabilities (including tool-misuse and memory-poisoning vectors).

| # | File | Description |
|---|------|-------------|
| 10 | `10_orq_agent.py` | Red team an agent deployed on the ORQ platform |

## CLI Reference

The same functionality is available via the CLI:

```bash
eq redteam run --help
# or
evaluatorq redteam run --help
```

### Target types

- **`llm:<model>`** — Test an LLM directly. Set `OPENAI_API_KEY` and use `--system-prompt`.
- **`agent:<key>`** — Test an ORQ agent. Set `ORQ_API_KEY` and use `--backend orq`.

### OpenAI examples

```bash
# Basic dynamic run
eq redteam run -t "llm:gpt-5-mini" \
  --system-prompt "You are a helpful assistant." \
  --max-turns 2 --max-dynamic-datapoints 5 -y

# Filter to specific categories
eq redteam run -t "llm:gpt-5-mini" \
  -c LLM01 -c LLM07 \
  --system-prompt "You are a helpful assistant." \
  --max-turns 2 --max-dynamic-datapoints 3 -y

# Compare two models
eq redteam run -t "llm:gpt-5-mini" -t "llm:gpt-4o" \
  -c LLM07 --max-turns 2 --max-dynamic-datapoints 3 -y

# Export reports
eq redteam run -t "llm:gpt-5-mini" \
  -c LLM07 --max-dynamic-datapoints 5 \
  --save-report ./report.json --export-md ./reports --export-html ./reports -y
```

### ORQ platform examples

```bash
# Dynamic run against an ORQ agent
eq redteam run -t "agent:my-agent-key" --backend orq \
  -c LLM01 -c ASI01 --max-turns 3 --max-dynamic-datapoints 5 -y

# Hybrid mode (dynamic + static dataset)
eq redteam run -t "agent:my-agent-key" --backend orq \
  --mode hybrid --max-turns 3 -y
```

### Key flags

| Flag                        | Description                                         |
|-----------------------------|-----------------------------------------------------|
| `-t` / `--target`           | Target (repeatable for multi-target)                |
| `--mode`                    | `dynamic`, `static`, or `hybrid`                    |
| `--backend`                 | `openai` (default) or `orq`                         |
| `-c` / `--category`         | OWASP category filter (LLM01-10, ASI01-10)          |
| `-V` / `--vulnerability`    | Vulnerability ID filter (e.g. `prompt_injection`)   |
| `--system-prompt`           | System message for `llm:` targets                   |
| `--max-turns`               | Max conversation turns per attack                   |
| `--max-dynamic-datapoints`  | Cap on generated attack datapoints                  |
| `--no-generate-strategies`  | Skip LLM strategy generation (faster)               |
| `--parallelism`             | Concurrent jobs                                     |
| `-n` / `--name`             | Experiment name (default: `red-team`)               |
| `-y`                        | Skip confirmation prompt                            |
| `-v` / `-vv`                | Info / debug verbosity                              |

See `eq redteam run --help` for the full list.

### List previous runs

```bash
eq redteam runs
```
