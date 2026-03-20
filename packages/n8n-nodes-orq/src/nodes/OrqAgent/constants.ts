export const DEFAULT_BASE_URL = "https://api.orq.ai";

export const AGENTS_LIST_ENDPOINT = "/v2/agents";
export const AGENT_INVOKE_ENDPOINT = (key: string) =>
  `/v2/agents/${encodeURIComponent(key)}/task`;
export const AGENT_TASK_ENDPOINT = (key: string, taskId: string) =>
  `/v2/agents/${encodeURIComponent(key)}/tasks/${encodeURIComponent(taskId)}`;
export const AGENT_TASK_MESSAGES_ENDPOINT = (key: string, taskId: string) =>
  `/v2/agents/${encodeURIComponent(key)}/tasks/${encodeURIComponent(taskId)}/messages`;

export const MAX_POLL_ATTEMPTS = 60;
export const POLL_INTERVAL_MS = 2000;

export const ERROR_MESSAGES = {
  AGENT_KEY_REQUIRED: "Agent Key is required",
  MESSAGE_REQUIRED: "Message is required",
  NO_CREDENTIALS: "No credentials configured. Please add Orq API credentials.",
  FETCH_AGENTS_FAILED: (error: string) => `Failed to fetch agents: ${error}`,
  AGENT_INVOKE_FAILED: (error: string) => `Failed to invoke agent: ${error}`,
  TASK_POLL_TIMEOUT: "Agent task timed out waiting for completion",
  TASK_FAILED: (state: string) => `Agent task ended with state: ${state}`,
};
