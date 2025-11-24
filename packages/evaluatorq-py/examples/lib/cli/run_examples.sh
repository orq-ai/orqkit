#!/bin/bash

# Run CLI examples for evaluatorq-py
# This script demonstrates running multiple CLI examples

echo "=========================================="
echo "Running Evaluatorq-py CLI Examples"
echo "=========================================="
echo ""

# Check for required environment variables
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "⚠️  Warning: ANTHROPIC_API_KEY not set. LLM examples will fail."
fi

if [ -z "$ORQ_API_KEY" ]; then
    echo "⚠️  Warning: ORQ_API_KEY not set. Dataset examples may fail."
fi

echo ""
echo "Running Example 1: Text Analysis"
echo "------------------------------------------"
python example_using_cli.py

echo ""
echo "Running Example 2: Text Analysis (variant)"
echo "------------------------------------------"
python example_using_cli_two.py

if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo ""
    echo "Running Example 3: LLM Evaluation"
    echo "------------------------------------------"
    python example_llm.py

    echo ""
    echo "Running Example 4: Cosine Similarity (placeholder)"
    echo "------------------------------------------"
    python example_cosine_similarity.py
else
    echo ""
    echo "⏭️  Skipping LLM examples (ANTHROPIC_API_KEY not set)"
fi

echo ""
echo "=========================================="
echo "All CLI Examples Completed!"
echo "=========================================="
