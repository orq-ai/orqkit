"""Hybrid red teaming — static dataset + dynamic strategy generation.

Combines the reproducibility of a fixed dataset with agent-specific
dynamic attacks in a single run. The report merges results from both
sources.

Prerequisites:
    - ORQ_API_KEY set in environment
    - A JSON dataset file for the static portion

Usage:
    ORQ_API_KEY=orq-... python 03_hybrid_mode.py
"""

import asyncio

from evaluatorq.redteam import red_team


async def main() -> None:
    report = await red_team(
        "agent:rt-vuln-tools-only",
        mode="hybrid",
        dataset_path="tests/redteam/fixtures/static_e2e_dataset.json",
        # Cap datapoints to keep the run short
        max_dynamic_datapoints=3,
        max_static_datapoints=3,
        generate_strategies=False,
        max_turns=2,
        # Limit to specific categories
        categories=["ASI01", "LLM07"],
    )

    print(f"Pipeline: {report.pipeline}")
    print(f"Total results: {report.total_results}")
    print(f"Categories tested: {', '.join(report.categories_tested)}")
    print(f"Resistance rate: {report.summary.resistance_rate:.0%}")
    print(f"Vulnerabilities: {report.summary.vulnerabilities_found}")


if __name__ == "__main__":
    asyncio.run(main())
