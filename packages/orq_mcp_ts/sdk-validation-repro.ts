/**
 * Minimal reproduction of SDK validation error.
 *
 * Usage:
 *   export ORQ_API_KEY=your-api-key
 *   bun sdk-validation-repro.ts
 *
 * This demonstrates two distinct SDK validation issues:
 * 1. Explicit `undefined` values in request parameters cause validation failure
 * 2. API returns `null` for optional fields, but SDK expects `string | undefined`
 */

import { Orq } from "@orq-ai/node";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const apiKey = process.env.ORQ_API_KEY;
if (!apiKey) {
	console.error("Error: ORQ_API_KEY environment variable is required");
	process.exit(1);
}

const client = new Orq({ apiKey });

// Helper to strip undefined values from objects
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined)
	) as T;
}

async function main() {
	console.log("=".repeat(60));
	console.log("SDK Validation Issue Reproduction");
	console.log("=".repeat(60));
	console.log("");

	try {
		const pkg = require("@orq-ai/node/package.json");
		console.log("SDK version:", pkg.version);
	} catch {
		console.log("SDK version: (could not read)");
	}
	console.log("");

	// ============================================================
	// ISSUE 1: Explicit undefined values cause validation failure
	// ============================================================
	console.log("-".repeat(60));
	console.log("ISSUE 1: Explicit undefined values in request parameters");
	console.log("-".repeat(60));
	console.log("");

	console.log("Test 1a: Call with explicit undefined args");
	console.log("  Code: client.datasets.list({ limit: undefined })");
	try {
		await client.datasets.list({ limit: undefined });
		console.log("  Result: ✅ SUCCESS (unexpected)");
	} catch (error: unknown) {
		console.log("  Result: ❌ FAILED (expected)");
		if (error instanceof Error) {
			console.log("  Error:", error.message.substring(0, 100));
		}
	}
	console.log("");

	console.log("Test 1b: Call with stripUndefined helper (THE FIX)");
	console.log("  Code: client.datasets.list(stripUndefined({ limit: undefined }))");
	try {
		await client.datasets.list(stripUndefined({ limit: undefined }));
		console.log("  Result: ✅ SUCCESS");
	} catch (error: unknown) {
		console.log("  Result: ❌ FAILED");
		if (error instanceof Error) {
			console.log("  Error:", error.message.substring(0, 100));
		}
	}
	console.log("");

	// ============================================================
	// ISSUE 2: API returns null but SDK expects undefined
	// ============================================================
	console.log("-".repeat(60));
	console.log("ISSUE 2: API returns null for optional fields");
	console.log("SDK schema uses z.string().optional() which only accepts");
	console.log("string | undefined, NOT null");
	console.log("-".repeat(60));
	console.log("");

	console.log("Test 2a: List datasets with limit=1");
	try {
		const result = await client.datasets.list({ limit: 1 });
		console.log("  Result: ✅ SUCCESS");
		console.log(`  Returned ${result.data?.length || 0} dataset(s)`);
	} catch (error: unknown) {
		console.log("  Result: ❌ FAILED");
		if (error instanceof Error) {
			console.log("  Error:", error.message.substring(0, 100));
		}
	}
	console.log("");

	console.log("Test 2b: List datasets with limit=2");
	try {
		const result = await client.datasets.list({ limit: 2 });
		console.log("  Result: ✅ SUCCESS");
		console.log(`  Returned ${result.data?.length || 0} dataset(s)`);
	} catch (error: unknown) {
		console.log("  Result: ❌ FAILED");
		if (error instanceof Error) {
			console.log("  Error:", error.message.substring(0, 100));
		}
	}
	console.log("");

	console.log("Test 2c: List datasets with limit=3 (EXPECTED TO FAIL)");
	console.log("  The 3rd dataset has created_by_id: null and updated_by_id: null");
	try {
		const result = await client.datasets.list({ limit: 3 });
		console.log("  Result: ✅ SUCCESS (unexpected - SDK may have been fixed)");
		console.log(`  Returned ${result.data?.length || 0} dataset(s)`);
	} catch (error: unknown) {
		console.log("  Result: ❌ FAILED (expected)");
		if (error instanceof Error) {
			console.log("  Error:", error.message.substring(0, 100));
		}
	}
	console.log("");

	// ============================================================
	// Verify with raw HTTP to show the data is valid
	// ============================================================
	console.log("-".repeat(60));
	console.log("VERIFICATION: Raw HTTP call to show API returns valid data");
	console.log("-".repeat(60));
	console.log("");

	console.log("Fetching 3 datasets via raw HTTP...");
	try {
		const response = await fetch("https://api.orq.ai/v2/datasets?limit=3", {
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});
		const data = await response.json() as { data?: Array<{ _id: string; display_name: string; created_by_id: unknown; updated_by_id: unknown }> };
		console.log("  Raw HTTP Result: ✅ SUCCESS");
		console.log(`  Returned ${data.data?.length || 0} dataset(s)`);
		console.log("");

		// Show the problematic fields
		data.data?.forEach((dataset, i) => {
			console.log(`  Dataset ${i + 1}: ${dataset.display_name}`);
			console.log(`    _id: ${dataset._id}`);
			console.log(`    created_by_id: ${JSON.stringify(dataset.created_by_id)} (type: ${typeof dataset.created_by_id})`);
			console.log(`    updated_by_id: ${JSON.stringify(dataset.updated_by_id)} (type: ${typeof dataset.updated_by_id})`);
			console.log("");
		});
	} catch (error: unknown) {
		console.log("  Raw HTTP Result: ❌ FAILED");
		if (error instanceof Error) {
			console.log("  Error:", error.message);
		}
	}

	// ============================================================
	// Summary
	// ============================================================
	console.log("=".repeat(60));
	console.log("SUMMARY");
	console.log("=".repeat(60));
	console.log("");
	console.log("Issue 1: SDK fails when explicit `undefined` is passed");
	console.log("  Fix: Use stripUndefined() helper before SDK calls");
	console.log("");
	console.log("Issue 2: SDK validation fails when API returns null fields");
	console.log("  Root cause: SDK schema uses z.string().optional()");
	console.log("              which accepts string | undefined, NOT null");
	console.log("  Fix: Use raw HTTP calls to bypass SDK validation");
	console.log("       OR wait for SDK fix (z.string().nullable().optional())");
	console.log("");
}

main();
