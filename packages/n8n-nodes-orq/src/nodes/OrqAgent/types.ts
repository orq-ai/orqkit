import type {
  TaskState,
  TaskStatusMessage,
} from "@orq-ai/node/models/operations";

export interface TaskMessagesResponse {
  object: "list";
  data: TaskStatusMessage[];
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
