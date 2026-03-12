"""Use a custom LLM client for red teaming.

By default, the red team pipeline creates an OpenAI-compatible client
from environment variables. You can override this with a custom client
to route through a local proxy, use a self-hosted model, or connect to
any OpenAI-compatible endpoint.

When `llm_client` is provided, ALL LLM calls in the pipeline use it:
    - Attack strategy generation
    - Adversarial prompt generation
    - Evaluation scoring
    - Model-under-test calls (static mode)

Usage:
    python 05_custom_llm_client.py
"""

import asyncio

from openai import AsyncOpenAI

from evaluatorq.redteam import red_team


async def main() -> None:
    # Route all LLM calls through the ORQ router as a custom endpoint.
    # You can replace this with any OpenAI-compatible endpoint:
    #   - A local proxy: base_url="http://localhost:8080/v1"
    #   - A self-hosted model: base_url="http://my-model:8000/v1"
    #   - Azure OpenAI: base_url="https://<resource>.openai.azure.com/..."
    import os

    client = AsyncOpenAI(
        api_key=os.environ["ORQ_API_KEY"],
        base_url=os.environ.get("ORQ_BASE_URL", "https://my.orq.ai") + "/v2/router",
    )

    report = await red_team(
        "agent:rt-vuln-tools-only",
        mode="dynamic",
        llm_client=client,
        categories=["LLM07"],
        max_turns=2,
        max_dynamic_datapoints=3,
        generate_strategies=False,
    )

    print(f"Resistance rate: {report.summary.resistance_rate:.0%}")


if __name__ == "__main__":
    asyncio.run(main())
