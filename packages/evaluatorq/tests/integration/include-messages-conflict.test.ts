/**
 * Integration tests for includeMessages conflict error.
 *
 * These tests use the real Orq API and require ORQ_API_KEY in .env
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env from package root
config({ path: resolve(import.meta.dir, "../../.env") });

const apiKey = process.env.ORQ_API_KEY;
const serverURL = process.env.ORQ_BASE_URL || "https://my.orq.ai";

// Dynamic imports to avoid issues when modules aren't available
let Orq: typeof import("@orq-ai/node").Orq;
let evaluatorq: typeof import("../../src/index.js").evaluatorq;
let job: typeof import("../../src/index.js").job;

describe("includeMessages integration tests", () => {
	let client: InstanceType<typeof Orq>;
	let datasetId: string | undefined;

	beforeAll(async () => {
		if (!apiKey) {
			console.warn("Skipping integration tests: ORQ_API_KEY not set in .env");
			return;
		}

		// Dynamic imports
		const orqModule = await import("@orq-ai/node");
		Orq = orqModule.Orq;

		const evaluatorqModule = await import("../../src/index.js");
		evaluatorq = evaluatorqModule.evaluatorq;
		job = evaluatorqModule.job;

		client = new Orq({ apiKey, serverURL });
	});

	afterAll(async () => {
		// Cleanup dataset if it was created
		if (datasetId && client) {
			try {
				await client.datasets.clear({ datasetId });
			} catch {
				// Ignore cleanup errors
			}
			try {
				await client.datasets.delete({ datasetId });
			} catch (e) {
				console.warn(`Warning: Failed to delete dataset: ${e}`);
			}
		}
	});

	it("throws error when includeMessages is true and inputs already contain messages", async () => {
		if (!apiKey) {
			console.warn("Skipping: ORQ_API_KEY not set");
			return;
		}

		// Create temporary dataset
		const dataset = await client.datasets.create({
			displayName: "test-include-messages-conflict-ts",
			path: "evaluatorq-test",
		});
		datasetId = dataset.id;

		// Add datapoint with messages in BOTH inputs and top-level
		await client.datasets.createDatapoint({
			datasetId,
			requestBody: [
				{
					inputs: {
						prompt: "Hello",
						messages: [
							{ role: "user", content: "Existing message in inputs" },
						],
					},
					messages: [{ role: "assistant", content: "Top-level message" }],
				},
			],
		});

		const dummyJob = job("dummy", async (data) => data.inputs);

		// Should throw error about conflicting messages
		let error: Error | undefined;
		try {
			await evaluatorq("test-conflict", {
				data: { datasetId, includeMessages: true },
				jobs: [dummyJob],
				evaluators: [],
				print: false,
			});
		} catch (e) {
			error = e as Error;
		}

		expect(error).toBeDefined();
		expect(error?.message).toContain(
			"includeMessages is enabled but the datapoint inputs already contain a 'messages' key",
		);
	});

	it("merges messages into inputs when there is no conflict", async () => {
		if (!apiKey) {
			console.warn("Skipping: ORQ_API_KEY not set");
			return;
		}

		// Create temporary dataset (reuse cleanup from previous test or create new)
		if (!datasetId) {
			const dataset = await client.datasets.create({
				displayName: "test-include-messages-no-conflict-ts",
				path: "evaluatorq-test",
			});
			datasetId = dataset.id;
		} else {
			// Clear existing datapoints
			await client.datasets.clear({ datasetId });
		}

		// Add datapoint with top-level messages but NO messages in inputs
		await client.datasets.createDatapoint({
			datasetId,
			requestBody: [
				{
					inputs: {
						prompt: "Hello",
					},
					messages: [{ role: "user", content: "Top-level message" }],
				},
			],
		});

		const capturedInputs: Record<string, unknown>[] = [];
		const captureJob = job("capture", async (data) => {
			capturedInputs.push(data.inputs);
			return "done";
		});

		await evaluatorq("test-no-conflict", {
			data: { datasetId, includeMessages: true },
			jobs: [captureJob],
			evaluators: [],
			print: false,
		});

		expect(capturedInputs).toHaveLength(1);
		const messages = capturedInputs[0].messages as Array<
			{ role: string; content: string } | { role: string; content: string; name?: string }
		>;
		expect(messages).toHaveLength(1);
		// Messages may be returned as objects with extra properties
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toBe("Top-level message");
	});
});
