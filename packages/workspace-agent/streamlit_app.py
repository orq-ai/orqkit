"""
Simplified Streamlit app for workspace agent.
"""

import asyncio
import streamlit as st

from src.workspace_agent.config import WorkspaceSetupRequest, LLMConfig
from src.workspace_agent.main import WorkspaceOrchestrator
from src.workspace_agent.ui.helpers import (
    render_sidebar_form,
    render_plan_preview,
    render_results,
    render_error,
)
from src.workspace_agent.log import logger

# Page config
st.set_page_config(
    page_title="Workspace Agent",
    page_icon="🤖",
    layout="wide",
)


def init_session_state():
    """Initialize session state variables."""
    defaults = {
        "status": "idle",  # idle, clarifying, planning, executing, awaiting_input, complete, error
        "plan": None,
        "result": None,
        "error": None,
        "form_data": None,
        "orchestrator_state": None,  # For resuming after human input
        "pending_question": None,  # Question waiting for user response
        "clarification_conversation": [],  # Conversation history for clarification
        "clarification_questions": None,  # List of clarification questions with options
        "clarification_answers": {},  # Dict of question_index -> answer
        "clarification_summary": "",  # Summary after clarification complete
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def run_async(coro):
    """Run async coroutine in sync context."""
    return asyncio.run(coro)


def run_clarification(form_data: dict, conversation: list = None):
    """Run clarification loop to gather requirements before planning."""
    logger.info("Running clarification loop...")

    request = WorkspaceSetupRequest(
        company_type=form_data["company_type"],
        industry=form_data["industry"],
        specific_instructions=form_data["instructions"],
        workspace_key=form_data["workspace_key"],
        customer_orq_api_key=form_data["customer_api_key"],
        num_dataset_rows=form_data["num_rows"],
        project_path=form_data["project_path"],
        default_prompt_model=form_data["model"],
    )

    llm_config = LLMConfig(
        expensive_model=form_data["model"],
        cheap_model=form_data["model"],
    )

    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)
    # Initialize agents for clarification
    orchestrator._initialize_agents(request.customer_orq_api_key, request.project_path)

    try:
        result = run_async(orchestrator.run_clarification_loop(request, conversation))
        return result
    except Exception as e:
        logger.error(f"Clarification failed: {e}")
        raise


def execute_planning(form_data: dict, clarification_summary: str = ""):
    """Execute planning phase."""
    logger.info("Starting planning phase...")

    request = WorkspaceSetupRequest(
        company_type=form_data["company_type"],
        industry=form_data["industry"],
        specific_instructions=form_data["instructions"],
        workspace_key=form_data["workspace_key"],
        customer_orq_api_key=form_data["customer_api_key"],
        num_dataset_rows=form_data["num_rows"],
        project_path=form_data["project_path"],
        default_prompt_model=form_data["model"],
    )

    llm_config = LLMConfig(
        expensive_model=form_data["model"],
        cheap_model=form_data["model"],
    )

    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)
    # Initialize agents
    orchestrator._initialize_agents(request.customer_orq_api_key, request.project_path)

    try:
        plan = run_async(orchestrator._run_planning(request, clarification_summary))
        plan_dict = {
            "reasoning": plan.reasoning,
            "datasets": [d.model_dump() for d in plan.datasets],
            "prompts": [p.model_dump() for p in plan.prompts],
        }
        logger.success(f"Planning complete: {len(plan_dict.get('datasets', []))} datasets, {len(plan_dict.get('prompts', []))} prompts")
        return plan_dict
    except Exception as e:
        logger.error(f"Planning failed: {e}")
        raise


def execute_full_setup(form_data: dict, resumed_state: dict = None, clarification_summary: str = ""):
    """Execute full workspace setup.

    Args:
        form_data: Form configuration
        resumed_state: Optional state from previous run (for resuming after human input)
        clarification_summary: Summary from clarification phase

    Returns:
        Result dict with status: 'complete', 'awaiting_input', or raises exception
    """
    logger.info("Starting full workspace setup..." + (" (resumed)" if resumed_state else ""))

    # If starting fresh, include clarification_summary in state
    if resumed_state is None and clarification_summary:
        resumed_state = {
            "clarification_summary": clarification_summary,
        }

    request = WorkspaceSetupRequest(
        company_type=form_data["company_type"],
        industry=form_data["industry"],
        specific_instructions=form_data["instructions"],
        workspace_key=form_data["workspace_key"],
        customer_orq_api_key=form_data["customer_api_key"],
        num_dataset_rows=form_data["num_rows"],
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

    st.title("🤖 Workspace Agent")
    st.caption("Multi-agent workspace setup with structured outputs")

    # Sidebar form
    form_data = render_sidebar_form()

    # Handle form submission
    if form_data:
        st.session_state.form_data = form_data
        st.session_state.status = "clarifying"  # Start with clarification phase
        st.session_state.plan = None
        st.session_state.result = None
        st.session_state.error = None
        st.session_state.clarification_conversation = []
        st.session_state.clarification_questions = None
        st.session_state.clarification_answers = {}
        st.session_state.clarification_summary = ""
        logger.debug("Form data saved, transitioning to clarifying status")
        st.rerun()

    # Main content based on status
    status = st.session_state.status

    if status == "idle":
        st.info("👈 Fill out the form in the sidebar to get started.")

    elif status == "clarifying":
        logger.debug("Status: clarifying")
        st.subheader("💬 Let's clarify your requirements")
        st.caption("Answer these 3 questions to help us create a tailored workspace plan.")

        # Check if we need to fetch questions
        if st.session_state.clarification_questions is None:
            with st.spinner("🤔 Generating clarification questions..."):
                try:
                    result = run_clarification(
                        st.session_state.form_data,
                        st.session_state.clarification_conversation,
                    )

                    if result.get("status") == "ready":
                        # Ready to proceed to planning
                        st.session_state.clarification_summary = result.get("summary", "")
                        st.session_state.status = "planning"
                        logger.success("Clarification complete, moving to planning")
                        st.rerun()
                    else:
                        # Store questions for display
                        st.session_state.clarification_questions = result.get("questions", [])
                        st.session_state.clarification_conversation = result.get("conversation", [])
                        st.rerun()

                except Exception as e:
                    st.session_state.error = str(e)
                    st.session_state.status = "error"
                    logger.error(f"Clarification failed: {e}")
                    st.rerun()
        else:
            # Display all questions in tabs
            questions = st.session_state.clarification_questions
            answers = st.session_state.clarification_answers

            if questions:
                tabs = st.tabs([f"Q{i+1}" for i in range(len(questions))])

                for i, (tab, q) in enumerate(zip(tabs, questions)):
                    with tab:
                        st.markdown(f"**{q['question']}**")

                        # Show option buttons
                        options = q.get("options", [])
                        if options:
                            st.write("**Quick options:**")
                            cols = st.columns(len(options))
                            for j, (col, opt) in enumerate(zip(cols, options)):
                                with col:
                                    if st.button(opt, key=f"opt_{i}_{j}", use_container_width=True):
                                        st.session_state.clarification_answers[i] = opt
                                        st.rerun()

                        # Show current answer or text input
                        current_answer = answers.get(i, "")
                        if current_answer:
                            st.success(f"**Your answer:** {current_answer}")
                            if st.button("Clear", key=f"clear_{i}"):
                                del st.session_state.clarification_answers[i]
                                st.rerun()
                        else:
                            custom = st.text_input(
                                "Or type your own answer:",
                                key=f"custom_{i}",
                                placeholder="Type here...",
                            )
                            if custom:
                                st.session_state.clarification_answers[i] = custom

            st.divider()

            # Show progress and submit
            answered = len(answers)
            total = len(questions)
            st.progress(answered / total if total > 0 else 0, text=f"Answered {answered}/{total} questions")

            col1, col2, col3 = st.columns([1, 1, 1])
            with col1:
                if st.button("✅ Submit All Answers", type="primary", use_container_width=True, disabled=(answered < total)):
                    logger.info(f"User submitted {answered} clarification answers")
                    # Build conversation from answers
                    conversation = []
                    for i, q in enumerate(questions):
                        answer = answers.get(i, "")
                        if answer:
                            conversation.append({"role": "user", "content": f"{q['question']}: {answer}"})
                    st.session_state.clarification_conversation = conversation
                    st.session_state.clarification_questions = None  # Trigger summary generation
                    st.rerun()
            with col2:
                if st.button("⏭️ Skip Clarification", use_container_width=True):
                    logger.info("User skipped clarification, moving to planning")
                    st.session_state.status = "planning"
                    st.rerun()
            with col3:
                if st.button("❌ Cancel", use_container_width=True):
                    logger.info("User cancelled during clarification")
                    st.session_state.status = "idle"
                    st.session_state.clarification_conversation = []
                    st.session_state.clarification_questions = None
                    st.session_state.clarification_answers = {}
                    st.rerun()

    elif status == "planning":
        logger.debug("Status: planning")
        with st.spinner("🔄 Creating workspace plan..."):
            try:
                plan = execute_planning(
                    st.session_state.form_data,
                    clarification_summary=st.session_state.clarification_summary,
                )
                st.session_state.plan = plan

                # Always show plan for approval before execution
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

        col1, col2, col3 = st.columns([1, 1, 2])
        with col1:
            if st.button("✅ Execute Plan", type="primary", use_container_width=True):
                logger.info("User approved plan, starting execution")
                st.session_state.status = "executing"
                st.rerun()
        with col2:
            if st.button("🔄 Regenerate", use_container_width=True):
                logger.info("User requested plan regeneration")
                st.session_state.status = "planning"
                st.rerun()
        with col3:
            if st.button("❌ Cancel", use_container_width=True):
                logger.info("User cancelled")
                st.session_state.status = "idle"
                st.session_state.plan = None
                st.rerun()

    elif status == "executing":
        logger.debug("Status: executing")
        with st.spinner("🔄 Executing workspace setup..."):
            try:
                # Check if we're resuming from human input
                resumed_state = st.session_state.orchestrator_state
                result = execute_full_setup(
                    st.session_state.form_data,
                    resumed_state=resumed_state,
                    clarification_summary=st.session_state.clarification_summary,
                )

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
        st.subheader("🤔 The agent needs more information")

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
                    submitted = st.form_submit_button("📤 Submit Response", type="primary", use_container_width=True)
                with col2:
                    cancelled = st.form_submit_button("❌ Cancel Setup", use_container_width=True)

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
        if st.button("🔄 Start New Setup", use_container_width=True):
            logger.info("User starting new setup")
            st.session_state.status = "idle"
            st.session_state.plan = None
            st.session_state.result = None
            st.rerun()

    elif status == "error":
        logger.debug("Status: error")
        render_error(st.session_state.error)

        if st.button("🔄 Try Again", use_container_width=True):
            logger.info("User retrying")
            st.session_state.status = "idle"
            st.session_state.error = None
            st.rerun()


if __name__ == "__main__":
    main()
