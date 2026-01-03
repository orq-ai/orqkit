import { defineCommand } from "citty";
import consola from "consola";

import { clearConfig, getApiKey, getBaseUrl, hasApiKey, setApiKey, setBaseUrl } from "../../lib/config.js";
import { printInfo, printSuccess } from "../../lib/output.js";

const login = defineCommand({
	meta: {
		name: "login",
		description: "Authenticate with the Orq AI platform",
	},
	args: {
		apiKey: {
			type: "string",
			description: "Your Orq API key",
			required: false,
		},
		baseUrl: {
			type: "string",
			description: "Custom API base URL",
			required: false,
		},
	},
	async run({ args }) {
		let apiKey = args.apiKey;

		if (!apiKey) {
			apiKey = await consola.prompt("Enter your Orq API key:", {
				type: "text",
			});
		}

		if (!apiKey || typeof apiKey !== "string") {
			consola.error("API key is required");
			process.exit(1);
		}

		setApiKey(apiKey);

		if (args.baseUrl) {
			setBaseUrl(args.baseUrl);
		}

		printSuccess("Successfully authenticated with Orq AI");
		printInfo(`API key stored securely`);
	},
});

const logout = defineCommand({
	meta: {
		name: "logout",
		description: "Remove stored credentials",
	},
	async run() {
		clearConfig();
		printSuccess("Successfully logged out");
	},
});

const status = defineCommand({
	meta: {
		name: "status",
		description: "Check authentication status",
	},
	async run() {
		if (hasApiKey()) {
			const apiKey = getApiKey();
			const maskedKey = apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : "";
			printSuccess("Authenticated");
			printInfo(`API Key: ${maskedKey}`);
			printInfo(`Base URL: ${getBaseUrl()}`);
		} else {
			consola.warn("Not authenticated. Run `orq auth login` to authenticate.");
		}
	},
});

export default defineCommand({
	meta: {
		name: "auth",
		description: "Authentication commands",
	},
	subCommands: {
		login,
		logout,
		status,
	},
});
