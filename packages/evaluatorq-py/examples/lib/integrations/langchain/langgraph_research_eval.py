"""
LangChain Agent — Dataset-Driven Research Evaluation Example

Demonstrates a dataset-driven evaluation scenario with:
  - LangChain createReactAgent with multiple tools
  - Dataset with structured inputs: { city, data }, messages, expected_output
  - System instructions built from dataset inputs (city + data)
  - User prompt extracted from dataset messages
  - OpenResponses output with input: [system, user] messages
  - Multiple evaluators: correctness, tool-usage, quality rubric,
    completeness, and city-relevance
  - Path-based organization for the Orq dashboard
  - Parallel processing

Prerequisites:
  - Set OPENAI_API_KEY and ORQ_API_KEY environment variables
  - Upload a dataset to Orq with columns:
      "city"            — city name (string)
      "data"            — contextual data about the city (string)
      "messages"        — conversation messages (the user prompt as a message)
      "expected_output" — the expected answer (string, optional)

Usage:
  ORQ_API_KEY=... OPENAI_API_KEY=... DATASET_ID=... python examples/lib/integrations/langchain/langgraph_research_eval.py
"""

import asyncio
import os
import re
from typing import Any

from dotenv import load_dotenv
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

from evaluatorq import DataPoint, ScorerParameter, evaluatorq
from evaluatorq.integrations.langchain_integration import (
    extract_tools_from_agent,
)
from evaluatorq.integrations.langchain_integration.convert import (
    convert_to_open_responses,
)

_ = load_dotenv()


# ────────────────────────────────────────────────
# Helpers — extract text and tool calls from OpenResponses output
# ────────────────────────────────────────────────
def extract_text(output: Any) -> str:
    if not isinstance(output, dict):
        return ""
    items: list[dict[str, Any]] = output.get("output", [])
    message = next((item for item in items if item.get("type") == "message"), None)
    if not message:
        return ""
    content_array: list[dict[str, Any]] = message.get("content", [])
    text_content = next((c for c in content_array if c.get("type") == "output_text"), None)
    return text_content.get("text", "") if text_content else ""


def extract_tool_calls(output: Any) -> list[dict[str, Any]]:
    if not isinstance(output, dict):
        return []
    items: list[dict[str, Any]] = output.get("output", [])
    return [item for item in items if item.get("type") == "function_call"]


# ────────────────────────────────────────────────
# Build system instructions from dataset inputs
# ────────────────────────────────────────────────
def build_system_instructions(city: str, data: str) -> str:
    return "\n\n".join([
        f"You are an expert analyst for the city of {city}.",
        f"Use the following context data to inform your answers:\n{data}",
        "Always ground your response in the provided data.",
        "You MUST use your tools (search, calculator, or fact_check) at least once before answering. Search for additional information to supplement the provided data, verify claims with the fact-checker, or use the calculator for any numerical analysis.",
    ])


# ────────────────────────────────────────────────
# Tools
# ────────────────────────────────────────────────


@tool
def search(query: str) -> dict[str, Any]:
    """Search the web for information on a topic."""
    return {
        "results": [
            {
                "title": f"Top result for: {query}",
                "snippet": (
                    f"Comprehensive information about {query}. According to recent studies, "
                    "this topic has significant implications in multiple domains."
                ),
                "url": f"https://example.com/search?q={query}",
            },
            {
                "title": f"Academic paper: {query}",
                "snippet": (
                    f"A peer-reviewed analysis of {query} published in 2024 found that the "
                    "key factors include scalability, reliability, and cost-effectiveness."
                ),
                "url": f"https://example.com/papers/{query}",
            },
        ],
    }


@tool
def calculator(expression: str) -> dict[str, Any]:
    """Evaluate a mathematical expression."""
    try:
        sanitized = re.sub(r"[^0-9+\-*/().%^ ]", "", expression)
        result = eval(sanitized)  # noqa: S307
        return {"expression": expression, "result": float(result), "error": None}
    except Exception:
        return {"expression": expression, "result": None, "error": "Could not evaluate"}


@tool
def fact_check(claim: str) -> dict[str, Any]:
    """Verify a factual claim against known sources."""
    confidence = 0.85
    return {
        "claim": claim,
        "verdict": "supported" if confidence >= 0.85 else "partially_supported",
        "confidence": round(confidence, 2),
        "sources": [f"https://example.com/fact-check/{claim[:30]}"],
    }


# ────────────────────────────────────────────────
# LangChain agent — createReactAgent
# ────────────────────────────────────────────────

tools = [search, calculator, fact_check]

model = ChatOpenAI(model="gpt-4o", temperature=0)

agent = create_react_agent(model, tools)


# ────────────────────────────────────────────────
# Custom job — extract inputs, build instructions, run agent
# ────────────────────────────────────────────────


async def research_agent_job(data: DataPoint, _row: int) -> dict[str, Any]:
    """
    Extracts city + data from dataset inputs to build system instructions,
    extracts the user prompt from dataset messages, then runs the agent.
    """
    city = str(data.inputs.get("city", ""))
    city_data = str(data.inputs.get("data", ""))

    # Messages come from the dataset's "messages" column (included via include_messages)
    messages = data.inputs.get("messages", [])
    user_message = ""
    if isinstance(messages, list):
        for m in messages:
            if isinstance(m, dict) and m.get("role") == "user":
                user_message = m.get("content", "")
                break

    # Fallback: if the dataset message is empty or too short to trigger tool use,
    # build a research-oriented prompt from the city input.
    if not user_message or len(user_message.strip()) < 10:
        user_message = (
            f"Research and analyze key information about {city}. "
            "Use your tools to search for data, verify facts, and perform any relevant calculations."
        )

    instructions = build_system_instructions(city, city_data)

    # Invoke the agent with system instructions + user message
    result = await agent.ainvoke({
        "messages": [SystemMessage(content=instructions), HumanMessage(content=user_message)],
    })

    # Extract messages from result and convert to OpenResponses format
    result_messages: list[BaseMessage] = result.get("messages", [])
    resolved_tools = extract_tools_from_agent(agent)
    open_responses = convert_to_open_responses(result_messages, resolved_tools)

    return {
        "name": "langchain-research-agent",
        "output": open_responses,
    }


# ────────────────────────────────────────────────
# Evaluators
# ────────────────────────────────────────────────


async def correctness_scorer(params: ScorerParameter) -> dict[str, Any]:
    """Checks correctness against expected output when available."""
    text = extract_text(params["output"]).lower()
    expected = params["data"].expected_output

    if not expected:
        return {
            "value": 1 if len(text) > 20 else 0.5,
            "explanation": "No expected output — scored on response substance",
        }

    expected_str = str(expected).lower()
    contains = expected_str in text
    return {
        "value": 1 if contains else 0,
        "pass": contains,
        "explanation": (
            f'Output contains expected answer "{expected}"'
            if contains
            else f'Expected "{expected}" not found in output'
        ),
    }


async def tool_usage_scorer(params: ScorerParameter) -> dict[str, Any]:
    """Validates that the agent actually used its tools."""
    calls = extract_tool_calls(params["output"])
    tool_names = list(set(c.get("name", "") for c in calls))
    score = min(len(tool_names) / 2, 1.0)
    return {
        "value": round(score, 2),
        "explanation": (
            f"Used {len(calls)} tool call(s) across {len(tool_names)} "
            f"distinct tool(s): {', '.join(tool_names) or 'none'}"
        ),
    }


async def quality_rubric_scorer(params: ScorerParameter) -> dict[str, Any]:
    """Multi-criteria quality rubric (structured result)."""
    text = extract_text(params["output"])
    words = [w for w in text.split() if w]
    sentences = [s for s in re.split(r"[.!?]+", text) if s.strip()]

    completeness = min(len(words) / 50, 1.0)

    avg_sentence_len = len(words) / len(sentences) if sentences else 0
    if 10 <= avg_sentence_len <= 25:
        clarity = 0.95
    elif avg_sentence_len > 0:
        clarity = 0.5
    else:
        clarity = 0.1

    has_structure = 0.9 if re.search(r"(\n[-•*]|\n\d+\.|\n\n)", text) else 0.5

    return {
        "value": {
            "type": "rubric",
            "value": {
                "completeness": round(completeness, 2),
                "clarity": round(clarity, 2),
                "structure": round(has_structure, 2),
            },
        },
        "explanation": "Multi-criteria quality rubric (completeness, clarity, structure)",
    }


async def completeness_scorer(params: ScorerParameter) -> dict[str, Any]:
    """Boolean pass/fail — the response must not be empty or a refusal."""
    text = extract_text(params["output"])
    words = [w for w in text.split() if w]
    is_refusal = bool(re.search(r"i (can't|cannot|am unable to)", text, re.IGNORECASE))
    is_complete = len(words) >= 10 and not is_refusal

    return {
        "value": is_complete,
        "pass": is_complete,
        "explanation": (
            f"Complete response ({len(words)} words)"
            if is_complete
            else (
                "Agent refused to answer"
                if is_refusal
                else f"Incomplete response (only {len(words)} words)"
            )
        ),
    }


async def city_relevance_scorer(params: ScorerParameter) -> dict[str, Any]:
    """Checks that the response references the city from the dataset input."""
    text = extract_text(params["output"]).lower()
    city = str(params["data"].inputs.get("city", ""))
    mentions_city = city.lower() in text
    return {
        "value": 1 if mentions_city else 0,
        "pass": mentions_city,
        "explanation": (
            f'Response references the target city "{city}"'
            if mentions_city
            else f'Response does not mention "{city}"'
        ),
    }


# ────────────────────────────────────────────────
# Run the evaluation
# ────────────────────────────────────────────────

DATASET_ID = os.environ.get("DATASET_ID")


async def main() -> None:
    if not DATASET_ID:
        raise ValueError("DATASET_ID environment variable is required")

    await evaluatorq(
        "langchain-research-eval",
        description=(
            "LangChain research agent evaluation with structured dataset input "
            "(city + data), custom instructions, and OpenResponses output"
        ),
        path="Integrations/LangChain",
        parallelism=3,
        data={"dataset_id": DATASET_ID, "include_messages": True},
        jobs=[research_agent_job],
        evaluators=[
            {"name": "correctness", "scorer": correctness_scorer},
            {"name": "tool-usage", "scorer": tool_usage_scorer},
            {"name": "quality-rubric", "scorer": quality_rubric_scorer},
            {"name": "completeness", "scorer": completeness_scorer},
            {"name": "city-relevance", "scorer": city_relevance_scorer},
        ],
    )


if __name__ == "__main__":
    asyncio.run(main())
