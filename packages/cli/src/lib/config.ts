import Conf from "conf";

interface CliConfig {
	apiKey?: string;
	baseUrl?: string;
}

const config = new Conf<CliConfig>({
	projectName: "orq-cli",
	schema: {
		apiKey: {
			type: "string",
		},
		baseUrl: {
			type: "string",
			default: "https://api.orq.ai",
		},
	},
});

export function getApiKey(): string | undefined {
	return process.env.ORQ_API_KEY || config.get("apiKey");
}

export function getBaseUrl(): string {
	return process.env.ORQ_BASE_URL || config.get("baseUrl") || "https://api.orq.ai";
}

export function setApiKey(apiKey: string): void {
	config.set("apiKey", apiKey);
}

export function setBaseUrl(baseUrl: string): void {
	config.set("baseUrl", baseUrl);
}

export function clearConfig(): void {
	config.clear();
}

export function hasApiKey(): boolean {
	return !!getApiKey();
}

export { config };
