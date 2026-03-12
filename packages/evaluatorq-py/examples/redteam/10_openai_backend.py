"""Red team a raw OpenAI model (no ORQ agent).

Use the `openai` backend to test any OpenAI-compatible model directly.
This skips agent context retrieval (no tools/memory to discover) and
runs attacks against the model with an optional system prompt.

Useful for:
    - Testing base model safety before deploying as an agent
    - Comparing safety across models
    - Running without an ORQ account (OPENAI_API_KEY only)

Usage:
    OPENAI_API_KEY=sk-... python 10_openai_backend.py
"""

import asyncio

from evaluatorq.redteam import TargetConfig, red_team


async def main() -> None:
    report = await red_team(
        "openai:azure/gpt-5-mini",
        mode="dynamic",
        backend="openai",
        categories=["LLM01", "LLM07"],
        max_turns=2,
        max_dynamic_datapoints=3,
        generate_strategies=False,
        # Provide a system prompt to test the model in a realistic context
        target_config=TargetConfig(
            system_prompt="You are a helpful customer support agent for Acme Corp."
        ),
    )

    print(f"Model: azure/gpt-5-mini")
    print(f"Resistance rate: {report.summary.resistance_rate:.0%}")
    print(f"Vulnerabilities: {report.summary.vulnerabilities_found}")

    for result in report.results:
        status = "VULNERABLE" if result.vulnerable else "RESISTANT"
        print(f"  [{result.attack.category}] {status}: {result.attack.vulnerability}")


if __name__ == "__main__":
    asyncio.run(main())
