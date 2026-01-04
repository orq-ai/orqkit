#!/usr/bin/env node

import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "orq",
		version: "1.0.9",
		description: "CLI for interacting with the Orq AI platform",
	},
	subCommands: {
		agents: () => import("../commands/agents/index.js").then((m) => m.default),
		deployments: () => import("../commands/deployments/index.js").then((m) => m.default),
		datasets: () => import("../commands/datasets/index.js").then((m) => m.default),
		knowledge: () => import("../commands/knowledge/index.js").then((m) => m.default),
		files: () => import("../commands/files/index.js").then((m) => m.default),
		prompts: () => import("../commands/prompts/index.js").then((m) => m.default),
		evals: () => import("../commands/evals/index.js").then((m) => m.default),
		models: () => import("../commands/models/index.js").then((m) => m.default),
		auth: () => import("../commands/auth/index.js").then((m) => m.default),
		evaluate: () => import("../commands/evaluate/index.js").then((m) => m.default),
	},
});

runMain(main);
