export const DEFAULT_BASE_URL = "https://api.orq.ai";
export const DEPLOYMENT_INVOKE_ENDPOINT = "/v2/deployments/invoke";
export const DEPLOYMENTS_LIST_ENDPOINT = "/v2/deployments";

export const KEY_VALIDATION_REGEX = /^[a-zA-Z0-9_-]+$/;

export const ERROR_MESSAGES = {
  DEPLOYMENT_KEY_REQUIRED: "Deployment Key is required",
  MESSAGE_REQUIRED: "At least one message is required",
  MESSAGE_TOO_LONG: "Total message content exceeds maximum length (100KB)",
  NO_CREDENTIALS: "No credentials configured. Please add Orq API credentials.",
  INVALID_CONTEXT_KEY: (key: string) =>
    `Invalid context key "${key}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
  INVALID_INPUT_KEY: (key: string) =>
    `Invalid input key "${key}". Only alphanumeric characters, underscores, and hyphens are allowed.`,
  FETCH_DEPLOYMENTS_FAILED: (error: string) =>
    `Failed to fetch deployments: ${error}`,
  DEPLOYMENT_INVOKE_FAILED: (error: string) =>
    `Failed to invoke deployment: ${error}`,
};
