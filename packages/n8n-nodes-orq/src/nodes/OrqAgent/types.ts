export interface OrqAgent {
  id: string;
  key: string;
  display_name?: string;
  description?: string;
}

export interface OrqAgentListResponse {
  object: "list";
  data: OrqAgent[];
  has_more: boolean;
}

export interface OrqAgentMessagePart {
  kind: "text";
  text: string;
}

export interface OrqAgentMessage {
  role: "user";
  parts: OrqAgentMessagePart[];
}

export interface OrqAgentInvokeRequest {
  message: OrqAgentMessage;
}

export type OrqTaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "input-required"
  | "rejected"
  | "auth-required";

export const TERMINAL_TASK_STATES: OrqTaskState[] = [
  "completed",
  "failed",
  "canceled",
  "input-required",
  "rejected",
  "auth-required",
];

export interface OrqTask {
  id: string;
  agent_key: string;
  status: { state: OrqTaskState };
}

export interface OrqTaskMessagePart {
  kind: "text" | "file" | "tool_call" | "tool_result" | "error" | "data";
  text?: string;
}

export interface OrqTaskMessage {
  role: string;
  parts: OrqTaskMessagePart[];
}

export interface OrqTaskMessagesResponse {
  object: "list";
  data: OrqTaskMessage[];
}

export interface OrqCredentials {
  apiKey: string;
}
