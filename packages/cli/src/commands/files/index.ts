import fs from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { getClient } from "../../lib/client.js";
import { printError, printJson, printSuccess, printTable, truncate } from "../../lib/output.js";

const list = defineCommand({
	meta: {
		name: "list",
		description: "List all files",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output as JSON",
			default: false,
		},
		limit: {
			type: "string",
			description: "Maximum number of files to return",
			required: false,
		},
	},
	async run({ args }) {
		try {
			const client = getClient();
			const response = await client.files.list({
				limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
			});

			const files = response.data || [];

			if (args.json) {
				printJson(files);
				return;
			}

			if (files.length === 0) {
				consola.info("No files found");
				return;
			}

			const headers = ["ID", "Filename", "Size", "Created"];
			const rows = files.map((file) => [
				file.id || "",
				truncate(file.fileName || "", 40),
				file.bytes ? `${(file.bytes / 1024).toFixed(1)} KB` : "N/A",
				file.created ? new Date(file.created).toLocaleDateString() : "",
			]);

			printTable(headers, rows);
		} catch (error) {
			printError(`Failed to list files: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const upload = defineCommand({
	meta: {
		name: "upload",
		description: "Upload a file",
	},
	args: {
		filePath: {
			type: "positional",
			description: "Path to the file to upload",
			required: true,
		},
		name: {
			type: "string",
			description: "Custom filename (defaults to original filename)",
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
			const absolutePath = path.resolve(args.filePath);

			if (!fs.existsSync(absolutePath)) {
				printError(`File not found: ${absolutePath}`);
				process.exit(1);
			}

			const fileName = args.name || path.basename(absolutePath);
			const fileContent = fs.readFileSync(absolutePath);
			const blob = new Blob([fileContent]);

			const client = getClient();
			const file = await client.files.create({
				file: blob,
				fileName,
			});

			if (args.json) {
				printJson(file);
				return;
			}

			printSuccess(`File uploaded successfully`);
			console.log(`ID: ${file.id}`);
			console.log(`Filename: ${file.fileName}`);
			console.log(`Size: ${file.bytes ? `${(file.bytes / 1024).toFixed(1)} KB` : "N/A"}`);
		} catch (error) {
			printError(`Failed to upload file: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const get = defineCommand({
	meta: {
		name: "get",
		description: "Get file details",
	},
	args: {
		id: {
			type: "positional",
			description: "File ID",
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
			const file = await client.files.get({ fileId: args.id });

			if (args.json) {
				printJson(file);
				return;
			}

			console.log(`ID: ${file.id}`);
			console.log(`Filename: ${file.fileName}`);
			console.log(`Size: ${file.bytes ? `${(file.bytes / 1024).toFixed(1)} KB` : "N/A"}`);
			console.log(`Created: ${file.created ? new Date(file.created).toISOString() : "N/A"}`);
		} catch (error) {
			printError(`Failed to get file: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

const deleteFile = defineCommand({
	meta: {
		name: "delete",
		description: "Delete a file",
	},
	args: {
		id: {
			type: "positional",
			description: "File ID",
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
				const confirm = await consola.prompt(`Are you sure you want to delete file ${args.id}?`, {
					type: "confirm",
				});

				if (!confirm) {
					consola.info("Cancelled");
					return;
				}
			}

			const client = getClient();
			await client.files.delete({ fileId: args.id });

			printSuccess(`File ${args.id} deleted successfully`);
		} catch (error) {
			printError(`Failed to delete file: ${error instanceof Error ? error.message : "Unknown error"}`);
			process.exit(1);
		}
	},
});

export default defineCommand({
	meta: {
		name: "files",
		description: "Manage files",
	},
	subCommands: {
		list,
		upload,
		get,
		delete: deleteFile,
	},
});
