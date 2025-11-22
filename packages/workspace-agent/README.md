# Workspace Agent

A true multi-agent workspace setup system using LangGraph and MCP for automated workspace creation on the Orq AI platform.

## Overview

This system uses **4 specialized ReAct agents** that work together to automatically set up workspaces for customers based on their company type and industry:

1. **Coordinator Agent** - Main orchestrator that delegates tasks to specialized agents and controls the overall workflow
2. **Planning Agent** - Analyzes requirements and creates detailed workspace plans (datasets + prompts)
3. **Dataset Agent** - Creates datasets and populates them with sample data using MCP tools
4. **Prompt Agent** - Creates industry-specific prompts with optimal configurations using MCP tools

## Architecture

### Multi-Agent Hierarchy

```
Coordinator Agent (Entrypoint)
  ↓ delegates to →  Planning Agent
                    ↓ returns plan
  ↓ delegates to →  Dataset Agent (with MCP dataset tools)
                    ↓ returns created datasets
  ↓ delegates to →  Prompt Agent (with MCP prompt tools)
                    ↓ returns created prompts
  ↓ completes setup
```

### Key Components

- **StateGraph Orchestrator**: LangGraph StateGraph managing the coordinator agent loop
- **Coordinator Agent**: ReAct agent that decides what context to pass to each specialized agent
- **Planning Agent**: ReAct agent with analysis and planning tools
- **Dataset Agent**: ReAct agent with MCP dataset tools for CRUD operations
- **Prompt Agent**: ReAct agent with MCP prompt tools for CRUD operations
- **MCP Integration**: langchain-mcp-adapters client connecting to orq-mcp server

### Why This Architecture?

- **True agents**: Each agent uses `create_react_agent` for autonomous decision-making
- **Delegation pattern**: Coordinator controls flow and decides context for subagents
- **Extensibility**: Easy to add new specialized agents (e.g., evaluation agent, deployment agent)
- **Flexibility**: Agents can handle queries, make decisions, and adapt to changing requirements

## Installation

```bash
cd packages/workspace-agent
uv pip install -e .
```

## Configuration

1. Copy the environment template:
```bash
cp .env.template .env
```

2. Edit `.env` with your platform Orq API key:
```env
ORQ_API_KEY=your-platform-orq-api-key
ORQ_BASE_URL=https://my.orq.ai/v2/proxy
```

## Usage

### CLI Interface

Run the interactive CLI:

```bash
cd packages/workspace-agent
python -m workspace_agent.main
```

The CLI will prompt you for:
- Company type (e.g., "E-commerce", "SaaS", "Healthcare")
- Industry (e.g., "Fashion Retail", "Fintech", "Telehealth")
- Special instructions (optional)
- Workspace key (unique identifier)
- Customer's Orq API key
- Number of dataset rows (1-20)

### Programmatic Usage

```python
from workspace_agent import WorkspaceOrchestrator, WorkspaceSetupRequest

# Create setup request
request = WorkspaceSetupRequest(
    company_type="E-commerce",
    industry="Fashion Retail",
    specific_instructions="Focus on customer service and inventory",
    workspace_key="fashion-retail-demo",
    customer_orq_api_key="customer-api-key",
    num_dataset_rows=15
)

# Run orchestrator
orchestrator = WorkspaceOrchestrator()
result = await orchestrator.setup_workspace(request)

print(f"Created {len(result['datasets_created'])} datasets")
print(f"Created {len(result['prompts_created'])} prompts")
```

### Streamlit Web Interface

For an interactive web-based experience, use the Streamlit frontend:

#### Installation

Install the UI dependencies:

```bash
cd packages/workspace-agent
uv pip install -e ".[ui]"
```

#### Running the App

```bash
cd packages/workspace-agent
streamlit run streamlit_app.py
```

The app will open in your browser at `http://localhost:8501`.

#### Features

- **📋 Configuration Presets**: Quick-start templates for common industries (Airline, E-commerce, Healthcare, FinTech, Education)
- **🎯 Dry Run Mode**: Preview the generated workspace plan before executing
- **🔄 Real-time Progress**: Live updates showing agent activity and current phase
- **🤔 Interactive Clarifications**: Modal dialogs when agents need additional input
- **💾 Checkpoint Persistence**: Automatic progress saving for crash recovery
- **📥 Export Results**: Download workspace setup results as JSON
- **✅ Results Dashboard**: View created datasets and prompts in formatted tables

#### Dry Run Workflow

1. Fill out the workspace configuration form in the sidebar
2. Select "Dry Run (Plan Only)" mode
3. Click "Start Setup"
4. Review the generated plan (datasets and prompts)
5. Click "Proceed with Execution" to create resources, or "Cancel" to start over

#### Full Execution Workflow

1. Fill out the workspace configuration form
2. Select "Full Execution" mode
3. Click "Start Setup"
4. Watch real-time progress updates
5. Respond to clarification requests if prompted
6. Download results when complete

#### Configuration Notes

- **Platform API Key**: Set in `.env` file (used by agents to make LLM calls)
- **Customer API Key**: Enter in the web form (used for workspace operations)
- **Workspace Key**: Auto-generated UUID, but can be customized
- **Dataset Rows**: 1-20 rows per dataset (slider control)

## Features

### Intelligent Coordination
- Coordinator agent decides what context each subagent needs
- Can ask clarifying questions at any stage
- Adapts to errors and changes in requirements
- Each agent operates autonomously within its domain

### Dual API Key System
- Platform API key for LLM operations (from .env)
- Customer API key for workspace operations (provided per request)
- Enables multi-tenant hosting while maintaining data isolation

### Model Configuration
- Coordinator: Expensive model (gpt-4o) for strategic decisions
- Planning: Expensive model (gpt-4o) for high-quality plans
- Dataset: Cheap model (gpt-4o-mini) for routine operations
- Prompt: Expensive model (gpt-4o) for high-quality prompt generation
- Configurable via `LLMConfig`

### Error Handling
- Each agent handles errors within its domain
- Coordinator can retry or adapt strategy on failures
- Complete error tracking across all agents
- Graceful degradation

### Sample Outputs

For an E-commerce Fashion Retail company, the system might create:

**Datasets:**
- Customer Support Conversations (input, messages, expected_output)

**Prompts:**
- Customer Service Response Generator
- Product Description Writer

## Dependencies

- **LangGraph 0.6.7+**: StateGraph workflow orchestration
- **langgraph-prebuilt 0.6.4+**: `create_react_agent` for agent creation
- **LangChain 0.3.27+**: Core LLM abstractions and OpenAI integration
- **langchain-mcp-adapters**: MCP client integration for LangChain
- **MCP 1.15.0**: Model Context Protocol
- **Pydantic 2.0+**: Configuration management and validation

## Development

The system is designed for clarity and extensibility:

- [config.py](src/workspace_agent/config.py) - Pydantic configuration models
- [state.py](src/workspace_agent/state.py) - LangGraph state definition
- [tools.py](src/workspace_agent/tools.py) - MCP client management
- [schemas.py](src/workspace_agent/schemas.py) - Pydantic schemas for structured data
- [agents.py](src/workspace_agent/agents.py) - Agent factory and specialized agent definitions
- [main.py](src/workspace_agent/main.py) - Orchestrator with coordinator pattern

## Key Implementation Details

### Agent Creation

Each agent is created using `create_react_agent`:
- Takes an LLM, tools, state schema, and system prompt
- Returns a runnable agent that can make decisions and use tools
- Agents communicate via messages and tool calls

### Coordinator Pattern

The coordinator agent:
- Receives the initial workspace setup request
- Delegates to specialized agents with appropriate context
- Collects results from each agent
- Makes strategic decisions about the workflow
- Can loop back to agents if needed

### MCP Integration

- Direct connection to orq-mcp server via langchain-mcp-adapters
- Customer API key passed as environment variable to MCP server
- Dataset and Prompt agents have filtered MCP tool access
- Real resource tracking from MCP responses

### State Management

- Uses LangGraph's StateGraph for orchestration
- Coordinator node loops until completion
- State includes messages, workspace plan, created resources, and phase tracking

## Extending the System

### Adding a New Specialized Agent

1. Create agent in [agents.py](src/workspace_agent/agents.py):
```python
def create_evaluation_agent(self, mcp_tools: List, helper_tools: List):
    llm = self.get_llm(use_expensive=False)
    evaluation_tools = [tool for tool in mcp_tools if "eval" in tool.name.lower()]

    system_prompt = """You are an evaluation specialist..."""

    return create_react_agent(
        model=llm,
        tools=evaluation_tools + helper_tools,
        state_schema=WorkspaceState,
        state_modifier=system_prompt,
    )
```

2. Add delegation tool for coordinator:
```python
@tool
def delegate_to_evaluation(request: str) -> str:
    """Delegate to Evaluation Agent"""
    return f"DELEGATE_EVALUATION:{request}"
```

3. Handle delegation in coordinator node in [main.py](src/workspace_agent/main.py)

## Limitations

- Maximum 20 dataset rows per dataset (validated by Pydantic)
- MCP server started as subprocess (could use persistent connection)
- Coordinator loops have max iterations (prevent infinite loops)
- Streamlit runs synchronously (long executions may appear to freeze briefly)
