import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all knowledge bases",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of knowledge bases to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.knowledge.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const knowledgeBases = response.data || [];

			if (args.json) {
				printJson(knowledgeBases);
				return;
			}

			if (knowledgeBases.length === 0) {
				consola.info("No knowledge bases found");
				return;
			}

			const headers = ["ID", "Key", "Name", "Created"];
			const rows = knowledgeBases.map((kb) => [
				kb.id || "",
				kb.key || "",
				truncate(kb.displayName || "", 30),
				kb.created ? new Date(kb.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list knowledge bases: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const get = defineCommand({
	meta: {
		name: "get",
		description: "Retrieve knowledge base details",
	},
	args: {
		id: {
			type: "positional",
			description: "Knowledge base ID",
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
			const kb = await client.knowledge.retrieve({ knowledgeId: args.id });

			if (args.json) {
				printJson(kb);
				return;
			}

			console.log(`ID: ${kb.id}`);
			console.log(`Key: ${kb.key}`);
			console.log(`Name: ${kb.displayName}`);
			console.log(`Embedding Model: ${kb.embeddingModel || "N/A"}`);
			console.log(`Created: ${kb.created ? new Date(kb.created).toISOString() : "N/A"}`);
			console.log(`Updated: ${kb.updated ? new Date(kb.updated).toISOString() : "N/A"}`);
		} catch (error) {
			printError(`Failed to retrieve knowledge base: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const create = defineCommand({
	meta: {
		name: "create",
		description: "Create a new knowledge base",
	},
	args: {
		key: {
			type: "string",
			description: "Knowledge base key",
			required: true,
		},
		name: {
			type: "string",
			description: "Display name",
			required: true,
		},
		embeddingModel: {
			type: "string",
			description: "Embedding model (e.g., cohere/embed-english-v3.0)",
			required: true,
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
			const kb = await client.knowledge.create({
				key: args.key,
				displayName: args.name,
				embeddingModel: args.embeddingModel,
				path: args.path,
			});

			if (args.json) {
				printJson(kb);
				return;
			}

			printSuccess(`Knowledge base created successfully`);
			console.log(`ID: ${kb.id}`);
			console.log(`Key: ${kb.key}`);
			console.log(`Name: ${kb.displayName}`);
		} catch (error) {
			printError(`Failed to create knowledge base: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const update = defineCommand({
	meta: {
		name: "update",
		description: "Update a knowledge base",
	},
	args: {
		id: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		name: {
			type: "string",
			description: "New display name",
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
			const kb = await client.knowledge.update({
				knowledgeId: args.id,
				displayName: args.name,
			});

			if (args.json) {
				printJson(kb);
				return;
			}

			printSuccess(`Knowledge base updated successfully`);
			console.log(`ID: ${kb.id}`);
			console.log(`Name: ${kb.displayName}`);
		} catch (error) {
			printError(`Failed to update knowledge base: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteKb = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a knowledge base",
	},
	args: {
		id: {
			type: "positional",
			description: "Knowledge base ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete knowledge base ${args.id}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.knowledge.delete({ knowledgeId: args.id });

			printSuccess(`Knowledge base ${args.id} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete knowledge base: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const search = defineCommand({
	meta: {
		name: "search",
		description: "Search a knowledge base",
	},
	args: {
		id: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		query: {
			type: "positional",
			description: "Search query",
			required: true,
		},
		limit: {
			type: "string",
			description: "Maximum number of results",
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
			const results = await client.knowledge.search({
				knowledgeId: args.id,
				query: args.query,
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			if (args.json) {
				printJson(results);
				return;
			}

			const chunks = results.data || [];
			if (chunks.length === 0) {
				consola.info("No results found");
				return;
			}

			for (const [index, chunk] of chunks.entries()) {
				console.log(`\n--- Result ${index + 1} (Score: ${chunk.score?.toFixed(4) || "N/A"}) ---`);
				console.log(truncate(chunk.content || "", 500));
			}
		} catch (error) {
			printError(`Failed to search knowledge base: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

// Datasources subcommands
const listDatasources = defineCommand({
	meta: {
		name: "list",
		description: "List datasources in a knowledge base",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
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
			const response = await client.knowledge.listDatasources({
				knowledgeId: args.knowledgeId,
			});

			const datasources = response.data || [];

			if (args.json) {
				printJson(datasources);
				return;
			}

			if (datasources.length === 0) {
				consola.info("No datasources found");
				return;
			}

			const headers = ["ID", "Display Name", "Created"];
			const rows = datasources.map((ds) => [
				ds.id || "",
				truncate(ds.displayName || "", 40),
				ds.created ? new Date(ds.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list datasources: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const createDatasource = defineCommand({
	meta: {
		name: "create",
		description: "Create a datasource",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		name: {
			type: "string",
			description: "Datasource display name",
			required: true,
		},
		fileId: {
			type: "string",
			description: "File ID to use for the datasource",
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
			const datasource = await client.knowledge.createDatasource({
				knowledgeId: args.knowledgeId,
				displayName: args.name,
				fileId: args.fileId,
			});

			if (args.json) {
				printJson(datasource);
				return;
			}

			printSuccess(`Datasource created successfully`);
			console.log(`ID: ${datasource.id}`);
			console.log(`Name: ${datasource.displayName}`);
		} catch (error) {
			printError(`Failed to create datasource: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const getDatasource = defineCommand({
	meta: {
		name: "get",
		description: "Get a datasource",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		datasourceId: {
			type: "positional",
			description: "Datasource ID",
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
			const datasource = await client.knowledge.retrieveDatasource({
				knowledgeId: args.knowledgeId,
				datasourceId: args.datasourceId,
			});

			if (args.json) {
				printJson(datasource);
				return;
			}

			console.log(`ID: ${datasource.id}`);
			console.log(`Name: ${datasource.displayName}`);
			console.log(`Created: ${datasource.created ? new Date(datasource.created).toISOString() : "N/A"}`);
		} catch (error) {
			printError(`Failed to get datasource: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteDatasource = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a datasource",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		datasourceId: {
			type: "positional",
			description: "Datasource ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete datasource ${args.datasourceId}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.knowledge.deleteDatasource({
				knowledgeId: args.knowledgeId,
				datasourceId: args.datasourceId,
			});

			printSuccess(`Datasource ${args.datasourceId} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete datasource: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const datasources = defineCommand({
	meta: {
		name: "datasources",
		description: "Manage knowledge base datasources",
	},
	subCommands: {
		list: listDatasources,
		create: createDatasource,
		get: getDatasource,
		delete: deleteDatasource,
	},
});

// Chunks subcommands
const listChunks = defineCommand({
	meta: {
		name: "list",
		description: "List chunks in a datasource",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		datasourceId: {
			type: "positional",
			description: "Datasource ID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of chunks to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.knowledge.listChunks({
				knowledgeId: args.knowledgeId,
				datasourceId: args.datasourceId,
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const chunks = response.data || [];

			if (args.json) {
				printJson(chunks);
				return;
			}

			if (chunks.length === 0) {
				consola.info("No chunks found");
				return;
			}

			const headers = ["ID", "Content Preview"];
			const rows = chunks.map((chunk) => [chunk.id || "", truncate(chunk.content || "", 60)]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list chunks: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const addChunks = defineCommand({
	meta: {
		name: "add",
		description: "Add chunks to a datasource",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		datasourceId: {
			type: "positional",
			description: "Datasource ID",
			required: true,
		},
		chunks: {
			type: "string",
			description: "Chunks as JSON array of objects with content field",
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
			let chunks: Array<{ content: string; metadata?: Record<string, unknown> }>;
			try {
				chunks = JSON.parse(args.chunks);
			} catch {
				printError("Invalid JSON for chunks");
				process.exit(1);
			}

			const client = getClient();
			const result = await client.knowledge.createChunks({
				knowledgeId: args.knowledgeId,
				datasourceId: args.datasourceId,
				chunks,
			});

			if (args.json) {
				printJson(result);
				return;
			}

			printSuccess(`Chunks added successfully`);
		} catch (error) {
			printError(`Failed to add chunks: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const countChunks = defineCommand({
	meta: {
		name: "count",
		description: "Get chunk count for a datasource",
	},
	args: {
		knowledgeId: {
			type: "positional",
			description: "Knowledge base ID",
			required: true,
		},
		datasourceId: {
			type: "positional",
			description: "Datasource ID",
			required: true,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const result = await client.knowledge.getChunksCount({
				knowledgeId: args.knowledgeId,
				datasourceId: args.datasourceId,
			});

			console.log(`Chunk count: ${result.count}`);
		} catch (error) {
			printError(`Failed to get chunk count: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const chunks = defineCommand({
	meta: {
		name: "chunks",
		description: "Manage datasource chunks",
	},
	subCommands: {
		list: listChunks,
		add: addChunks,
		count: countChunks,
	},
});

export default defineCommand({
	meta: {
		name: "knowledge",
		description: "Manage knowledge bases",
	},
	subCommands: {
		list,
		get,
		create,
		update,
		delete: deleteKb,
		search,
		datasources,
		chunks,
	},
});
