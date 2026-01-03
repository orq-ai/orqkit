import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all prompts",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of prompts to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.prompts.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const prompts = response.data || [];

			if (args.json) {
				printJson(prompts);
				return;
			}

			if (prompts.length === 0) {
				consola.info("No prompts found");
				return;
			}

			const headers = ["ID", "Key", "Display Name", "Created"];
			const rows = prompts.map((prompt) => [
				prompt.id || "",
				prompt.key || "",
				truncate(prompt.displayName || "", 30),
				prompt.created ? new Date(prompt.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list prompts: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const get = defineCommand({
	meta: {
		name: "get",
		description: "Retrieve prompt details",
	},
	args: {
		id: {
			type: "positional",
			description: "Prompt ID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const prompt = await client.prompts.retrieve({ promptId: args.id });

			if (args.json) {
				printJson(prompt);
				return;
			}

			console.log(`ID: ${prompt.id}`);
			console.log(`Key: ${prompt.key}`);
			console.log(`Display Name: ${prompt.displayName}`);
			console.log(`Description: ${prompt.description || "N/A"}`);
			console.log(`Created: ${prompt.created ? new Date(prompt.created).toISOString() : "N/A"}`);
			console.log(`Updated: ${prompt.updated ? new Date(prompt.updated).toISOString() : "N/A"}`);

			if (prompt.promptConfig?.messages) {
				console.log("\nMessages:");
				for (const msg of prompt.promptConfig.messages) {
					console.log(`  [${msg.role}]: ${truncate(String(msg.content || ""), 80)}`);
				}
			}
		} catch (error) {
			printError(`Failed to retrieve prompt: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const create = defineCommand({
	meta: {
		name: "create",
		description: "Create a new prompt",
	},
	args: {
		key: {
			type: "string",
			description: "Prompt key",
			required: true,
		},
		name: {
			type: "string",
			description: "Display name",
			required: true,
		},
		description: {
			type: "string",
			description: "Prompt description",
			required: false,
		},
		model: {
			type: "string",
			description: "Model ID",
			required: false,
		},
		systemPrompt: {
			type: "string",
			description: "System prompt content",
			required: false,
		},
		path: {
			type: "string",
			description: "Path (e.g., Default/Production)",
			required: false,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();

			const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
			if (args.systemPrompt) {
				messages.push({ role: "system", content: args.systemPrompt });
			}

			const prompt = await client.prompts.create({
				key: args.key,
				displayName: args.name,
				description: args.description,
				path: args.path,
				promptConfig: {
					messages: messages.length > 0 ? messages : undefined,
				},
				modelConfig: args.model
					? {
							modelId: args.model,
						}
					: undefined,
			});

			if (args.json) {
				printJson(prompt);
				return;
			}

			printSuccess(`Prompt created successfully`);
			console.log(`ID: ${prompt.id}`);
			console.log(`Key: ${prompt.key}`);
			console.log(`Name: ${prompt.displayName}`);
		} catch (error) {
			printError(`Failed to create prompt: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const update = defineCommand({
	meta: {
		name: "update",
		description: "Update a prompt",
	},
	args: {
		id: {
			type: "positional",
			description: "Prompt ID",
			required: true,
		},
		name: {
			type: "string",
			description: "New display name",
			required: false,
		},
		description: {
			type: "string",
			description: "New description",
			required: false,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const prompt = await client.prompts.update({
				promptId: args.id,
				displayName: args.name,
				description: args.description,
			});

			if (args.json) {
				printJson(prompt);
				return;
			}

			printSuccess(`Prompt updated successfully`);
			console.log(`ID: ${prompt.id}`);
			console.log(`Name: ${prompt.displayName}`);
		} catch (error) {
			printError(`Failed to update prompt: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deletePrompt = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a prompt",
	},
	args: {
		id: {
			type: "positional",
			description: "Prompt ID",
			required: true,
		},
		force: {
			type: "boolean",
			description: "Skip confirmation",
			default: false,
		},
	},
	async run({ args }) {
		try {
			if (!args.force) {
				const confirm = await consola.prompt(`Are you sure you want to delete prompt ${args.id}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.prompts.delete({ promptId: args.id });

			printSuccess(`Prompt ${args.id} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete prompt: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const versions = defineCommand({
	meta: {
		name: "versions",
		description: "List prompt versions",
	},
	args: {
		id: {
			type: "positional",
			description: "Prompt ID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.prompts.listVersions({ promptId: args.id });

			const promptVersions = response.data || [];

			if (args.json) {
				printJson(promptVersions);
				return;
			}

			if (promptVersions.length === 0) {
				consola.info("No versions found");
				return;
			}

			const headers = ["Version", "Commit", "Created"];
			const rows = promptVersions.map((version) => [
				version.version?.toString() || "",
				truncate(version.commit || "", 20),
				version.created ? new Date(version.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list prompt versions: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const version = defineCommand({
	meta: {
		name: "version",
		description: "Get a specific prompt version",
	},
	args: {
		id: {
			type: "positional",
			description: "Prompt ID",
			required: true,
		},
		versionId: {
			type: "positional",
			description: "Version ID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const promptVersion = await client.prompts.getVersion({
				promptId: args.id,
				versionId: args.versionId,
			});

			if (args.json) {
				printJson(promptVersion);
				return;
			}

			console.log(`Version: ${promptVersion.version}`);
			console.log(`Commit: ${promptVersion.commit || "N/A"}`);
			console.log(`Created: ${promptVersion.created ? new Date(promptVersion.created).toISOString() : "N/A"}`);

			if (promptVersion.promptConfig?.messages) {
				console.log("\nMessages:");
				for (const msg of promptVersion.promptConfig.messages) {
					console.log(`  [${msg.role}]: ${truncate(String(msg.content || ""), 80)}`);
				}
			}
		} catch (error) {
			printError(`Failed to get prompt version: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

export default defineCommand({
	meta: {
		name: "prompts",
		description: "Manage prompts",
	},
	subCommands: {
		list,
		get,
		create,
		update,
		delete: deletePrompt,
		versions,
		version,
	},
});
