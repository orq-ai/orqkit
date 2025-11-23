"""
FastHTML app for workspace agent.

Run with:
    python -m workspace_agent.fasthtml.app
    # or
    uvicorn workspace_agent.fasthtml.app:app --reload
"""

import json
from pathlib import Path
from fasthtml.common import *
from starlette.staticfiles import StaticFiles
from starlette.responses import FileResponse

from ..shared import PRESETS
from ..log import logger
from .components import (
    STYLES,
    render_page,
    render_step_indicator,
    render_config_form,
    render_clarifying_state,
    render_clarification_questions,
    render_clarification_processing,
    render_prompt_planning_state,
    render_prompts_review,
    render_prompt_card,
    render_prompt_edit_form,
    render_dataset_planning_state,
    render_datasets_review,
    render_plan_preview,
    render_executing_state,
    render_results,
    render_error,
    render_human_input,
)
from .handlers import (
    get_or_create_task,
    validate_form_data,
    clarifying_stream_generator,
    clarification_summary_stream_generator,
    prompt_planning_stream_generator,
    dataset_planning_stream_generator,
    executing_stream_generator,
)
from .chat import (
    get_or_create_chat,
    update_chat_config,
    chat_stream_generator,
)
from .chat_components import (
    render_chat_page,
    render_chat_message,
)
from ..config import PlatformConfig


# SSE extension for HTMX
sse_extension = Script(
    src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js",
    crossorigin="anonymous",
)

# Favicon link
favicon_link = Link(rel="icon", type="image/svg+xml", href="/static/orq-logo.svg")

# Create app with headers
app, rt = fast_app(
    hdrs=(sse_extension, favicon_link),
    secret_key="workspace-agent-secret-key-change-in-production",
    title="Orq Workspace Agent",
)

# Static files directory
static_dir = Path(__file__).parent / "static"

# Mount static files directory
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


def _get_step_number(status: str) -> int:
    """Get step number based on status for 5-stage flow.

    Stages:
    1. Config - idle
    2. Clarifications - clarifying, clarify_questions, clarify_processing
    3. Prompts - planning_prompts, prompts_ready
    4. Datasets - planning_datasets, datasets_ready
    5. Complete - plan_ready, executing, awaiting_input, complete, error
    """
    if status == "idle":
        return 1
    elif status in ("clarifying", "clarify_questions", "clarify_processing"):
        return 2
    elif status in ("planning_prompts", "prompts_ready"):
        return 3
    elif status in ("planning_datasets", "datasets_ready"):
        return 4
    elif status in ("plan_ready", "executing", "awaiting_input", "complete", "error"):
        return 5
    return 1


def _with_step_indicator(content, task):
    """Wrap content with OOB step indicator update for HTMX partial updates."""
    step = _get_step_number(task.status)
    return (
        content,
        render_step_indicator(step, hx_swap_oob="true"),
    )


@rt("/")
def get(session):
    """Main page."""
    task = get_or_create_task(session)
    logger.debug(f"Main page loaded, task status: {task.status}")

    step = _get_step_number(task.status)
    content = _get_state_content(task)

    return render_page(Div(content, id="main-content"), step=step)


@rt("/current-state")
def get(session):
    """Get current state content (for HTMX partial updates)."""
    task = get_or_create_task(session)
    return _with_step_indicator(_get_state_content(task), task)


@rt("/go-to-step/{step}")
async def post(session, step: int):
    """Navigate back to a previous step.

    Only allows navigating to completed steps (steps before current).
    """
    task = get_or_create_task(session)
    current_step = _get_step_number(task.status)

    logger.debug(f"Go to step {step}: task_id={task.task_id}, status={task.status}, current_step={current_step}")

    # Can only go back, not forward
    if step >= current_step:
        logger.warning(f"Cannot navigate to step {step} from current step {current_step} (status={task.status})")
        return _with_step_indicator(_get_state_content(task), task)

    logger.info(f"Navigating from step {current_step} back to step {step}")

    # Set the appropriate status based on target step
    if step == 1:
        # Config - just show the form with existing data
        task.status = "idle"
    elif step == 2:
        # Clarifications - show questions if we have them
        if task.clarification_questions:
            task.status = "clarify_questions"
        else:
            task.status = "idle"  # Fall back to config if no questions
    elif step == 3:
        # Prompts - show prompts review if we have them
        if task.prompts:
            task.status = "prompts_ready"
        else:
            task.status = "planning_prompts"  # Re-plan prompts
    elif step == 4:
        # Datasets - show datasets review if we have them
        if task.datasets:
            task.status = "datasets_ready"
        else:
            task.status = "planning_datasets"  # Re-plan datasets

    return _with_step_indicator(_get_state_content(task), task)


def _get_state_content(task):
    """Get the appropriate content based on task status."""
    if task.status == "idle":
        return render_config_form()
    elif task.status == "clarifying":
        return render_clarifying_state()
    elif task.status == "clarify_questions":
        return render_clarification_questions(
            task.clarification_questions or [],
            task.clarification_answers or {},
            task.clarification_reasoning,
        )
    elif task.status == "clarify_processing":
        return render_clarification_processing()
    elif task.status == "planning_prompts":
        return render_prompt_planning_state()
    elif task.status == "prompts_ready":
        return render_prompts_review(task.prompts or [])
    elif task.status == "planning_datasets":
        return render_dataset_planning_state()
    elif task.status == "datasets_ready":
        return render_datasets_review(task.datasets or [], task.prompts or [])
    elif task.status == "plan_ready":
        return render_plan_preview(task.plan)
    elif task.status == "executing":
        return render_executing_state()
    elif task.status == "awaiting_input":
        pending = task.pending_question or {}
        return render_human_input(
            pending.get("question"),
            pending.get("reasoning"),
        )
    elif task.status == "complete":
        return render_results(task.result, task.form_data)
    elif task.status == "error":
        return render_error(task.error)
    else:
        return render_config_form()


@rt("/preset-values")
def get(preset: str):
    """Get preset field values as JSON (for dynamic form update)."""
    preset_data = PRESETS.get(preset, PRESETS["Custom"])
    return Response(
        json.dumps(preset_data),
        media_type="application/json",
    )


@rt("/start")
async def post(session, request):
    """Handle form submission to start planning."""
    task = get_or_create_task(session)

    # Parse form data
    form = await request.form()
    form_data = {
        "company_type": form.get("company_type", ""),
        "industry": form.get("industry", ""),
        "instructions": form.get("instructions", ""),
        "customer_api_key": form.get("customer_api_key", ""),
        "num_rows": form.get("num_rows", "5"),
        "num_datasets": form.get("num_datasets", "2"),
        "num_prompts": form.get("num_prompts", "2"),
        "project_path": form.get("project_path", "WorkspaceAgent"),
        "model": form.get("model", "google/gemini-2.5-flash"),
    }

    # Validate
    errors = validate_form_data(form_data)
    if errors:
        return Div(cls="card")(
            Div("Validation Error", cls="card-title"),
            *[Div(e, style="color: var(--error-400); margin-bottom: 0.5rem") for e in errors],
            Button(
                "Back",
                hx_get="/current-state",
                hx_target="#main-content",
                cls="btn btn-secondary",
                style="margin-top: 1rem",
            ),
        )

    # Store form data and start clarification
    task.form_data = form_data
    task.status = "clarifying"
    task.plan = None
    task.result = None
    task.error = None
    task.progress_messages = []
    task.clarification_questions = None
    task.clarification_reasoning = None
    task.clarification_answers = {}

    logger.info(f"Starting clarification for {form_data['company_type']} / {form_data['industry']}")

    return _with_step_indicator(render_clarifying_state(), task)


@rt("/stream/clarifying")
async def get(session):
    """SSE endpoint for clarification question generation."""
    task = get_or_create_task(session)
    return EventStream(clarifying_stream_generator(task))


@rt("/stream/clarification-summary")
async def get(session):
    """SSE endpoint for clarification summary generation."""
    task = get_or_create_task(session)
    return EventStream(clarification_summary_stream_generator(task))


@rt("/submit-clarification")
async def post(session, request):
    """Handle clarification answers submission."""
    task = get_or_create_task(session)

    form = await request.form()

    # Collect answers from form
    questions = task.clarification_questions or []
    answers = {}
    for i in range(len(questions)):
        answer = form.get(f"answer_{i}", "").strip()
        if answer:
            answers[i] = answer

    task.clarification_answers = answers

    # Check if all questions answered
    if len(answers) < len(questions):
        return _with_step_indicator(render_clarification_questions(questions, answers, task.clarification_reasoning), task)

    # All answered - process and get summary
    task.status = "clarify_processing"
    task.progress_messages = []
    logger.info(f"Processing clarification answers for task {task.task_id}")

    return _with_step_indicator(render_clarification_processing(), task)


@rt("/skip-clarification")
async def post(session):
    """Skip clarification and go to the appropriate next stage."""
    task = get_or_create_task(session)
    task.clarification_questions = None
    task.clarification_reasoning = None
    task.clarification_answers = {}
    task.progress_messages = []

    # Check if we should skip prompts (num_prompts == 0)
    num_prompts = int(task.form_data.get("num_prompts", 2))
    if num_prompts == 0:
        # Skip prompts, check datasets
        num_datasets = int(task.form_data.get("num_datasets", 2))
        if num_datasets == 0:
            # Skip everything, go to complete
            task.status = "plan_ready"
            task.plan = {"prompts": [], "datasets": [], "reasoning": "No prompts or datasets requested."}
            logger.info(f"Skipping clarification, prompts, and datasets for task {task.task_id}")
            return _with_step_indicator(render_plan_preview(task.plan), task)
        else:
            task.status = "planning_datasets"
            logger.info(f"Skipping clarification and prompts for task {task.task_id}")
            return _with_step_indicator(render_dataset_planning_state(), task)
    else:
        task.status = "planning_prompts"
        logger.info(f"Skipping clarification for task {task.task_id}")
        return _with_step_indicator(render_prompt_planning_state(), task)


@rt("/stream/planning-prompts")
async def get(session):
    """SSE endpoint for prompt planning progress."""
    task = get_or_create_task(session)
    return EventStream(prompt_planning_stream_generator(task))


@rt("/stream/planning-datasets")
async def get(session):
    """SSE endpoint for dataset planning progress."""
    task = get_or_create_task(session)
    return EventStream(dataset_planning_stream_generator(task))


@rt("/approve-prompts")
async def post(session):
    """Approve prompts and proceed to dataset generation or skip if num_datasets is 0."""
    task = get_or_create_task(session)
    task.progress_messages = []

    # Check if we should skip datasets (num_datasets == 0)
    num_datasets = int(task.form_data.get("num_datasets", 2))
    if num_datasets == 0:
        # Skip datasets, go to final plan
        task.plan = {
            "prompts": task.prompts or [],
            "datasets": [],
            "reasoning": "Your workspace has been configured with the prompts you approved. No datasets were requested.",
        }
        task.status = "plan_ready"
        logger.info(f"Prompts approved, skipping datasets for task {task.task_id}")
        return _with_step_indicator(render_plan_preview(task.plan), task)
    else:
        task.status = "planning_datasets"
        logger.info(f"Prompts approved, starting dataset planning for task {task.task_id}")
        return _with_step_indicator(render_dataset_planning_state(), task)


@rt("/regenerate-prompts")
async def post(session):
    """Regenerate the prompts."""
    task = get_or_create_task(session)
    task.status = "planning_prompts"
    task.prompts = None
    task.progress_messages = []
    logger.info(f"Regenerating prompts for task {task.task_id}")
    return _with_step_indicator(render_prompt_planning_state(), task)


@rt("/edit-prompt/{index}")
async def get(session, index: int):
    """Return the edit form for a specific prompt."""
    task = get_or_create_task(session)
    if not task.prompts or index >= len(task.prompts):
        logger.warning(f"Invalid prompt index {index} for task {task.task_id}")
        return render_prompt_card({"name": "Invalid Prompt"}, index)

    logger.info(f"Editing prompt {index} for task {task.task_id}")
    return render_prompt_edit_form(task.prompts[index], index)


@rt("/save-prompt/{index}")
async def post(session, index: int, name: str, description: str, system_prompt: str, model: str, temperature: str):
    """Save edits to a specific prompt."""
    task = get_or_create_task(session)
    if not task.prompts or index >= len(task.prompts):
        logger.warning(f"Invalid prompt index {index} for task {task.task_id}")
        return render_prompt_card({"name": "Invalid Prompt"}, index)

    # Update the prompt
    task.prompts[index] = {
        **task.prompts[index],
        "name": name,
        "description": description,
        "system_prompt": system_prompt,
        "model": model,
        "temperature": float(temperature),
    }
    logger.info(f"Saved prompt {index} for task {task.task_id}: {name}")
    return render_prompt_card(task.prompts[index], index)


@rt("/cancel-edit-prompt/{index}")
async def get(session, index: int):
    """Cancel editing and return to read-only view."""
    task = get_or_create_task(session)
    if not task.prompts or index >= len(task.prompts):
        logger.warning(f"Invalid prompt index {index} for task {task.task_id}")
        return render_prompt_card({"name": "Invalid Prompt"}, index)

    logger.info(f"Cancelled editing prompt {index} for task {task.task_id}")
    return render_prompt_card(task.prompts[index], index)


@rt("/approve-datasets")
async def post(session):
    """Approve datasets and proceed to final plan review."""
    task = get_or_create_task(session)
    # Build the final plan from approved prompts and datasets
    task.plan = {
        "prompts": task.prompts or [],
        "datasets": task.datasets or [],
        "reasoning": "Your workspace has been configured with the prompts and datasets you approved.",
    }
    task.status = "plan_ready"
    logger.info(f"Datasets approved, showing final plan for task {task.task_id}")
    return _with_step_indicator(render_plan_preview(task.plan), task)


@rt("/regenerate-datasets")
async def post(session):
    """Regenerate the datasets."""
    task = get_or_create_task(session)
    task.status = "planning_datasets"
    task.datasets = None
    task.progress_messages = []
    logger.info(f"Regenerating datasets for task {task.task_id}")
    return _with_step_indicator(render_dataset_planning_state(), task)


@rt("/stream/executing")
async def get(session):
    """SSE endpoint for execution progress."""
    task = get_or_create_task(session)
    return EventStream(executing_stream_generator(task))


@rt("/execute")
async def post(session):
    """Execute the approved plan."""
    task = get_or_create_task(session)
    task.status = "executing"
    task.progress_messages = []
    logger.info(f"Starting execution for task {task.task_id}")
    return _with_step_indicator(render_executing_state(), task)


@rt("/regenerate")
async def post(session):
    """Regenerate the plan from scratch."""
    task = get_or_create_task(session)
    task.plan = None
    task.prompts = None
    task.datasets = None
    task.progress_messages = []

    # Check if we should skip prompts (num_prompts == 0)
    num_prompts = int(task.form_data.get("num_prompts", 2))
    if num_prompts == 0:
        # Skip prompts, check datasets
        num_datasets = int(task.form_data.get("num_datasets", 2))
        if num_datasets == 0:
            # Skip everything
            task.status = "plan_ready"
            task.plan = {"prompts": [], "datasets": [], "reasoning": "No prompts or datasets requested."}
            logger.info(f"Regenerate skipped (no prompts/datasets) for task {task.task_id}")
            return _with_step_indicator(render_plan_preview(task.plan), task)
        else:
            task.status = "planning_datasets"
            logger.info(f"Regenerating datasets (skipping prompts) for task {task.task_id}")
            return _with_step_indicator(render_dataset_planning_state(), task)
    else:
        task.status = "planning_prompts"
        logger.info(f"Regenerating plan for task {task.task_id}")
        return _with_step_indicator(render_prompt_planning_state(), task)


@rt("/cancel")
async def post(session):
    """Cancel the current operation."""
    task = get_or_create_task(session)
    task.status = "idle"
    task.plan = None
    task.prompts = None
    task.datasets = None
    task.result = None
    task.error = None
    task.orchestrator_state = None
    task.pending_question = None
    task.progress_messages = []
    task.clarification_questions = None
    task.clarification_reasoning = None
    task.clarification_answers = {}
    logger.info(f"Cancelled task {task.task_id}")
    return _with_step_indicator(render_config_form(), task)


@rt("/reset")
async def post(session):
    """Reset to start a new setup."""
    task = get_or_create_task(session)
    task.status = "idle"
    task.plan = None
    task.prompts = None
    task.datasets = None
    task.result = None
    task.error = None
    task.orchestrator_state = None
    task.pending_question = None
    task.progress_messages = []
    task.clarification_questions = None
    task.clarification_reasoning = None
    task.clarification_answers = {}
    logger.info(f"Reset task {task.task_id}")
    return _with_step_indicator(render_config_form(), task)


# =============================================================================
# Chat Routes
# =============================================================================


@rt("/chat")
async def get(session):
    """Render the dedicated chat page."""
    task = get_or_create_task(session)
    form_data = task.form_data or {}

    # Get or create chat session
    chat = get_or_create_chat(session, form_data)

    return render_chat_page(
        messages=chat.messages,
        chat_id=chat.chat_id,
        model=chat.config.get("model", "google/gemini-2.5-flash"),
        temperature=chat.config.get("temperature", 0.7),
        use_mcp=chat.use_mcp,
        customer_api_key=chat.customer_api_key or "",
        error=chat.error,
    )


@rt("/chat/config")
async def post(session, request):
    """Update chat configuration."""
    chat = get_or_create_chat(session)
    form = await request.form()

    model = form.get("chat_model")
    temp_str = form.get("chat_temp")
    temperature = float(temp_str) if temp_str else None

    # Handle MCP toggle - checkbox sends value when checked, absent when unchecked
    use_mcp = form.get("use_mcp") is not None

    # Handle customer API key
    customer_api_key = form.get("customer_api_key")
    if customer_api_key is not None:
        chat.customer_api_key = customer_api_key if customer_api_key else None

    update_chat_config(chat, model=model, temperature=temperature)

    # Update MCP mode separately (not in update_chat_config to keep it simple)
    chat.use_mcp = use_mcp

    logger.debug(f"Chat config updated: model={model}, temp={temperature}, use_mcp={use_mcp}, has_api_key={bool(chat.customer_api_key)}")
    return ""  # Empty response for hx-swap="none"


@rt("/chat/send")
async def post(session, request):
    """Send a chat message and stream the response."""
    task = get_or_create_task(session)
    form_data = task.form_data or {}

    chat = get_or_create_chat(session, form_data)

    form = await request.form()
    message = form.get("message", "").strip()

    if not message:
        return ""

    # Get platform config
    platform_config = PlatformConfig()

    # Return SSE stream for the response
    return EventStream(chat_stream_generator(chat, message, platform_config))


@rt("/submit-response")
async def post(session, request):
    """Handle human input response."""
    task = get_or_create_task(session)

    form = await request.form()
    response = form.get("response", "").strip()

    pending = task.pending_question or {}

    if not response:
        return _with_step_indicator(
            Div(
                Div(cls="card")(
                    Div("Please provide a response before submitting.",
                        style="color: var(--error-400); margin-bottom: 1rem"),
                ),
                render_human_input(
                    pending.get("question"),
                    pending.get("reasoning"),
                ),
            ),
            task,
        )

    # Add response to state
    if task.orchestrator_state is None:
        task.orchestrator_state = {}
    if "human_responses" not in task.orchestrator_state:
        task.orchestrator_state["human_responses"] = []

    task.orchestrator_state["human_responses"].append(
        (pending.get("question", ""), response)
    )

    task.pending_question = None
    task.status = "executing"
    task.progress_messages = []

    logger.info(f"Human response submitted for task {task.task_id}")

    return _with_step_indicator(render_executing_state(), task)


def serve():
    """Run the app."""
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5001)


if __name__ == "__main__":
    serve()
