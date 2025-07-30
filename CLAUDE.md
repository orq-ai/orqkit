# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

This is an Nx monorepo that uses Bun as the package manager. Use `bunx` instead of `npx` for all commands.

### Common Commands

- **Build a package**: `bunx nx build <package-name>` (e.g., `bunx nx build evaluatorq`)
- **Type checking**: `bunx nx typecheck <package-name>`
- **Linting**: Use Biome for formatting and linting - `bunx biome check` or `bunx biome format`
- **Run any Nx task**: `bunx nx <target> <project-name>`
- **Explore project graph**: `bunx nx graph`
- **Sync TypeScript references**: `bunx nx sync`

### Biome Configuration

The project uses Biome for linting and formatting with:
- Tab indentation
- Double quotes for strings
- Automatic import organization

## Project Architecture

### Monorepo Structure

- **packages/evaluatorq**: The main library package
  - Exports evaluation framework types and functions
  - Peer dependency on `@orq-ai/node` (optional)
  - Uses ESM modules (`type: "module"`)
  
- **examples/**: Example usage of the evaluatorq library
  - Demonstrates integration with Orq AI platform
  - Shows dataset-based evaluation workflows

### Integration with Orq AI

The library is designed to work with the Orq AI platform:
- Uses `ORQ_API_KEY` environment variable for authentication
- Can fetch datasets from the platform using `datasetId`
- Integrates with Orq's evaluation system