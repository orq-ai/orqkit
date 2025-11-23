"""
Streamlit app for workspace agent.

Run with:
    streamlit run src/workspace_agent/streamlit/app.py
"""

import asyncio
import streamlit as st

from ..config import WorkspaceSetupRequest, LLMConfig
from ..main import WorkspaceOrchestrator
from .helpers import (
    render_sidebar_form,
    render_plan_preview,
    render_results,
    render_error,
)
from ..log import logger

# Page config
st.set_page_config(
    page_title="Workspace Agent",
    page_icon="robot_face",
    layout="wide",
)


def init_session_state():
    """Initialize session state variables."""
    defaults = {
        "status": "idle",  # idle, planning, executing, awaiting_input, complete, error
        "plan": None,
        "result": None,
        "error": None,
        "form_data": None,
        "orchestrator_state": None,  # For resuming after human input
        "pending_question": None,  # Question waiting for user response
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def run_async(coro):
    """Run async coroutine in sync context."""
    return asyncio.run(coro)


def execute_planning(form_data: dict):
    """Execute planning phase."""
    logger.info("Starting planning phase...")

    request = WorkspaceSetupRequest(
        company_type=form_data["company_type"],
        industry=form_data["industry"],
        specific_instructions=form_data["instructions"],
        customer_orq_api_key=form_data["customer_api_key"],
        num_dataset_rows=form_data["num_rows"],
        num_datasets=form_data["num_datasets"],
        num_prompts=form_data["num_prompts"],
        project_path=form_data["project_path"],
        default_prompt_model=form_data["model"],
    )

    llm_config = LLMConfig(
        expensive_model=form_data["model"],
        cheap_model=form_data["model"],
    )

    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    try:
        plan = run_async(orchestrator.run_planning_only(request))
        logger.success(f"Planning complete: {len(plan.get('datasets', []))} datasets, {len(plan.get('prompts', []))} prompts")
        return plan
    except Exception as e:
        logger.error(f"Planning failed: {e}")
        raise


def execute_full_setup(form_data: dict, resumed_state: dict = None):
    """Execute full workspace setup.

    Args:
        form_data: Form configuration
        resumed_state: Optional state from previous run (for resuming after human input)

    Returns:
        Result dict with status: 'complete', 'awaiting_input', or raises exception
    """
    logger.info("Starting full workspace setup..." + (" (resumed)" if resumed_state else ""))

    request = WorkspaceSetupRequest(
        company_type=form_data["company_type"],
        industry=form_data["industry"],
        specific_instructions=form_data["instructions"],
        customer_orq_api_key=form_data["customer_api_key"],
        num_dataset_rows=form_data["num_rows"],
        num_datasets=form_data["num_datasets"],
        num_prompts=form_data["num_prompts"],
        project_path=form_data["project_path"],
        default_prompt_model=form_data["model"],
    )

    llm_config = LLMConfig(
        expensive_model=form_data["model"],
        cheap_model=form_data["model"],
    )

    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    try:
        result = run_async(orchestrator.setup_workspace(request, resumed_state=resumed_state))

        if result.get("status") == "awaiting_input":
            logger.info(f"Coordinator needs human input: {result.get('question')}")
        else:
            logger.success(f"Setup complete: {len(result.get('datasets_created', []))} datasets, {len(result.get('prompts_created', []))} prompts")

        return result
    except Exception as e:
        logger.error(f"Setup failed: {e}")
        raise


def add_human_response_to_state(state: dict, question: str, answer: str) -> dict:
    """Add human response to orchestrator state."""
    if "human_responses" not in state:
        state["human_responses"] = []
    state["human_responses"].append((question, answer))
    logger.debug(f"Added human response to state")
    return state


def main():
    """Main app."""
    init_session_state()

    st.title("Workspace Agent")
    st.caption("Multi-agent workspace setup with structured outputs")

    # Sidebar form
    form_data = render_sidebar_form()

    # Handle form submission
    if form_data:
        st.session_state.form_data = form_data
        st.session_state.status = "planning"
        st.session_state.plan = None
        st.session_state.result = None
        st.session_state.error = None
        logger.debug("Form data saved, transitioning to planning status")
        st.rerun()

    # Main content based on status
    status = st.session_state.status

    if status == "idle":
        st.info("Fill out the form in the sidebar to get started.")

    elif status == "planning":
        logger.debug("Status: planning")
        with st.spinner("Creating workspace plan..."):
            try:
                plan = execute_planning(st.session_state.form_data)
                st.session_state.plan = plan

                # Always show plan for user approval before execution
                st.session_state.status = "plan_ready"
                logger.info("Plan created, showing for user approval")

                st.rerun()

            except Exception as e:
                st.session_state.error = str(e)
                st.session_state.status = "error"
                logger.error(f"Planning failed: {e}")
                st.rerun()

    elif status == "plan_ready":
        logger.debug("Status: plan_ready")
        render_plan_preview(st.session_state.plan)

        st.divider()

        # User must approve plan before execution
        col1, col2, col3 = st.columns([1, 1, 2])
        with col1:
            if st.button("Execute Plan", type="primary", use_container_width=True):
                logger.info("User approved plan, starting execution")
                st.session_state.status = "executing"
                st.rerun()
        with col2:
            if st.button("Regenerate", use_container_width=True):
                logger.info("User requested plan regeneration")
                st.session_state.status = "planning"
                st.rerun()
        with col3:
            if st.button("Cancel", use_container_width=True):
                logger.info("User cancelled")
                st.session_state.status = "idle"
                st.session_state.plan = None
                st.rerun()

    elif status == "executing":
        logger.debug("Status: executing")
        with st.spinner("Executing workspace setup..."):
            try:
                # Check if we're resuming from human input
                resumed_state = st.session_state.orchestrator_state
                result = execute_full_setup(st.session_state.form_data, resumed_state=resumed_state)

                if result.get("status") == "awaiting_input":
                    # Coordinator needs human input
                    st.session_state.orchestrator_state = result.get("state")
                    st.session_state.pending_question = {
                        "question": result.get("question"),
                        "reasoning": result.get("reasoning"),
                    }
                    st.session_state.status = "awaiting_input"
                    logger.info("Transitioning to awaiting_input status")
                else:
                    # Setup complete
                    st.session_state.result = result
                    st.session_state.status = "complete"
                    st.session_state.orchestrator_state = None
                    logger.success("Execution complete")

                st.rerun()

            except Exception as e:
                st.session_state.error = str(e)
                st.session_state.status = "error"
                logger.error(f"Execution failed: {e}")
                st.rerun()

    elif status == "awaiting_input":
        logger.debug("Status: awaiting_input")
        st.subheader("The agent needs more information")

        pending = st.session_state.pending_question
        if pending:
            st.info(f"**Reasoning:** {pending.get('reasoning', 'No reasoning provided')}")
            st.markdown(f"**Question:** {pending.get('question', 'No question provided')}")

            # Input form for user response
            with st.form("human_input_form"):
                user_response = st.text_area(
                    "Your response:",
                    placeholder="Type your answer here...",
                    height=100,
                )
                col1, col2 = st.columns([1, 1])
                with col1:
                    submitted = st.form_submit_button("Submit Response", type="primary", use_container_width=True)
                with col2:
                    cancelled = st.form_submit_button("Cancel Setup", use_container_width=True)

                if submitted and user_response.strip():
                    logger.info(f"User submitted response: {user_response[:50]}...")
                    # Add response to state and resume
                    state = st.session_state.orchestrator_state
                    question = pending.get("question", "")
                    st.session_state.orchestrator_state = add_human_response_to_state(
                        state, question, user_response.strip()
                    )
                    st.session_state.pending_question = None
                    st.session_state.status = "executing"
                    st.rerun()
                elif submitted:
                    st.warning("Please provide a response before submitting.")
                elif cancelled:
                    logger.info("User cancelled during human input")
                    st.session_state.status = "idle"
                    st.session_state.orchestrator_state = None
                    st.session_state.pending_question = None
                    st.rerun()

    elif status == "complete":
        logger.debug("Status: complete")
        render_results(st.session_state.result)

        st.divider()
        if st.button("Start New Setup", use_container_width=True):
            logger.info("User starting new setup")
            st.session_state.status = "idle"
            st.session_state.plan = None
            st.session_state.result = None
            st.rerun()

    elif status == "error":
        logger.debug("Status: error")
        render_error(st.session_state.error)

        if st.button("Try Again", use_container_width=True):
            logger.info("User retrying")
            st.session_state.status = "idle"
            st.session_state.error = None
            st.rerun()


if __name__ == "__main__":
    main()
