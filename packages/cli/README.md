# @orq-ai/cli

Command-line interface for interacting with the Orq AI platform. This CLI provides comprehensive access to manage agents, deployments, datasets, knowledge bases, prompts, and more.

## Features

- **Agent Management**: Create, update, delete, and run AI agents
- **Deployment Operations**: Invoke and stream deployments, get configurations
- **Dataset Management**: Full CRUD operations for datasets and datapoints
- **Knowledge Base**: Manage knowledge bases, datasources, and chunks
- **File Operations**: Upload, list, and manage files
- **Prompt Management**: Create and version prompts
- **Evaluator Integration**: Manage and invoke custom evaluators
- **Model Discovery**: List available models
- **Secure Authentication**: Store API keys securely

## Installation

### Global Installation

```bash
npm install -g @orq-ai/cli
# or
bun add -g @orq-ai/cli
```

### Local Installation

```bash
npm install --save-dev @orq-ai/cli
# or
bun add -d @orq-ai/cli
```

## Quick Start

```bash
# Authenticate with Orq AI
orq auth login

# List your agents
orq agents list

# Invoke a deployment
orq deployments invoke my-deployment --input "Hello, world!"

# Run evaluation files
orq evaluate "**/*.eval.ts"
```

## Commands

### Authentication

```bash
orq auth login              # Authenticate with API key
orq auth login --apiKey <key>   # Authenticate with specific key
orq auth logout             # Remove stored credentials
orq auth status             # Check authentication status
```

### Agents

```bash
orq agents list                          # List all agents
orq agents list --json                   # Output as JSON
orq agents get <agent-id>                # Get agent details
orq agents create --displayName "My Agent"   # Create agent
orq agents update <agent-id> --displayName "New Name"
orq agents delete <agent-id>             # Delete agent
orq agents delete <agent-id> --force     # Skip confirmation
orq agents run <agent-id> --input "Hello"    # Run agent
```

### Deployments

```bash
orq deployments list                     # List deployments
orq deployments invoke <key> --input "message"   # Invoke deployment
orq deployments config <key>             # Get deployment config
orq deployments stream <key> --input "message"   # Stream response
```

### Datasets

```bash
orq datasets list                        # List datasets
orq datasets get <dataset-id>            # Get dataset details
orq datasets create --name "My Dataset"  # Create dataset
orq datasets update <id> --name "New Name"
orq datasets delete <id>                 # Delete dataset
orq datasets clear <id>                  # Clear all datapoints

# Datapoints
orq datasets datapoints list <dataset-id>
orq datasets datapoints add <dataset-id> --inputs '{"key": "value"}'
orq datasets datapoints get <dataset-id> <datapoint-id>
orq datasets datapoints delete <dataset-id> <datapoint-id>
```

### Knowledge Bases

```bash
orq knowledge list                       # List knowledge bases
orq knowledge get <kb-id>                # Get knowledge base
orq knowledge create --key my-kb --name "My KB" --embeddingModel "cohere/embed-english-v3.0"
orq knowledge update <id> --name "New Name"
orq knowledge delete <id>
orq knowledge search <kb-id> "query"     # Search knowledge base

# Datasources
orq knowledge datasources list <kb-id>
orq knowledge datasources create <kb-id> --name "My Source"
orq knowledge datasources get <kb-id> <ds-id>
orq knowledge datasources delete <kb-id> <ds-id>

# Chunks
orq knowledge chunks list <kb-id> <ds-id>
orq knowledge chunks add <kb-id> <ds-id> --chunks '[{"content": "..."}]'
orq knowledge chunks count <kb-id> <ds-id>
```

### Files

```bash
orq files list                           # List files
orq files upload ./document.pdf          # Upload a file
orq files upload ./doc.pdf --name "custom-name.pdf"
orq files get <file-id>                  # Get file details
orq files delete <file-id>               # Delete file
```

### Prompts

```bash
orq prompts list                         # List prompts
orq prompts get <prompt-id>              # Get prompt details
orq prompts create --key my-prompt --name "My Prompt"
orq prompts create --key my-prompt --name "Prompt" --systemPrompt "You are..."
orq prompts update <id> --name "New Name"
orq prompts delete <id>
orq prompts versions <prompt-id>         # List versions
orq prompts version <prompt-id> <version-id>   # Get specific version
```

### Evaluators

```bash
orq evals list                           # List evaluators
orq evals create --key my-eval --name "My Eval" --type llm
orq evals update <id> --name "New Name"
orq evals delete <id>
orq evals invoke <id> --input "input" --output "output"
```

### Models

```bash
orq models list                          # List all models
orq models list --type embedding         # Filter by type
orq models list --provider openai        # Filter by provider
orq models list --json                   # Output as JSON
```

### Evaluate (Run Evaluation Files)

```bash
orq evaluate "**/*.eval.ts"              # Run all evaluation files
orq evaluate "src/**/*.eval.ts"          # Run in specific directory
```

## Environment Variables

- `ORQ_API_KEY`: API key for Orq platform (overrides stored credentials)
- `ORQ_BASE_URL`: Custom API base URL (default: https://api.orq.ai)

## Output Formats

All list commands support `--json` flag for machine-readable output:

```bash
orq agents list --json
orq datasets list --json | jq '.[] | .id'
```

## CI/CD Integration

```yaml
# GitHub Actions example
- name: Run Orq CLI
  run: |
    orq agents list
    orq deployments invoke my-deployment --input "$INPUT"
  env:
    ORQ_API_KEY: ${{ secrets.ORQ_API_KEY }}
```

## Package.json Scripts

```json
{
  "scripts": {
    "orq:agents": "orq agents list",
    "orq:eval": "orq evaluate \"**/*.eval.ts\"",
    "orq:deploy": "orq deployments invoke production"
  }
}
```

## Development

```bash
# Build the package
bunx nx build cli

# Run type checking
bunx nx typecheck cli

# Run locally without installing
bunx tsx packages/cli/src/bin/cli.ts --help
```

## License

MIT
