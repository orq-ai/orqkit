import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all datasets",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of datasets to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.datasets.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const datasets = response.data || [];

			if (args.json) {
				printJson(datasets);
				return;
			}

			if (datasets.length === 0) {
				consola.info("No datasets found");
				return;
			}

			const headers = ["ID", "Name", "Created"];
			const rows = datasets.map((dataset) => [
				dataset.id || "",
				truncate(dataset.displayName || "", 40),
				dataset.created ? new Date(dataset.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list datasets: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const get = defineCommand({
	meta: {
		name: "get",
		description: "Retrieve dataset details",
	},
	args: {
		id: {
			type: "positional",
			description: "Dataset ID",
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
			const dataset = await client.datasets.retrieve({ datasetId: args.id });

			if (args.json) {
				printJson(dataset);
				return;
			}

			console.log(`ID: ${dataset.id}`);
			console.log(`Name: ${dataset.displayName}`);
			console.log(`Created: ${dataset.created ? new Date(dataset.created).toISOString() : "N/A"}`);
			console.log(`Updated: ${dataset.updated ? new Date(dataset.updated).toISOString() : "N/A"}`);
		} catch (error) {
			printError(`Failed to retrieve dataset: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const create = defineCommand({
	meta: {
		name: "create",
		description: "Create a new dataset",
	},
	args: {
		name: {
			type: "string",
			description: "Dataset display name",
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
			const dataset = await client.datasets.create({
				displayName: args.name,
			});

			if (args.json) {
				printJson(dataset);
				return;
			}

			printSuccess(`Dataset created successfully`);
			console.log(`ID: ${dataset.id}`);
			console.log(`Name: ${dataset.displayName}`);
		} catch (error) {
			printError(`Failed to create dataset: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const update = defineCommand({
	meta: {
		name: "update",
		description: "Update a dataset",
	},
	args: {
		id: {
			type: "positional",
			description: "Dataset ID",
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
			const dataset = await client.datasets.update({
				datasetId: args.id,
				displayName: args.name,
			});

			if (args.json) {
				printJson(dataset);
				return;
			}

			printSuccess(`Dataset updated successfully`);
			console.log(`ID: ${dataset.id}`);
			console.log(`Name: ${dataset.displayName}`);
		} catch (error) {
			printError(`Failed to update dataset: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteDataset = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a dataset",
	},
	args: {
		id: {
			type: "positional",
			description: "Dataset ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete dataset ${args.id}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.datasets.delete({ datasetId: args.id });

			printSuccess(`Dataset ${args.id} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete dataset: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const clear = defineCommand({
	meta: {
		name: "clear",
		description: "Delete all datapoints from a dataset",
	},
	args: {
		id: {
			type: "positional",
			description: "Dataset ID",
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
				const confirm = await consola.prompt(
					`Are you sure you want to delete ALL datapoints from dataset ${args.id}?`,
					{
						type: "confirm",
					},
				);

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.datasets.clear({ datasetId: args.id });

			printSuccess(`All datapoints deleted from dataset ${args.id}`);
		} catch (error) {
			printError(`Failed to clear dataset: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

// Datapoints subcommands
const listDatapoints = defineCommand({
	meta: {
		name: "list",
		description: "List datapoints in a dataset",
	},
	args: {
		datasetId: {
			type: "positional",
			description: "Dataset ID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of datapoints to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.datasets.listDatapoints({
				datasetId: args.datasetId,
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const datapoints = response.data || [];

			if (args.json) {
				printJson(datapoints);
				return;
			}

			if (datapoints.length === 0) {
				consola.info("No datapoints found");
				return;
			}

			const headers = ["ID", "Created"];
			const rows = datapoints.map((dp) => [
				dp.id || "",
				dp.created ? new Date(dp.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list datapoints: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const addDatapoint = defineCommand({
	meta: {
		name: "add",
		description: "Add a datapoint to a dataset",
	},
	args: {
		datasetId: {
			type: "positional",
			description: "Dataset ID",
			required: true,
		},
		inputs: {
			type: "string",
			description: "Inputs as JSON object",
			required: true,
		},
		expectedOutput: {
			type: "string",
			description: "Expected output",
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
			let inputs: Record<string, unknown>;
			try {
				inputs = JSON.parse(args.inputs);
			} catch {
				printError("Invalid JSON for inputs");
				process.exit(1);
			}

			const client = getClient();
			const datapoint = await client.datasets.createDatapoint({
				datasetId: args.datasetId,
				inputs,
				expectedOutput: args.expectedOutput,
			});

			if (args.json) {
				printJson(datapoint);
				return;
			}

			printSuccess(`Datapoint created successfully`);
			console.log(`ID: ${datapoint.id}`);
		} catch (error) {
			printError(`Failed to create datapoint: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const getDatapoint = defineCommand({
	meta: {
		name: "get",
		description: "Get a datapoint",
	},
	args: {
		datasetId: {
			type: "positional",
			description: "Dataset ID",
			required: true,
		},
		datapointId: {
			type: "positional",
			description: "Datapoint ID",
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
			const datapoint = await client.datasets.retrieveDatapoint({
				datasetId: args.datasetId,
				datapointId: args.datapointId,
			});

			if (args.json) {
				printJson(datapoint);
				return;
			}

			console.log(`ID: ${datapoint.id}`);
			console.log(`Created: ${datapoint.created ? new Date(datapoint.created).toISOString() : "N/A"}`);
			console.log(`Inputs: ${JSON.stringify(datapoint.inputs, null, 2)}`);
			if (datapoint.expectedOutput) {
				console.log(`Expected Output: ${datapoint.expectedOutput}`);
			}
		} catch (error) {
			printError(`Failed to get datapoint: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteDatapoint = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a datapoint",
	},
	args: {
		datasetId: {
			type: "positional",
			description: "Dataset ID",
			required: true,
		},
		datapointId: {
			type: "positional",
			description: "Datapoint ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete datapoint ${args.datapointId}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.datasets.deleteDatapoint({
				datasetId: args.datasetId,
				datapointId: args.datapointId,
			});

			printSuccess(`Datapoint ${args.datapointId} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete datapoint: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const datapoints = defineCommand({
	meta: {
		name: "datapoints",
		description: "Manage dataset datapoints",
	},
	subCommands: {
		list: listDatapoints,
		add: addDatapoint,
		get: getDatapoint,
		delete: deleteDatapoint,
	},
});

export default defineCommand({
	meta: {
		name: "datasets",
		description: "Manage datasets and datapoints",
	},
	subCommands: {
		list,
		get,
		create,
		update,
		delete: deleteDataset,
		clear,
		datapoints,
	},
});
