import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { orqFetch } from "../client.js";
import { MessagesArraySchema } from "../types.js";

/**
 * Helper to wrap API calls with error handling.
 *
 * Note: We use raw HTTP calls instead of the SDK because the SDK has validation
 * issues with `null` values in response fields (e.g., created_by_id: null).
 * See SDK_VALIDATION_ISSUE.md for details.
 */
async function apiCall(
	fn: () => Promise<unknown>
): Promise<{ type: "text"; text: string }[]> {
	try {
		const result = await fn();
		return [{ type: "text", text: JSON.stringify(result, null, 2) }];
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return [{ type: "text", text: `Error: ${errorMessage}` }];
	}
}

/**
 * Register all dataset-related tools with the MCP server
 */
export function registerDatasetTools(server: McpServer): void {
	// List all datasets
	server.tool(
		"list_datasets",
		"List all datasets in the workspace with pagination support",
		{
			limit: z.number().optional().describe("Maximum number of datasets to return (1-50, default 10)"),
			startingAfter: z.string().optional().describe("Cursor for pagination - fetch items after this ID"),
		},
		async (args) => {
			const params = new URLSearchParams();
			if (args.limit) params.set("limit", String(args.limit));
			if (args.startingAfter) params.set("starting_after", args.startingAfter);
			const query = params.toString() ? `?${params.toString()}` : "";

			const content = await apiCall(() => orqFetch(`/datasets${query}`));
			return { content };
		}
	);

	// Create a new dataset
	server.tool(
		"create_dataset",
		"Create a new dataset for storing datapoints",
		{
			displayName: z.string().describe("Display name for the dataset"),
			path: z.string().describe("Organizational path (e.g., 'project-name/training')"),
		},
		async (args) => {
			const content = await apiCall(() =>
				orqFetch("/datasets", {
					method: "POST",
					body: JSON.stringify({
						display_name: args.displayName,
						path: args.path,
					}),
				})
			);
			return { content };
		}
	);

	// Get a single dataset by ID
	server.tool(
		"get_dataset",
		"Retrieve a specific dataset by its ID",
		{
			datasetId: z.string().describe("The unique identifier of the dataset"),
		},
		async (args) => {
			const content = await apiCall(() => orqFetch(`/datasets/${args.datasetId}`));
			return { content };
		}
	);

	// Update an existing dataset
	server.tool(
		"update_dataset",
		"Update an existing dataset's metadata",
		{
			datasetId: z.string().describe("The unique identifier of the dataset to update"),
			path: z.string().optional().describe("New organizational path"),
		},
		async (args) => {
			const body: Record<string, unknown> = {};
			if (args.path !== undefined) body.path = args.path;

			const content = await apiCall(() =>
				orqFetch(`/datasets/${args.datasetId}`, {
					method: "PATCH",
					body: JSON.stringify(body),
				})
			);
			return { content };
		}
	);

	// NOTE: Destructive operation - commented out for safety
	// server.tool("delete_dataset", ...)

	// List datapoints in a dataset
	server.tool(
		"list_datapoints",
		"List all datapoints in a specific dataset",
		{
			datasetId: z.string().describe("The unique identifier of the dataset"),
			limit: z.number().optional().describe("Maximum number of datapoints to return (1-50, default 10)"),
			startingAfter: z.string().optional().describe("Cursor for pagination - fetch items after this ID"),
		},
		async (args) => {
			const params = new URLSearchParams();
			if (args.limit) params.set("limit", String(args.limit));
			if (args.startingAfter) params.set("starting_after", args.startingAfter);
			const query = params.toString() ? `?${params.toString()}` : "";

			const content = await apiCall(() =>
				orqFetch(`/datasets/${args.datasetId}/datapoints${query}`)
			);
			return { content };
		}
	);

	// Create a new datapoint
	server.tool(
		"create_datapoint",
		"Create a new datapoint in a dataset with messages (conversation format)",
		{
			datasetId: z.string().describe("The unique identifier of the dataset"),
			messages: MessagesArraySchema.describe("Array of messages (role + content pairs) representing the conversation"),
			expectedOutput: z.string().optional().describe("Expected output/response for this datapoint"),
		},
		async (args) => {
			const datapoint: Record<string, unknown> = {
				inputs: {
					messages: args.messages,
				},
			};
			if (args.expectedOutput !== undefined) {
				datapoint.expected_output = args.expectedOutput;
			}

			const content = await apiCall(() =>
				orqFetch(`/datasets/${args.datasetId}/datapoints`, {
					method: "POST",
					body: JSON.stringify([datapoint]),
				})
			);
			return { content };
		}
	);

	// Get a specific datapoint
	server.tool(
		"get_datapoint",
		"Retrieve a specific datapoint from a dataset",
		{
			datasetId: z.string().describe("The unique identifier of the dataset"),
			datapointId: z.string().describe("The unique identifier of the datapoint"),
		},
		async (args) => {
			const content = await apiCall(() =>
				orqFetch(`/datasets/${args.datasetId}/datapoints/${args.datapointId}`)
			);
			return { content };
		}
	);

	// NOTE: Destructive operations - commented out for safety
	// server.tool("delete_datapoint", ...)
	// server.tool("clear_dataset", ...)
}
