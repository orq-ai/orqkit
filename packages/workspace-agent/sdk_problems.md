# Orq AI SDK Import Problems

This document explains why the Orq AI Python SDK imports are confusing and prone to errors.

## The Core Problem

The SDK is **auto-generated** from an OpenAPI spec, and the code generation creates a massive number of types with inconsistent and verbose naming conventions.

## Specific Issues

### 1. Explosion of Similar-Looking Types

A single module like `createdatasetitemop` exports **200+ types** with names like:
- `CreateDatasetItemRequestBody`
- `CreateDatasetItemMessages`
- `CreateDatasetItemMessagesUserMessage`
- `CreateDatasetItemMessagesSystemMessage`
- `CreateDatasetItemDatasetsMessages`
- `CreateDatasetItemMessagesDatasetsUserMessage`
- `CreateDatasetItem21`, `CreateDatasetItem22`, `CreateDatasetItem23`...

It's nearly impossible to know which one to use without trial and error.

### 2. Inconsistent Naming Between Versions

Types get renamed between SDK versions:
- `RequestBody` → `CreateDatasetItemRequestBody` (renamed)
- `PromptConfig` → `PromptConfiguration` (available but deprecated)
- `CreatePromptPromptConfig` vs `PromptConfiguration` (both exist, different purposes)

### 3. Request vs Response Types Look Identical

The SDK generates separate types for request and response with nearly identical names:
- `CreatePromptMessages` (for requests)
- `CreatePromptPromptsResponseMessages` (for responses)

Using the wrong one causes type errors that are hard to debug.

### 4. No Clear Documentation on Which Types to Use

The SDK doesn't document which types are the "main" ones vs internal implementation details. You have to:
1. Guess based on the name
2. Check `model_fields` to see if it has the right structure
3. Try importing and hope for the best

### 5. Type Aliases vs Pydantic Models

Some exports are Pydantic models, others are `TypeAliasType`:
```python
CreateDatasetItemMessages  # TypeAliasType (union of message types)
CreateDatasetItemMessagesUserMessage  # Pydantic model
```

You can't introspect them the same way, making discovery harder.

### 6. Nested Type Requirements

Simple operations require deeply nested SDK types:
```python
# Instead of just passing dicts:
messages=[{"role": "user", "content": "hello"}]

# You need specific SDK message types:
from orq_ai_sdk.models.createdatasetitemop import CreateDatasetItemMessagesUserMessage
messages=[CreateDatasetItemMessagesUserMessage(role="user", content="hello")]
```

## Working Solution

After extensive debugging, here are the correct imports (as of SDK version ~1.x):

```python
# For datasets
from orq_ai_sdk.models import CreateDatasetRequestBody
from orq_ai_sdk.models.createdatasetitemop import (
    CreateDatasetItemRequestBody,  # NOT "RequestBody"
    CreateDatasetItemMessagesUserMessage,
    CreateDatasetItemMessagesSystemMessage,
    CreateDatasetItemMessagesAssistantMessage,
)

# For prompts (PromptConfiguration is deprecated but still works)
from orq_ai_sdk.models.createpromptop import (
    CreatePromptRequestBody,
    PromptConfiguration,  # Deprecated but functional
    CreatePromptMessages,
    ModelParameters,
)
```

## Recommendations for SDK Maintainers

1. **Export canonical types** from the top-level `orq_ai_sdk.models` module
2. **Use stable, short names** like `DatasetItem`, `PromptConfig` instead of `CreateDatasetItemRequestBody`
3. **Document the primary types** users should import
4. **Accept simple dicts** for messages instead of requiring specific message types
5. **Version types** clearly when making breaking changes
6. **Reduce the number of exported symbols** - most are internal implementation details

## Time Spent Debugging

Each SDK import error requires:
1. Running `dir(module)` to see available exports (~200+ names)
2. Guessing which similarly-named type is correct
3. Checking `model_fields` to verify structure
4. Testing if it actually works at runtime

This makes integration unnecessarily painful and error-prone.
