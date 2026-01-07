# Orq Evaluate Action

A GitHub Action for running evaluatorq evaluation files using the `@orq-ai/cli`.

## Usage

### Basic Usage

```yaml
- uses: orq-ai/evaluatorq/.github/actions/evaluate@main
  with:
    pattern: "**/*.eval.ts"
    orq-api-key: ${{ secrets.ORQ_API_KEY }}
```

### Full Example

```yaml
name: Run Evaluations

on:
  push:
    branches: [main]
  pull_request:

jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: orq-ai/evaluatorq/.github/actions/evaluate@main
        with:
          pattern: "examples/**/*.eval.ts"
          orq-api-key: ${{ secrets.ORQ_API_KEY }}
          orq-base-url: "https://my.orq.ai"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `pattern` | Glob pattern for evaluation files (e.g., `**/*.eval.ts`) | Yes | - |
| `orq-api-key` | Orq API key for authentication and tracing | No | - |
| `orq-base-url` | Orq API base URL | No | `https://my.orq.ai` |
| `otel-endpoint` | Custom OTEL endpoint (overrides auto-detection) | No | - |
| `working-directory` | Working directory to run evaluations from | No | `.` |
| `bun-version` | Bun version to use | No | `latest` |
| `disable-tracing` | Disable OTEL tracing even when API key is set | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `passed` | Whether all evaluations passed (`true` or `false`) |

## Features

- **Automatic OTEL Tracing**: When `orq-api-key` is provided, traces are automatically sent to the Orq platform
- **GitHub Job Summaries**: Evaluation results are displayed in the GitHub Actions summary
- **Flexible Patterns**: Use glob patterns to match specific evaluation files
- **Exit Codes**: Action fails with exit code 1 if any evaluation fails

## Environment Variables

The action sets the following environment variables:

- `ORQ_API_KEY` - From the `orq-api-key` input
- `ORQ_BASE_URL` - From the `orq-base-url` input
- `ORQ_DISABLE_TRACING` - From the `disable-tracing` input
- `OTEL_EXPORTER_OTLP_ENDPOINT` - From the `otel-endpoint` input

## Example Workflows

### Run on Label

```yaml
name: Evaluation on Label

on:
  pull_request:
    types: [labeled]

jobs:
  evaluate:
    if: github.event.label.name == 'run-evaluations'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: orq-ai/evaluatorq/.github/actions/evaluate@main
        with:
          pattern: "tests/**/*.eval.ts"
          orq-api-key: ${{ secrets.ORQ_API_KEY }}
```

### Run on Schedule

```yaml
name: Nightly Evaluations

on:
  schedule:
    - cron: "0 0 * * *"

jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: orq-ai/evaluatorq/.github/actions/evaluate@main
        with:
          pattern: "**/*.eval.ts"
          orq-api-key: ${{ secrets.ORQ_API_KEY }}
```

### Conditional on Output

```yaml
- uses: orq-ai/evaluatorq/.github/actions/evaluate@main
  id: eval
  continue-on-error: true
  with:
    pattern: "**/*.eval.ts"
    orq-api-key: ${{ secrets.ORQ_API_KEY }}

- name: Check results
  if: steps.eval.outputs.passed == 'false'
  run: echo "Some evaluations failed!"
```
