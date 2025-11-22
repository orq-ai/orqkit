#!/usr/bin/env python3
"""
CLI script to run the workspace agent.
Usage: python run_agent.py
"""

import asyncio
import os
from src.workspace_agent.main import WorkspaceOrchestrator, WorkspaceSetupRequest


async def main():
    """Main entry point for running the workspace agent"""

    # Example configuration - modify as needed
    orchestrator = WorkspaceOrchestrator()

    request = WorkspaceSetupRequest(
        company_type="Airline",
        industry="Aviation Customer Service",
        workspace_key="62922ea7-ac87-4641-99d9-11f9dc786915",
        customer_orq_api_key=os.getenv(
            "CUSTOMER_ORQ_API_KEY",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3b3Jrc3BhY2VJZCI6IjdlNDhjMzljLTMxYjMtNGYwMi04MTZlLWI1ZWEyZTJhNTAwYSIsImlzcyI6Im9ycSIsImlhdCI6MTc1NjcxODQyMH0.nihB2BUoY3FifWk79fgWjNwssW_9Xv8Nt1LAQ7c0bBo",
        ),
        specific_instructions="""Create datasets and prompts for an airline customer service AI agent with the following specs:

PLATFORMS:
- Web chat (primary interface)
- Email support (secondary interface)

LANGUAGE SUPPORT:
- English only

CAPABILITIES:
- Handle flight booking inquiries and modifications
- Process baggage claim requests and track luggage
- Assist with check-in procedures and seat selection
- Answer questions about flight status, delays, and cancellations
- Help with loyalty program points and tier status
- Provide information about baggage policies and fees

INTEGRATIONS (Currently Mocked):
- Booking system integration (use fake/mock data for now)
- Flight information system (use fake/mock data for now)

Note: The agent should be designed to work with real integrations later, but for now, all external system calls should use placeholder/mock responses.""",
        num_dataset_rows=5,
    )

    print(f"🚀 Starting workspace setup...")
    print(f"   Company: {request.company_type} in {request.industry}")
    print(f"   Workspace: {request.workspace_key}")

    try:
        result = await orchestrator.setup_workspace(request)

        # Display results
        print("\n" + "=" * 65)
        print(f"✅ Workspace '{request.workspace_key}' setup completed successfully!")

        print(f"\n📊 Datasets Created ({len(result.get('datasets_created', []))}):")
        for dataset in result.get("datasets_created", []):
            if hasattr(dataset, "name") and hasattr(dataset, "id"):
                print(f"   - {dataset.name} (ID: {dataset.id})")
            else:
                print(f"   - {dataset}")

        print(f"\n📝 Prompts Created ({len(result.get('prompts_created', []))}):")
        for prompt in result.get("prompts_created", []):
            if hasattr(prompt, "name") and hasattr(prompt, "id"):
                print(f"   - {prompt.name} (ID: {prompt.id})")
            else:
                print(f"   - {prompt}")

        if result.get("errors"):
            print(f"\n⚠️  Errors encountered ({len(result['errors'])}):")
            for error in result["errors"]:
                print(f"   - {error}")

        print("\n🎉 Workspace setup complete!")

    except KeyboardInterrupt:
        print("\n\n👋 Setup cancelled by user.")
    except Exception as e:
        error_msg = str(e)
        if "Recursion limit" in error_msg:
            print(f"\n⚠️  Workspace setup hit recursion limit")
            print(
                "   The agent workflow is executing but needs more steps to complete."
            )
            print("   This means the graph IS running - agents just need optimization:")
            print("   - Increase recursion_limit in config")
            print("   - Improve agent prompts for faster completion")
            print("   - Simplify tool configurations")
        else:
            print(f"\n❌ Workspace setup failed: {e}")
            import traceback

            traceback.print_exc()
            raise


if __name__ == "__main__":
    asyncio.run(main())
