import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all agents",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of agents to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.agents.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const agents = response.data || [];

			if (args.json) {
				printJson(agents);
				return;
			}

			if (agents.length === 0) {
				consola.info("No agents found");
				return;
			}

			const headers = ["ID", "Display Name", "Status", "Created"];
			const rows = agents.map((agent) => [
				agent.id || "",
				truncate(agent.displayName || "", 30),
				agent.status || "",
				agent.created ? new Date(agent.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list agents: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const get = defineCommand({
	meta: {
		name: "get",
		description: "Retrieve agent details",
	},
	args: {
		id: {
			type: "positional",
			description: "Agent ID",
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
			const agent = await client.agents.retrieve({ agentId: args.id });

			if (args.json) {
				printJson(agent);
				return;
			}

			console.log(`ID: ${agent.id}`);
			console.log(`Display Name: ${agent.displayName}`);
			console.log(`Status: ${agent.status}`);
			console.log(`Description: ${agent.description || "N/A"}`);
			console.log(`Created: ${agent.created ? new Date(agent.created).toISOString() : "N/A"}`);
			console.log(`Updated: ${agent.updated ? new Date(agent.updated).toISOString() : "N/A"}`);

			if (agent.modelId) {
				console.log(`Model: ${agent.modelId}`);
			}
		} catch (error) {
			printError(`Failed to retrieve agent: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const create = defineCommand({
	meta: {
		name: "create",
		description: "Create a new agent",
	},
	args: {
		displayName: {
			type: "string",
			description: "Agent display name",
			required: true,
		},
		description: {
			type: "string",
			description: "Agent description",
			required: false,
		},
		model: {
			type: "string",
			description: "Model ID to use",
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
			const agent = await client.agents.create({
				displayName: args.displayName,
				description: args.description,
				modelId: args.model,
			});

			if (args.json) {
				printJson(agent);
				return;
			}

			printSuccess(`Agent created successfully`);
			console.log(`ID: ${agent.id}`);
			console.log(`Display Name: ${agent.displayName}`);
		} catch (error) {
			printError(`Failed to create agent: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const update = defineCommand({
	meta: {
		name: "update",
		description: "Update an agent",
	},
	args: {
		id: {
			type: "positional",
			description: "Agent ID",
			required: true,
		},
		displayName: {
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
			const agent = await client.agents.update({
				agentId: args.id,
				displayName: args.displayName,
				description: args.description,
			});

			if (args.json) {
				printJson(agent);
				return;
			}

			printSuccess(`Agent updated successfully`);
			console.log(`ID: ${agent.id}`);
			console.log(`Display Name: ${agent.displayName}`);
		} catch (error) {
			printError(`Failed to update agent: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteAgent = defineCommand({
	meta: {
		name: "delete",
		description: "Delete an agent",
	},
	args: {
		id: {
			type: "positional",
			description: "Agent ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete agent ${args.id}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.agents.delete({ agentId: args.id });

			printSuccess(`Agent ${args.id} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete agent: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const run = defineCommand({
	meta: {
		name: "run",
		description: "Run an agent and get a response",
	},
	args: {
		id: {
			type: "positional",
			description: "Agent ID",
			required: true,
		},
		input: {
			type: "string",
			description: "Input message for the agent",
			required: true,
		},
		sessionId: {
			type: "string",
			description: "Session ID for conversation continuity",
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
			const response = await client.agents.responses.create({
				agentId: args.id,
				input: args.input,
				sessionId: args.sessionId,
			});

			if (args.json) {
				printJson(response);
				return;
			}

			console.log(response.output || "No output");
		} catch (error) {
			printError(`Failed to run agent: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

export default defineCommand({
	meta: {
		name: "agents",
		description: "Manage AI agents",
	},
	subCommands: {
		list,
		get,
		create,
		update,
		delete: deleteAgent,
		run,
	},
});
