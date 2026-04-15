export const DEFAULT_BASE_URL = "https://api.orq.ai";

export const AGENTS_LIST_ENDPOINT = "/v2/agents";
export const RESPONSES_ENDPOINT = "/v1/responses";

export const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 600;

export const ERROR_MESSAGES = {
  AGENT_KEY_REQUIRED: "Agent Key is required",
  MESSAGE_REQUIRED: "Message is required",
  NO_CREDENTIALS: "No credentials configured. Please add Orq API credentials.",
  API_KEY_REQUIRED: "API Key is required in credentials",
  FETCH_AGENTS_FAILED: (error: string) => `Failed to fetch agents: ${error}`,
  RESPONSE_REQUEST_FAILED: (error: string) =>
    `Agent execution failed: ${error}`,
  RESPONSE_FAILED: (message: string) => `Agent response failed: ${message}`,
  RESPONSE_REQUIRES_ACTION:
    "Agent returned status 'requires_action' (e.g. human-approval tool). This is not yet supported by the n8n node.",
  RESPONSE_UNEXPECTED_STATUS: (status: string) =>
    `Agent returned unexpected status: ${status}`,
};
