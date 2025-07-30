# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Nx monorepo workspace called "evaluatorq" that uses TypeScript and Bun as the package manager. The workspace is configured for TypeScript-only development with strict mode enabled.

## Key Commands

### Package Management
- Use `bun install` to install dependencies (not npm/yarn)
- Workspace packages are located in `packages/` directory

### Build Commands
```bash
# Build a specific package
npx nx build <package-name>

# Type check a specific package
npx nx typecheck <package-name>

# Visualize project dependencies
npx nx graph

# Sync TypeScript project references
npx nx sync

# Check if TypeScript project references are in sync (useful for CI)
npx nx sync:check
```

### Creating New Libraries
```bash
# Generate a publishable library
npx nx g @nx/js:lib packages/<pkg-name> --publishable --importPath=@evaluatorq/<pkg-name>

# Generate a non-publishable internal library
npx nx g @nx/js:lib packages/<pkg-name>
```

### Release Management
```bash
# Version and release packages
npx nx release

# Dry run to preview changes
npx nx release --dry-run
```

## Architecture

This is a freshly initialized Nx workspace with no packages yet. The monorepo structure follows these conventions:

- **`packages/`** - Contains all workspace packages/libraries
- **TypeScript Configuration** - Uses composite builds with project references for efficient compilation
- **Nx Configuration** - Centralized in `nx.json` with TypeScript plugin configured
- **Module System** - Targets ES2022 with Node.js module resolution

## Development Guidelines

- TypeScript strict mode is enabled - ensure all code passes strict type checking
- The workspace uses Nx's inferred tasks system - most commands are automatically available based on file structure
- Project references are automatically managed by Nx - run `npx nx sync` if imports seem broken
- This is a private workspace (`"private": true`) - packages need to be explicitly marked as publishable

## Testing

The project uses Vitest for testing. Test files should use the pattern `*.test.ts` or `*.spec.ts`.

```bash
# Run tests
bun run test

# Run tests with UI
bun run test:ui

# Run tests with coverage
bun run test:coverage
```

## Linting and Formatting

The project uses Biome for linting and formatting.

```bash
# Check for lint and format issues
bun run lint

# Fix lint and format issues
bun run lint:fix

# Format code
bun run format

# Check formatting without making changes
bun run format:check
```

## Task Master AI Instructions
**Import Task Master's development workflow commands and guidelines, treat as if import is in the main CLAUDE.md file.**
@./.taskmaster/CLAUDE.md
