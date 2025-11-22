import { Orq } from "@orq-ai/node";

const BASE_URL = process.env.ORQ_BASE_URL || "https://api.orq.ai/v2";

let client: Orq | null = null;

/**
 * Get or create the Orq SDK client (high-level).
 * Uses ORQ_API_KEY from environment variables.
 */
export function getOrqClient(): Orq {
	if (client) {
		return client;
	}

	const apiKey = process.env.ORQ_API_KEY;

	if (!apiKey) {
		throw new Error("ORQ_API_KEY environment variable is required");
	}

	client = new Orq({ apiKey });
	return client;
}

/**
 * Get API key for direct HTTP requests.
 */
export function getApiKey(): string {
	const apiKey = process.env.ORQ_API_KEY;
	if (!apiKey) {
		throw new Error("ORQ_API_KEY environment variable is required");
	}
	return apiKey;
}

/**
 * Make a raw HTTP request to the Orq API.
 * Bypasses SDK validation which can fail on schema mismatches.
 */
export async function orqFetch(
	path: string,
	options: RequestInit = {}
): Promise<unknown> {
	const apiKey = getApiKey();

	const response = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`API Error ${response.status}: ${errorBody}`);
	}

	// For DELETE requests that return no content
	if (response.status === 204) {
		return { success: true };
	}

	return response.json();
}
