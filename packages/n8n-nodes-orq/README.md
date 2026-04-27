# @orq-ai/n8n-nodes-orq

Community nodes for integrating [Orq AI](https://orq.ai) with n8n workflows. These nodes provide seamless access to Orq AI's deployment and knowledge base capabilities within your automation workflows.

## Features

- **Agent Execution**: Run Orq AI Agents for complex, multi-step workflows
- **Deployment Invocation**: Execute Orq AI deployments with messages, context, and inputs
- **Knowledge Base Search**: Search and retrieve content from Orq knowledge bases
- **Dynamic Configuration**: Automatically load available agents, deployments, and knowledge bases
- **Multi-modal Support**: Send text and image content to vision-capable models
- **Metadata Filtering**: Advanced filtering options for knowledge base searches
- **Error Handling**: Built-in error handling with continue-on-fail support

## Installation

### Community Node Installation

Follow the [n8n community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) to install this package.

### Manual Installation

```bash
bun add @orq-ai/n8n-nodes-orq
```

### Docker Installation

If using n8n with Docker, set the environment variable:

```bash
N8N_COMMUNITY_NODE_PACKAGES=@orq-ai/n8n-nodes-orq
```

### Local Development Installation

For local development and testing with n8n:

1. Clone and navigate to the package:

```bash
git clone https://github.com/orq-ai/orqkit.git
cd orqkit/packages/n8n-nodes-orq
```

2. Install dependencies:

```bash
bun install
```

3. Build the nodes:

```bash
bunx nx build n8n-nodes-orq
```

4. Start n8n with custom nodes:

```bash
N8N_CUSTOM_EXTENSIONS="$(pwd)" n8n start
```

The nodes will appear as "OrqAgent", "OrqDeployment" and "OrqKnowledgeBaseSearch" in the n8n node panel.

## Authentication

1. Sign up or log in at [Orq AI](https://orq.ai)
2. Navigate to your account settings to generate an API key
3. In n8n, create new credentials:
   - Go to **Credentials** → **New**
   - Select **Orq API**
   - Enter your API key
   - Save the credentials

## Available Nodes

### Orq Agent

Run Orq AI Agents for complex, long-running tasks with multi-step reasoning and tool use.

#### How It Works

1. **Run**: Send a message to an agent
2. **Execute**: The server runs the agent turn (including any tools it has configured) and returns when done
3. **Retrieve Results**: Extract the final agent response

#### Configuration

- **Agent**: Select from your available agents or specify via expression
- **Message**: Send your instruction or data to the agent
- **Timeout (seconds)**: How long to wait for the agent to finish (default 600)

**Additional Fields** (optional)
- **Previous Response ID**: Continue from a prior response by passing its `responseId`
- **Conversation ID**: Thread multiple calls into a long-lived conversation (pre-create via the Orq API; mutually exclusive with Previous Response ID)
- **Memory Entity ID**: Attach a persistent memory entity so the agent can recall facts across calls
- **Store Response**: Whether Orq persists this response server-side (default on)
- **Variables**: Templated prompt variables; each row has Name, Value, and a Secret toggle for log redaction
- **Metadata**: Key-value tags (max 16 pairs)

#### Response Statuses

The node branches on the agent's final status:

- `completed` — success, response text extracted
- `incomplete` — partial response returned with an `incomplete` flag
- `failed` — throws with the server error message

#### Output

The node returns:

- **responseId**: Unique identifier for this response (use as Previous Response ID in a downstream node)
- **agentKey**: The agent that was invoked
- **status**: Final status (`completed` or `incomplete`)
- **success**: Boolean indicating if the response completed successfully
- **response**: The agent's response text
- **raw**: Full response body for anything else you need
- **usage**: Token counts, when present
- **refusals**: Array of refusal strings, when present
- **incomplete**: `true` when status is `incomplete`
- **incompleteReason**: Reason for the incomplete status, when present

#### Example Use Cases

- Data analysis and insights generation
- Complex document processing
- Multi-step reasoning tasks
- Tool use and function calling

#### Example Workflow

```yaml
1. Set Node (Create data)
   - csvData: "Month,Sales\nJan,10000..."
2. Orq Agent
   - Agent: "data-analyst"
   - Message: "Analyze this sales data and provide insights"
3. Email Send
   - Body: "{{ $node["Orq Agent"].json.response }}"
```

#### When to Use Orq Agent vs Orq Deployment

These n8n nodes connect to different resource types in your Orq workspace:

**Use Orq Agent when you need:**
- **Tools & Actions**: Agent can call HTTP APIs, run Python code, or use built-in utilities
- **Autonomous Iteration**: Agent works through multi-step problems independently to reach the final output

**Use Orq Deployment when you need:**
- **Direct LLM Calls**: Single prompt-to-response execution
- **No Tool Complexity**: Just generate text without external actions
- **Template Variables**: Parameterized prompts with inputs

**Key Difference**: In Orq, Agents have access to tools and can autonomously iterate to solve problems, while Deployments are single LLM calls without tools or autonomous iteration.

### Orq Deployment

Invoke Orq AI deployments to process messages with AI models.

#### Configuration

- **Deployment Key**: Select from your available deployments or specify via expression
- **Messages**: Add conversation messages with roles (User, System, Assistant)
- **Context**: Set key-value pairs for deployment routing
- **Inputs**: Provide values for prompt template variables

#### Message Types

- **Text Messages**: Standard text content for all roles
- **Image Messages**: For User role only, supporting:
  - Image URLs
  - Base64 encoded images
  - Optional text descriptions with images

#### Example Use Cases

- Generate content based on templates
- Process customer inquiries
- Analyze images with vision models
- Chain multiple AI operations

### Orq Knowledge Base Search

Search and retrieve relevant content from your Orq knowledge bases.

#### Configuration

- **Knowledge Base**: Select from your available knowledge bases
- **Query**: Search query to find relevant content
- **Metadata Filters**: Optional filtering with AND/OR conditions or custom JSON

#### Filter Types

- **None**: No filtering, return all matching results
- **AND**: All filter conditions must match
- **OR**: Any filter condition must match
- **Custom JSON**: Advanced recursive filter structures

#### Example Use Cases

- Semantic search across documents
- Context retrieval for RAG applications
- Content discovery and recommendations
- Metadata-based filtering

## Workflow Examples

### Agent-Based Data Analysis

```yaml
1. Manual Trigger
2. Set Node
   - csvData: "Month,Sales,Region\nJan,10000,North..."
3. Orq Agent
   - Agent: "data-analyst"
   - Message: "Analyze this sales data by region and provide growth rates"
4. Email Send
   - Subject: "Sales Analysis Report"
   - Body: "{{ $node["Orq Agent"].json.response }}"
```

### Basic Text Generation

```yaml
1. Trigger (e.g., Webhook)
2. Orq Deployment
   - Deployment: "content-generator"
   - Input: { topic: "{{$json.topic}}" }
   - Message: "Generate an article"
3. Output (e.g., Google Sheets)
```

### Knowledge-Enhanced Response

```yaml
1. Trigger (e.g., Form submission)
2. Orq Knowledge Base Search
   - Query: "{{$json.question}}"
   - Knowledge Base: "product-docs"
3. Orq Deployment
   - Context from search results
   - Generate informed response
4. Send response (e.g., Email)
```

### Image Analysis Pipeline

```yaml
1. Image input (e.g., S3 trigger)
2. Orq Deployment
- Vision model deployment
- Image URL from trigger
- Analyze and extract data
3. Store results (e.g., Database)
```

## Development

```bash
# Build the package
bunx nx build n8n-nodes-orq

# Run development mode
bunx nx dev n8n-nodes-orq

# Test locally with n8n
bun run test:local
```

## Resources

- [n8n Documentation](https://docs.n8n.io)
- [n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
- [Orq AI Documentation](https://docs.orq.ai)
- [Orq AI Platform](https://orq.ai)
