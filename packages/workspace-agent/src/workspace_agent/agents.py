"""
Specialized agents using hybrid approach:
- Planning/Coordinator: Structured outputs with .with_structured_output()
- Dataset/Prompt: Agents with SDK tools + structured output planning/generation

Supports both SDK tools (direct) and MCP tools (via TypeScript server).
"""

from typing import Optional, List

from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI
from langchain_core.tools import StructuredTool, BaseTool

from .config import LLMConfig, PlatformConfig
from .state import WorkspaceState, ChatAgentState
from .schemas import (
    WorkspacePlan,
    CoordinatorDecision,
    ClarificationDecision,
    DatasetCreationResult,
    DatapointPlansResult,
    GeneratedDatapoint,
)
from .sdk_tools import OrqSDKTools
from .tools import initialize_mcp_client, get_mcp_tools, cleanup_mcp_client
from .log import logger


class WorkspaceAgentFactory:
    """Factory for creating specialized workspace agents.

    Supports two tool backends:
    - SDK tools: Direct SDK calls (init_sdk_tools)
    - MCP tools: Via TypeScript MCP server (init_mcp_tools)
    """

    def __init__(
        self,
        llm_config: Optional[LLMConfig] = None,
        platform_config: Optional[PlatformConfig] = None,
    ):
        self.llm_config = llm_config or LLMConfig()
        self.platform_config = platform_config or PlatformConfig()
        self._sdk_tools: Optional[OrqSDKTools] = None
        self._mcp_tools: Optional[List[BaseTool]] = None

    def init_sdk_tools(self, api_key: str, project_path: str):
        """Initialize SDK tools with customer API key and project path."""
        self._sdk_tools = OrqSDKTools(api_key=api_key, project_path=project_path)
        logger.info(f"SDK tools initialized for project: {project_path}")

    async def init_mcp_tools(self, api_key: str):
        """Initialize MCP tools with customer API key.

        Uses the TypeScript MCP server (orq_mcp_ts) via stdio transport.
        """
        await initialize_mcp_client(api_key)
        self._mcp_tools = await get_mcp_tools()
        logger.info(f"MCP tools initialized: {len(self._mcp_tools)} tools available")

    async def cleanup_mcp(self):
        """Cleanup MCP client resources."""
        await cleanup_mcp_client()
        self._mcp_tools = None
        logger.info("MCP tools cleaned up")

    def get_llm(self, use_expensive: bool = False):
        """Get LLM instance for agents"""
        model_name = (
            self.llm_config.expensive_model
            if use_expensive
            else self.llm_config.cheap_model
        )

        return ChatOpenAI(
            model=model_name,
            temperature=self.llm_config.temperature,
            max_tokens=self.llm_config.max_tokens,
            openai_api_key=self.platform_config.orq_api_key,
            openai_api_base=self.platform_config.orq_base_url,
        )

    def create_coordinator_agent(self):
        """
        Create coordinator agent that orchestrates the entire workspace setup process.
        Returns structured CoordinatorDecision for next action.
        """
        logger.debug(f"Creating coordinator agent with model: {self.llm_config.expensive_model}")
        llm = self.get_llm(use_expensive=True)
        return llm.with_structured_output(CoordinatorDecision)

    def create_clarification_agent(self):
        """
        Create clarification agent that gathers requirements before planning.
        Uses multi-turn conversation to understand user needs.
        Returns structured ClarificationDecision.
        """
        logger.debug(f"Creating clarification agent with model: {self.llm_config.expensive_model}")
        llm = self.get_llm(use_expensive=True)
        return llm.with_structured_output(ClarificationDecision)

    def create_planning_agent(self):
        """
        Create planning agent that analyzes requirements and creates workspace plans.
        Returns structured WorkspacePlan with datasets and prompts.
        """
        logger.debug(f"Creating planning agent with model: {self.llm_config.expensive_model}")
        llm = self.get_llm(use_expensive=True)
        return llm.with_structured_output(WorkspacePlan)

    def create_datapoint_plans_agent(self):
        """
        Create a simple structured output agent for generating datapoint plans.
        This agent doesn't use tools - it just generates structured plans.
        Returns structured DatapointPlansResult with a list of datapoint plans.
        """
        logger.debug(f"Creating datapoint plans agent with model: {self.llm_config.cheap_model}")
        llm = self.get_llm(use_expensive=False)
        return llm.with_structured_output(DatapointPlansResult)

    def create_dataset_planner_agent(self):
        """
        Create dataset planner agent that:
        1. Creates a dataset using SDK tools
        2. Plans N datapoints (high-level descriptions)

        Returns structured DatasetCreationResult with dataset_id and datapoint_plans.
        """
        logger.debug(f"Creating dataset planner agent with model: {self.llm_config.expensive_model}")

        if not self._sdk_tools:
            raise RuntimeError("SDK tools not initialized. Call init_sdk_tools() first.")

        llm = self.get_llm(use_expensive=True)

        # Get only the create_dataset tool for this agent
        dataset_tools = [
            tool for tool in self._sdk_tools.get_dataset_tools()
            if tool.name == "create_dataset"
        ]

        system_prompt = """You are a dataset creation specialist. Your job is to:
1. Create a dataset using the create_dataset tool
2. Plan high-level descriptions for each datapoint to be created

WORKFLOW:
1. Call create_dataset with an appropriate name based on the context
2. Return your result with:
   - dataset_id: The ID returned from create_dataset
   - dataset_name: The name you used
   - datapoint_plans: A list of high-level plans for each datapoint

For each datapoint plan, provide:
- description: What this datapoint represents (e.g., "Angry customer about late delivery")
- scenario: Specific scenario details
- tone: The emotional tone (frustrated, polite, confused, etc.)
- key_elements: Important elements to include

DO NOT create the actual datapoint content - just plan what they should be.
The datapoints will be created by a specialized agent based on your plans."""

        return create_react_agent(
            model=llm,
            tools=dataset_tools,
            state_schema=WorkspaceState,
            prompt=system_prompt,
            response_format=DatasetCreationResult,
        )

    def create_datapoint_generator_agent(self):
        """
        Create datapoint generator agent that generates structured datapoint content.
        Returns structured GeneratedDatapoint with inputs, messages, expected_output.

        The actual SDK call to add_datapoint is handled by the orchestrator.
        """
        logger.debug(f"Creating datapoint generator agent with model: {self.llm_config.cheap_model}")
        llm = self.get_llm(use_expensive=False)
        return llm.with_structured_output(GeneratedDatapoint)

    def get_sdk_tools(self) -> OrqSDKTools:
        """Get the SDK tools instance for direct calls from orchestrator."""
        if not self._sdk_tools:
            raise RuntimeError("SDK tools not initialized. Call init_sdk_tools() first.")
        return self._sdk_tools

    def create_prompt_agent(self):
        """
        Create prompt agent that uses SDK tools to create prompts.
        Returns ReAct agent that can call tools.
        """
        logger.debug(f"Creating prompt agent with model: {self.llm_config.expensive_model}")

        if not self._sdk_tools:
            raise RuntimeError("SDK tools not initialized. Call init_sdk_tools() first.")

        llm = self.get_llm(use_expensive=True)
        prompt_tools = self._sdk_tools.get_prompt_tools()

        # Add structured reporting tool
        def report_results(created_prompts: list, errors: list | None = None) -> dict:
            return {
                "created_prompts": created_prompts,
                "errors": errors or [],
            }

        report_tool = StructuredTool.from_function(
            func=report_results,
            name="report_prompt_results",
            description="Report final prompt creation results",
            return_direct=True,
        )

        all_tools = prompt_tools + [report_tool]

        system_prompt = """You are a prompt creation specialist. Use the tools to create prompts based on the workspace plan.

WORKFLOW:
1. For each prompt in the plan:
   - Use create_prompt with:
     - display_name: Name of the prompt
     - system_prompt: The system message
     - user_template: The user message template with {{variables}}
     - model: The model to use (default: gpt-4o-mini)
     - temperature: Temperature setting (default: 0.7)
   - Track what you created

2. Report results using report_prompt_results with:
   - created_prompts: List of {id, name, description}
   - errors: List of any error messages

Make sure prompts are production-ready and follow best practices.
Use template variables like {{customer_name}}, {{issue_description}} for dynamic content."""

        return create_react_agent(
            model=llm,
            tools=all_tools,
            state_schema=WorkspaceState,
            prompt=system_prompt,
        )

    def create_chat_agent(self, use_mcp: bool = False):
        """
        Create a conversational chat agent with access to workspace tools.
        This agent can help users interactively manage their workspace.

        Args:
            use_mcp: If True, use MCP tools (TypeScript server). If False, use SDK tools.

        Returns ReAct agent that can:
        - Create/list/delete datasets
        - Add datapoints to datasets
        - Create/list/delete prompts
        - Answer questions about the workspace
        """
        logger.debug(f"Creating chat agent with model: {self.llm_config.cheap_model}, use_mcp={use_mcp}")

        llm = self.get_llm(use_expensive=False)

        # Get tools based on preference
        if use_mcp:
            if not self._mcp_tools:
                raise RuntimeError("MCP tools not initialized. Call init_mcp_tools() first.")
            all_tools = self._mcp_tools
            logger.info(f"Chat agent using MCP tools: {[t.name for t in all_tools]}")
        else:
            if not self._sdk_tools:
                raise RuntimeError("SDK tools not initialized. Call init_sdk_tools() first.")
            all_tools = self._sdk_tools.get_all_tools()
            logger.info(f"Chat agent using SDK tools: {[t.name for t in all_tools]}")

        system_prompt = """You are a helpful Workspace Assistant for the Orq.ai platform.
You can help users manage their workspace by creating and managing datasets and prompts.

AVAILABLE TOOLS:
- create_dataset: Create a new dataset in the workspace
- add_datapoint: Add a datapoint (inputs, messages, expected_output) to a dataset
- list_datasets: List all datasets in the workspace
- list_datapoints: List all datapoints in a specific dataset
- delete_dataset: Delete a dataset by ID
- create_prompt: Create a new prompt with system message and settings
- list_prompts: List all prompts in the workspace
- delete_prompt: Delete a prompt by ID

GUIDELINES:
1. Be helpful and concise in your responses
2. Use tools when appropriate to fulfill user requests
3. Always confirm before deleting anything
4. When creating datasets/prompts, ask for necessary details if not provided
5. Report results clearly after using tools
6. If a tool fails, explain the error and suggest alternatives

EXAMPLES:
- "Create a dataset for customer support" -> Use create_dataset tool
- "Show me all my datasets" -> Use list_datasets tool
- "Add a test case to dataset X" -> Use add_datapoint tool
- "What prompts do I have?" -> Use list_prompts tool"""

        return create_react_agent(
            model=llm,
            tools=all_tools,
            state_schema=ChatAgentState,
            prompt=system_prompt,
        )
