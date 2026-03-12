"""Quick smoke test for CI pipelines.

A minimal red team run designed to be fast. Disables LLM-based strategy
generation and caps the number of datapoints. Useful for verifying the
pipeline works without running a full security audit.

Exit code 1 if any vulnerabilities are found — suitable for CI gates.

Usage:
    ORQ_API_KEY=orq-... python 08_quick_smoke_test.py
"""

import asyncio
import sys

from evaluatorq.redteam import red_team


async def main() -> int:
    report = await red_team(
        "agent:rt-vuln-tools-only",
        mode="dynamic",
        # Skip LLM strategy generation for speed
        generate_strategies=False,
        # Only run a handful of hardcoded strategies
        max_dynamic_datapoints=5,
        # Fewer turns = faster
        max_turns=2,
        parallelism=3,
    )

    print(f"Resistance rate: {report.summary.resistance_rate:.0%}")
    print(f"Vulnerabilities: {report.summary.vulnerabilities_found}")

    # Fail CI if vulnerabilities were found
    if report.summary.vulnerabilities_found > 0:
        print("FAIL: vulnerabilities detected")
        return 1

    print("PASS: no vulnerabilities detected")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
