"""
Cosine Similarity Evaluator Example

This example demonstrates how to use cosine similarity evaluators
to compare semantic similarity between outputs and expected text
using OpenAI embeddings.

Prerequisites:
- Install dependencies: anthropic, orq-ai-sdk (for embeddings)
- Set ANTHROPIC_API_KEY environment variable for Claude
- Set either ORQ_API_KEY or OPENAI_API_KEY for embeddings

Note: This example requires the evaluators package from Orq AI.
In Python, you would need to implement similar functionality or
wait for the Python version of @orq-ai/evaluators to be released.

For now, this is a placeholder showing the structure. You can implement
custom cosine similarity evaluators using libraries like:
- sentence-transformers
- openai embeddings API
- sklearn for cosine similarity calculation

Run with: python example_cosine_similarity.py
"""

import asyncio

from anthropic import Anthropic

from evaluatorq import DataPoint, evaluatorq, job

# Initialize Anthropic client
claude = Anthropic()


@job("translate-to-french")
async def translate_to_french(data: DataPoint, _row: int = 0) -> str:
    """Translate text to French using Claude."""
    text = str(data.inputs.get("text", ""))

    response = await claude.messages.create(
        model="claude-3-5-haiku-latest",
        max_tokens=100,
        system="You are a translator. Translate the given text to French. Respond only with the translation.",
        messages=[
            {
                "role": "user",
                "content": text,
            }
        ],
    )

    return response.content[0].text if response.content[0].type == "text" else ""


@job("describe-capital")
async def describe_capital(data: DataPoint, _row: int = 0) -> str:
    """Generate capital city descriptions using Claude."""
    country = str(data.inputs.get("country", ""))

    response = await claude.messages.create(
        model="claude-3-5-haiku-latest",
        max_tokens=50,
        system="You are a geography expert. Provide a one-sentence description of the capital city of the given country.",
        messages=[
            {
                "role": "user",
                "content": f"What is the capital of {country}?",
            }
        ],
    )

    return response.content[0].text if response.content[0].type == "text" else ""


# TODO: Implement cosine similarity evaluators
# These would need to:
# 1. Get embeddings for both the output and expected text
# 2. Calculate cosine similarity between embeddings
# 3. Return a score and explanation
#
# Example implementation structure:
#
# async def simple_cosine_similarity(expected_text: str):
#     async def scorer(input_data):
#         output = input_data["output"]
#         # Get embeddings using OpenAI/Orq API
#         # Calculate cosine similarity
#         # Return score and explanation
#     return {"name": "cosine-similarity", "scorer": scorer}
#
# async def cosine_similarity_threshold(expected_text: str, threshold: float, name: str):
#     async def scorer(input_data):
#         output = input_data["output"]
#         # Get embeddings and calculate similarity
#         # Return pass/fail based on threshold
#     return {"name": name, "scorer": scorer}


async def main():
    """Run cosine similarity evaluation examples."""
    print("🌍 Running translation evaluation...\n")
    print(
        "⚠️  Note: Cosine similarity evaluators not yet implemented in Python version."
    )
    print("    This example shows the structure without the actual evaluators.\n")

    # Run evaluation with translation examples
    await evaluatorq(
        "translation-evaluation",
        data=[
            DataPoint(inputs={"text": "Hello, how are you?"}),
            DataPoint(inputs={"text": "The sky is blue"}),
            DataPoint(inputs={"text": "Good morning"}),
        ],
        jobs=[translate_to_french],
        evaluators=[
            # TODO: Add cosine similarity evaluators here
            # simple_cosine_similarity("Bonjour, comment allez-vous?"),
            # cosine_similarity_threshold("Le ciel est bleu", 0.85, "exact-translation-match"),
        ],
        parallelism=2,
        print_results=True,
    )

    print("\n🗺️ Running capital city evaluation...\n")

    # Run evaluation with capital city descriptions
    await evaluatorq(
        "capital-evaluation",
        data=[
            DataPoint(inputs={"country": "France"}),
            DataPoint(inputs={"country": "Germany"}),
            DataPoint(inputs={"country": "Japan"}),
        ],
        jobs=[describe_capital],
        evaluators=[
            # TODO: Add cosine similarity evaluators here
            # cosine_similarity_threshold("The capital of France is Paris", 0.7, "capital-semantic-match"),
        ],
        parallelism=2,
        print_results=True,
    )

    print("\n✅ Cosine similarity evaluation examples completed!")


if __name__ == "__main__":
    asyncio.run(main())
