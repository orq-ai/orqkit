# Evaluatorq MVP Task Breakdown

## Overview
This document outlines the comprehensive task breakdown for implementing the Evaluatorq MVP based on the plan.md specification.

## Task Structure

### 1. Project Setup and Configuration (Priority: Critical, Est: 4 hours)

#### 1.1 Initialize Monorepo Structure
- **Priority**: Critical
- **Estimate**: 1 hour
- **Dependencies**: None
- **Tasks**:
  - [ ] Generate core package: `npx nx g @nx/js:lib packages/core --publishable --importPath=@evaluatorq/core`
  - [ ] Generate evaluators package: `npx nx g @nx/js:lib packages/evaluators --publishable --importPath=@evaluatorq/evaluators`
  - [ ] Generate orq-integration package: `npx nx g @nx/js:lib packages/orq-integration --publishable --importPath=@evaluatorq/orq-integration`
  - [ ] Generate cli package: `npx nx g @nx/js:lib packages/cli --publishable --importPath=@evaluatorq/cli`
  - [ ] Generate shared package: `npx nx g @nx/js:lib packages/shared --publishable --importPath=@evaluatorq/shared`

#### 1.2 Configure Dependencies
- **Priority**: Critical
- **Estimate**: 1 hour
- **Dependencies**: 1.1
- **Tasks**:
  - [ ] Add Effect.ts (v3.16.16) to workspace dependencies
  - [ ] Add @orq-ai/node SDK
  - [ ] Add CLI dependencies (chalk, ora, commander)
  - [ ] Configure TypeScript for Effect.ts usage
  - [ ] Update tsconfig.json with strict mode and proper module resolution

#### 1.3 Setup Development Environment
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: 1.2
- **Tasks**:
  - [ ] Create base tsconfig for all packages
  - [ ] Setup ESLint configuration
  - [ ] Configure prettier
  - [ ] Add husky for pre-commit hooks
  - [ ] Create example experiments directory

### 2. Core Types and Interfaces (Priority: Critical, Est: 3 hours)

#### 2.1 Define Core Types
- **Priority**: Critical
- **Estimate**: 1.5 hours
- **Dependencies**: 1.3
- **Package**: `@evaluatorq/shared`
- **Tasks**:
  - [ ] Create `Experiment` interface with generics
  - [ ] Define `Task` type
  - [ ] Create `Evaluator` interface
  - [ ] Define `EvaluationResult` interface
  - [ ] Create error types (`DataError`, `EvaluatorError`, `OutputError`)
  - [ ] Define `TaskResult` type

#### 2.2 Define Configuration Types
- **Priority**: High
- **Estimate**: 1.5 hours
- **Dependencies**: 2.1
- **Package**: `@evaluatorq/shared`
- **Tasks**:
  - [ ] Create `EvaluatorqConfig` interface
  - [ ] Define `OutputHandler` interface
  - [ ] Create `OrqConfig` type
  - [ ] Define CLI option types

### 3. Core Evaluation Engine (Priority: Critical, Est: 8 hours)

#### 3.1 Implement Main Evaluatorq Function
- **Priority**: Critical
- **Estimate**: 3 hours
- **Dependencies**: 2.1, 2.2
- **Package**: `@evaluatorq/core`
- **Tasks**:
  - [ ] Create main `Evaluatorq` function with Effect.ts
  - [ ] Implement experiment validation
  - [ ] Setup Effect runtime configuration
  - [ ] Create execution context management
  - [ ] Add logging with Effect.ts Logger

#### 3.2 Implement Data Loading Pipeline
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 3.1
- **Package**: `@evaluatorq/core`
- **Tasks**:
  - [ ] Create data loader with Effect.ts
  - [ ] Implement error handling for data loading
  - [ ] Add support for async data sources
  - [ ] Create data validation helpers

#### 3.3 Implement Task Execution Engine
- **Priority**: Critical
- **Estimate**: 3 hours
- **Dependencies**: 3.2
- **Package**: `@evaluatorq/core`
- **Tasks**:
  - [ ] Create task runner with Effect.ts
  - [ ] Implement concurrent task execution
  - [ ] Add task error handling and recovery
  - [ ] Create task result collection
  - [ ] Implement cancellation support

### 4. Basic Evaluators (Priority: Critical, Est: 8 hours)

#### 4.1 Implement Evaluator Base
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 2.1
- **Package**: `@evaluatorq/evaluators`
- **Tasks**:
  - [ ] Create base evaluator abstract class
  - [ ] Implement evaluator composition helpers
  - [ ] Add score normalization utilities
  - [ ] Create evaluator error handling

#### 4.2 Implement Cosine Similarity
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 4.1
- **Package**: `@evaluatorq/evaluators`
- **Tasks**:
  - [ ] Implement vector conversion for text
  - [ ] Create cosine similarity calculation
  - [ ] Add error handling for invalid inputs
  - [ ] Write unit tests

#### 4.3 Implement Exact Match
- **Priority**: Critical
- **Estimate**: 1 hour
- **Dependencies**: 4.1
- **Package**: `@evaluatorq/evaluators`
- **Tasks**:
  - [ ] Implement exact match logic
  - [ ] Add case sensitivity options
  - [ ] Handle different data types
  - [ ] Write unit tests

#### 4.4 Implement Levenshtein Distance
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 4.1
- **Package**: `@evaluatorq/evaluators`
- **Tasks**:
  - [ ] Implement Levenshtein algorithm
  - [ ] Normalize scores to 0-1 range
  - [ ] Add string preprocessing options
  - [ ] Write unit tests

#### 4.5 Create Evaluator Registry
- **Priority**: High
- **Estimate**: 1 hour
- **Dependencies**: 4.2, 4.3, 4.4
- **Package**: `@evaluatorq/evaluators`
- **Tasks**:
  - [ ] Create evaluator registry system
  - [ ] Export all built-in evaluators
  - [ ] Add evaluator discovery mechanism

### 5. Output Handlers (Priority: Critical, Est: 6 hours)

#### 5.1 Implement Local JSON Output
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 3.3
- **Package**: `@evaluatorq/core`
- **Tasks**:
  - [ ] Create JSON formatter for results
  - [ ] Implement file system writer with Effect.ts
  - [ ] Add timestamped file naming
  - [ ] Create output directory management

#### 5.2 Implement CLI Display
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 5.1
- **Package**: `@evaluatorq/cli`
- **Tasks**:
  - [ ] Create table formatter for results
  - [ ] Implement summary statistics display
  - [ ] Add progress indicators with ora
  - [ ] Style output with chalk

#### 5.3 Create Output Handler System
- **Priority**: Critical
- **Estimate**: 2 hours
- **Dependencies**: 5.1, 5.2
- **Package**: `@evaluatorq/core`
- **Tasks**:
  - [ ] Implement OutputHandler interface
  - [ ] Create handler selection based on environment
  - [ ] Add error handling for output failures
  - [ ] Create composite output handler

### 6. orq.ai Integration (Priority: High, Est: 6 hours)

#### 6.1 Implement orq.ai Client Wrapper
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: 2.2
- **Package**: `@evaluatorq/orq-integration`
- **Tasks**:
  - [ ] Create Effect.ts wrapper for @orq-ai/node
  - [ ] Implement authentication handling
  - [ ] Add retry logic with Effect.ts Schedule
  - [ ] Create error mapping

#### 6.2 Implement Result Transformation
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: 6.1
- **Package**: `@evaluatorq/orq-integration`
- **Tasks**:
  - [ ] Map EvaluationResult to orq.ai format
  - [ ] Transform evaluator scores
  - [ ] Include metadata and traces
  - [ ] Handle data type conversions

#### 6.3 Implement orq.ai Output Handler
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: 6.1, 6.2
- **Package**: `@evaluatorq/orq-integration`
- **Tasks**:
  - [ ] Create OrqOutputHandler class
  - [ ] Implement API key detection
  - [ ] Add fallback to local output
  - [ ] Create success/error logging

### 7. CLI Interface (Priority: High, Est: 4 hours)

#### 7.1 Create CLI Entry Point
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: 3.3, 5.2
- **Package**: `@evaluatorq/cli`
- **Tasks**:
  - [ ] Setup commander.js CLI structure
  - [ ] Create `run` command
  - [ ] Add `evaluators` list command
  - [ ] Implement help documentation

#### 7.2 Add CLI Configuration
- **Priority**: Medium
- **Estimate**: 2 hours
- **Dependencies**: 7.1
- **Package**: `@evaluatorq/cli`
- **Tasks**:
  - [ ] Create config file loader
  - [ ] Add CLI argument parsing
  - [ ] Implement environment variable support
  - [ ] Create default configuration

### 8. Testing and Documentation (Priority: High, Est: 6 hours)

#### 8.1 Setup Testing Infrastructure
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: All core features
- **Tasks**:
  - [ ] Configure Vitest for all packages
  - [ ] Setup test utilities for Effect.ts
  - [ ] Create test fixtures
  - [ ] Add test scripts to package.json

#### 8.2 Write Core Tests
- **Priority**: High
- **Estimate**: 2 hours
- **Dependencies**: 8.1
- **Tasks**:
  - [ ] Test evaluation engine
  - [ ] Test all evaluators
  - [ ] Test output handlers
  - [ ] Test CLI commands

#### 8.3 Create Documentation
- **Priority**: Medium
- **Estimate**: 2 hours
- **Dependencies**: All features
- **Tasks**:
  - [ ] Write README with quick start
  - [ ] Create API documentation
  - [ ] Add example experiments
  - [ ] Document configuration options

## MVP Delivery Checklist

### Core Requirements
- [ ] Main Evaluatorq function works with proposed API syntax
- [ ] Data loading from async sources
- [ ] Task execution with concurrency control
- [ ] Three basic evaluators (Cosine, Exact Match, Levenshtein)
- [ ] Local JSON output with CLI display
- [ ] orq.ai integration with API key detection
- [ ] TypeScript types with strict mode
- [ ] Effect.ts error handling throughout

### Developer Experience
- [ ] Simple, intuitive API
- [ ] Clear error messages
- [ ] Progress indicators for long operations
- [ ] Comprehensive TypeScript types
- [ ] Working examples included

### Output Modes
- [ ] JSON file generation with timestamps
- [ ] CLI table formatting with summaries
- [ ] Automatic orq.ai upload when API key present
- [ ] Graceful fallback to local output

## Estimated Timeline

- **Week 1**: Project setup, core types, evaluation engine, basic evaluators
- **Week 2**: Output handlers, orq.ai integration, CLI interface
- **Week 3**: Testing, documentation, polish, and bug fixes

**Total Estimated Time**: ~50 hours for MVP

## Priority Order for Implementation

1. **Critical Path** (Must have for MVP):
   - Project setup and configuration
   - Core types and interfaces
   - Evaluation engine
   - Basic evaluators (at least one)
   - Local output (JSON + CLI)

2. **High Priority** (Should have for MVP):
   - All three basic evaluators
   - orq.ai integration
   - CLI interface
   - Basic testing

3. **Medium Priority** (Nice to have):
   - Comprehensive documentation
   - Additional evaluators
   - Configuration file support
   - Watch mode

## Risk Mitigation

1. **Effect.ts Learning Curve**: 
   - Start with simple Effect patterns
   - Use Effect documentation and examples
   - Build incrementally

2. **orq.ai API Integration**:
   - Design with clear interface boundaries
   - Implement local mode first
   - Test with mock API responses

3. **Performance with Large Datasets**:
   - Use Effect's streaming capabilities
   - Implement proper concurrency limits
   - Add progress indicators early