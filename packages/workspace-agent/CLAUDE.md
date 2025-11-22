# Workspace Agent

Multi-agent system for automated workspace setup using LangChain/LangGraph with structured outputs.

## Quick Start

```bash
cd packages/workspace-agent
source .venv/bin/activate
streamlit run streamlit_app.py
```

## Architecture

### Agent Flow
1. **Clarification Agent** - Generates exactly 3 questions with 3 options each (strict limit)
2. **Planning Agent** - Creates workspace plan with datasets and prompts
3. **Dataset Planner Agent** - Creates datasets and plans datapoints
4. **Datapoint Generator Agent** - Generates individual datapoint content
5. **Prompt Agent** - Creates prompts using SDK tools
6. **Coordinator Agent** - Orchestrates the entire workflow

### Clarification Flow

- **3 question limit**: Agent generates all 3 questions at once
- **3 options per question**: Each question has 3 suggested options to choose from
- **Free text allowed**: Users can also type custom answers
- **Tabs UI**: Questions displayed in tabs for easy navigation
- Schema: `ClarificationDecision` with `questions: List[ClarificationQuestion]`

### Key Files
- `streamlit_app.py` - Streamlit UI with status flow: idle -> clarifying -> planning -> plan_ready -> executing -> complete
- `src/workspace_agent/main.py` - `WorkspaceOrchestrator` main orchestration logic
- `src/workspace_agent/agents.py` - `WorkspaceAgentFactory` creates all agents
- `src/workspace_agent/sdk_tools.py` - SDK-based tools for datasets/prompts
- `src/workspace_agent/schemas.py` - Pydantic schemas for structured outputs
- `src/workspace_agent/state.py` - `WorkspaceState` for LangGraph

## Orq SDK Models

The SDK model names vary by version. Use imports from the `.venv` SDK version:

### Dataset Operations
```python
from orq_ai_sdk.models import CreateDatasetRequestBody
from orq_ai_sdk.models.createdatasetitemop import CreateDatasetItemRequestBody
```

### Prompt Operations
```python
from orq_ai_sdk.models.createpromptop import (
    CreatePromptRequestBody,
    PromptConfiguration,  # Note: marked deprecated but currently required
    CreatePromptMessages,
    ModelParameters,
)
```

### Usage Pattern
```python
# Creating a prompt
messages = [
    CreatePromptMessages(role="system", content="..."),
    CreatePromptMessages(role="user", content="..."),
]
model_parameters = ModelParameters(temperature=0.7)
prompt_config = PromptConfiguration(
    messages=messages,
    model="gpt-4o-mini",
    model_parameters=model_parameters,
)
request = CreatePromptRequestBody(
    display_name="My Prompt",
    path="project/path",
    prompt_config=prompt_config,
)
```

## Pydantic Schemas

All schemas use `extra="forbid"` for Gemini compatibility:

```python
class MySchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str = Field(description="...")
```

## LangGraph Notes

When using `create_react_agent` with `response_format`, the state schema must include:
```python
structured_response: Optional[Any] = None
```
