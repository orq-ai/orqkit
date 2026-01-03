import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all deployments",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of deployments to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.deployments.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const deployments = response.data || [];

			if (args.json) {
				printJson(deployments);
				return;
			}

			if (deployments.length === 0) {
				consola.info("No deployments found");
				return;
			}

			const headers = ["Key", "Description", "Created"];
			const rows = deployments.map((deployment) => [
				deployment.key || "",
				truncate(deployment.description || "", 40),
				deployment.created ? new Date(deployment.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list deployments: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const invoke = defineCommand({
	meta: {
		name: "invoke",
		description: "Invoke a deployment",
	},
	args: {
		key: {
			type: "positional",
			description: "Deployment key",
			required: true,
		},
		input: {
			type: "string",
			description: "Input for the deployment (JSON object or simple string)",
			required: false,
		},
		context: {
			type: "string",
			description: "Context variables as JSON",
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

			let context: Record<string, unknown> | undefined;
			if (args.context) {
				try {
					context = JSON.parse(args.context);
				} catch {
					printError("Invalid JSON for context");
					process.exit(1);
				}
			}

			const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
			if (args.input) {
				messages.push({ role: "user", content: args.input });
			}

			const response = await client.deployments.invoke({
				key: args.key,
				context,
				messages: messages.length > 0 ? messages : undefined,
			});

			if (args.json) {
				printJson(response);
				return;
			}

			if (response.choices && response.choices.length > 0) {
				const choice = response.choices[0];
				if (choice.message?.content) {
					console.log(choice.message.content);
				} else {
					printJson(choice);
				}
			} else {
				printJson(response);
			}
		} catch (error) {
			printError(`Failed to invoke deployment: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const config = defineCommand({
	meta: {
		name: "config",
		description: "Get deployment configuration",
	},
	args: {
		key: {
			type: "positional",
			description: "Deployment key",
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
			const deploymentConfig = await client.deployments.getConfig({
				key: args.key,
			});

			if (args.json) {
				printJson(deploymentConfig);
				return;
			}

			console.log(`Key: ${deploymentConfig.key}`);
			console.log(`Model: ${deploymentConfig.model || "N/A"}`);
			console.log(`Provider: ${deploymentConfig.provider || "N/A"}`);

			if (deploymentConfig.parameters) {
				console.log("\nParameters:");
				for (const [key, value] of Object.entries(deploymentConfig.parameters)) {
					console.log(`  ${key}: ${value}`);
				}
			}

			if (deploymentConfig.messages && deploymentConfig.messages.length > 0) {
				console.log("\nMessages:");
				for (const msg of deploymentConfig.messages) {
					console.log(`  [${msg.role}]: ${truncate(String(msg.content || ""), 60)}`);
				}
			}
		} catch (error) {
			printError(`Failed to get deployment config: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const stream = defineCommand({
	meta: {
		name: "stream",
		description: "Stream deployment execution",
	},
	args: {
		key: {
			type: "positional",
			description: "Deployment key",
			required: true,
		},
		input: {
			type: "string",
			description: "Input message",
			required: false,
		},
		context: {
			type: "string",
			description: "Context variables as JSON",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();

			let context: Record<string, unknown> | undefined;
			if (args.context) {
				try {
					context = JSON.parse(args.context);
				} catch {
					printError("Invalid JSON for context");
					process.exit(1);
				}
			}

			const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
			if (args.input) {
				messages.push({ role: "user", content: args.input });
			}

			const stream = await client.deployments.stream({
				key: args.key,
				context,
				messages: messages.length > 0 ? messages : undefined,
			});

			for await (const chunk of stream) {
				if (chunk.choices && chunk.choices.length > 0) {
					const delta = chunk.choices[0].delta;
					if (delta?.content) {
						process.stdout.write(delta.content);
					}
				}
			}
			console.log(); // New line after streaming
		} catch (error) {
			printError(`Failed to stream deployment: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

export default defineCommand({
	meta: {
		name: "deployments",
		description: "Manage deployments",
	},
	subCommands: {
		list,
		invoke,
		config,
		stream,
	},
});
