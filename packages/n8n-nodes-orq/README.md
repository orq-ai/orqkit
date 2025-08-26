# @orq-ai/n8n-nodes-orq

Community nodes for integrating [Orq AI](https://orq.ai) with n8n workflows. These nodes provide seamless access to Orq AI's deployment and knowledge base capabilities within your automation workflows.

## Features

- **Deployment Invocation**: Execute Orq AI deployments with messages, context, and inputs
- **Knowledge Base Search**: Search and retrieve content from Orq knowledge bases
- **Dynamic Configuration**: Automatically load available deployments and knowledge bases
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

The nodes will appear as "OrqDeployment" and "OrqKnowledgeBaseSearch" in the n8n node panel.

## Authentication

1. Sign up or log in at [Orq AI](https://orq.ai)
2. Navigate to your account settings to generate an API key
3. In n8n, create new credentials:
   - Go to **Credentials** → **New**
   - Select **Orq API**
   - Enter your API key
   - Save the credentials

## Available Nodes

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

## License

This is free and unencumbered software released into the public domain. See [UNLICENSE](https://unlicense.org) for details.