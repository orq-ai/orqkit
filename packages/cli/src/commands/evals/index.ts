import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all evaluators",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of evaluators to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.evals.all({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const evals = response.data || [];

			if (args.json) {
				printJson(evals);
				return;
			}

			if (evals.length === 0) {
				consola.info("No evaluators found");
				return;
			}

			const headers = ["ID", "Key", "Display Name", "Type", "Created"];
			const rows = evals.map((ev) => [
				ev.id || "",
				ev.key || "",
				truncate(ev.displayName || "", 25),
				ev.type || "",
				ev.created ? new Date(ev.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list evaluators: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const create = defineCommand({
	meta: {
		name: "create",
		description: "Create a new evaluator",
	},
	args: {
		key: {
			type: "string",
			description: "Evaluator key",
			required: true,
		},
		name: {
			type: "string",
			description: "Display name",
			required: true,
		},
		type: {
			type: "string",
			description: "Evaluator type (e.g., llm, code, ragas)",
			required: true,
		},
		description: {
			type: "string",
			description: "Evaluator description",
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
			const evaluator = await client.evals.create({
				key: args.key,
				displayName: args.name,
				type: args.type as "llm" | "code" | "ragas",
				description: args.description,
			});

			if (args.json) {
				printJson(evaluator);
				return;
			}

			printSuccess(`Evaluator created successfully`);
			console.log(`ID: ${evaluator.id}`);
			console.log(`Key: ${evaluator.key}`);
			console.log(`Name: ${evaluator.displayName}`);
		} catch (error) {
			printError(`Failed to create evaluator: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const update = defineCommand({
	meta: {
		name: "update",
		description: "Update an evaluator",
	},
	args: {
		id: {
			type: "positional",
			description: "Evaluator ID",
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
			const evaluator = await client.evals.update({
				evaluatorId: args.id,
				displayName: args.name,
				description: args.description,
			});

			if (args.json) {
				printJson(evaluator);
				return;
			}

			printSuccess(`Evaluator updated successfully`);
			console.log(`ID: ${evaluator.id}`);
			console.log(`Name: ${evaluator.displayName}`);
		} catch (error) {
			printError(`Failed to update evaluator: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteEval = defineCommand({
	meta: {
		name: "delete",
		description: "Delete an evaluator",
	},
	args: {
		id: {
			type: "positional",
			description: "Evaluator ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete evaluator ${args.id}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.evals.delete({ evaluatorId: args.id });

			printSuccess(`Evaluator ${args.id} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete evaluator: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const invoke = defineCommand({
	meta: {
		name: "invoke",
		description: "Run a custom evaluator",
	},
	args: {
		id: {
			type: "positional",
			description: "Evaluator ID",
			required: true,
		},
		input: {
			type: "string",
			description: "Input to evaluate",
			required: true,
		},
		output: {
			type: "string",
			description: "Output to evaluate",
			required: true,
		},
		expected: {
			type: "string",
			description: "Expected output (reference)",
			required: false,
		},
		context: {
			type: "string",
			description: "Additional context as JSON",
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
			let context: Record<string, unknown> | undefined;
			if (args.context) {
				try {
					context = JSON.parse(args.context);
				} catch {
					printError("Invalid JSON for context");
					process.exit(1);
				}
			}

			const client = getClient();
			const result = await client.evals.invoke({
				evaluatorId: args.id,
				input: args.input,
				output: args.output,
				expected: args.expected,
				context,
			});

			if (args.json) {
				printJson(result);
				return;
			}

			console.log(`Score: ${result.score}`);
			if (result.reason) {
				console.log(`Reason: ${result.reason}`);
			}
		} catch (error) {
			printError(`Failed to invoke evaluator: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

export default defineCommand({
	meta: {
		name: "evals",
		description: "Manage evaluators",
	},
	subCommands: {
		list,
		create,
		update,
		delete: deleteEval,
		invoke,
	},
});
