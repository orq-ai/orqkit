#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "http";
import { registerPromptTools } from "./tools/prompts.js";
import { registerDatasetTools } from "./tools/datasets.js";

/**
 * Orq AI MCP Server
 *
 * Provides tools for managing prompts and datasets in the Orq AI platform.
 * Requires ORQ_API_KEY environment variable to be set.
 *
 * Usage:
 *   stdio mode (default): bun run start
 *   SSE mode: bun run start --sse [--port 3000]
 */

// Validate environment
if (!process.env.ORQ_API_KEY) {
	console.error("Error: ORQ_API_KEY environment variable is required");
	process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
const useSSE = args.includes("--sse");
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;

// Create the MCP server
const server = new McpServer({
	name: "orq-ai",
	version: "0.1.0",
});

// Register all tools
registerPromptTools(server);
registerDatasetTools(server);

async function startStdio(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Orq AI MCP Server running on stdio");
}

async function startSSE(): Promise<void> {
	const transports = new Map<string, SSEServerTransport>();

	const httpServer = createServer(async (req, res) => {
		// Enable CORS
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url || "", `http://localhost:${port}`);

		// SSE endpoint for establishing connection
		if (url.pathname === "/sse" && req.method === "GET") {
			const transport = new SSEServerTransport("/messages", res);
			const sessionId = crypto.randomUUID();
			transports.set(sessionId, transport);

			res.on("close", () => {
				transports.delete(sessionId);
			});

			await server.connect(transport);
			return;
		}

		// Messages endpoint for receiving client messages
		if (url.pathname === "/messages" && req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				// Find the transport for this session (simplified - in production use session ID)
				const transport = transports.values().next().value;
				if (transport) {
					await transport.handlePostMessage(req, res, body);
				} else {
					res.writeHead(400);
					res.end("No active session");
				}
			});
			return;
		}

		// Health check
		if (url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", transport: "sse" }));
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	});

	httpServer.listen(port, () => {
		console.error(`Orq AI MCP Server running on SSE at http://localhost:${port}/sse`);
	});
}

// Start the server
async function main(): Promise<void> {
	if (useSSE) {
		await startSSE();
	} else {
		await startStdio();
	}
}

main().catch((error) => {
	console.error("Failed to start server:", error);
	process.exit(1);
});
