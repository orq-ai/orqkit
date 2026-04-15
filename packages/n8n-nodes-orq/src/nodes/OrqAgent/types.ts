export interface RawAgentListItem {
  _id: string;
  key: string;
  display_name: string;
  status: string;
}

export interface OrqCredentials {
  apiKey: string;
}

export interface ApiError extends Error {
  response?: { status?: number; data?: { message?: string } };
  statusCode?: number;
  description?: string;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error;
}

export interface CreateResponseBody {
  model: string;
  input: string;
  stream?: boolean;
}

export interface ResponseOutputTextContent {
  type: "output_text";
  text: string;
}

export interface ResponseOutputRefusalContent {
  type: "refusal";
  refusal: string;
}

export type ResponseOutputContent =
  | ResponseOutputTextContent
  | ResponseOutputRefusalContent
  | { type: string; [key: string]: unknown };

export interface ResponseOutputMessage {
  type: "message";
  content: ResponseOutputContent[];
  [key: string]: unknown;
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | { type: string; [key: string]: unknown };

export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ResponseError {
  message?: string;
  code?: string;
  [key: string]: unknown;
}

export interface ResponseIncompleteDetails {
  reason?: string;
  [key: string]: unknown;
}

export type ResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "incomplete"
  | "requires_action"
  | string;

export interface ResponseResource {
  id: string;
  object?: string;
  status: ResponseStatus;
  model?: string;
  output?: ResponseOutputItem[];
  error?: ResponseError | null;
  usage?: ResponseUsage | null;
  incomplete_details?: ResponseIncompleteDetails | null;
  [key: string]: unknown;
}
