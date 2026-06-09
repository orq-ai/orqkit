# Agent Simulation Examples

Python examples for simulating user interactions against AI agents - testing goal completion, criteria adherence, and iterative instruction improvement.

## Prerequisites

```bash
uv pip install evaluatorq
```

> **Examples 03 and 04** (`03_tool_simulation.py`, `04_hardening_loop.py`) also require the
> `agent-simulation` research package (not on PyPI - install from source):
>
> ```bash
> uv pip install "agent-simulation @ git+https://github.com/orq-ai/research.git#subdirectory=projects/agent-simulation"
> ```

## Quick Start

```bash
export ORQ_API_KEY="orq-..."

# Simplest example - runs against a local mock agent, no deployment needed
uv run python examples/agent_simulation/01_basic_simulation.py

# Against a live orq.ai deployment
uv run python examples/agent_simulation/02_orq_deployment_simulation.py --deployment my-support-agent
```

## Examples

| File | What it shows |
|------|--------------|
| `01_basic_simulation.py` | Core simulation loop with a mock agent - no deployment needed |
| `02_orq_deployment_simulation.py` | Batch simulation against a live orq.ai deployment or A2A agent |
| `03_tool_simulation.py` | Testing tool-calling agents with `MockToolRegistry` |
| `04_hardening_loop.py` | Iterative instruction improvement with `HardeningLoop` |
| `05_wrap_and_experiment.py` | Production pattern: `wrap_simulation_agent()` + `evaluatorq()` for Experiment upload and CI gating |

## Environment

Copy `.env.example` and fill in your key:

```bash
cp .env.example .env
# add ORQ_API_KEY=orq-...
```
