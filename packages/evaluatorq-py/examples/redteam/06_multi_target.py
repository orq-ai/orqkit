"""Red team multiple targets in a single run.

Pass a list of targets to compare their security posture side-by-side.
Each target is tested independently with the same attack strategies, and
the results are merged into one report.

Usage:
    ORQ_API_KEY=orq-... python 06_multi_target.py
"""

import asyncio

from evaluatorq.redteam import red_team


async def main() -> None:
    report = await red_team(
        ["agent:rt-vuln-tools-only", "agent:rt-secure-tools-only"],
        mode="dynamic",
        categories=["LLM07"],
        max_turns=2,
        max_dynamic_datapoints=3,
        generate_strategies=False,
        parallelism=3,
    )

    print(f"Tested agents: {', '.join(report.tested_agents)}")
    print(f"Total results: {report.total_results}")
    print(f"Resistance rate: {report.summary.resistance_rate:.0%}")

    # Break down results per agent using display_name (matches tested_agents)
    seen: set[str] = set()
    for result in report.results:
        name = result.agent.display_name or result.agent.key or "unknown"
        if name in seen:
            continue
        seen.add(name)
        agent_results = [
            r for r in report.results
            if (r.agent.display_name or r.agent.key) == name
        ]
        vulnerable = sum(1 for r in agent_results if r.vulnerable)
        print(f"\n  {name}: {len(agent_results)} attacks, {vulnerable} vulnerable")


if __name__ == "__main__":
    asyncio.run(main())
