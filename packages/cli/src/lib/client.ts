import { Orq } from "@orq-ai/node";
import consola from "consola";

import { getApiKey, getBaseUrl } from "./config.js";

let clientInstance: Orq | null = null;

export function getClient(): Orq {
	if (clientInstance) {
		return clientInstance;
	}

	const apiKey = getApiKey();
	if (!apiKey) {
		consola.error("No API key found. Run `orq auth login` or set ORQ_API_KEY environment variable.");
		process.exit(1);
	}

	clientInstance = new Orq({
		apiKey,
		serverURL: getBaseUrl(),
	});

	return clientInstance;
}

export function resetClient(): void {
	clientInstance = null;
}
