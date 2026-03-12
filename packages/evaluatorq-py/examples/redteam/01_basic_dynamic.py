"""Basic dynamic red teaming against an ORQ agent.

The simplest possible red team run. Uses dynamic mode (default) to
automatically discover agent capabilities, plan attack strategies, and
execute multi-turn adversarial attacks.

Prerequisites:
    - ORQ_API_KEY set in environment
    - An agent deployed on the ORQ platform

Usage:
    ORQ_API_KEY=orq-... python 01_basic_dynamic.py
"""

import asyncio

from evaluatorq.redteam import red_team


async def main() -> None:
    report = await red_team(
        "agent:rt-vuln-tools-only",
        mode="dynamic",
        categories=["LLM07"],
        max_dynamic_datapoints=3,
        generate_strategies=False,
        max_turns=2,
    )

    summary = report.summary
    print(f"Resistance rate: {summary.resistance_rate:.0%}")
    print(f"Vulnerabilities found: {summary.vulnerabilities_found}")
    print(f"Total attacks: {summary.total_attacks}")


if __name__ == "__main__":
    asyncio.run(main())
