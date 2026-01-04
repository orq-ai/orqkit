import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List available models",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		type: {
			type: "string",
			description: "Filter by model type (e.g., chat, embedding)",
			required: false,
		},
		provider: {
			type: "string",
			description: "Filter by provider (e.g., openai, anthropic)",
			required: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of models to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.models.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			let models = response.data || [];

			// Apply filters if specified
			if (args.type) {
				models = models.filter((m) => m.type?.toLowerCase() === args.type?.toLowerCase());
			}

			if (args.provider) {
				models = models.filter((m) => m.provider?.toLowerCase() === args.provider?.toLowerCase());
			}

			if (args.json) {
				printJson(models);
				return;
			}

			if (models.length === 0) {
				consola.info("No models found");
				return;
			}

			const headers = ["ID", "Provider", "Type", "Name"];
			const rows = models.map((model) => [
				model.id || "",
				model.provider || "",
				model.type || "",
				truncate(model.displayName || model.id || "", 40),
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list models: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

export default defineCommand({
	meta: {
		name: "models",
		description: "Discover available models",
	},
	subCommands: {
		list,
	},
});
