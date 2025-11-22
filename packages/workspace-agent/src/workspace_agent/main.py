"""
Simplified orchestrator with coordinator loop and structured outputs.
Coordinator decides next action, delegates to specialized agents, loops until complete.
"""

from typing import Dict, Any, List, Optional, Callable
import asyncio

from .config import LLMConfig, PlatformConfig, WorkspaceSetupRequest
from .schemas import (
    CreatedDataset,
    CreatedPrompt,
    WorkspacePlan,
    CoordinatorDecision,
    ClarificationDecision,
    DatasetCreationResult,
    DatapointPlan,
    DatapointPlansResult,
    GeneratedDatapoint,
)
from .agents import WorkspaceAgentFactory
from .log import logger


class WorkspaceOrchestrator:
    """Simplified orchestrator with coordinator loop pattern."""

    MAX_ITERATIONS = 10

    def __init__(
        self,
        llm_config: LLMConfig = None,
        platform_config: PlatformConfig = None,
    ):
        self.llm_config = llm_config or LLMConfig()
        self.platform_config = platform_config or PlatformConfig()
        self.agent_factory = WorkspaceAgentFactory(self.llm_config, self.platform_config)

        # Agents initialized per request
        self.clarification_agent = None
        self.coordinator_agent = None
        self.planning_agent = None
        self.dataset_planner_agent = None
        self.datapoint_plans_agent = None
        self.datapoint_generator_agent = None
        self.prompt_agent = None

        logger.info("WorkspaceOrchestrator initialized")

    def _initialize_agents(self, customer_api_key: str, project_path: str):
        """Initialize SDK tools and create agents."""
        logger.debug("Initializing SDK tools...")
        self.agent_factory.init_sdk_tools(api_key=customer_api_key, project_path=project_path)

        logger.debug("Creating agents...")
        self.clarification_agent = self.agent_factory.create_clarification_agent()
        self.coordinator_agent = self.agent_factory.create_coordinator_agent()
        self.planning_agent = self.agent_factory.create_planning_agent()
        self.dataset_planner_agent = self.agent_factory.create_dataset_planner_agent()
        self.datapoint_plans_agent = self.agent_factory.create_datapoint_plans_agent()
        self.datapoint_generator_agent = self.agent_factory.create_datapoint_generator_agent()
        self.prompt_agent = self.agent_factory.create_prompt_agent()
        logger.info("All agents ready")

    def _build_coordinator_prompt(self, request: WorkspaceSetupRequest, state: Dict[str, Any]) -> str:
        """Build prompt for coordinator to decide next action."""
        plan_status = "Created" if state.get("workspace_plan") else "Not created yet"
        datasets_status = f"{len(state.get('datasets_created', []))} created"
        prompts_status = f"{len(state.get('prompts_created', []))} created"

        # Include any human responses in context
        human_context = ""
        if state.get("human_responses"):
            human_context = "\n\nPrevious clarifications from user:\n"
            for q, a in state["human_responses"]:
                human_context += f"- Q: {q}\n  A: {a}\n"

        return f"""You are coordinating a workspace setup. Decide the next action.

Request:
- Company Type: {request.company_type}
- Industry: {request.industry}
- Instructions: {request.specific_instructions}

Current Status:
- Workspace Plan: {plan_status}
- Datasets: {datasets_status}
- Prompts: {prompts_status}{human_context}

Workflow:
1. First, delegate_planning to create the workspace plan
2. Then, delegate_dataset to create datasets from the plan
3. Then, delegate_prompt to create prompts from the plan
4. Finally, complete when everything is done

Available actions:
- 'delegate_planning': Create the workspace plan
- 'delegate_dataset': Create datasets from the plan
- 'delegate_prompt': Create prompts from the plan
- 'request_human_input': Ask the user a clarifying question (use 'question' field)
- 'complete': Finish when everything is done

Choose ONE action. If the request is unclear or you need more information, use 'request_human_input'.
Provide reasoning for your choice."""

    def _build_clarification_prompt(
        self,
        request: WorkspaceSetupRequest,
        conversation: List[Dict[str, str]],
    ) -> str:
        """Build prompt for clarification agent."""
        # Check if we already have answers (conversation has user responses)
        has_answers = any(msg["role"] == "user" for msg in conversation)

        conversation_context = ""
        if conversation:
            conversation_context = "\n\nUser's answers to clarification questions:\n"
            for msg in conversation:
                if msg["role"] == "user":
                    conversation_context += f"- {msg['content']}\n"

        # If we have answers, generate summary
        if has_answers:
            return f"""You are helping gather requirements before creating a workspace plan.

Initial Request:
- Company Type: {request.company_type}
- Industry: {request.industry}
- Instructions: {request.specific_instructions or '(none provided)'}
- Number of dataset rows: {request.num_dataset_rows}
{conversation_context}

The user has answered your clarification questions.
You MUST now set ready_to_plan=True and provide a comprehensive summary of all requirements.
Synthesize the initial request with all the user's answers into a clear, actionable summary."""

        # First call - generate all 3 questions at once
        return f"""You are helping gather requirements before creating a workspace plan.
Your goal is to understand what the user needs to create useful datasets and prompts.

Initial Request:
- Company Type: {request.company_type}
- Industry: {request.industry}
- Instructions: {request.specific_instructions or '(none provided)'}
- Number of dataset rows: {request.num_dataset_rows}

IMPORTANT: You have a STRICT LIMIT of 3 questions total. Generate all 3 questions now.

Set ready_to_plan=False and provide exactly 3 questions in the 'questions' field.
For EACH question, provide exactly 3 suggested options that the user can choose from.

Your 3 questions should cover:
1. USE CASES: What specific scenarios should the datasets cover?
2. CONTENT TYPE: What types of conversations/interactions should be in the data?
3. TONE/STYLE: What tone and communication style should the prompts have?

Example question format:
{{
  "question": "What customer support scenarios should the dataset include?",
  "options": ["Complaint handling", "Product inquiries", "Technical troubleshooting"]
}}

Make options specific and relevant to the user's industry ({request.industry}) and company type ({request.company_type})."""

    async def run_clarification_loop(
        self,
        request: WorkspaceSetupRequest,
        conversation: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """
        Run clarification loop to gather requirements before planning.

        Args:
            request: The workspace setup request
            conversation: Existing conversation history (for resumption)

        Returns:
            Dict with status='clarifying' and question, or status='ready' with summary
        """
        if conversation is None:
            conversation = []

        logger.info(f"Running clarification loop (conversation length: {len(conversation)})")

        # Lazily initialize clarification agent (doesn't need SDK tools)
        if not self.clarification_agent:
            logger.debug("Lazily initializing clarification agent...")
            self.clarification_agent = self.agent_factory.create_clarification_agent()

        # Build prompt with conversation history
        prompt = self._build_clarification_prompt(request, conversation)

        # Get clarification decision
        result = await self.clarification_agent.ainvoke(prompt)

        # Handle both dict and Pydantic model responses
        if isinstance(result, ClarificationDecision):
            decision = result
        elif isinstance(result, dict):
            decision = ClarificationDecision(**result)
        else:
            raise ValueError(f"Unexpected result type: {type(result)}")

        logger.debug(f"Clarification decision: ready={decision.ready_to_plan}, reasoning={decision.reasoning[:100]}...")

        if decision.ready_to_plan:
            logger.success("Clarification complete - ready to plan")
            return {
                "status": "ready",
                "summary": decision.summary,
                "conversation": conversation,
            }
        else:
            questions_data = [
                {"question": q.question, "options": q.options}
                for q in decision.questions
            ]
            logger.info(f"Clarification questions: {len(questions_data)} questions generated")
            return {
                "status": "clarifying",
                "questions": questions_data,
                "reasoning": decision.reasoning,
                "conversation": conversation,
            }

    def add_clarification_response(
        self,
        conversation: List[Dict[str, str]],
        question: str,
        answer: str,
    ) -> List[Dict[str, str]]:
        """Add a Q&A pair to the clarification conversation."""
        conversation.append({"role": "assistant", "content": question})
        conversation.append({"role": "user", "content": answer})
        logger.debug(f"Added clarification: Q='{question[:50]}...' A='{answer[:50]}...'")
        return conversation

    async def _run_planning(
        self,
        request: WorkspaceSetupRequest,
        clarification_summary: str = "",
    ) -> WorkspacePlan:
        """Run planning agent to create workspace plan."""
        logger.info("Running planning agent...")

        clarification_context = ""
        if clarification_summary:
            clarification_context = f"""
Clarification Summary (from user conversation):
{clarification_summary}

Use this information to create a more tailored plan.
"""

        planning_prompt = f"""Create a workspace plan for:
- Company Type: {request.company_type}
- Industry: {request.industry}
- Instructions: {request.specific_instructions}
- Dataset Rows: {request.num_dataset_rows} per dataset
- Number of Datasets: {request.num_datasets}
- Default Model for Prompts: {request.default_prompt_model}
{clarification_context}
IMPORTANT: Prompts and datasets are 1:1 matched. Create exactly {request.num_datasets} prompts AND {request.num_datasets} datasets.
Each prompt[i] will provide the system_prompt for dataset[i].

Create:
1. Exactly {request.num_datasets} prompt(s), each with:
   - name, description
   - system_prompt: The instruction that defines the AI's role and behavior
     Example: "You are a helpful customer service agent for [Company]. Be professional, empathetic, and solution-oriented."
   - model: Use "{request.default_prompt_model}" for all prompts
   - temperature: 0.7 (or adjust based on use case)

2. Exactly {request.num_datasets} dataset(s), each with:
   - name, description (NO system_prompt - it comes from the matched prompt)
   - fields: "input", "messages", "expected_output"

   Dataset[0] will use the system_prompt from Prompt[0], Dataset[1] from Prompt[1], etc.

Make prompts and datasets practical and industry-appropriate. Ensure each prompt-dataset pair makes sense together."""

        workspace_plan: WorkspacePlan = await self.planning_agent.ainvoke(planning_prompt)
        logger.success(f"Plan created: {len(workspace_plan.datasets)} datasets, {len(workspace_plan.prompts)} prompts")
        return workspace_plan

    async def _run_dataset_creation(
        self,
        plan: WorkspacePlan,
        request: WorkspaceSetupRequest,
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[CreatedDataset]:
        """
        Run hierarchical dataset creation:
        1. Dataset planner creates dataset + plans datapoints
        2. Datapoint generator creates each datapoint

        Args:
            plan: The workspace plan with dataset schemas
            request: The workspace setup request
            progress_callback: Optional callback(current, total, message) for progress updates
        """
        logger.info("Running dataset creation (hierarchical)...")
        created_datasets = []

        # Calculate total datapoints across all datasets
        total_datapoints = len(plan.datasets) * request.num_dataset_rows
        current_datapoint = 0

        for ds_idx, ds_schema in enumerate(plan.datasets):
            logger.info(f"Creating dataset: {ds_schema.name}")

            # Get the system_prompt from the matched prompt (1:1 matching by index)
            if ds_idx < len(plan.prompts):
                system_prompt = plan.prompts[ds_idx].system_prompt
                logger.debug(f"Using system_prompt from prompt[{ds_idx}]: {plan.prompts[ds_idx].name}")
            else:
                logger.warning(f"No matching prompt for dataset[{ds_idx}], using empty system_prompt")
                system_prompt = ""

            # Step 1: Dataset planner creates dataset and plans datapoints
            planner_prompt = f"""Create a dataset for:
- Name: {ds_schema.name}
- Description: {ds_schema.description}
- Number of datapoints to plan: {request.num_dataset_rows}
- Company Type: {request.company_type}
- Industry: {request.industry}

Call create_dataset first, then return your result with the dataset_id and datapoint_plans."""

            agent_input = {
                "messages": [{"role": "user", "content": planner_prompt}],
                "workspace_key": request.workspace_key,
                "customer_orq_api_key": request.customer_orq_api_key,
                "project_path": request.project_path,
                "company_type": request.company_type,
                "industry": request.industry,
                "num_dataset_rows": request.num_dataset_rows,
            }

            try:
                planner_result = await self.dataset_planner_agent.ainvoke(agent_input)

                # Extract the structured result from the agent
                dataset_result = self._extract_dataset_result(planner_result)

                if not dataset_result:
                    logger.error(f"Failed to get dataset result for {ds_schema.name}")
                    continue

                logger.info(f"Dataset created: {dataset_result.dataset_id} with {len(dataset_result.datapoint_plans)} plans")

                # Step 2: Generate each datapoint using the subagent
                num_plans = len(dataset_result.datapoint_plans)
                for i, dp_plan in enumerate(dataset_result.datapoint_plans):
                    current_datapoint += 1
                    logger.debug(f"Generating datapoint {i + 1}/{num_plans}: {dp_plan.description[:50]}...")

                    # Report progress before generating
                    if progress_callback:
                        progress_callback(
                            current_datapoint,
                            total_datapoints,
                            f"Creating datapoint {i + 1}/{num_plans} for {ds_schema.name}",
                        )

                    await self._generate_datapoint(
                        dataset_id=dataset_result.dataset_id,
                        plan=dp_plan,
                        request=request,
                        system_prompt=system_prompt,  # From matched prompt
                    )

                created_datasets.append(
                    CreatedDataset(
                        id=dataset_result.dataset_id,
                        name=dataset_result.dataset_name,
                        description=ds_schema.description,
                    )
                )
                logger.success(f"Dataset {ds_schema.name} complete with {len(dataset_result.datapoint_plans)} datapoints")

            except Exception as e:
                logger.error(f"Failed to create dataset {ds_schema.name}: {e}")

        logger.success(f"Created {len(created_datasets)} datasets")
        return created_datasets

    async def _generate_datapoint(
        self,
        dataset_id: str,
        plan: DatapointPlan,
        request: WorkspaceSetupRequest,
        system_prompt: str,
    ) -> None:
        """
        Generate a single datapoint using structured output, then store via SDK.

        Flow:
        1. Call datapoint generator (structured output) to get GeneratedDatapoint
        2. Call SDK add_datapoint tool directly to store it
        """
        # Build input keys constraint based on user configuration
        if request.input_keys:
            input_keys_instruction = f"""INPUT KEYS CONSTRAINT:
You MUST use EXACTLY these input variable names: {request.input_keys}
- Use ALL of these keys in your inputs
- Do NOT create any other variable names
- Each key must be referenced as {{{{key}}}} in the messages"""
        else:
            input_keys_instruction = """INPUT KEYS CONSTRAINT:
- Generate at most 3 input variables
- Keep inputs minimal and focused on the most important dynamic content"""

        generator_prompt = f"""Generate realistic synthetic data for a datapoint.

Plan:
- Description: {plan.description}
- Scenario: {plan.scenario}
- Tone: {plan.tone}
- Key Elements: {', '.join(plan.key_elements) if plan.key_elements else 'None specified'}

Company Context:
- Type: {request.company_type}
- Industry: {request.industry}

SYSTEM PROMPT (include as first message with role "system"):
{system_prompt}

{input_keys_instruction}

IMPORTANT RULES:
1. The `inputs` field contains ONLY variables that are actually used in messages via {{{{variable}}}} syntax
2. Do NOT create input variables that aren't referenced in messages
3. Only use template variables where dynamic content makes sense (user queries, names, order IDs)
4. Static content like the system prompt should NOT be templated

Generate:
1. inputs: Key-value mapping ONLY for variables used in messages
   Example: {{"user_query": "My order #12345 hasn't arrived"}}

2. messages: Must include:
   - First: {{"role": "system", "content": "<the system prompt above>"}}
   - Then: User/assistant messages with {{{{variable}}}} for dynamic content
   Example: [{{"role": "system", "content": "..."}}, {{"role": "user", "content": "{{{{user_query}}}}"}}]

3. expected_output: The ideal assistant response

VALIDATION:
- Every key in inputs MUST appear as {{{{key}}}} somewhere in messages
- System message uses the exact system prompt provided (not templated)

Match the tone specified in the plan."""

        try:
            if not self.datapoint_generator_agent:
                raise RuntimeError("Datapoint generator agent not initialized")

            # Step 1: Generate structured datapoint content
            result = await self.datapoint_generator_agent.ainvoke(generator_prompt)

            # Handle both dict and Pydantic model responses
            if isinstance(result, GeneratedDatapoint):
                datapoint = result
            elif isinstance(result, dict):
                datapoint = GeneratedDatapoint(**result)
            else:
                raise ValueError(f"Unexpected result type: {type(result)}")

            logger.debug(f"Generated datapoint content for: {plan.description[:30]}...")

            # Step 2: Store via SDK tool
            sdk_tools = self.agent_factory.get_sdk_tools()
            datapoint_id = sdk_tools.add_datapoint(
                dataset_id=dataset_id,
                inputs=datapoint.inputs,
                messages=datapoint.messages,
                expected_output=datapoint.expected_output,
            )
            logger.debug(f"Datapoint stored: {datapoint_id}")

        except Exception as e:
            logger.error(f"Failed to generate/store datapoint: {e}")

    async def generate_single_datapoint(
        self,
        plan: DatapointPlan,
        request: WorkspaceSetupRequest,
        system_prompt: str,
    ) -> Optional[GeneratedDatapoint]:
        """
        Generate a single datapoint content WITHOUT persisting to SDK.

        Args:
            plan: The high-level plan for this datapoint
            request: Workspace setup request with context
            system_prompt: The system prompt from the matched prompt

        Returns:
            GeneratedDatapoint with inputs, messages, expected_output, or None on error
        """
        # Build input keys constraint based on user configuration
        if request.input_keys:
            input_keys_instruction = f"""INPUT KEYS CONSTRAINT:
You MUST use EXACTLY these input variable names: {request.input_keys}
- Use ALL of these keys in your inputs
- Do NOT create any other variable names
- Each key must be referenced as {{{{key}}}} in the messages"""
        else:
            input_keys_instruction = """INPUT KEYS CONSTRAINT:
- Generate at most 3 input variables
- Keep inputs minimal and focused on the most important dynamic content"""

        generator_prompt = f"""Generate realistic synthetic data for a datapoint.

Plan:
- Description: {plan.description}
- Scenario: {plan.scenario}
- Tone: {plan.tone}
- Key Elements: {', '.join(plan.key_elements) if plan.key_elements else 'None specified'}

Company Context:
- Type: {request.company_type}
- Industry: {request.industry}

SYSTEM PROMPT (include as first message with role "system"):
{system_prompt}

{input_keys_instruction}

IMPORTANT RULES:
1. The `inputs` field contains ONLY variables that are actually used in messages via {{{{variable}}}} syntax
2. Do NOT create input variables that aren't referenced in messages
3. Only use template variables where dynamic content makes sense (user queries, names, order IDs)
4. Static content like the system prompt should NOT be templated

Generate:
1. inputs: Key-value mapping ONLY for variables used in messages
   Example: {{"user_query": "My order #12345 hasn't arrived"}}

2. messages: Must include:
   - First: {{"role": "system", "content": "<the system prompt above>"}}
   - Then: User/assistant messages with {{{{variable}}}} for dynamic content
   Example: [{{"role": "system", "content": "..."}}, {{"role": "user", "content": "{{{{user_query}}}}"}}]

3. expected_output: The ideal assistant response

VALIDATION:
- Every key in inputs MUST appear as {{{{key}}}} somewhere in messages
- System message uses the exact system prompt provided (not templated)

Match the tone specified in the plan."""

        try:
            if not self.datapoint_generator_agent:
                raise RuntimeError("Datapoint generator agent not initialized")

            # Generate structured datapoint content
            result = await self.datapoint_generator_agent.ainvoke(generator_prompt)

            # Handle both dict and Pydantic model responses
            if isinstance(result, GeneratedDatapoint):
                return result
            elif isinstance(result, dict):
                return GeneratedDatapoint(**result)
            else:
                raise ValueError(f"Unexpected result type: {type(result)}")

        except Exception as e:
            logger.error(f"Failed to generate datapoint: {e}")
            return None

    def _extract_dataset_result(self, agent_result: Dict[str, Any]) -> Optional[DatasetCreationResult]:
        """Extract DatasetCreationResult from agent output."""
        # Check if result has structured_response (from response_format)
        if "structured_response" in agent_result:
            sr = agent_result["structured_response"]
            if isinstance(sr, DatasetCreationResult):
                return sr
            if isinstance(sr, dict):
                return DatasetCreationResult(**sr)

        # Try to extract from messages
        messages = agent_result.get("messages", [])
        for msg in reversed(messages):
            # Check for structured output in message content
            if hasattr(msg, "content") and isinstance(msg.content, dict):
                try:
                    return DatasetCreationResult(**msg.content)
                except Exception:
                    pass

            # Check for tool calls that might contain the result
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                for tool_call in msg.tool_calls:
                    if tool_call.get("name") == "create_dataset":
                        args = tool_call.get("args", {})
                        # The tool returns the dataset_id
                        # We need to construct the result from context
                        pass

        logger.warning("Could not extract DatasetCreationResult from agent output")
        return None

    async def _run_prompt_creation(self, plan: WorkspacePlan, request: WorkspaceSetupRequest) -> List[CreatedPrompt]:
        """Run prompt agent to create prompts."""
        logger.info("Running prompt agent...")

        prompt_prompt = f"""Create the following prompts:

{self._format_prompts(plan)}

For each prompt, use create_prompt with the appropriate parameters.
Then call report_prompt_results with the created prompts."""

        agent_input = {
            "messages": [{"role": "user", "content": prompt_prompt}],
            "workspace_key": request.workspace_key,
            "customer_orq_api_key": request.customer_orq_api_key,
            "project_path": request.project_path,
            "company_type": request.company_type,
            "industry": request.industry,
            "num_dataset_rows": request.num_dataset_rows,
        }

        result = await self.prompt_agent.ainvoke(agent_input)
        prompts = self._extract_prompts_from_messages(result.get("messages", []))
        logger.success(f"Created {len(prompts)} prompts")
        return prompts

    def _format_prompts(self, plan: WorkspacePlan) -> str:
        """Format prompts for agent prompt."""
        lines = []
        for i, p in enumerate(plan.prompts, 1):
            lines.append(f"Prompt {i}: {p.name}")
            lines.append(f"  Description: {p.description}")
            lines.append(f"  System Prompt: {p.system_prompt[:100]}..." if len(p.system_prompt) > 100 else f"  System Prompt: {p.system_prompt}")
            lines.append(f"  Model: {p.model}")
            lines.append(f"  Temperature: {p.temperature}")
        return "\n".join(lines)

    def _extract_prompts_from_messages(self, messages) -> List[CreatedPrompt]:
        """Extract prompts from agent messages."""
        for message in reversed(messages):
            if hasattr(message, "tool_calls") and message.tool_calls:
                for tool_call in message.tool_calls:
                    if tool_call.get("name") == "report_prompt_results":
                        args = tool_call.get("args", {})
                        return [
                            CreatedPrompt(
                                id=p.get("id", ""),
                                name=p.get("name", ""),
                                description=p.get("description", ""),
                            )
                            for p in args.get("created_prompts", [])
                        ]
        return []

    async def setup_workspace(
        self,
        request: WorkspaceSetupRequest,
        resumed_state: Optional[Dict[str, Any]] = None,
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> Dict[str, Any]:
        """Main entry point - coordinator loop with structured output decisions.

        Args:
            request: Workspace setup configuration
            resumed_state: Optional state from previous run (for resuming after human input)
            progress_callback: Optional callback(current, total, message) for progress updates

        Returns:
            Dict with status, results, or question for human input
        """
        logger.info(f"Starting workspace setup: {request.company_type} in {request.industry}")

        self._initialize_agents(request.customer_orq_api_key, request.project_path)

        # State tracking - resume from previous state if provided
        # Default state structure
        default_state = {
            "workspace_plan": None,
            "datasets_created": [],
            "prompts_created": [],
            "errors": [],
            "human_responses": [],
            "clarification_summary": "",  # From pre-planning clarification
        }

        if resumed_state:
            # Merge resumed state with defaults to ensure all keys exist
            state = {**default_state, **resumed_state}
            logger.info(f"Resuming from previous state with {len(state.get('human_responses', []))} human responses")
        else:
            state = default_state

        # Coordinator loop
        for iteration in range(self.MAX_ITERATIONS):
            logger.debug(f"Coordinator iteration {iteration + 1}/{self.MAX_ITERATIONS}")

            # Get coordinator decision (structured output)
            coordinator_prompt = self._build_coordinator_prompt(request, state)
            decision: CoordinatorDecision = await self.coordinator_agent.ainvoke(coordinator_prompt)
            logger.info(f"Coordinator decision: {decision.action} - {decision.reasoning[:100]}...")

            # Execute decided action
            if decision.action == "delegate_planning":
                logger.debug("Delegating to planning agent...")
                try:
                    state["workspace_plan"] = await self._run_planning(
                        request,
                        clarification_summary=state.get("clarification_summary", ""),
                    )
                except Exception as e:
                    logger.error(f"Planning failed: {e}")
                    state["errors"].append(f"Planning failed: {str(e)}")

            elif decision.action == "delegate_dataset":
                if not state["workspace_plan"]:
                    logger.warning("No plan available, skipping dataset creation")
                    continue
                logger.debug("Delegating to dataset agent...")
                try:
                    state["datasets_created"] = await self._run_dataset_creation(
                        state["workspace_plan"], request, progress_callback=progress_callback
                    )
                except Exception as e:
                    logger.error(f"Dataset creation failed: {e}")
                    state["errors"].append(f"Dataset creation failed: {str(e)}")

            elif decision.action == "delegate_prompt":
                if not state["workspace_plan"]:
                    logger.warning("No plan available, skipping prompt creation")
                    continue
                logger.debug("Delegating to prompt agent...")
                try:
                    state["prompts_created"] = await self._run_prompt_creation(
                        state["workspace_plan"], request
                    )
                except Exception as e:
                    logger.error(f"Prompt creation failed: {e}")
                    state["errors"].append(f"Prompt creation failed: {str(e)}")

            elif decision.action == "request_human_input":
                logger.info(f"Coordinator requesting human input: {decision.question}")
                return {
                    "status": "awaiting_input",
                    "question": decision.question,
                    "reasoning": decision.reasoning,
                    "state": state,
                }

            elif decision.action == "complete":
                logger.success("Workspace setup complete!")
                break
            else:
                logger.warning(f"Unknown action: {decision.action}")

        # Return results
        return {
            "status": "complete",
            "workspace_key": request.workspace_key,
            "datasets_created": state["datasets_created"],
            "prompts_created": state["prompts_created"],
            "errors": state["errors"],
        }

    def add_human_response(self, state: Dict[str, Any], question: str, answer: str) -> Dict[str, Any]:
        """Add a human response to the state for resumption."""
        if "human_responses" not in state:
            state["human_responses"] = []
        state["human_responses"].append((question, answer))
        logger.debug(f"Added human response: Q='{question[:50]}...' A='{answer[:50]}...'")
        return state

    async def run_planning_only(
        self, request: WorkspaceSetupRequest, clarification_summary: str = ""
    ) -> Dict[str, Any]:
        """Dry-run mode: only create the plan, don't execute it."""
        logger.info(f"Running planning only (dry-run) for: {request.company_type} in {request.industry}")

        self._initialize_agents(request.customer_orq_api_key, request.project_path)
        workspace_plan = await self._run_planning(request, clarification_summary=clarification_summary)

        return {
            "reasoning": workspace_plan.reasoning,
            "datasets": [d.model_dump() for d in workspace_plan.datasets],
            "prompts": [p.model_dump() for p in workspace_plan.prompts],
        }

    async def run_dataset_planning(
        self,
        request: WorkspaceSetupRequest,
        approved_prompts: list,
        clarification_summary: str = "",
    ) -> Dict[str, Any]:
        """Generate datasets aligned to pre-approved prompts.

        Args:
            request: The workspace setup request
            approved_prompts: List of prompt dicts that have been reviewed and approved
            clarification_summary: Optional summary from clarification phase
        """
        logger.info(f"Running dataset planning with {len(approved_prompts)} approved prompts")

        self._initialize_agents(request.customer_orq_api_key, request.project_path)

        clarification_context = ""
        if clarification_summary:
            clarification_context = f"""
Clarification Summary (from user conversation):
{clarification_summary}

Use this information to create more tailored datasets.
"""

        # Generate datasets 1:1 matched to the approved prompts
        # Build detailed prompt context including which dataset matches which prompt
        prompt_details = "\n".join([
            f"- Prompt[{i}] '{p.get('name', 'Unnamed')}': {p.get('description', 'No description')}"
            for i, p in enumerate(approved_prompts)
        ])

        planning_prompt = f"""Create datasets for:
- Company Type: {request.company_type}
- Industry: {request.industry}
- Instructions: {request.specific_instructions}
- Dataset Rows: {request.num_dataset_rows} per dataset
- Number of Datasets: {len(approved_prompts)} (one per approved prompt)
{clarification_context}
The following prompts have been approved. Create ONE dataset for EACH prompt (1:1 matching):
{prompt_details}

IMPORTANT: Datasets do NOT have their own system_prompt - they will use the system_prompt from their matched prompt.
- Dataset[0] will use system_prompt from Prompt[0]
- Dataset[1] will use system_prompt from Prompt[1]
- etc.

Create exactly {len(approved_prompts)} dataset(s), each with:
- name, description (NO system_prompt field)
- fields: "input", "messages", "expected_output"
- Test cases that work well with the corresponding prompt's system_prompt

Make the datasets practical, diverse, and industry-appropriate."""

        workspace_plan: WorkspacePlan = await self.planning_agent.ainvoke(planning_prompt)
        logger.success(f"Dataset plan created: {len(workspace_plan.datasets)} datasets")

        return {
            "reasoning": workspace_plan.reasoning,
            "datasets": [d.model_dump() for d in workspace_plan.datasets],
        }

    async def run_full_dataset_planning(
        self,
        request: WorkspaceSetupRequest,
        approved_prompts: list,
        clarification_summary: str = "",
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> Dict[str, Any]:
        """Generate datasets with ALL datapoints during planning phase.

        This method:
        1. Generates dataset schemas aligned to approved prompts
        2. Generates datapoint plans for each dataset
        3. Generates full datapoint content for each plan
        4. Returns everything for review (no SDK persistence)

        Args:
            request: The workspace setup request
            approved_prompts: List of prompt dicts that have been reviewed and approved
            clarification_summary: Optional summary from clarification phase
            progress_callback: Optional callback for progress updates (current, total, message)

        Returns:
            Dict with datasets including their generated datapoints
        """
        logger.info(f"Running full dataset planning with {len(approved_prompts)} approved prompts")

        self._initialize_agents(request.customer_orq_api_key, request.project_path)

        # Step 1: Generate dataset schemas (same as run_dataset_planning)
        clarification_context = ""
        if clarification_summary:
            clarification_context = f"""
Clarification Summary (from user conversation):
{clarification_summary}

Use this information to create more tailored datasets.
"""

        prompt_details = "\n".join([
            f"- Prompt[{i}] '{p.get('name', 'Unnamed')}': {p.get('description', 'No description')}"
            for i, p in enumerate(approved_prompts)
        ])

        planning_prompt = f"""Create datasets for:
- Company Type: {request.company_type}
- Industry: {request.industry}
- Instructions: {request.specific_instructions}
- Dataset Rows: {request.num_dataset_rows} per dataset
- Number of Datasets: {len(approved_prompts)} (one per approved prompt)
{clarification_context}
The following prompts have been approved. Create ONE dataset for EACH prompt (1:1 matching):
{prompt_details}

IMPORTANT: Datasets do NOT have their own system_prompt - they will use the system_prompt from their matched prompt.
- Dataset[0] will use system_prompt from Prompt[0]
- Dataset[1] will use system_prompt from Prompt[1]
- etc.

Create exactly {len(approved_prompts)} dataset(s), each with:
- name, description (NO system_prompt field)
- fields: "input", "messages", "expected_output"
- Test cases that work well with the corresponding prompt's system_prompt

Make the datasets practical, diverse, and industry-appropriate."""

        workspace_plan: WorkspacePlan = await self.planning_agent.ainvoke(planning_prompt)
        logger.success(f"Dataset schemas created: {len(workspace_plan.datasets)} datasets")

        # Step 2: Generate datapoint plans for ALL datasets in parallel
        logger.info("Generating datapoint plans for all datasets in parallel...")

        async def generate_plans_for_dataset(idx: int, dataset_schema):
            matched_prompt = approved_prompts[idx] if idx < len(approved_prompts) else {}
            system_prompt = matched_prompt.get("system_prompt", "You are a helpful assistant.")
            plans = await self._generate_datapoint_plans(dataset_schema, request, system_prompt)
            return idx, dataset_schema, system_prompt, plans

        plan_results = await asyncio.gather(*[
            generate_plans_for_dataset(idx, ds)
            for idx, ds in enumerate(workspace_plan.datasets)
        ])

        logger.success(f"Generated datapoint plans for {len(plan_results)} datasets")

        # Step 3: Generate ALL datapoints in parallel across all datasets
        # First, build list of all generation tasks
        all_tasks = []
        for idx, dataset_schema, system_prompt, datapoint_plans in plan_results:
            for plan in datapoint_plans:
                all_tasks.append((idx, dataset_schema, system_prompt, plan))

        total_datapoints = len(all_tasks)
        logger.info(f"Generating {total_datapoints} datapoints in parallel...")

        if progress_callback:
            progress_callback(0, total_datapoints, f"Generating {total_datapoints} datapoints...")

        # Track progress with atomic counter
        completed_count = [0]  # Use list to allow mutation in nested function

        async def generate_datapoint_with_progress(task_info):
            idx, _, system_prompt, plan = task_info
            datapoint = await self.generate_single_datapoint(plan, request, system_prompt)
            completed_count[0] += 1
            if progress_callback:
                progress_callback(
                    completed_count[0],
                    total_datapoints,
                    f"Generated {completed_count[0]}/{total_datapoints} datapoints"
                )
            return idx, datapoint

        datapoint_results = await asyncio.gather(*[
            generate_datapoint_with_progress(task) for task in all_tasks
        ])

        # Step 4: Group datapoints by dataset index
        datasets_with_datapoints = []
        for idx, dataset_schema, system_prompt, datapoint_plans in plan_results:
            generated_datapoints = []
            for result_idx, datapoint in datapoint_results:
                if result_idx == idx and datapoint:
                    generated_datapoints.append(datapoint.model_dump())

            if len(generated_datapoints) < len(datapoint_plans):
                failed_count = len(datapoint_plans) - len(generated_datapoints)
                logger.warning(f"Failed to generate {failed_count} datapoints for {dataset_schema.name}")

            dataset_dict = dataset_schema.model_dump()
            dataset_dict["datapoints"] = generated_datapoints
            dataset_dict["matched_prompt_index"] = idx
            datasets_with_datapoints.append(dataset_dict)

            logger.success(f"Generated {len(generated_datapoints)} datapoints for {dataset_schema.name}")

        if progress_callback:
            progress_callback(total_datapoints, total_datapoints, "All datapoints generated")

        return {
            "reasoning": workspace_plan.reasoning,
            "datasets": datasets_with_datapoints,
        }

    async def _generate_datapoint_plans(
        self,
        dataset_schema,
        request: WorkspaceSetupRequest,
        system_prompt: str,
    ) -> List[DatapointPlan]:
        """Generate high-level plans for datapoints in a dataset."""
        planning_prompt = f"""Create {request.num_dataset_rows} diverse test case plans for:

Dataset: {dataset_schema.name}
Description: {dataset_schema.description}

Company Context:
- Type: {request.company_type}
- Industry: {request.industry}

System Prompt that will be used:
{system_prompt}

Create {request.num_dataset_rows} diverse DatapointPlan items, each with:
- description: Brief description of the test case
- scenario: Specific scenario details
- tone: Tone of the interaction (frustrated, polite, confused, etc.)
- key_elements: Key elements to include

Make the plans diverse, covering different scenarios, tones, and edge cases."""

        if not self.datapoint_plans_agent:
            raise RuntimeError("Datapoint plans agent not initialized")

        result = await self.datapoint_plans_agent.ainvoke(planning_prompt)

        # Extract datapoint plans from result
        if isinstance(result, DatapointPlansResult):
            return result.datapoint_plans
        elif isinstance(result, dict) and "datapoint_plans" in result:
            return [DatapointPlan(**p) for p in result["datapoint_plans"]]
        else:
            logger.warning(f"Unexpected result type from datapoint plans agent: {type(result)}")
            return []

    async def persist_plan(
        self,
        request: WorkspaceSetupRequest,
        approved_prompts: list,
        approved_datasets: list,
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> Dict[str, Any]:
        """Persist approved prompts and datasets (with datapoints) to SDK.

        This is the ONLY method that writes to the SDK. It takes pre-generated
        data from the planning phases and persists it.

        Args:
            request: Workspace setup request
            approved_prompts: List of approved prompt dicts
            approved_datasets: List of approved dataset dicts (with 'datapoints' key)
            progress_callback: Optional callback for progress updates

        Returns:
            Dict with created prompt/dataset IDs and any errors
        """
        logger.info(f"Persisting plan: {len(approved_prompts)} prompts, {len(approved_datasets)} datasets")

        self._initialize_agents(request.customer_orq_api_key, request.project_path)
        sdk_tools = self.agent_factory.get_sdk_tools()

        created_prompts = []
        created_datasets = []
        errors = []

        total_items = len(approved_prompts) + len(approved_datasets)
        # Count total datapoints for progress
        total_datapoints = sum(len(ds.get("datapoints", [])) for ds in approved_datasets)
        total_operations = total_items + total_datapoints
        current_operation = 0

        # Step 1: Create prompts
        for prompt in approved_prompts:
            current_operation += 1
            if progress_callback:
                progress_callback(
                    current_operation,
                    total_operations,
                    f"Creating prompt: {prompt.get('name', 'Unnamed')}"
                )
            try:
                prompt_id = sdk_tools._create_prompt(
                    display_name=prompt.get("name", "Unnamed Prompt"),
                    system_prompt=prompt.get("system_prompt", ""),
                    model=prompt.get("model", request.default_prompt_model),
                    temperature=prompt.get("temperature", 0.7),
                )
                created_prompts.append(CreatedPrompt(
                    id=prompt_id,
                    name=prompt.get("name", "Unnamed Prompt"),
                    description=prompt.get("description", ""),
                ))
                logger.success(f"Created prompt: {prompt.get('name')} -> {prompt_id}")
            except Exception as e:
                error_msg = f"Failed to create prompt {prompt.get('name')}: {e}"
                logger.error(error_msg)
                errors.append(error_msg)

        # Step 2: Create datasets and their datapoints
        for dataset in approved_datasets:
            current_operation += 1
            if progress_callback:
                progress_callback(
                    current_operation,
                    total_operations,
                    f"Creating dataset: {dataset.get('name', 'Unnamed')}"
                )
            try:
                dataset_id = sdk_tools._create_dataset(
                    display_name=dataset.get("name", "Unnamed Dataset"),
                    description=dataset.get("description", ""),
                )
                logger.success(f"Created dataset: {dataset.get('name')} -> {dataset_id}")

                # Add datapoints to dataset
                datapoints = dataset.get("datapoints", [])
                for dp in datapoints:
                    current_operation += 1
                    if progress_callback:
                        progress_callback(
                            current_operation,
                            total_operations,
                            f"Adding datapoint to {dataset.get('name')}"
                        )
                    try:
                        sdk_tools.add_datapoint(
                            dataset_id=dataset_id,
                            inputs=dp.get("inputs", {}),
                            messages=dp.get("messages", []),
                            expected_output=dp.get("expected_output", ""),
                        )
                    except Exception as e:
                        error_msg = f"Failed to add datapoint to {dataset.get('name')}: {e}"
                        logger.error(error_msg)
                        errors.append(error_msg)

                created_datasets.append(CreatedDataset(
                    id=dataset_id,
                    name=dataset.get("name", "Unnamed Dataset"),
                    description=dataset.get("description", ""),
                    datapoint_count=len(datapoints),
                ))

            except Exception as e:
                error_msg = f"Failed to create dataset {dataset.get('name')}: {e}"
                logger.error(error_msg)
                errors.append(error_msg)

        if progress_callback:
            progress_callback(total_operations, total_operations, "Complete")

        return {
            "status": "complete",
            "prompts_created": created_prompts,
            "datasets_created": created_datasets,
            "errors": errors,
        }


# CLI Entry point
async def main():
    """CLI entry point for testing."""
    logger.info("Workspace Agent - CLI Mode")

    try:
        company_type = input("Company type: ").strip()
        industry = input("Industry: ").strip()
        instructions = input("Special instructions (optional): ").strip()
        workspace_key = input("Workspace key: ").strip()
        customer_api_key = input("Customer API key: ").strip()
        project_path = input("Project path (default 'Example'): ").strip() or "Example"
        num_rows = int(input("Dataset rows (default 10): ").strip() or "10")

        request = WorkspaceSetupRequest(
            company_type=company_type,
            industry=industry,
            specific_instructions=instructions,
            workspace_key=workspace_key,
            customer_orq_api_key=customer_api_key,
            project_path=project_path,
            num_dataset_rows=num_rows,
        )

        orchestrator = WorkspaceOrchestrator()
        result = await orchestrator.setup_workspace(request)

        logger.success(f"Setup complete! Datasets: {len(result['datasets_created'])}, Prompts: {len(result['prompts_created'])}")

        if result["errors"]:
            for error in result["errors"]:
                logger.warning(f"Error: {error}")

    except KeyboardInterrupt:
        logger.info("Cancelled by user")
    except Exception as e:
        logger.error(f"Setup failed: {e}")


if __name__ == "__main__":
    asyncio.run(main())
