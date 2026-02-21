"""Agent context retrieval from ORQ API."""

import asyncio

try:
    from orq_ai_sdk import Orq
    from evaluatorq.redteam.backends.orq import ORQContextProvider
except ImportError:
    Orq = None  # type: ignore[assignment,misc]
    ORQContextProvider = None  # type: ignore[assignment,misc]

from evaluatorq.redteam.contracts import AgentContext


async def retrieve_agent_context(orq_client: Orq, agent_key: str) -> AgentContext:
    """Retrieve agent context from ORQ API.

    Delegates to :class:`ORQContextProvider`.

    Args:
        orq_client: ORQ SDK client instance
        agent_key: Unique agent key/identifier

    Returns:
        AgentContext with parsed and enriched agent configuration
    """
    return await ORQContextProvider(orq_client).get_agent_context(agent_key)


def retrieve_agent_context_sync(orq_client: Orq, agent_key: str) -> AgentContext:
    """Synchronous version of retrieve_agent_context.

    Args:
        orq_client: ORQ SDK client instance
        agent_key: Unique agent key/identifier

    Returns:
        AgentContext with parsed agent configuration
    """
    return asyncio.run(retrieve_agent_context(orq_client, agent_key))
