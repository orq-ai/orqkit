import os


def _router():
    return os.environ.get("ORQ_BASE_URL", "https://my.orq.ai").rstrip("/") + "/v3/router"


def make_pydantic_agent():
    from pydantic_ai import Agent
    from pydantic_ai.models.openai import OpenAIResponsesModel
    from pydantic_ai.providers.openai import OpenAIProvider

    provider = OpenAIProvider(base_url=_router(), api_key=os.environ["ORQ_API_KEY"])
    model = OpenAIResponsesModel("openai/gpt-6-luna", provider=provider)
    return Agent(model, instructions="Answer customer questions briefly.")


def make_crew():
    from crewai import Agent, Crew, LLM, Task

    llm = LLM(
        model="openai/gpt-6-luna",
        provider="openai",
        base_url=_router(),
        api_key=os.environ["ORQ_API_KEY"],
        max_completion_tokens=2048,
    )
    agent = Agent(
        role="Support agent",
        goal="Answer customer questions briefly.",
        backstory="You help customers with their questions.",
        llm=llm,
        allow_delegation=False,
        max_iter=2,
    )
    task = Task(
        description="Answer the last customer message in this conversation: {conversation}",
        expected_output="A brief answer to the customer.",
        agent=agent,
    )
    return Crew(agents=[agent], tasks=[task], memory=False)
