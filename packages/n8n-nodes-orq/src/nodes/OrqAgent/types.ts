import type {
  TaskState,
  TaskStatusMessage,
} from "@orq-ai/node/models/operations";

export interface RawAgentListItem {
  _id: string;
  key: string;
  display_name: string;
  status: string;
}

export interface RawTaskMessage extends TaskStatusMessage {
  _id: string;
}

export const TERMINAL_TASK_STATES: TaskState[] = [
  "completed",
  "failed",
  "canceled",
  "input-required",
  "rejected",
  "auth-required",
];

export interface OrqCredentials {
  apiKey: string;
}

export interface ApiError extends Error {
  response?: { status?: number; data?: { message?: string } };
  statusCode?: number;
  description?: string;
}

// Broadly matches any Error so the catch block can extract .message;
// API-specific fields (response, statusCode) are safely optional-chained at call sites.
export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error;
}
