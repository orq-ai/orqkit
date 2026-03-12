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

## CLI Alternative

All examples use the Python API. The same functionality is available via CLI:

```bash
# Equivalent to 01_basic_dynamic.py
evaluatorq-redteam -t agent:my-agent-key --mode dynamic --print-results

# Equivalent to 08_quick_smoke_test.py
evaluatorq-redteam -t agent:my-agent-key --no-generate-strategies --max-dynamic-datapoints 5 --max-turns 2 -y --print-results
```

See `evaluatorq-redteam --help` for all options.
