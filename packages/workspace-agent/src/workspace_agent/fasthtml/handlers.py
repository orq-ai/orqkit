"""FastHTML request handlers for workspace agent."""

import asyncio
import uuid
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

from fasthtml.common import *

from ..config import WorkspaceSetupRequest, LLMConfig
from ..main import WorkspaceOrchestrator
from ..log import logger
from ..shared import PRESETS


def step_update_script(phase: str, step_id: str, status: str = "active") -> Script:
    """Generate JavaScript to update a step in the progress stepper.

    Args:
        phase: The phase prefix (e.g., 'planning', 'execute', 'clarify')
        step_id: The step ID to update
        status: 'active', 'complete', or 'error'
    """
    return Script(f"""
        (function() {{
            const step = document.getElementById('{phase}-step-{step_id}');
            if (step) {{
                // Remove all status classes
                step.classList.remove('active', 'complete', 'error');
                // Add new status
                step.classList.add('{status}');
            }}
        }})();
    """)


def progress_bar_update_script(current: int, total: int, message: str) -> Script:
    """Generate JavaScript to update the progress bar.

    Args:
        current: Current progress value
        total: Total progress value
        message: Status message to display
    """
    percent = int((current / total) * 100) if total > 0 else 0
    return Script(f"""
        (function() {{
            const container = document.getElementById('datapoint-progress');
            if (container) {{
                container.style.display = 'block';
            }}
            const fill = document.getElementById('progress-bar-fill');
            if (fill) {{
                fill.style.width = '{percent}%';
            }}
            const count = document.getElementById('progress-bar-count');
            if (count) {{
                count.textContent = '{current} / {total}';
            }}
            const detail = document.getElementById('progress-bar-detail');
            if (detail) {{
                detail.textContent = '{message}';
            }}
        }})();
    """)


@dataclass
class TaskState:
    """State for a running task."""

    task_id: str
    # States: idle, clarifying, clarify_questions, clarify_processing,
    #         planning_prompts, prompts_ready, planning_datasets, datasets_ready, plan_ready,
    #         executing, awaiting_input, complete, error
    status: str = "idle"
    form_data: Dict[str, Any] = field(default_factory=dict)
    plan: Optional[Dict[str, Any]] = None
    prompts: Optional[list] = None  # Approved prompts (before dataset generation)
    datasets: Optional[list] = None  # Approved datasets (before final plan)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    orchestrator_state: Optional[Dict[str, Any]] = None
    pending_question: Optional[Dict[str, str]] = None
    progress_messages: list = field(default_factory=list)
    # Clarification questions (3-question flow)
    clarification_questions: Optional[list] = (
        None  # List of {question, reasoning, options: [opt1, opt2, opt3]}
    )
    clarification_answers: Dict[int, str] = field(
        default_factory=dict
    )  # {question_index: answer}
    clarification_reasoning: Optional[str] = (
        None  # Agent's reasoning for the clarification questions
    )
    # Datapoint creation progress
    datapoint_progress: Optional[Dict[str, Any]] = None  # {current, total, message}


# In-memory task storage (for simplicity; use Redis in production)
_tasks: Dict[str, TaskState] = {}


def get_or_create_task(session) -> TaskState:
    """Get existing task from session or create a new one."""
    task_id = session.get("task_id")
    if task_id and task_id in _tasks:
        logger.debug(f"Retrieved existing task: {task_id}, status={_tasks[task_id].status}")
        return _tasks[task_id]

    # Check if session had a task_id that's no longer in memory (server restart)
    if task_id:
        logger.warning(f"Session had task_id={task_id} but task not found in memory (server restart?)")

    # Create new task
    task_id = str(uuid.uuid4())
    task = TaskState(task_id=task_id)
    _tasks[task_id] = task
    session["task_id"] = task_id
    logger.debug(f"Created new task: {task_id}")
    return task


def get_task(task_id: str) -> Optional[TaskState]:
    """Get task by ID."""
    return _tasks.get(task_id)


def validate_form_data(form_data: Dict[str, Any]) -> list[str]:
    """Validate form data and return list of errors."""
    errors = []

    if not form_data.get("company_type"):
        errors.append("Company Type is required")
    if not form_data.get("industry"):
        errors.append("Industry is required")

    api_key = form_data.get("customer_api_key", "")
    if not api_key:
        errors.append("Customer API Key is required")
    elif not api_key.startswith("ey"):
        errors.append("API Key should be a JWT (starts with 'ey')")

    return errors


async def execute_planning_async(task: TaskState) -> Dict[str, Any]:
    """Execute the planning phase asynchronously."""
    form_data = task.form_data
    logger.info(f"[{task.task_id}] Starting planning phase...")

    # Validate form_data exists
    if not form_data or not form_data.get("company_type"):
        raise ValueError(
            "Form data is missing or incomplete. Please restart the setup."
        )

    task.progress_messages.append("Initializing orchestrator...")

    request = WorkspaceSetupRequest(
        company_type=form_data.get("company_type", ""),
        industry=form_data.get("industry", ""),
        specific_instructions=form_data.get("instructions", ""),
        customer_orq_api_key=form_data.get("customer_api_key", ""),
        num_dataset_rows=int(form_data.get("num_rows", 5)),
        num_datasets=int(form_data.get("num_datasets", 2)),
        project_path=form_data.get("project_path", "WorkspaceAgent"),
        default_prompt_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    llm_config = LLMConfig(
        expensive_model=form_data.get("model", "google/gemini-2.5-flash"),
        cheap_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    task.progress_messages.append("Creating workspace orchestrator...")
    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    # Get clarification summary if available
    clarification_summary = ""
    if task.orchestrator_state:
        clarification_summary = task.orchestrator_state.get("clarification_summary", "")

    task.progress_messages.append("Running planning agent...")
    plan = await orchestrator.run_planning_only(
        request, clarification_summary=clarification_summary
    )

    task.progress_messages.append(
        f"Planning complete: {len(plan.get('datasets', []))} datasets, {len(plan.get('prompts', []))} prompts"
    )
    logger.success(f"[{task.task_id}] Planning complete")

    return plan


async def execute_setup_async(task: TaskState) -> Dict[str, Any]:
    """Persist the approved plan to SDK.

    This only persists data - all generation happens in earlier stages.
    The approved prompts and datasets (with datapoints) are stored in task.
    """
    form_data = task.form_data
    approved_prompts = task.prompts or []
    approved_datasets = task.datasets or []

    logger.info(
        f"[{task.task_id}] Persisting plan: {len(approved_prompts)} prompts, {len(approved_datasets)} datasets"
    )

    # Validate form_data exists
    if not form_data or not form_data.get("company_type"):
        raise ValueError(
            "Form data is missing or incomplete. Please restart the setup."
        )

    task.progress_messages.append("Initializing persistence...")

    request = WorkspaceSetupRequest(
        company_type=form_data.get("company_type", ""),
        industry=form_data.get("industry", ""),
        specific_instructions=form_data.get("instructions", ""),
        customer_orq_api_key=form_data.get("customer_api_key", ""),
        num_dataset_rows=int(form_data.get("num_rows", 5)),
        num_datasets=int(form_data.get("num_datasets", 2)),
        project_path=form_data.get("project_path", "WorkspaceAgent"),
        default_prompt_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    llm_config = LLMConfig(
        expensive_model=form_data.get("model", "google/gemini-2.5-flash"),
        cheap_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    task.progress_messages.append("Creating prompts and datasets...")
    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    # Create progress callback to track persistence progress
    def progress_callback(current: int, total: int, message: str):
        task.datapoint_progress = {
            "current": current,
            "total": total,
            "message": message,
        }

    # Persist the approved plan (prompts and datasets with datapoints)
    result = await orchestrator.persist_plan(
        request=request,
        approved_prompts=approved_prompts,
        approved_datasets=approved_datasets,
        progress_callback=progress_callback,
    )

    task.progress_messages.append(
        f"Setup complete: {len(result.get('datasets_created', []))} datasets, {len(result.get('prompts_created', []))} prompts"
    )

    return result


async def execute_clarification_async(task: TaskState) -> Dict[str, Any]:
    """Execute the clarification phase to gather requirements."""
    form_data = task.form_data
    logger.info(f"[{task.task_id}] Starting clarification phase...")

    # Validate form_data exists
    if not form_data or not form_data.get("company_type"):
        raise ValueError(
            "Form data is missing or incomplete. Please restart the setup."
        )

    task.progress_messages.append("Analyzing your requirements...")

    request = WorkspaceSetupRequest(
        company_type=form_data.get("company_type", ""),
        industry=form_data.get("industry", ""),
        specific_instructions=form_data.get("instructions", ""),
        customer_orq_api_key=form_data.get("customer_api_key", ""),
        num_dataset_rows=int(form_data.get("num_rows", 5)),
        num_datasets=int(form_data.get("num_datasets", 2)),
        project_path=form_data.get("project_path", "WorkspaceAgent"),
        default_prompt_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    llm_config = LLMConfig(
        expensive_model=form_data.get("model", "google/gemini-2.5-flash"),
        cheap_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    task.progress_messages.append("Generating clarification questions...")
    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    # First call - get the 3 questions
    result = await orchestrator.run_clarification_loop(request, conversation=[])

    if result.get("status") == "clarifying":
        task.progress_messages.append(
            f"Generated {len(result.get('questions', []))} clarification questions"
        )
    else:
        task.progress_messages.append("Ready to proceed with planning")

    return result


async def execute_clarification_summary_async(task: TaskState) -> Dict[str, Any]:
    """Execute clarification to get summary after user answers all questions."""
    form_data = task.form_data
    logger.info(f"[{task.task_id}] Getting clarification summary...")

    # Validate form_data exists
    if not form_data or not form_data.get("company_type"):
        raise ValueError(
            "Form data is missing or incomplete. Please restart the setup."
        )

    request = WorkspaceSetupRequest(
        company_type=form_data.get("company_type", ""),
        industry=form_data.get("industry", ""),
        specific_instructions=form_data.get("instructions", ""),
        customer_orq_api_key=form_data.get("customer_api_key", ""),
        num_dataset_rows=int(form_data.get("num_rows", 5)),
        num_datasets=int(form_data.get("num_datasets", 2)),
        project_path=form_data.get("project_path", "WorkspaceAgent"),
        default_prompt_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    llm_config = LLMConfig(
        expensive_model=form_data.get("model", "google/gemini-2.5-flash"),
        cheap_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    # Build conversation from questions and answers
    conversation = []
    questions = task.clarification_questions or []
    answers = task.clarification_answers or {}

    for i, q in enumerate(questions):
        answer = answers.get(i, "")
        if answer:
            conversation = orchestrator.add_clarification_response(
                conversation, q.get("question", ""), answer
            )

    # Second call - get the summary
    result = await orchestrator.run_clarification_loop(
        request, conversation=conversation
    )

    return result


async def clarifying_stream_generator(task: TaskState):
    """Generator for SSE streaming during clarification phase."""
    # Map progress messages to step IDs (must match CLARIFICATION_STEPS in components.py)
    step_map = {
        "Analyzing": ("init", None),
        "Generating": ("generate", "init"),
    }
    last_step = None

    try:
        # Immediately activate first step
        yield sse_message(
            step_update_script("clarify", "init", "active"), event="message"
        )
        last_step = "init"

        # Start clarification in background
        clarify_task = asyncio.create_task(execute_clarification_async(task))

        last_msg_count = 0
        while not clarify_task.done():
            # Send any new progress messages as step updates
            current_count = len(task.progress_messages)
            if current_count > last_msg_count:
                for msg in task.progress_messages[last_msg_count:current_count]:
                    # Find matching step
                    for key, (step_id, prev_step) in step_map.items():
                        if msg.startswith(key):
                            # Complete previous step if exists
                            if prev_step:
                                yield sse_message(
                                    step_update_script(
                                        "clarify", prev_step, "complete"
                                    ),
                                    event="message",
                                )
                            # Activate current step
                            yield sse_message(
                                step_update_script("clarify", step_id, "active"),
                                event="message",
                            )
                            last_step = step_id
                            break
                last_msg_count = current_count
            await asyncio.sleep(0.1)

        # Get result
        result = await clarify_task

        if result.get("status") == "clarifying":
            # Store questions, reasoning, and transition to clarify state
            task.clarification_questions = result.get("questions", [])
            task.clarification_reasoning = result.get("reasoning", "")
            task.clarification_answers = {}
            task.status = "clarify_questions"
        else:
            # Ready to plan immediately (no questions needed)
            task.orchestrator_state = task.orchestrator_state or {}
            task.orchestrator_state["clarification_summary"] = result.get("summary", "")

            # Always go to prompts planning (prompts page is never skipped)
            task.status = "planning_prompts"

        # Mark final steps complete
        if last_step:
            yield sse_message(
                step_update_script("clarify", last_step, "complete"), event="message"
            )
        yield sse_message(
            step_update_script("clarify", "complete", "complete"), event="message"
        )

        # Short delay for visual feedback then redirect
        await asyncio.sleep(0.3)
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")

    except Exception as e:
        logger.error(f"[{task.task_id}] Clarification failed: {e}")
        task.status = "error"
        task.error = str(e)
        # Mark current step as error
        if last_step:
            yield sse_message(
                step_update_script("clarify", last_step, "error"), event="message"
            )
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")


async def clarification_summary_stream_generator(task: TaskState):
    """Generator for SSE streaming while getting clarification summary."""
    try:
        # Start summary generation in background
        summary_task = asyncio.create_task(execute_clarification_summary_async(task))

        last_msg_count = len(task.progress_messages)
        while not summary_task.done():
            # Send any new progress messages
            current_count = len(task.progress_messages)
            if current_count > last_msg_count:
                for msg in task.progress_messages[last_msg_count:current_count]:
                    yield sse_message(Div(msg, cls="log-message"), event="message")
                last_msg_count = current_count
            await asyncio.sleep(0.1)

        # Get result
        result = await summary_task

        if result.get("status") == "ready":
            # Store summary
            task.orchestrator_state = task.orchestrator_state or {}
            task.orchestrator_state["clarification_summary"] = result.get("summary", "")
            task.progress_messages = []  # Reset for next phase

            # Always go to prompts planning (prompts page is never skipped)
            task.status = "planning_prompts"

        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")

    except Exception as e:
        logger.error(f"[{task.task_id}] Clarification summary failed: {e}")
        task.status = "error"
        task.error = str(e)
        yield sse_message(Div(f"Error: {e}", cls="log-message error"), event="message")
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")


async def executing_stream_generator(task: TaskState):
    """Generator for SSE streaming during execution phase.

    This phase only persists the pre-generated data to SDK.
    All generation happens in earlier stages.
    """
    # Simplified step map - we're only persisting now
    step_map = {
        "Initializing persistence": ("init", None),
        "Creating prompts and datasets": ("persist", "init"),
        "Setup complete": ("complete", "persist"),
    }
    last_step = None

    try:
        # Immediately activate first step
        yield sse_message(
            step_update_script("execute", "init", "active"), event="message"
        )
        last_step = "init"

        # Start execution in background
        exec_task = asyncio.create_task(execute_setup_async(task))

        last_msg_count = len(task.progress_messages)
        last_progress = None  # Track persistence progress
        while not exec_task.done():
            # Send any new progress messages as step updates
            current_count = len(task.progress_messages)
            if current_count > last_msg_count:
                for msg in task.progress_messages[last_msg_count:current_count]:
                    # Find matching step
                    for key, (step_id, prev_step) in step_map.items():
                        if msg.startswith(key):
                            # Complete previous step if exists
                            if prev_step:
                                yield sse_message(
                                    step_update_script(
                                        "execute", prev_step, "complete"
                                    ),
                                    event="message",
                                )
                            # Activate current step
                            yield sse_message(
                                step_update_script("execute", step_id, "active"),
                                event="message",
                            )
                            last_step = step_id
                            break
                last_msg_count = current_count

            # Check for persistence progress updates
            if task.datapoint_progress and task.datapoint_progress != last_progress:
                dp = task.datapoint_progress
                yield sse_message(
                    progress_bar_update_script(
                        dp["current"], dp["total"], dp["message"]
                    ),
                    event="message",
                )
                last_progress = dp.copy() if isinstance(dp, dict) else dp

            await asyncio.sleep(0.1)

        # Get result
        result = await exec_task

        task.result = result
        task.status = "complete"
        task.orchestrator_state = None

        # Mark final step complete
        if last_step:
            yield sse_message(
                step_update_script("execute", last_step, "complete"), event="message"
            )
        yield sse_message(
            step_update_script("execute", "complete", "complete"), event="message"
        )

        # Short delay for visual feedback then redirect
        await asyncio.sleep(0.5)
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")

    except Exception as e:
        logger.error(f"[{task.task_id}] Execution failed: {e}")
        task.status = "error"
        task.error = str(e)
        # Mark current step as error
        if last_step:
            yield sse_message(
                step_update_script("execute", last_step, "error"), event="message"
            )
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")


async def execute_prompt_planning_async(task: TaskState) -> list:
    """Execute the prompt planning phase (prompts only, no datasets)."""
    form_data = task.form_data
    logger.info(f"[{task.task_id}] Starting prompt planning phase...")

    # Validate form_data exists
    if not form_data or not form_data.get("company_type"):
        raise ValueError(
            "Form data is missing or incomplete. Please restart the setup."
        )

    task.progress_messages.append("Initializing orchestrator...")

    request = WorkspaceSetupRequest(
        company_type=form_data.get("company_type", ""),
        industry=form_data.get("industry", ""),
        specific_instructions=form_data.get("instructions", ""),
        customer_orq_api_key=form_data.get("customer_api_key", ""),
        num_dataset_rows=int(form_data.get("num_rows", 5)),
        num_datasets=int(form_data.get("num_datasets", 2)),
        project_path=form_data.get("project_path", "WorkspaceAgent"),
        default_prompt_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    llm_config = LLMConfig(
        expensive_model=form_data.get("model", "google/gemini-2.5-flash"),
        cheap_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    task.progress_messages.append("Creating workspace orchestrator...")
    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    # Get clarification summary if available
    clarification_summary = ""
    if task.orchestrator_state:
        clarification_summary = task.orchestrator_state.get("clarification_summary", "")

    task.progress_messages.append("Generating prompts...")
    # Use existing planning but extract only prompts
    plan = await orchestrator.run_planning_only(
        request, clarification_summary=clarification_summary
    )
    prompts = plan.get("prompts", [])

    task.progress_messages.append(f"Generated {len(prompts)} prompts")
    logger.success(f"[{task.task_id}] Prompt planning complete")

    return prompts


async def execute_dataset_planning_async(task: TaskState) -> Dict[str, Any]:
    """Execute the dataset planning phase based on approved prompts.

    This now generates FULL datapoints during planning (not just schemas),
    so persistence happens only in the execute stage.
    """
    form_data = task.form_data
    approved_prompts = task.prompts or []
    logger.info(
        f"[{task.task_id}] Starting dataset planning phase with {len(approved_prompts)} prompts..."
    )

    # Validate form_data exists
    if not form_data or not form_data.get("company_type"):
        raise ValueError(
            "Form data is missing or incomplete. Please restart the setup."
        )

    task.progress_messages.append("Analyzing approved prompts...")

    request = WorkspaceSetupRequest(
        company_type=form_data.get("company_type", ""),
        industry=form_data.get("industry", ""),
        specific_instructions=form_data.get("instructions", ""),
        customer_orq_api_key=form_data.get("customer_api_key", ""),
        num_dataset_rows=int(form_data.get("num_rows", 5)),
        num_datasets=int(form_data.get("num_datasets", 2)),
        project_path=form_data.get("project_path", "WorkspaceAgent"),
        default_prompt_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    llm_config = LLMConfig(
        expensive_model=form_data.get("model", "google/gemini-2.5-flash"),
        cheap_model=form_data.get("model", "google/gemini-2.5-flash"),
    )

    task.progress_messages.append("Generating datasets and datapoints...")
    orchestrator = WorkspaceOrchestrator(llm_config=llm_config)

    # Get clarification summary if available
    clarification_summary = ""
    if task.orchestrator_state:
        clarification_summary = task.orchestrator_state.get("clarification_summary", "")

    # Create progress callback for datapoint generation
    def progress_callback(current: int, total: int, message: str):
        task.datapoint_progress = {
            "current": current,
            "total": total,
            "message": message,
        }

    # Generate datasets WITH full datapoints
    plan = await orchestrator.run_full_dataset_planning(
        request,
        approved_prompts=approved_prompts,
        clarification_summary=clarification_summary,
        progress_callback=progress_callback,
    )

    total_datapoints = sum(len(ds.get("datapoints", [])) for ds in plan.get("datasets", []))
    task.progress_messages.append(f"Generated {len(plan.get('datasets', []))} datasets with {total_datapoints} datapoints")
    logger.success(f"[{task.task_id}] Dataset planning complete")

    return plan


async def prompt_planning_stream_generator(task: TaskState):
    """Generator for SSE streaming during prompt planning phase."""
    # Map progress messages to step IDs
    step_map = {
        "Initializing orchestrator": ("init", None),
        "Creating workspace orchestrator": ("create", "init"),
        "Generating prompts": ("plan", "create"),
        "Generated": ("complete", "plan"),
    }
    last_step = None

    try:
        # Immediately activate first step
        yield sse_message(
            step_update_script("prompt-planning", "init", "active"), event="message"
        )
        last_step = "init"

        # Start prompt planning in background
        planning_task = asyncio.create_task(execute_prompt_planning_async(task))

        last_msg_count = 0
        while not planning_task.done():
            # Send any new progress messages as step updates
            current_count = len(task.progress_messages)
            if current_count > last_msg_count:
                for msg in task.progress_messages[last_msg_count:current_count]:
                    # Find matching step
                    for key, (step_id, prev_step) in step_map.items():
                        if msg.startswith(key):
                            # Complete previous step if exists
                            if prev_step:
                                yield sse_message(
                                    step_update_script(
                                        "prompt-planning", prev_step, "complete"
                                    ),
                                    event="message",
                                )
                            # Activate current step
                            yield sse_message(
                                step_update_script(
                                    "prompt-planning", step_id, "active"
                                ),
                                event="message",
                            )
                            last_step = step_id
                            break
                last_msg_count = current_count
            await asyncio.sleep(0.1)

        # Get result
        prompts = await planning_task
        task.prompts = prompts
        task.status = "prompts_ready"

        # Mark final step complete
        if last_step:
            yield sse_message(
                step_update_script("prompt-planning", last_step, "complete"),
                event="message",
            )
        yield sse_message(
            step_update_script("prompt-planning", "complete", "complete"),
            event="message",
        )

        # Short delay for visual feedback then redirect
        await asyncio.sleep(0.5)
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")

    except Exception as e:
        logger.error(f"[{task.task_id}] Prompt planning failed: {e}")
        task.status = "error"
        task.error = str(e)
        yield sse_message(Div(f"Error: {e}", cls="log-message error"), event="message")
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")


async def dataset_planning_stream_generator(task: TaskState):
    """Generator for SSE streaming during dataset planning phase.

    With parallel LLM calls, we use a simplified two-phase approach:
    1. Init phase: Creating dataset schemas
    2. Generate phase: Generating all datapoints in parallel (with progress bar)
    """
    try:
        # Phase 1: Activate init step
        yield sse_message(
            step_update_script("dataset-planning", "init", "active"), event="message"
        )

        # Start dataset planning in background
        planning_task = asyncio.create_task(execute_dataset_planning_async(task))

        # Wait briefly then transition to generate phase
        await asyncio.sleep(0.5)
        yield sse_message(
            step_update_script("dataset-planning", "init", "complete"), event="message"
        )
        yield sse_message(
            step_update_script("dataset-planning", "generate", "active"), event="message"
        )

        # Track progress until complete
        last_progress = None
        while not planning_task.done():
            # Check for datapoint progress updates
            if task.datapoint_progress and task.datapoint_progress != last_progress:
                dp = task.datapoint_progress
                yield sse_message(
                    progress_bar_update_script(
                        dp["current"], dp["total"], dp["message"]
                    ),
                    event="message",
                )
                last_progress = dp.copy() if isinstance(dp, dict) else dp

            await asyncio.sleep(0.1)

        # Get result - this returns the datasets with datapoints
        plan = await planning_task
        # Store datasets (now including datapoints) for review
        task.datasets = plan.get("datasets", [])
        task.status = "datasets_ready"

        # Mark generate and complete steps as done
        yield sse_message(
            step_update_script("dataset-planning", "generate", "complete"),
            event="message",
        )
        yield sse_message(
            step_update_script("dataset-planning", "complete", "complete"),
            event="message",
        )

        # Short delay for visual feedback then redirect
        await asyncio.sleep(0.5)
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")

    except Exception as e:
        logger.error(f"[{task.task_id}] Dataset planning failed: {e}")
        task.status = "error"
        task.error = str(e)
        yield sse_message(Div(f"Error: {e}", cls="log-message error"), event="message")
        yield sse_message(
            Script(
                "htmx.ajax('GET', '/current-state', {target: '#main-content', swap: 'innerHTML'})"
            ),
            event="message",
        )
        yield sse_message("", event="close")
