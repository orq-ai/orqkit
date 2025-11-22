# SDK Validation Issue

This documents two validation issues with the `@orq-ai/node` SDK that prevent its use in MCP servers.

## Quick Summary

| Issue | Cause | Fix |
|-------|-------|-----|
| Request validation fails | Explicit `undefined` values in request | Use `stripUndefined()` helper |
| Response validation fails | API returns `null`, SDK expects `undefined` | Use raw HTTP calls |

## Issue 1: Explicit Undefined Values

When MCP tools pass optional parameters as explicit `undefined`, the SDK request validation fails.

### Reproduction

```typescript
// This FAILS
await client.datasets.list({ limit: undefined });
// Error: Response validation failed

// This WORKS
await client.datasets.list({});  // Empty object
await client.datasets.list({ limit: 1 });  // Defined value
```

### Fix

Use a `stripUndefined()` helper to remove undefined values before calling the SDK:

```typescript
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as T;
}

// Usage
await client.datasets.list(stripUndefined({ limit: args.limit }));
```

## Issue 2: Null Values in API Response (BLOCKING)

**This is the primary issue that prevents using the SDK.**

The API returns `null` for optional fields, but the SDK's Zod schemas use `z.string().optional()` which only accepts `string | undefined`, NOT `null`.

### Reproduction

```bash
# This works (first 2 datasets have non-null fields)
client.datasets.list({ limit: 2 })  # Success

# This fails (3rd dataset has null fields)
client.datasets.list({ limit: 3 })  # Response validation failed
```

### Root Cause Analysis

**API Response (via raw HTTP):**
```json
{
  "data": [
    {
      "_id": "01KAWEQZDC...",
      "display_name": "Dataset 1",
      "created_by_id": "01JAJ6B2EH...",
      "updated_by_id": "01JAJ6B2EH..."
    },
    {
      "_id": "01KAWE6HQB...",
      "display_name": "Dataset 2",
      "created_by_id": "01JAJ6B2EH...",
      "updated_by_id": "01JAJ6B2EH..."
    },
    {
      "_id": "01K76B7J1D...",
      "display_name": "Dataset 3",
      "created_by_id": null,        // <-- PROBLEM: API returns null
      "updated_by_id": null         // <-- PROBLEM: API returns null
    }
  ]
}
```

**SDK Schema (from `node_modules/@orq-ai/node/src/models/operations/listdatasets.ts`):**
```typescript
export const ListDatasetsData$inboundSchema = z.object({
  created_by_id: z.string().optional(),  // Accepts: string | undefined
  updated_by_id: z.string().optional(),  // Does NOT accept: null
  // ...
});
```

**The Mismatch:**
- SDK expects: `string | undefined`
- API returns: `string | null`
- Result: Validation fails when `null` is encountered

### Why This Can't Be Fixed Client-Side

Unlike Issue 1, this cannot be fixed with a simple helper because:
1. The validation happens on the **response** (not request)
2. The SDK validates the response **before** returning it to user code
3. There's no way to intercept and transform the response before validation

## The Solution

Use raw HTTP calls to bypass SDK validation entirely:

```typescript
// client.ts
const BASE_URL = "https://api.orq.ai/v2";

export async function orqFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const apiKey = getApiKey();

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error ${response.status}: ${errorBody}`);
  }

  return response.json();
}
```

```typescript
// datasets.ts - Using direct HTTP
server.tool(
  "list_datasets",
  "List all datasets in the workspace",
  {
    limit: z.number().optional(),
    startingAfter: z.string().optional(),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.limit) params.set("limit", String(args.limit));
    if (args.startingAfter) params.set("starting_after", args.startingAfter);
    const query = params.toString() ? `?${params.toString()}` : "";

    const result = await orqFetch(`/datasets${query}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

## Reproduction Script

Run the reproduction script to verify the issues:

```bash
cd packages/orq_mcp_ts
export ORQ_API_KEY=your-api-key
bun sdk-validation-repro.ts
```

Expected output:
```
============================================================
SDK Validation Issue Reproduction
============================================================

SDK version: 3.14.45

------------------------------------------------------------
ISSUE 1: Explicit undefined values in request parameters
------------------------------------------------------------

Test 1a: Call with explicit undefined args
  Code: client.datasets.list({ limit: undefined })
  Result: ❌ FAILED (expected)

Test 1b: Call with stripUndefined helper (THE FIX)
  Code: client.datasets.list(stripUndefined({ limit: undefined }))
  Result: ✅ SUCCESS

------------------------------------------------------------
ISSUE 2: API returns null for optional fields
------------------------------------------------------------

Test 2a: List datasets with limit=1
  Result: ✅ SUCCESS

Test 2b: List datasets with limit=2
  Result: ✅ SUCCESS

Test 2c: List datasets with limit=3 (EXPECTED TO FAIL)
  Result: ❌ FAILED (expected)

------------------------------------------------------------
VERIFICATION: Raw HTTP call to show API returns valid data
------------------------------------------------------------

  Dataset 3: ...
    created_by_id: null (type: object)
    updated_by_id: null (type: object)
```

## Recommendation for SDK Maintainers

The SDK schemas should be updated to handle `null` values:

```typescript
// Current (broken)
created_by_id: z.string().optional(),

// Fixed
created_by_id: z.string().nullable().optional(),
```

This change should be applied to all optional fields that can be `null` in the API response.

## SDK Version Tested

- `@orq-ai/node`: 3.14.45

---

## Linear Ticket Template

**Title:** SDK Response Validation Fails on Null Fields (`@orq-ai/node`)

**Description:**

The `@orq-ai/node` SDK fails with "Response validation failed" when the API returns `null` for optional fields. This prevents reliable use of the SDK in production applications.

**Root Cause:**

The SDK uses Zod schemas for response validation with `z.string().optional()` for optional fields. This schema type only accepts `string | undefined`, but the API returns `null` for these fields when they are not set.

Example failing response:
```json
{
  "_id": "01K76B7J1DVFHAW8D7HX6R8V44",
  "display_name": "Loyalty Program Information",
  "created_by_id": null,
  "updated_by_id": null
}
```

SDK schema (from `@orq-ai/node`):
```typescript
export const ListDatasetsData$inboundSchema = z.object({
  created_by_id: z.string().optional(),  // Does NOT accept null
  updated_by_id: z.string().optional(),  // Does NOT accept null
});
```

**Reproduction:**

```typescript
import { Orq } from "@orq-ai/node";

const client = new Orq({ apiKey: "..." });

// This fails if any returned dataset has null fields
await client.datasets.list({ limit: 10 });
// Error: Response validation failed
```

A full reproduction script is available at `packages/orq_mcp_ts/sdk-validation-repro.ts`.

**Current Workaround:**

We bypass the SDK entirely and use raw HTTP calls:

```typescript
const response = await fetch("https://api.orq.ai/v2/datasets", {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const data = await response.json();
```

This workaround is implemented in the `orq_mcp_ts` MCP server for both datasets and prompts endpoints.

**Required Fix:**

Update the SDK Zod schemas to use `.nullable()` for fields that can be `null`:

```typescript
// Before (broken)
created_by_id: z.string().optional(),

// After (fixed)
created_by_id: z.string().nullable().optional(),
```

This change should be applied to all optional fields across all response schemas in the SDK.

**Affected SDK Version:** `@orq-ai/node` 3.14.45

**Impact:** High - Prevents SDK usage for any workspace with data that has null fields. Affects `datasets.list`, `prompts.list`, and likely other endpoints.
