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
 * Register all prompt-related tools with the MCP server
 */
export function registerPromptTools(server: McpServer): void {
	// List all prompts
	server.tool(
		"list_prompts",
		"List all prompts in the workspace, sorted by creation date (newest first)",
		{
			limit: z.number().optional().describe("Maximum number of prompts to return (1-50, default 10)"),
			startingAfter: z.string().optional().describe("Cursor for pagination - fetch items after this ID"),
		},
		async (args) => {
			const params = new URLSearchParams();
			if (args.limit) params.set("limit", String(args.limit));
			if (args.startingAfter) params.set("starting_after", args.startingAfter);
			const query = params.toString() ? `?${params.toString()}` : "";

			const content = await apiCall(() => orqFetch(`/prompts${query}`));
			return { content };
		}
	);

	// Create a new prompt
	server.tool(
		"create_prompt",
		"Create a new prompt with the specified configuration",
		{
			displayName: z.string().describe("Display name for the prompt"),
			path: z.string().describe("Organizational path (e.g., 'project-name/folder')"),
			model: z.string().describe("Model to use (e.g., 'gpt-4', 'claude-3-sonnet')"),
			messages: MessagesArraySchema.describe("Array of messages defining the prompt template"),
			temperature: z.number().min(0).max(2).optional().describe("Sampling temperature (0-2)"),
			maxTokens: z.number().int().min(1).optional().describe("Maximum tokens in response"),
		},
		async (args) => {
			const modelParameters: Record<string, unknown> = {};
			if (args.temperature !== undefined) modelParameters.temperature = args.temperature;
			if (args.maxTokens !== undefined) modelParameters.maxTokens = args.maxTokens;

			const content = await apiCall(() =>
				orqFetch("/prompts", {
					method: "POST",
					body: JSON.stringify({
						display_name: args.displayName,
						path: args.path,
						prompt_config: {
							messages: args.messages.map((m) => ({
								role: m.role,
								content: m.content,
							})),
							model: args.model,
							model_parameters: Object.keys(modelParameters).length > 0 ? modelParameters : undefined,
						},
					}),
				})
			);
			return { content };
		}
	);

	// Get a single prompt by ID
	server.tool(
		"get_prompt",
		"Retrieve a specific prompt by its ID",
		{
			promptId: z.string().describe("The unique identifier of the prompt"),
		},
		async (args) => {
			const content = await apiCall(() => orqFetch(`/prompts/${args.promptId}`));
			return { content };
		}
	);

	// Update an existing prompt
	server.tool(
		"update_prompt",
		"Update an existing prompt. Only provide fields you want to change.",
		{
			promptId: z.string().describe("The unique identifier of the prompt to update"),
			path: z.string().optional().describe("New organizational path"),
			model: z.string().optional().describe("New model to use"),
			messages: MessagesArraySchema.optional().describe("New messages array"),
			temperature: z.number().min(0).max(2).optional().describe("New sampling temperature"),
			maxTokens: z.number().int().min(1).optional().describe("New maximum tokens"),
		},
		async (args) => {
			const body: Record<string, unknown> = {};

			if (args.path !== undefined) {
				body.path = args.path;
			}

			// Only include prompt_config if there's something to update
			const hasPromptConfigUpdates =
				args.model !== undefined ||
				args.messages !== undefined ||
				args.temperature !== undefined ||
				args.maxTokens !== undefined;

			if (hasPromptConfigUpdates) {
				const promptConfig: Record<string, unknown> = {};

				if (args.model !== undefined) {
					promptConfig.model = args.model;
				}
				if (args.messages !== undefined) {
					promptConfig.messages = args.messages.map((m) => ({
						role: m.role,
						content: m.content,
					}));
				}

				const modelParameters: Record<string, unknown> = {};
				if (args.temperature !== undefined) modelParameters.temperature = args.temperature;
				if (args.maxTokens !== undefined) modelParameters.maxTokens = args.maxTokens;
				if (Object.keys(modelParameters).length > 0) {
					promptConfig.model_parameters = modelParameters;
				}

				body.prompt_config = promptConfig;
			}

			const content = await apiCall(() =>
				orqFetch(`/prompts/${args.promptId}`, {
					method: "PATCH",
					body: JSON.stringify(body),
				})
			);
			return { content };
		}
	);

	// NOTE: Destructive operation - commented out for safety
	// server.tool("delete_prompt", ...)

	// List prompt versions
	server.tool(
		"list_prompt_versions",
		"List all versions of a specific prompt",
		{
			promptId: z.string().describe("The unique identifier of the prompt"),
			limit: z.number().optional().describe("Maximum number of versions to return (1-50, default 10)"),
			startingAfter: z.string().optional().describe("Cursor for pagination - fetch items after this ID"),
		},
		async (args) => {
			const params = new URLSearchParams();
			if (args.limit) params.set("limit", String(args.limit));
			if (args.startingAfter) params.set("starting_after", args.startingAfter);
			const query = params.toString() ? `?${params.toString()}` : "";

			const content = await apiCall(() =>
				orqFetch(`/prompts/${args.promptId}/versions${query}`)
			);
			return { content };
		}
	);

	// Get a specific prompt version
	server.tool(
		"get_prompt_version",
		"Retrieve a specific version of a prompt",
		{
			promptId: z.string().describe("The unique identifier of the prompt"),
			versionId: z.string().describe("The unique identifier of the version"),
		},
		async (args) => {
			const content = await apiCall(() =>
				orqFetch(`/prompts/${args.promptId}/versions/${args.versionId}`)
			);
			return { content };
		}
	);
}
